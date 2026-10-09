//! The saved list of proposed rules for one repository, and the rule audit that runs in the
//! background.
//!
//! An audit (see `ask::propose_rules`) can take minutes, so it runs as a background task: the
//! owner can leave the page, and a notification says when the rules are ready. Each audit adds
//! to the list and replaces nothing. The list has one entry for each check: a proposal with the
//! same key as an entry (the same form, kinds and files, see `Repository::rule_trial`), the
//! same rule ID, or the same files with at least one kind in common counts as that entry
//! again. A new rule is not selected. The owner's choice stays with the entry: a selected
//! rule stays selected after the next audit, and a drafted rule stays drafted.
//!
//! The list is in `rule-audit.json` in the repository's private state folder. Each read tries
//! every rule again at the commit on the map, so the numbers are always for that commit.
use crate::App;
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

/// Starts an audit at `body.head` with the Ask agent `body.using`, in the background. It holds
/// Ask's lock until it ends, so it waits for no Ask answer and Ask waits for it.
///
/// # Errors
/// An Ask answer or another audit in progress.
pub fn start(app: Arc<App>, mut body: Value) -> Result<Value> {
    let guard = app
        .ask_lock
        .clone()
        .try_lock_owned()
        .ok()
        .context("An Ask answer or a rule audit is in progress. Try again when it ends")?;
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
        let result = crate::ask::propose_rules(&app, body).await;
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
                let message = crate::ask::plain_error(&e);
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
            json!({"groups": groups, "rule": r["rule"]})
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
