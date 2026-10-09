//! The read-only agent: how Peekumi runs the agent that the owner chose for Ask. Claude Code
//! runs with every built-in tool off; an OpenRouter model has no tools of its own. Both read
//! the repository only through the lookups in [`crate::lookup`], at the revisions of one
//! grant, and they change nothing.
//!
//! Ask, the rule audit (see the audit module) and Proposed fixes (see the fix_proposals
//! module) use this module, so no service uses another service.
use crate::{App, lookup};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// Closes the answer's lookup grant when dropped, on success, error or a dropped stream.
pub(crate) struct Closes<'a>(pub(crate) &'a App);
impl Drop for Closes<'_> {
    fn drop(&mut self) {
        self.0
            .ask_grant
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}
/// Opens a lookup grant for one answer and returns the client's MCP configuration, or `None`
/// when the listener address is unknown (lookups are then simply unavailable).
pub(crate) fn open_grant(app: &App, base: &Value, head: &Value) -> Option<String> {
    crate::local_origin().map(|origin| {
        let key = crate::random_token();
        *app.ask_grant.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(lookup::Grant::new(key.clone(), base.clone(), head.clone()));
        // `alwaysLoad`: the lookups are in the first prompt, not hidden behind a tool search.
        json!({"mcpServers":{"peekumi":{"type":"http","url":format!("{origin}/mcp/ask"),"headers":{"Authorization":format!("Bearer {key}")},"alwaysLoad":true}}}).to_string()
    })
}
/// Claude Code arguments: every built-in tool off, the configured effort and model, and the
/// lookup server when a grant is open. `stream` asks for incremental text events. `system` is
/// the system prompt (Ask's, or the proposal agent's) and `turns` the most model turns.
pub(crate) fn provider_args<'a>(
    model: Option<&'a str>,
    effort: Option<&'a str>,
    lookups: Option<&'a str>,
    tools: &'a str,
    stream: bool,
    system: &'a str,
    turns: &'a str,
) -> Vec<&'a str> {
    let mut args = vec![
        "-p",
        "--tools",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--system-prompt",
        system,
    ];
    // No model means Claude Code's own default; no effort ("auto") lets it decide.
    if let Some(model) = model {
        args.extend(["--model", model]);
    }
    if let Some(effort) = effort {
        args.extend(["--effort", effort]);
    }
    if stream {
        args.extend([
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
        ]);
    } else {
        args.extend(["--output-format", "json"]);
    }
    match lookups {
        Some(config) => args.extend([
            "--mcp-config",
            config,
            "--allowedTools",
            tools,
            "--max-turns",
            turns,
        ]),
        None => args.extend(["--mcp-config", "{\"mcpServers\":{}}"]),
    }
    args
}

/// Where an answer comes from: Claude Code (its executable, model and effort), with every
/// built-in tool off and the lookups over MCP; or an OpenRouter model (and effort), with the
/// lookups run by Peekumi. Both can only read the repository at the compared revisions.
pub(crate) enum Engine {
    Claude(String, Option<String>, Option<String>),
    OpenRouter(String, Option<String>),
}
/// The owner's choice for Ask from this device (`using`, see the agents module).
pub(crate) fn ask_engine(app: &App, body: &Value) -> Result<Engine> {
    let choice = app
        .workflow
        .choice(crate::agents::Job::Ask, &body["using"])?;
    let (model, effort) = crate::agents::flags(&choice);
    match choice["agent"].as_str() {
        Some("claude") => Ok(Engine::Claude(app.options.claude.clone(), model, effort)),
        Some("openrouter") => Ok(Engine::OpenRouter(
            model.context("Choose an OpenRouter model in Agents")?,
            effort,
        )),
        _ => bail!("This provider cannot answer questions; choose another in Agents"),
    }
}

/// One OpenRouter conversation: Peekumi sends the instructions, the prompt and the lookup
/// tools; for each tool call it runs the lookup under the answer's grant and sends the result
/// back, until the model answers. The last turn offers no tools, so the model must answer.
pub(crate) async fn openrouter_pass(
    app: &App,
    model: &str,
    effort: Option<String>,
    system: &str,
    prompt: &str,
    relay: Option<mpsc::Sender<Value>>,
) -> Result<String> {
    const TURNS: usize = 12;
    let provider = crate::agents::OpenRouter::new(&app.workflow.secrets);
    let key = provider.key_or_error()?;
    let mut messages = vec![
        json!({"role": "system", "content": system}),
        json!({"role": "user", "content": prompt}),
    ];
    let mut reported = 0;
    for turn in 0..TURNS {
        let mut request = json!({"model": model, "messages": messages, "stream": true});
        if turn + 1 < TURNS {
            request["tools"] = lookup::function_tools();
        }
        if let Some(effort) = &effort {
            request["reasoning"] = json!({"effort": effort});
        }
        if let Some(relay) = &relay {
            let _ = relay.send(json!({"type": "turn"})).await;
        }
        let (provider, key, text_relay) = (provider.clone(), key.clone(), relay.clone());
        let (text, calls) = tokio::task::spawn_blocking(move || -> Result<(String, Vec<Value>)> {
            let (mut text, mut calls, mut failure) = (String::new(), Vec::<Value>::new(), None);
            provider.request(
                "/chat/completions",
                Some(&key),
                Some(&request),
                std::time::Duration::from_secs(240),
                |line| {
                    let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                        return;
                    };
                    let Ok(chunk) = serde_json::from_str::<Value>(data) else {
                        return;
                    };
                    if let Some(message) = chunk["error"]["message"].as_str() {
                        failure = Some(message.to_string());
                        return;
                    }
                    let delta = &chunk["choices"][0]["delta"];
                    if let Some(piece) = delta["content"].as_str().filter(|p| !p.is_empty()) {
                        text.push_str(piece);
                        if let Some(relay) = &text_relay {
                            let _ = relay.blocking_send(json!({"type": "text", "text": piece}));
                        }
                    }
                    // Tool calls arrive in pieces, joined by their index.
                    for part in delta["tool_calls"].as_array().into_iter().flatten() {
                        let index = part["index"].as_u64().unwrap_or(0) as usize;
                        while calls.len() <= index {
                            calls.push(json!({"id": "", "name": "", "arguments": ""}));
                        }
                        let call = &mut calls[index];
                        for (field, piece) in [
                            ("id", part["id"].as_str()),
                            ("name", part["function"]["name"].as_str()),
                            ("arguments", part["function"]["arguments"].as_str()),
                        ] {
                            if let Some(piece) = piece {
                                let joined =
                                    format!("{}{piece}", call[field].as_str().unwrap_or(""));
                                call[field] = json!(joined);
                            }
                        }
                    }
                },
            )?;
            if let Some(message) = failure {
                bail!("OpenRouter: {message}");
            }
            Ok((text, calls))
        })
        .await??;
        if calls.is_empty() {
            ensure!(!text.trim().is_empty(), "OpenRouter returned no answer");
            return Ok(text);
        }
        messages.push(json!({
            "role": "assistant",
            "content": if text.is_empty() { Value::Null } else { json!(text) },
            "tool_calls": calls.iter().map(|c| json!({"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}})).collect::<Vec<_>>(),
        }));
        for call in &calls {
            let args = serde_json::from_str::<Value>(call["arguments"].as_str().unwrap_or(""))
                .unwrap_or_else(|_| json!({}));
            let (result, _) =
                lookup::call_tool(app, call["name"].as_str().unwrap_or(""), &args).await;
            messages.push(json!({"role": "tool", "tool_call_id": call["id"], "content": result}));
        }
        let (made, places) = app
            .ask_grant
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|g| (g.calls.clone(), g.places.clone()))
            .unwrap_or_default();
        if let Some(relay) = &relay {
            for (i, call) in made.iter().enumerate().skip(reported) {
                let _ = relay
                    .send(json!({"type": "lookup", "text": call, "place": places.get(i)}))
                    .await;
            }
        }
        reported = made.len();
    }
    bail!("OpenRouter did not finish its answer")
}

/// A plain sentence for an Ask failure. Messages from Peekumi itself stay as they are; the
/// output of an agent that failed (stack lines, temporary file paths) becomes one short
/// reason, so the owner sees what to do and nothing of the host's file system.
pub fn plain_error(e: &anyhow::Error) -> String {
    let text = e.to_string();
    let Some((program, detail)) = text.split_once(": ").filter(|(p, _)| p.starts_with('/')) else {
        if let Some(program) = text.strip_prefix("Cannot start ") {
            let name = program.rsplit('/').next().unwrap_or(program);
            return format!(
                "The agent ({name}) cannot start on this computer. Check that it is installed and signed in, then try again. peekumi doctor shows its state."
            );
        }
        if text.starts_with('/') && text.ends_with(" timed out") {
            return "The agent took too long to answer. Ask again, perhaps about a smaller part."
                .into();
        }
        return text;
    };
    let name = program.rsplit('/').next().unwrap_or(program);
    // The most telling line: an error line if there is one, else the last line that is not
    // part of a stack. Paths shrink to their file name.
    let lines: Vec<&str> = detail
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let line = lines
        .iter()
        .find(|l| l.contains("Error:") || l.starts_with("error"))
        .or_else(|| {
            lines
                .iter()
                .rev()
                .find(|l| !l.starts_with("at ") && !l.starts_with('^'))
        })
        .copied()
        .unwrap_or("");
    // "Error: " says nothing that "stopped with an error" does not.
    let line = line.trim_start_matches("Error:").trim();
    let line: String = line
        .split_whitespace()
        .map(|w| {
            if w.contains('/') && w.len() > 1 {
                w.rsplit('/').next().unwrap_or(w)
            } else {
                w
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect();
    if line.is_empty() {
        format!(
            "The agent ({name}) stopped with an error. Try again, or choose another model in Agents."
        )
    } else {
        format!("The agent ({name}) stopped with an error: {line}")
    }
}

/// Runs the agent that the owner chose for Ask (`body.using`) once for a proposal: `system`
/// and `prompt`, with read-only lookups at commit `sha`, at most `turns` model turns and
/// `seconds` seconds. Returns the reply text and the provider's name.
pub(crate) async fn proposal_pass(
    app: &App,
    body: &Value,
    system: &'static str,
    prompt: String,
    sha: &Value,
    turns: &'static str,
    seconds: u64,
) -> Result<(String, String)> {
    let engine = ask_engine(app, body)?;
    let lookups = open_grant(app, sha, sha);
    let _closes = Closes(app);
    Ok(match engine {
        Engine::OpenRouter(model, effort) => {
            lookup::open(app, sha, sha);
            let raw = openrouter_pass(app, &model, effort, system, &prompt, None).await?;
            (raw, format!("OpenRouter · {model}"))
        }
        Engine::Claude(executable, model, effort) => {
            let cwd = app.workflow.state.join("ask");
            std::fs::create_dir_all(&cwd)?;
            let raw = tokio::task::spawn_blocking(move || -> Result<String> {
                let tools = lookup::TOOLS.join(",");
                let args = provider_args(
                    model.as_deref(),
                    effort.as_deref(),
                    lookups.as_deref(),
                    &tools,
                    false,
                    system,
                    turns,
                );
                let output = crate::process::run_for(
                    &executable,
                    &args,
                    Some(&cwd),
                    prompt.into_bytes(),
                    std::time::Duration::from_secs(seconds),
                )?;
                let response: Value =
                    serde_json::from_slice(&output).context("The agent returned invalid JSON")?;
                ensure!(
                    response["is_error"] != true,
                    "The agent could not make a proposal"
                );
                Ok(response["result"]
                    .as_str()
                    .context("The agent returned no proposal")?
                    .to_string())
            })
            .await??;
            (raw, "Claude Code".to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ask_errors_are_plain_sentences_without_host_paths() {
        let raw = anyhow::anyhow!(
            "/var/folders/x/T/state/agent: file:///var/folders/x/T/state/agent:12\n    throw Error(\"Unsupported model\");\n    ^\n\nError: Unsupported model\n    at process.processTicks (node:internal)"
        );
        let plain = plain_error(&raw);
        assert_eq!(
            plain,
            "The agent (agent) stopped with an error: Unsupported model"
        );
        let missing = plain_error(&anyhow::anyhow!("Cannot start /opt/bin/claude"));
        assert!(
            missing.starts_with("The agent (claude) cannot start") && !missing.contains("/opt")
        );
        assert_eq!(
            plain_error(&anyhow::anyhow!("Select a part of the map first")),
            "Select a part of the map first"
        );
    }
}
