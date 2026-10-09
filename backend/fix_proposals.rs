//! Proposed fixes as a background job.
//!
//! The agent can take minutes to propose fixes for many rule breaks (see
//! `propose_fixes`). A phone can leave the app or lose its connection in that time, so
//! the proposal runs on the server: the page starts it, reads its state while it is open, and
//! the owner's devices get a notification when it ends. The last proposal is saved in
//! `fix-proposals.json` in the repository's private state folder, with the commit that it is
//! for, so the page shows it again when the owner comes back.
use crate::{App, agent_call::proposal_pass};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

/// One change to the saved proposal at a time.
static SAVE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn file(app: &App) -> PathBuf {
    app.workflow.state.join("fix-proposals.json")
}

fn load(app: &App) -> Value {
    std::fs::read(file(app))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn save(app: &App, state: &Value) -> Result<()> {
    let path = file(app);
    let partial = path.with_extension("partial");
    std::fs::write(&partial, serde_json::to_vec(state)?)?;
    std::fs::rename(partial, path)?;
    Ok(())
}

/// What the page shows while another agent run holds Ask's lock.
pub const BUSY: &str = "Another agent run is in progress: an Ask answer, a rule audit or a fix proposal. Peekumi starts this one when it ends.";

/// Starts a proposal for the breaks at `body.head` with the Ask agent `body.using`, in the
/// background, and returns `{running: true}`. It holds Ask's lock until it ends, so it waits
/// for no Ask answer and Ask waits for it. A proposal for the same commit that runs already
/// counts as started (a second tap, a second device). When another agent run holds the lock,
/// it returns `{busy}` and starts nothing: the page tries again.
///
/// # Errors
/// The saved proposal cannot be written.
pub fn start(app: Arc<App>, body: Value) -> Result<Value> {
    let head = body["head"].as_str().unwrap_or("").to_string();
    {
        let _one = SAVE.lock().unwrap_or_else(|e| e.into_inner());
        let state = load(&app);
        if state["head"] == head.as_str()
            && state["running"]["process"].as_u64() == Some(u64::from(std::process::id()))
        {
            return Ok(json!({"running": true}));
        }
    }
    let Ok(guard) = app.ask_lock.clone().try_lock_owned() else {
        return Ok(json!({"busy": BUSY}));
    };
    {
        let _one = SAVE.lock().unwrap_or_else(|e| e.into_inner());
        save(
            &app,
            &json!({
                "head": head,
                "running": {"startedAt": crate::workflow::now(), "process": std::process::id()},
            }),
        )?;
    }
    tokio::spawn(async move {
        let _guard = guard;
        let result = propose_fixes(&app, body).await;
        let (state, title, text) = match result {
            Ok(done) => {
                let n = done["fixes"].as_array().map_or(0, Vec::len);
                let breaks: u64 = done["groups"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|g| g["count"].as_u64().unwrap_or(0))
                    .sum();
                (
                    json!({"head": head, "fixes": done["fixes"], "groups": done["groups"], "provider": done["provider"], "finishedAt": crate::workflow::now()}),
                    "Fixes proposed",
                    format!(
                        "{n} fix{} for {breaks} rule break{}.",
                        if n == 1 { "" } else { "es" },
                        if breaks == 1 { "" } else { "s" }
                    ),
                )
            }
            Err(e) => {
                let message = crate::agent_call::plain_error(&e);
                (
                    json!({"head": head, "error": message, "finishedAt": crate::workflow::now()}),
                    "Fix proposal needs you",
                    message,
                )
            }
        };
        let _one = SAVE.lock().unwrap_or_else(|e| e.into_inner());
        if save(&app, &state).is_ok() {
            app.workflow
                .notify_link(title, &text, "fixes=1", "fix-proposal");
        }
    });
    Ok(json!({"running": true}))
}

/// The saved proposal for `head`: `{running}` while it runs, then `{fixes, groups, provider}`
/// or `{error}`. A proposal for another commit gives `{}`.
pub fn read(app: &App, head: &str) -> Result<Value> {
    let _one = SAVE.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = load(app);
    // A proposal of an earlier Peekumi process stopped with it.
    if state["running"]["process"]
        .as_u64()
        .is_some_and(|p| p != u64::from(std::process::id()))
    {
        state["running"] = Value::Null;
        state["error"] = json!("The proposal stopped when Peekumi restarted. Try again.");
        save(app, &state)?;
    }
    Ok(if state["head"] == head {
        state
    } else {
        json!({})
    })
}

fn text_of(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

/// What the proposal agent is told. It reads the code through the same read-only lookups as
/// Ask, and it changes nothing.
const PROPOSE: &str = "You propose fixes for dependency-rule breaks in a Git repository. You read the code only through the lookup tools, and you change nothing. The user message lists the breaks, grouped by rule and by the declaration that they reach. Read the code at those places, and read .peekumi.json to see the groups and the rules. Then propose the smallest set of changes that removes the breaks and keeps the behaviour the same. A good fix names exactly what to move or change, where it goes, which callers change, and which group in .peekumi.json a new file joins. One fix can cover several groups when one change removes all of them. Write each instruction for a coding agent in ASD-STE100 Simplified Technical English: short sentences, one instruction in each sentence, the imperative, the active voice. Reply with JSON only, and no other text: {\"fixes\": [{\"title\": \"<a short name for the change>\", \"instruction\": \"<what the agent must do>\", \"covers\": [\"<group id>\"], \"files\": [\"<path>\"]}]}. Use only the group ids from the user message.";

/// Reads the proposal agent's reply: a JSON object (code fences and text around it are
/// ignored) with `fixes`. Keeps each fix that has a title, an instruction and at least one
/// known group, and gives it the anchor of its first group and the breaks it covers.
fn read_proposals(raw: &str, groups: &[Value]) -> Result<Vec<Value>> {
    let start = raw.find('{').context("The agent did not reply with JSON")?;
    let end = raw
        .rfind('}')
        .context("The agent did not reply with JSON")?;
    ensure!(end > start, "The agent did not reply with JSON");
    let reply: Value =
        serde_json::from_str(&raw[start..=end]).context("The agent replied with invalid JSON")?;
    let by_id = |id: &str| groups.iter().find(|g| g["id"] == id);
    let mut fixes = vec![];
    for fix in reply["fixes"].as_array().into_iter().flatten().take(20) {
        let title = text_of(&fix["title"]).trim();
        let instruction = text_of(&fix["instruction"]).trim();
        let covers: Vec<&Value> = fix["covers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|id| id.as_str().and_then(by_id))
            .collect();
        if title.is_empty() || title.len() > 200 || instruction.is_empty() || covers.is_empty() {
            continue;
        }
        let ids: Vec<&Value> = covers.iter().map(|g| &g["id"]).collect();
        let rules: std::collections::BTreeSet<&str> =
            covers.iter().filter_map(|g| g["rule"].as_str()).collect();
        let files: Vec<&str> = fix["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|f| !f.is_empty() && f.len() <= 300)
            .take(20)
            .collect();
        fixes.push(json!({
            "id": &crate::hash::hash(json!([title, ids]).to_string())[..16],
            "title": title,
            "text": instruction.chars().take(4000).collect::<String>(),
            "covers": ids,
            "rules": rules,
            "files": files,
            "count": covers.iter().map(|g| g["count"].as_u64().unwrap_or(0)).sum::<u64>(),
            "anchor": covers[0]["anchor"],
        }));
    }
    ensure!(!fixes.is_empty(), "The agent proposed no usable fix");
    Ok(fixes)
}

/// Proposes fixes for the rule breaks at `body.head` with the agent that the owner chose for
/// Ask (`body.using`): it reads the code through read-only lookups at that commit, with
/// Peekumi's grouped breaks (`GET /api/fixes`) as its context. Returns `{fixes, groups,
/// provider}`; `groups` are Peekumi's own proposals, the fallback when the agent fails.
async fn propose_fixes(app: &App, body: Value) -> Result<Value> {
    let head = body["head"]
        .as_str()
        .filter(|h| !h.is_empty())
        .context("Name the commit to fix")?;
    let data = app
        .engine
        .call("fixes", json!([head]))
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let groups = data["fixes"].as_array().cloned().unwrap_or_default();
    if groups.is_empty() {
        return Ok(json!({"fixes": [], "groups": [], "provider": null}));
    }
    let sha = data["head"].clone();
    let context: Vec<Value> = groups
        .iter()
        .take(40)
        .map(|g| json!({"id": g["id"], "rule": g["rule"], "message": g["message"], "target": g["target"], "kinds": g["kinds"], "breaks": g["count"], "from": g["sources"]}))
        .collect();
    let prompt = format!(
        "These dependency-rule breaks are at commit {sha}, grouped by rule and by the declaration that they reach. Propose the fixes.\n\n{}",
        serde_json::to_string_pretty(&context)?
    );
    let (raw, provider) = proposal_pass(app, &body, PROPOSE, prompt, &sha, "24", 360).await?;
    Ok(json!({"fixes": read_proposals(&raw, &groups)?, "groups": groups, "provider": provider}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proposals_keep_only_fixes_for_known_groups() {
        let groups = vec![
            json!({"id":"a1","rule":"ui-no-db","count":2,"anchor":{"kind":"symbol","path":"db/store.py","symbol":"save"}}),
            json!({"id":"b2","rule":"layers","count":3,"anchor":{"kind":"file","path":"x.py"}}),
        ];
        let raw = "Here you are:\n```json\n{\"fixes\":[{\"title\":\"Add a service\",\"instruction\":\"Create services/store.py.\",\"covers\":[\"a1\",\"b2\",\"zz\"],\"files\":[\"services/store.py\"]},{\"title\":\"\",\"instruction\":\"No title\",\"covers\":[\"a1\"]},{\"title\":\"Unknown\",\"instruction\":\"x\",\"covers\":[\"zz\"]}]}\n```";
        let fixes = read_proposals(raw, &groups).unwrap();
        assert_eq!(
            fixes.len(),
            1,
            "Fixes with no title or no known group are left out"
        );
        assert_eq!(fixes[0]["covers"], json!(["a1", "b2"]));
        assert_eq!(fixes[0]["count"], 5);
        assert_eq!(fixes[0]["anchor"]["path"], "db/store.py");
        assert_eq!(fixes[0]["rules"], json!(["layers", "ui-no-db"]));
        assert!(read_proposals("I cannot help.", &groups).is_err());
        assert!(read_proposals("{\"fixes\":[]}", &groups).is_err());
    }
}
