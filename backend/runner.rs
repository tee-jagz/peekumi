//! Isolated agent processes and a run-scoped stdio MCP reporting bridge.
//! Agents retain their own permission controls. Peekumi never pushes their branches; the
//! owner merges an approved one explicitly (see the merge module).
use crate::workflow::{Workflow, active};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    io::{BufRead, Read, Seek, Write},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
/// Launches a supervisor without blocking the HTTP runtime;
/// startup failures close the run.
pub fn launch(store: Workflow, id: String, token: String) {
    std::thread::spawn(move || {
        if let Err(e) = execute(&store, &id, &token) {
            let _ = store.finish(&id, "failed", &e.to_string(), json!([]));
        }
        // A session message that waited for this task can start now.
        store.wake_sessions();
    });
}
/// Creates one worktree from the frozen SHA, then supervises a bounded agent session.
fn execute(store: &Workflow, id: &str, token: &str) -> Result<()> {
    let common = store.git(&["rev-parse", "--git-common-dir"])?;
    let common = store.repo.join(common);
    let mut repo_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(common.join("peekumi-run.lock"))?;
    repo_lock
        .try_lock()
        .context("Another Peekumi instance is running an agent for this repository")?;
    let mut prior = String::new();
    repo_lock.read_to_string(&mut prior)?;
    if let Ok(pid) = prior.trim().parse::<u32>() {
        ensure!(
            !alive(pid),
            "An agent from an interrupted Peekumi instance is still running"
        );
    }
    let run = store.run(id)?;
    if run["cancelRequested"] == true {
        store.finish(
            id,
            "cancelled",
            "Cancelled before agent startup.",
            json!([]),
        )?;
        return Ok(());
    }
    // The log and the bytes it may still take.
    let log = Arc::new(Mutex::new((
        std::fs::File::create(store.state.join(format!("run-{id}.log")))?,
        TASK_LOG,
    )));
    let dir = store.state.join("runs").join(id);
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    std::fs::rename(
        store.state.join(format!("run-{id}.log")),
        dir.join("output.log"),
    )?;
    let worktree = dir.join("worktree");
    store.git(&[
        "worktree",
        "add",
        "-b",
        run["branch"].as_str().unwrap(),
        worktree.to_str().context("Invalid worktree path")?,
        run["base"].as_str().unwrap(),
    ])?;
    std::fs::write(dir.join("task.md"), run["task"].as_str().unwrap())?;
    let exe = std::env::current_exe()?;
    let args = vec![
        store.repo.to_string_lossy().to_string(),
        "--state-dir".into(),
        store.state.to_string_lossy().to_string(),
        "--report-run".into(),
        id.into(),
    ];
    // The agent's own command line comes from the agents module; the model and effort are
    // the ones this task started with.
    let agent = crate::agents::find(store, run["agent"].as_str().unwrap_or(""))
        .context("This task's agent is not available on this server")?;
    // The code graph for this run: a read-only lookup grant on its start commit, closed when
    // the run ends, whatever happens.
    let graph_url = crate::local_origin().map(|origin| format!("{origin}/mcp/ask"));
    let graph_key = (run["graph"] == true && graph_url.is_some()).then(crate::random_token);
    let _grant = GraphGrant::open(store, graph_key.clone(), &run["base"]);
    let graph = graph_url.as_deref().zip(graph_key.as_deref());
    let (status, message) = if agent.runs_in_process() {
        // A provider that is only an API: Peekumi's own agent runs the model here, with its
        // tools confined to the worktree.
        let mut out = std::fs::OpenOptions::new()
            .append(true)
            .open(dir.join("output.log"))?;
        store.patch_run(
            id,
            json!({"status":"running","supervisorPid":std::process::id(),"worktree":worktree}),
        )?;
        let cancelled = || {
            store
                .run(id)
                .map(|r| r["cancelRequested"] == true)
                .unwrap_or(false)
        };
        match crate::task_agent::run(
            store, id, token, &run, &worktree, &mut out, cancelled, graph,
        ) {
            Ok(done) => done,
            Err(e) => ("failed", e.to_string()),
        }
    } else {
        let (model, effort) = crate::agents::flags(&run);
        let mut command = agent
            .task_command(&crate::agents::Launch {
                model: model.as_deref(),
                effort: effort.as_deref(),
                bridge: &exe,
                args: &args,
                token,
                graph,
                session: None,
            })
            .context(
                "This task's provider cannot start; check it in Agents (for OpenRouter, the key)",
            )?;
        command
            .current_dir(&worktree)
            .env("PEEKUMI_REPORT_TOKEN", token)
            .env_remove("PEEKUMI_TOKEN")
            .env_remove("STRATA_TOKEN")
            .env_remove("STRATA_REPORT_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Each run owns a process group so cancel/timeout also stop its helper processes.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let task = run["task"].as_str().unwrap().to_string();
        supervise(
            store,
            id,
            &mut repo_lock,
            &mut command,
            task,
            log,
            token,
            json!({"worktree": worktree}),
        )?
    };
    repo_lock.set_len(0)?;
    let results = store
        .git(&[
            "rev-list",
            "--reverse",
            &format!(
                "{}..{}",
                run["base"].as_str().unwrap(),
                run["branch"].as_str().unwrap()
            ),
        ])
        .unwrap_or_default();
    store.finish(
        id,
        status,
        &message,
        json!(results.lines().collect::<Vec<_>>()),
    )?;
    Ok(())
}
/// Spawns an agent command in its own process group, sends `input` on stdin, captures its
/// output into `log` with the token redacted, and waits until it exits, the owner stops it or
/// an hour passes. `patch` is saved with the process ID. Returns the status and message.
#[allow(clippy::too_many_arguments)]
fn supervise(
    store: &Workflow,
    id: &str,
    repo_lock: &mut std::fs::File,
    command: &mut Command,
    input: String,
    log: Arc<Mutex<(std::fs::File, usize)>>,
    token: &str,
    patch: Value,
) -> Result<(&'static str, String)> {
    let mut owned = OwnedChild(
        command
            .spawn()
            .context("Cannot launch agent; check the configured executable and sign-in")?,
    );
    let child = &mut owned.0;
    let pid = child.id();
    repo_lock.set_len(0)?;
    repo_lock.rewind()?;
    write!(repo_lock, "{pid}")?;
    repo_lock.sync_all()?;
    let mut state = json!({"status":"running","pid":pid,"supervisorPid":std::process::id()});
    for (k, v) in patch.as_object().into_iter().flatten() {
        state[k] = v.clone();
    }
    if let Err(e) = store.patch_run(id, state) {
        stop_group(pid);
        let _ = child.wait();
        return Err(e);
    }
    let mut stdin = child.stdin.take().context("Agent stdin missing")?;
    std::thread::spawn(move || {
        let _ = stdin.write_all(input.as_bytes());
    });
    let stdout = child.stdout.take().context("Agent stdout missing")?;
    let stderr = child.stderr.take().context("Agent stderr missing")?;
    let a = log.clone();
    let b = log;
    let secret = token.to_string();
    let secret2 = secret.clone();
    let out = std::thread::spawn(move || capture(stdout, a, &secret));
    let err = std::thread::spawn(move || capture(stderr, b, &secret2));
    let start = Instant::now();
    let (status, message) = loop {
        if let Some(exit) = child.try_wait()? {
            break (
                if exit.success() {
                    "completed"
                } else {
                    "failed"
                },
                if exit.success() {
                    format!("Agent exited with {exit}. Review each report before verification.")
                } else {
                    format!("The agent stopped with an error ({exit}).")
                },
            );
        }
        let current = store.run(id)?;
        if current["cancelRequested"] == true || start.elapsed() > Duration::from_secs(3600) {
            stop_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            break (
                "cancelled",
                "Agent stopped by owner or one-hour time limit.".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(300));
    };
    // Close any helpers left alive after the main CLI process exits.
    stop_group(pid);
    let _ = out.join();
    let _ = err.join();
    Ok((status, message))
}

/// Runs a session's turns in the background, one agent process per turn, while the owner's
/// messages wait. A failure ends the turn, not the session: it waits for the next message.
pub fn launch_session(store: Workflow, id: String) {
    std::thread::spawn(move || {
        loop {
            match session_turn(&store, &id) {
                Ok(true) => continue,
                Ok(false) => break,
                Err(e) => {
                    let _ = append(
                        &store,
                        &id,
                        json!({"type": "peekumi.error", "message": e.to_string()}),
                    );
                    let _ = store.close_turn(
                        &id,
                        current_results(&store, &id),
                        None,
                        None,
                        Some(e.to_string()),
                    );
                    // Messages sent during a failed turn wait for the owner's next message.
                    let _ = store.update(|v| {
                        let r = crate::workflow::find_mut(v, "runs", &id)?;
                        r["status"] = json!("waiting");
                        Ok(Value::Null)
                    });
                    break;
                }
            }
        }
        // Another session's message that waited for this one can start now.
        store.wake_sessions();
    });
}
/// One session turn: takes the waiting messages, prepares the worktree on the first turn,
/// runs the agent so that it continues its conversation, and closes the turn. Returns true
/// when more messages wait.
fn session_turn(store: &Workflow, id: &str) -> Result<bool> {
    let common = store
        .repo
        .join(store.git(&["rev-parse", "--git-common-dir"])?);
    let mut repo_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(common.join("peekumi-run.lock"))?;
    repo_lock.try_lock().context(
        "Another agent is working on this repository. Your message is kept: send a message again when it finishes",
    )?;
    let mut prior = String::new();
    repo_lock.read_to_string(&mut prior)?;
    if let Ok(pid) = prior.trim().parse::<u32>() {
        ensure!(
            !alive(pid),
            "An agent from an interrupted Peekumi instance is still running"
        );
    }
    let token = crate::random_token();
    let Some((turn, messages, run)) =
        store.take_turn(id, &crate::engine::hash(token.as_bytes()))?
    else {
        return Ok(false);
    };
    let dir = store.state.join("runs").join(id);
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let worktree = dir.join("worktree");
    if !worktree.exists() {
        store.git(&[
            "worktree",
            "add",
            "-b",
            run["branch"].as_str().context("Missing branch")?,
            worktree.to_str().context("Invalid worktree path")?,
            run["base"].as_str().context("Missing base")?,
        ])?;
        std::fs::write(dir.join("task.md"), run["task"].as_str().unwrap_or(""))?;
    }
    // The owner's words, with the parts of the map they point at.
    let said = messages
        .iter()
        .map(|m| {
            let parts: Vec<String> = m["anchors"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|a| a["kind"] != "repo")
                .map(|a| match a["symbol"].as_str() {
                    Some(symbol) => format!("{} · {symbol}", a["path"].as_str().unwrap_or("")),
                    None => a["path"].as_str().unwrap_or("").to_string(),
                })
                .collect();
            let text = m["text"].as_str().unwrap_or("");
            if parts.is_empty() {
                text.to_string()
            } else {
                format!("{text}\n(About: {})", parts.join("; "))
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let prompt = if turn == 1 {
        format!(
            "{}\n## The owner's first message\n{said}\n",
            run["task"].as_str().unwrap_or("")
        )
    } else {
        format!("The owner's message:\n{said}\n")
    };
    append(
        store,
        id,
        json!({"type": "peekumi.owner", "turn": turn, "at": crate::workflow::now(), "messages": messages}),
    )?;
    let path = dir.join("output.log");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    let used = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
    let log = Arc::new(Mutex::new((file, SESSION_LOG.saturating_sub(used))));
    let agent = crate::agents::find(store, run["agent"].as_str().unwrap_or(""))
        .context("This session's agent is not available on this server")?;
    let graph_url = crate::local_origin().map(|origin| format!("{origin}/mcp/ask"));
    let graph_key = (run["graph"] == true && graph_url.is_some()).then(crate::random_token);
    let _grant = GraphGrant::open(store, graph_key.clone(), &run["base"]);
    let graph = graph_url.as_deref().zip(graph_key.as_deref());
    let (status, message) = if agent.runs_in_process() {
        let mut out = std::fs::OpenOptions::new().append(true).open(&path)?;
        store.patch_run(
            id,
            json!({"supervisorPid": std::process::id(), "worktree": worktree}),
        )?;
        let cancelled = || {
            store
                .run(id)
                .map(|r| r["cancelRequested"] == true)
                .unwrap_or(false)
        };
        let saved = dir.join("conversation.json");
        match crate::task_agent::session_turn(
            store, &run, &worktree, &saved, &prompt, &mut out, cancelled, graph,
        ) {
            Ok(done) => done,
            Err(e) => ("failed", e.to_string()),
        }
    } else {
        let exe = std::env::current_exe()?;
        let args = vec![
            store.repo.to_string_lossy().to_string(),
            "--state-dir".into(),
            store.state.to_string_lossy().to_string(),
            "--report-run".into(),
            id.into(),
        ];
        let (model, effort) = crate::agents::flags(&run);
        let mut command = agent
            .task_command(&crate::agents::Launch {
                model: model.as_deref(),
                effort: effort.as_deref(),
                bridge: &exe,
                args: &args,
                token: &token,
                graph,
                session: Some(crate::agents::SessionTurn {
                    conversation: run["conversation"].as_str(),
                    first: turn == 1,
                    allow_all: run["permissions"] == "allow",
                }),
            })
            .context("This session's provider cannot start; check it in Agents")?;
        command
            .current_dir(&worktree)
            .env("PEEKUMI_REPORT_TOKEN", &token)
            .env_remove("PEEKUMI_TOKEN")
            .env_remove("STRATA_TOKEN")
            .env_remove("STRATA_REPORT_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        supervise(
            store,
            id,
            &mut repo_lock,
            &mut command,
            prompt,
            log,
            &token,
            json!({"worktree": worktree}),
        )?
    };
    repo_lock.set_len(0)?;
    let output = String::from_utf8_lossy(&std::fs::read(&path).unwrap_or_default()).into_owned();
    let turn_output = output
        .rsplit_once("\"type\":\"peekumi.owner\"")
        .map_or(output.as_str(), |(_, after)| after);
    let summary = last_message(turn_output);
    // Codex names its thread on the first turn; later turns resume it.
    let conversation = if run["conversation"].is_null() {
        turn_output.lines().rev().find_map(|line| {
            let event: Value = serde_json::from_str(line).ok()?;
            (event["type"] == "thread.started")
                .then(|| event["thread_id"].as_str().map(str::to_string))?
        })
    } else {
        None
    };
    append(
        store,
        id,
        json!({"type": "peekumi.turn", "turn": turn, "status": status, "at": crate::workflow::now()}),
    )?;
    let note = match status {
        "completed" => None,
        "cancelled" => Some("Stopped. Send a message to continue.".to_string()),
        _ => Some(format!("The agent's turn failed: {message}")),
    };
    store.close_turn(id, current_results(store, id), summary, conversation, note)
}
/// Appends one Peekumi event line to a session's log.
fn append(store: &Workflow, id: &str, event: Value) -> Result<()> {
    let dir = store.state.join("runs").join(id);
    std::fs::create_dir_all(&dir)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("output.log"))?;
    writeln!(file, "{event}")?;
    Ok(())
}
/// The commits on a run's branch after its start commit, oldest first.
fn current_results(store: &Workflow, id: &str) -> Value {
    let Ok(run) = store.run(id) else {
        return json!([]);
    };
    let commits = store
        .git(&[
            "rev-list",
            "--reverse",
            &format!(
                "{}..refs/heads/{}",
                run["base"].as_str().unwrap_or("HEAD"),
                run["branch"].as_str().unwrap_or("HEAD")
            ),
        ])
        .unwrap_or_default();
    json!(commits.lines().collect::<Vec<_>>())
}
/// The agent's last message in a log: Claude Code's result, or the last text it wrote; the
/// last `agent_message` of Codex or Peekumi's own agent.
fn last_message(log: &str) -> Option<String> {
    let mut last = None;
    for line in log.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if event["type"] == "result" && event["is_error"] != true {
            if let Some(text) = event["result"].as_str().filter(|t| !t.trim().is_empty()) {
                last = Some(text.to_string());
            }
        } else if event["type"] == "assistant" {
            for part in event["message"]["content"].as_array().into_iter().flatten() {
                if let Some(text) = part["text"].as_str().filter(|t| !t.trim().is_empty()) {
                    last = Some(text.to_string());
                }
            }
        } else if event["item"]["type"] == "agent_message"
            && let Some(text) = event["item"]["text"].as_str()
        {
            last = Some(text.to_string());
        }
    }
    last.map(|t| t.chars().take(12000).collect())
}
/// A task run's code graph grant: open while the run lasts, closed on drop.
struct GraphGrant<'a>(&'a Workflow, Option<String>);
impl<'a> GraphGrant<'a> {
    fn open(store: &'a Workflow, key: Option<String>, base: &Value) -> Self {
        if let Some(key) = &key {
            store
                .grants
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    key.clone(),
                    crate::lookup::Grant::with_limit(
                        key.clone(),
                        base.clone(),
                        base.clone(),
                        crate::lookup::TASK_CALLS,
                    ),
                );
        }
        Self(store, key)
    }
}
impl Drop for GraphGrant<'_> {
    fn drop(&mut self) {
        if let Some(key) = &self.1 {
            self.0
                .grants
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(key);
        }
    }
}
/// Owns the child through all error paths, preventing a failed supervisor from leaving it running.
struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        stop_group(self.0.id());
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
/// The most output a task's log keeps, and a session's log over all its turns.
const TASK_LOG: usize = 1024 * 1024;
const SESSION_LOG: usize = 8 * 1024 * 1024;
/// Writes output into the log while its budget (the second field) lasts, and drains the rest.
/// Split credentials are redacted before writing.
fn capture(mut input: impl Read, log: Arc<Mutex<(std::fs::File, usize)>>, secret: &str) {
    let mut buffer = [0u8; 4096];
    let mut pending = Vec::new();
    loop {
        let n = input.read(&mut buffer).unwrap_or(0);
        pending.extend_from_slice(&buffer[..n]);
        let end = if n == 0 {
            pending.len()
        } else {
            pending
                .iter()
                .rposition(|b| *b == b'\n')
                .map(|i| i + 1)
                .unwrap_or(0)
        };
        if end > 0 {
            let output = String::from_utf8_lossy(&pending[..end]).replace(secret, "[redacted]");
            if let Ok(mut l) = log.lock() {
                let count = l.1.min(output.len());
                let _ = l.0.write_all(&output.as_bytes()[..count]);
                l.1 -= count;
            }
            pending.drain(..end);
        }
        // A single enormous unterminated line is discarded, never partially exposed.
        if pending.len() > 1024 * 1024 {
            pending.clear();
            if let Ok(mut l) = log.lock() {
                l.1 = 0;
            }
        }
        if n == 0 {
            break;
        }
    }
}
/// Conservatively checks a recorded process without sending a terminating signal.
fn alive(pid: u32) -> bool {
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
/// Stops only a process group recorded by this run supervisor.
fn stop_group(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}
/// Recovers runs after a service restart without launching duplicate agents or trusting a reused PID.
/// Interrupted runs hold their slot while their process exists;
/// no automatic PID-based killing occurs.
pub fn recover(store: Workflow) -> Result<()> {
    for run in store.read()?["runs"].as_array().unwrap() {
        if !active(run) {
            continue;
        }
        let id = run["id"].as_str().unwrap().to_string();
        store.patch_run(&id,json!({"status":"interrupted","message":"Service restarted. Waiting for the previous agent process to exit. If needed, stop that agent on the host. New runs remain blocked until it exits."}))?;
        let store = store.clone();
        let pid = run["pid"].as_u64();
        std::thread::spawn(move || {
            if let Some(pid) = pid {
                while Command::new("/bin/kill")
                    .args(["-0", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|s| s.success())
                {
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
            let r = store.run(&id).unwrap_or_default();
            if r["kind"] == "session" {
                let _ = store.close_turn(
                    &id,
                    current_results(&store, &id),
                    None,
                    None,
                    Some(
                        "Service restarted, and the last turn stopped. Send a message to continue."
                            .into(),
                    ),
                );
                let _ = store.patch_run(&id, json!({"status": "waiting"}));
                store.wake_sessions();
                return;
            }
            let commits = store
                .git(&[
                    "rev-list",
                    "--reverse",
                    &format!(
                        "{}..{}",
                        r["base"].as_str().unwrap_or("HEAD"),
                        r["branch"].as_str().unwrap_or("HEAD")
                    ),
                ])
                .unwrap_or_default();
            let _ = store.finish(
                &id,
                "failed",
                "Service interrupted this run; inspect retained work and reports.",
                json!(commits.lines().collect::<Vec<_>>()),
            );
            store.wake_sessions();
        });
    }
    // A session message that waited for the repository before the restart.
    store.wake_sessions();
    Ok(())
}
/// Serves a minimal stdio MCP transport with only three run-scoped reporting tools.
/// Credentials are inherited from the dispatcher, never supplied by an HTTP owner request.
pub fn mcp(store: Workflow, id: &str) -> Result<()> {
    let token = std::env::var("PEEKUMI_REPORT_TOKEN").context("Missing reporting credential")?;
    ensure!(!token.is_empty(), "Empty reporting credential");
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        ensure!(line.len() <= 131072, "MCP request too large");
        let request: Value = serde_json::from_str(&line)?;
        if request.get("id").is_none() {
            continue;
        }
        let result: Result<Value> = (|| match request["method"].as_str().unwrap_or("") {
            "initialize" => Ok(
                json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"peekumi","version":"0.3.0"}}),
            ),
            "ping" => Ok(json!({})),
            "tools/list" if store.run(id).is_ok_and(|r| r["kind"] == "session") => {
                Ok(json!({"tools":[
                {"name":"get_run","description":"Read this session: its context, the owner's messages and rules.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
                {"name":"approve","description":"Asks the owner whether a tool may run. Peekumi calls this for permission prompts.","inputSchema":{"type":"object","properties":{"tool_name":{"type":"string"},"input":{"type":"object"},"tool_use_id":{"type":"string"}},"required":["tool_name","input"]}}
                ]}))
            }
            "tools/list" => Ok(json!({"tools":[
            {"name":"get_run","description":"Read this run's frozen task, comments and rules.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
            {"name":"resolve_comment","description":"Report an addressed comment with a new attributed commit and check results; never verifies it.","inputSchema":{"type":"object","properties":{"comment_id":{"type":"string"},"commit_sha":{"type":"string"},"note":{"type":"string"},"checks":{"type":"string"}},"required":["comment_id","commit_sha","note","checks"],"additionalProperties":false}},
            {"name":"flag_comment","description":"Flag a comment you could not address, explaining the blocker.","inputSchema":{"type":"object","properties":{"comment_id":{"type":"string"},"reason":{"type":"string"}},"required":["comment_id","reason"],"additionalProperties":false}}
            ]})),
            "tools/call" if request["params"]["name"] == "approve" => {
                let outcome = store.request_approval(id, &token, &request["params"]["arguments"]);
                Ok(match outcome {
                    Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
                    Err(e) => {
                        json!({"isError":true,"content":[{"type":"text","text":e.to_string()}]})
                    }
                })
            }
            "tools/call" => {
                let outcome = store.report(
                    id,
                    &token,
                    request["params"]["name"].as_str().unwrap_or(""),
                    &request["params"]["arguments"],
                );
                Ok(match outcome {
                    Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
                    Err(e) => {
                        json!({"isError":true,"content":[{"type":"text","text":e.to_string()}]})
                    }
                })
            }
            _ => anyhow::bail!("Unknown MCP method"),
        })();
        let response = match result {
            Ok(value) => json!({"jsonrpc":"2.0","id":request["id"],"result":value}),
            Err(e) => {
                json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":e.to_string()}})
            }
        };
        println!("{response}");
        std::io::stdout().flush()?;
    }
    Ok(())
}
