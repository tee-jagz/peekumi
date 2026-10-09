//! The saved list of proposed rules for one repository, and the rule audit that runs in the
//! background.
//!
//! An audit (see `propose_rules`) can take minutes, so it runs as a background task: the
//! owner can leave the page, and a notification says when the rules are ready. Each audit adds
//! to the list and replaces nothing. The list has one entry for each check: a proposal with the
//! same key as an entry (the same form, kinds and files, see `Repository::rule_trial`), the
//! same rule ID, or the same files with at least one kind in common counts as that entry
//! again. A new rule is not selected. The owner's choice stays with the entry: a selected
//! rule stays selected after the next audit, and a drafted rule stays drafted.
//!
//! The list is in `rule-audit.json` in the repository's private state folder. Each read tries
//! every rule again at the commit on the map, so the numbers are always for that commit.
use crate::{App, agent_call::proposal_pass};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

/// One change to the saved list at a time, for every repository of this server.
static LIST: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn file(app: &App) -> PathBuf {
    app.workflow.state.join("rule-audit.json")
}

fn load(app: &App) -> Value {
    std::fs::read(file(app))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(|v| v["rules"].is_array())
        .unwrap_or_else(|| json!({"rules": [], "dropped": []}))
}

fn save(app: &App, list: &Value) -> Result<()> {
    let path = file(app);
    let partial = path.with_extension("partial");
    std::fs::write(&partial, serde_json::to_vec(list)?)?;
    std::fs::rename(partial, path)?;
    Ok(())
}

/// Changes the saved list with `change` and saves it.
fn change<T>(app: &App, change: impl FnOnce(&mut Value) -> Result<T>) -> Result<T> {
    let _one = LIST.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load(app);
    let out = change(&mut list)?;
    save(app, &list)?;
    Ok(out)
}

/// Starts an audit at `body.head` with the Ask agent `body.using`, in the background, and
/// returns `{running: true}`. It holds Ask's lock until it ends, so it waits for no Ask answer
/// and Ask waits for it. An audit that runs already counts as started. When another agent run
/// holds the lock, it returns `{busy}` and starts nothing: the page tries again.
///
/// # Errors
/// The saved list cannot be written.
pub fn start(app: Arc<App>, mut body: Value) -> Result<Value> {
    if load(&app)["running"]["process"].as_u64() == Some(u64::from(std::process::id())) {
        return Ok(json!({"running": true}));
    }
    let Ok(guard) = app.ask_lock.clone().try_lock_owned() else {
        return Ok(json!({"busy": crate::fix_proposals::BUSY}));
    };
    // The agent gets the rules that earlier audits proposed, so it proposes only what is
    // missing.
    body["known"] = json!(
        load(&app)["rules"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| {
                let plain = r["plain"].as_str().filter(|p| !p.is_empty());
                json!({"plain": plain.or(r["title"].as_str()), "rule": r["rule"]})
            })
            .collect::<Vec<_>>()
    );
    change(&app, |list| {
        list["running"] = json!({
            "head": body["head"],
            "startedAt": crate::workflow::now(),
            "process": std::process::id(),
        });
        list["error"] = Value::Null;
        Ok(())
    })?;
    tokio::spawn(async move {
        let _guard = guard;
        let result = propose_rules(&app, body).await;
        finish(&app, result);
    });
    Ok(json!({"running": true}))
}

/// Adds the audit's rules to the list, keeps its dropped proposals and tells the owner's
/// devices.
fn finish(app: &App, result: Result<Value>) {
    let now = crate::workflow::now();
    let told = change(app, |list| {
        list["running"] = Value::Null;
        let audit = match result {
            Ok(audit) => audit,
            Err(e) => {
                let message = crate::agent_call::plain_error(&e);
                list["error"] = json!(message);
                return Ok(("Rule audit needs you".to_string(), message));
            }
        };
        let rules = list["rules"].as_array_mut().context("Damaged rule list")?;
        let mut added = 0;
        for mut proposal in audit["rules"].as_array().cloned().unwrap_or_default() {
            proposal.as_object_mut().map(|p| p.remove("trial"));
            // The same check, the same rule ID (an agent keeps an ID for one idea when it writes
            // the rule another way), or the same files with at least one kind in common.
            let kinds = |rule: &Value| -> Vec<Value> {
                rule["kinds"].as_array().cloned().unwrap_or_default()
            };
            match rules.iter_mut().find(|r| {
                r["id"] == proposal["id"]
                    || r["rule"]["id"] == proposal["rule"]["id"]
                    || (r["scope"].is_string()
                        && r["scope"] == proposal["scope"]
                        && kinds(&r["rule"])
                            .iter()
                            .any(|k| kinds(&proposal["rule"]).contains(k)))
            }) {
                Some(known) => {
                    // The latest words for the rule: an older entry gets the plain sentence,
                    // value and notes of this audit. The check and the owner's choice stay.
                    if known["status"] != "drafted" {
                        for key in ["title", "plain", "value", "why", "now", "principle"] {
                            if proposal[key].as_str().is_some_and(|text| !text.is_empty()) {
                                known[key] = proposal[key].clone();
                            }
                        }
                    }
                    known["lastSeen"] = json!(now);
                    known["runs"] = json!(known["runs"].as_u64().unwrap_or(1) + 1);
                }
                None => {
                    proposal["status"] = json!("proposed");
                    proposal["firstSeen"] = json!(now);
                    proposal["lastSeen"] = json!(now);
                    proposal["runs"] = json!(1);
                    rules.push(proposal);
                    added += 1;
                }
            }
        }
        let total = rules.len();
        for key in [
            "dropped",
            "principles",
            "provider",
            "configured",
            "configFile",
        ] {
            list[key] = audit[key].clone();
        }
        list["lastRun"] = json!(now);
        list["lastAdded"] = json!(added);
        list["error"] = Value::Null;
        Ok(if added == 0 {
            (
                "No missing rule".to_string(),
                "The audit found no rule that is missing. The current rules are enough."
                    .to_string(),
            )
        } else {
            (
                "Rules proposed".to_string(),
                format!(
                    "{added} new rule{} from the audit, {total} in the list.",
                    if added == 1 { "" } else { "s" }
                ),
            )
        })
    });
    if let Ok((title, body)) = told {
        app.workflow
            .notify_link(&title, &body, "audit=1", "rule-audit");
    }
}

/// The saved list, with each rule tried again at `head`: `trial` has its numbers there, or
/// `problem` says why the engine refuses it (`added` when the configuration has it now).
/// `partOf` names a rule in the list that covers it. `running` is the audit in progress, if
/// any.
pub async fn read(app: &App, head: &str) -> Result<Value> {
    let mut list = {
        let _one = LIST.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = load(app);
        // An audit of an earlier Peekumi process stopped with it.
        if list["running"]["process"]
            .as_u64()
            .is_some_and(|p| p != u64::from(std::process::id()))
        {
            list["running"] = Value::Null;
            list["error"] = json!("The audit stopped when Peekumi restarted. Audit again.");
            save(app, &list)?;
        }
        list
    };
    for rule in list["rules"].as_array_mut().into_iter().flatten() {
        // Before rules started unselected, "cleared" meant not selected.
        if rule["status"] == "cleared" {
            rule["status"] = json!("proposed");
        }
        let proposal = json!({"groups": rule["groups"], "rule": rule["rule"]});
        match app.engine.call("rule_trial", json!([head, proposal])).await {
            Ok(mut trial) => {
                trial.as_object_mut().map(|t| t.remove("config"));
                rule["trial"] = trial;
            }
            Err(problem) => {
                rule["added"] = json!(
                    problem.contains("already exists")
                        || problem.contains("checks the same files")
                        || problem.contains("already covers")
                );
                rule["problem"] = json!(problem);
            }
        }
    }
    // A rule that another rule in the list covers joins it (`partOf`): the list shows each
    // idea once.
    let rules = list["rules"].as_array_mut().context("Damaged rule list")?;
    let open: Vec<usize> = (0..rules.len())
        .filter(|&i| rules[i]["problem"].is_null())
        .collect();
    let proposals: Vec<Value> = open
        .iter()
        .map(|&i| {
            let r = &rules[i];
            let groups = if r["trial"]["groups"].is_object() {
                &r["trial"]["groups"]
            } else {
                &r["groups"]
            };
            let rule = if r["trial"]["rule"].is_object() {
                &r["trial"]["rule"]
            } else {
                &r["rule"]
            };
            json!({"groups": groups, "rule": rule})
        })
        .collect();
    if let Ok(found) = app
        .engine
        .call("rule_overlaps", json!([head, proposals]))
        .await
    {
        for (k, by) in found.as_array().into_iter().flatten().enumerate() {
            if let Some(j) = by.as_u64() {
                let parent = rules[open[j as usize]]["id"].clone();
                rules[open[k]]["partOf"] = parent;
            }
        }
    }
    Ok(list)
}

/// Keeps the owner's choice for rule `id`: `proposed` (not selected), `selected` or
/// `drafted`.
pub fn mark(app: &App, id: &str, status: &str) -> Result<Value> {
    ensure!(
        ["proposed", "selected", "drafted"].contains(&status),
        "Unknown rule status"
    );
    change(app, |list| {
        let rule = list["rules"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .find(|r| r["id"] == id)
            .context("Rule not found")?;
        rule["status"] = json!(status);
        Ok(json!({"ok": true}))
    })
}

fn text_of(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

/// The engineering principles that dependency rules can check, with what each one means. Each
/// proposed rule names one of them.
pub const PRINCIPLES: [(&str, &str); 8] = [
    (
        "Layering",
        "a lower layer does not use a higher layer (the layers form)",
    ),
    (
        "Acyclic dependencies",
        "two parts never use each other, so no part depends on itself in a cycle",
    ),
    (
        "Dependency inversion",
        "high-level policy does not use concrete details; both use an abstraction",
    ),
    (
        "Open-closed",
        "an extension point (adapters, plugins, handlers) uses only its contract, so a new extension changes nothing else (the only form)",
    ),
    (
        "Separation of concerns",
        "parts with different jobs do not use each other's code",
    ),
    (
        "Encapsulation",
        "other parts use a module only through its public entry point, not through its internal files",
    ),
    (
        "Stable dependencies",
        "a stable core uses only other stable parts (the only form)",
    ),
    ("Test isolation", "product code does not use test code"),
];

/// What the rule audit agent is told. It reads the code through the same read-only lookups as
/// Ask, and it changes nothing.
const AUDIT: &str = "You audit the architecture of a Git repository and propose dependency rules for Peekumi's rule engine. You read the code only through the lookup tools, and you change nothing.

Start from the architecture. The user message gives the map of folders and files, the folder descriptions, the dependency cycles that exist now, the current .peekumi.json and the rules that earlier audits proposed. Read the READMEs, the module documentation and the entry points that tell what each part is for. Then find the rules that are missing: the rules that keep this design true while the repository grows.

Do not be pedantic. Propose a rule only when it is needed: it must stop a mistake that is likely in this repository and that costs much when it occurs. Do not propose a rule for a boundary that no change is likely to cross, a rule that only repeats the folder layout, or one idea in several rules. A rule that a current rule or an earlier proposal states, fully or in part, is not missing: do not propose it. When the current rules are enough, reply with no rules. That is a good result.

Do not copy the current dependencies: the code can already contain mistakes. Get each rule from the job of each part and from a principle, not from the imports that exist now. A rule that the current code breaks can be a good rule: Peekumi shows the breaks, and the owner fixes them. Never shape a group or a rule to leave out a file only because that file breaks the rule.

The engine checks only static relationships between files: imports, calls, implements and inherits. It cannot check size, duplication, names or runtime behaviour. Propose only rules that it can check.

A rule has one of three forms, and each rule has an id (lowercase words with hyphens), kinds (from imports, calls, implements, inherits) and a message:
- {\"id\", \"from\": \"<group>\", \"to\": [\"<group>\"], \"kinds\", \"message\"}: files in from must not use files in the to groups.
- {\"id\", \"from\": \"<group>\", \"only\": [\"<group>\"], \"kinds\", \"message\"}: files in from may use only files in from or in the only groups.
- {\"id\", \"layers\": [\"<top group>\", \"...\", \"<bottom group>\"], \"kinds\", \"message\"}: a file in a layer must not use a layer above it.
The only form always lets a group use its own files. To keep the files of one group apart from each other (no feature uses a different feature), use the to form with that group in from and in to. A file that uses itself never breaks a rule.
A group is a name and a list of path globs from the repository root: * stays in one folder, ** crosses folders, ? is one character. Do not use braces or brackets. Use a group of the current .peekumi.json with its name and patterns unchanged, or give a new group a new name.

Put each rule under exactly one of these principles:
PRINCIPLES

Before you propose a rule, use the lookups to see whether the code breaks it now. When it does, say in now whether the break looks like a deliberate design (the code needs it on purpose) or a mistake, and what a fix costs, in one or two sentences. When nothing breaks it, leave now empty. Peekumi measures the breaks itself.

Write plain as one sentence that a new developer understands, with the file or folder names, for example \"frontend/model.js must not use other frontend files\". Give each rule a value: high when the mistake it stops is expensive or hard to see (security, the release, a cycle in the core), medium when it keeps a boundary clear, low otherwise. Write why, now and message in ASD-STE100 Simplified Technical English: short sentences, the active voice, approved words. In why, say what the rule protects and what goes wrong without it, in two or three sentences.

Propose every rule that passes this bar, and no other, the most valuable first. Do not propose a rule that is only a part of another rule that you propose. Reply with JSON only, and no other text: {\"rules\": [{\"principle\": \"<principle>\", \"title\": \"<a short name>\", \"plain\": \"<one plain sentence>\", \"value\": \"high, medium or low\", \"why\": \"<why>\", \"now\": \"<the breaks now, or empty>\", \"groups\": {\"<name>\": [\"<glob>\"]}, \"rule\": {<the rule>}}]}. In groups, give every group that the rule names.";

/// Reads the rule audit agent's reply: a JSON object (text around it is ignored) with
/// `rules`. Keeps each proposal (at most 40) with a known principle, a title, groups and a rule
/// object, each with its plain sentence (the title when it has none), its value (`high`,
/// `medium` or `low`) and its note on the breaks now.
fn read_rule_proposals(raw: &str) -> Result<Vec<Value>> {
    let start = raw.find('{').context("The agent did not reply with JSON")?;
    let end = raw
        .rfind('}')
        .context("The agent did not reply with JSON")?;
    ensure!(end > start, "The agent did not reply with JSON");
    let reply: Value =
        serde_json::from_str(&raw[start..=end]).context("The agent replied with invalid JSON")?;
    Ok(reply["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| {
            PRINCIPLES.iter().any(|(name, _)| p["principle"] == *name)
                && !text_of(&p["title"]).trim().is_empty()
                && p["groups"].is_object()
                && p["rule"].is_object()
        })
        // No limit on the number of rules: the bar in the instructions decides. This ceiling
        // only protects the server from a broken or runaway reply.
        .take(40)
        .map(|p| {
            let short = |v: &Value, n: usize| text_of(v).trim().chars().take(n).collect::<String>();
            let title = short(&p["title"], 200);
            let plain = short(&p["plain"], 300);
            let value = p["value"]
                .as_str()
                .filter(|v| ["high", "medium", "low"].contains(v))
                .unwrap_or("medium");
            json!({
                "principle": p["principle"],
                "title": title,
                "plain": if plain.is_empty() { title.clone() } else { plain },
                "value": value,
                "why": short(&p["why"], 2000),
                "now": short(&p["now"], 1000),
                "groups": p["groups"],
                "rule": p["rule"],
            })
        })
        .collect())
}

/// Audits the repository at `body.head` and proposes dependency rules, with the agent that the
/// owner chose for Ask (`body.using`). The agent gets a high-level view first (the names-only
/// map, the folder descriptions and the current `.peekumi.json`), then reads the code through
/// read-only lookups. Peekumi tries each proposal at that commit (see `Repository::rule_trial`):
/// it keeps the valid ones with their numbers, and returns the others in `dropped` with the
/// reason. Returns `{rules, dropped, principles, provider, head, configured, configFile}`.
async fn propose_rules(app: &App, body: Value) -> Result<Value> {
    let head = body["head"]
        .as_str()
        .filter(|h| !h.is_empty())
        .context("Name the commit to audit")?;
    let sha = app
        .engine
        .call("resolve", json!([head]))
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let sha_text = sha
        .as_str()
        .context("The commit did not resolve")?
        .to_string();
    let map = crate::graph_brief::map(app, &[], &sha_text).await;
    let folders = app
        .engine
        .call("directories", json!([sha_text, sha_text]))
        .await
        .map(|d| d["after"].clone())
        .unwrap_or(Value::Null);
    let mut described = String::new();
    for (path, about) in folders.as_object().into_iter().flatten() {
        let summary = about["description"].as_str().unwrap_or("");
        if !summary.is_empty() && described.len() < 6000 {
            described.push_str(&format!(
                "- {}: {}\n",
                if path.is_empty() { "(root)" } else { path },
                summary.chars().take(300).collect::<String>()
            ));
        }
    }
    let found = crate::rules::CONFIG_FILES.iter().find_map(|name| {
        app.workflow
            .git_read(&["show", &format!("{sha_text}:{name}")])
            .ok()
            .map(|text| (*name, text))
    });
    let config = found.as_ref().map(|(_, text)| text.clone());
    // The rules that earlier audits proposed (see the audit module): the agent proposes only
    // what is missing.
    let known: String = body["known"]
        .as_array()
        .into_iter()
        .flatten()
        .take(60)
        .map(|k| format!("- {} ({})\n", text_of(&k["plain"]), k["rule"]))
        .collect();
    // Cycles are faults, not a design: the agent can propose rules against them without
    // copying the dependencies that exist now.
    let cycles = app
        .engine
        .call("cycles", json!([sha_text]))
        .await
        .unwrap_or(Value::Null);
    let cycles: String = cycles
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let files: Vec<&str> = c["files"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let size = c["size"].as_u64().unwrap_or(0);
            let more = size.saturating_sub(files.len() as u64);
            let more = if more > 0 {
                format!(" and {more} more")
            } else {
                String::new()
            };
            format!("- {size} files: {}{more}\n", files.join(", "))
        })
        .collect();
    let prompt = format!(
        "Audit the repository at commit {sha_text} and propose dependency rules.\n\n## Map of folders and files\n{map}\n\n## Folder descriptions\n{}\n\n## Dependency cycles now\nThese files reach each other through static relationships now. Each cycle is a fault to consider, not a design to copy.\n{}\n\n## Current .peekumi.json\n{}\n\n## Rules that earlier audits proposed\nThe owner has these rules already. Do not propose them again, or a part of them.\n{}\n",
        if described.is_empty() {
            "None."
        } else {
            &described
        },
        if cycles.is_empty() {
            "None found."
        } else {
            &cycles
        },
        config
            .as_deref()
            .unwrap_or("None: this repository has no rules yet."),
        if known.is_empty() { "None." } else { &known },
    );
    // The prompt with the list of principles, made once.
    static SYSTEM: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let system = SYSTEM.get_or_init(|| {
        AUDIT.replace(
            "PRINCIPLES",
            &PRINCIPLES
                .iter()
                .map(|(name, meaning)| format!("- {name}: {meaning}."))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    });
    let (raw, provider) = proposal_pass(app, &body, system, prompt, &sha, "40", 600).await?;
    let (mut rules, mut dropped) = (vec![], vec![]);
    for mut proposal in read_rule_proposals(&raw)? {
        let trial = app
            .engine
            .call(
                "rule_trial",
                json!([sha_text, {"groups": proposal["groups"], "rule": proposal["rule"]}]),
            )
            .await;
        match trial {
            Ok(mut trial) => {
                trial.as_object_mut().map(|t| t.remove("config"));
                // The same check gets the same ID in each audit (see `rule_key`).
                proposal["id"] = trial["key"].clone();
                proposal["scope"] = trial["scope"].clone();
                proposal["trial"] = trial;
                rules.push(proposal);
            }
            Err(reason) => dropped.push(json!({"title": proposal["title"], "reason": reason})),
        }
    }
    // No rule is a good result: the current rules are enough.
    Ok(json!({
        "rules": rules,
        "dropped": dropped,
        "principles": PRINCIPLES.iter().map(|(name, meaning)| json!({"name": name, "meaning": meaning})).collect::<Vec<_>>(),
        "provider": provider,
        "head": sha_text,
        "configured": config.is_some(),
        "configFile": found.map(|(name, _)| name),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_audit_keeps_every_rule_that_the_agent_proposes() {
        let rule = |n: usize| json!({"principle": "Layering", "title": format!("Rule {n}"), "groups": {}, "rule": {"id": format!("r{n}")}});
        let raw = json!({"rules": (0..8).map(rule).collect::<Vec<_>>()}).to_string();
        assert_eq!(
            read_rule_proposals(&raw).unwrap().len(),
            8,
            "No fixed number"
        );
        let many = json!({"rules": (0..60).map(rule).collect::<Vec<_>>()}).to_string();
        assert_eq!(
            read_rule_proposals(&many).unwrap().len(),
            40,
            "Only a runaway reply meets the ceiling"
        );
    }
}
