//! Isolated agent processes and a run-scoped stdio MCP reporting bridge.
//! Agents retain their own permission controls. Strata never pushes or merges their branches.
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
        .open(common.join("strata-run.lock"))?;
    repo_lock
        .try_lock()
        .context("Another Strata instance is running an agent for this repository")?;
    let mut prior = String::new();
    repo_lock.read_to_string(&mut prior)?;
    if let Ok(pid) = prior.trim().parse::<u32>() {
        ensure!(
            !alive(pid),
            "An agent from an interrupted Strata instance is still running"
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
    let log = Arc::new(Mutex::new((
        std::fs::File::create(store.state.join(format!("run-{id}.log")))?,
        0usize,
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
    let mut command = if run["agent"] == "codex" {
        let mut c = Command::new(&store.codex);
        c.args([
            "exec",
            "--sandbox",
            "workspace-write",
            "--approve-for-me",
            "--json",
            "--color",
            "never",
        ]);
        c.arg("-c")
            .arg(format!("mcp_servers.strata.command={}", json!(exe)));
        c.arg("-c")
            .arg(format!("mcp_servers.strata.args={}", json!(args)));
        c.arg("-c")
            .arg("mcp_servers.strata.env_vars=[\"STRATA_REPORT_TOKEN\"]");
        c.arg("-");
        c
    } else {
        let mut c = Command::new(&store.claude);
        c.args([
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "acceptEdits",
            "--strict-mcp-config",
            "--allowedTools",
            "Read,Edit,Write,Glob,Grep,Bash,mcp__strata__get_run,mcp__strata__resolve_comment,mcp__strata__flag_comment",
        ]);
        c.arg("--mcp-config").arg(json!({"mcpServers":{"strata":{"command":exe,"args":args,"env":{"STRATA_REPORT_TOKEN":token}}}}).to_string());
        c
    };
    command
        .current_dir(&worktree)
        .env("STRATA_REPORT_TOKEN", token)
        .env_remove("STRATA_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Each run owns a process group so cancel/timeout also stop its helper processes.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
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
    if let Err(e)=store.patch_run(id,json!({"status":"running","pid":pid,"supervisorPid":std::process::id(),"worktree":worktree})) { stop_group(pid);
        let _=child.wait();
        return Err(e);
    }
    let mut stdin = child.stdin.take().context("Agent stdin missing")?;
    let task = run["task"].as_str().unwrap().to_string();
    std::thread::spawn(move || {
        let _ = stdin.write_all(task.as_bytes());
    });
    let stdout = child.stdout.take().context("Agent stdout missing")?;
    let stderr = child.stderr.take().context("Agent stderr missing")?;
    let a = log.clone();
    let b = log.clone();
    let secret = token.to_string();
    let secret2 = secret.clone();
    std::thread::spawn(move || capture(stdout, a, &secret));
    std::thread::spawn(move || capture(stderr, b, &secret2));
    let start = Instant::now();
    let (status, message) = loop {
        if let Some(exit) = child.try_wait()? {
            break (
                if exit.success() {
                    "completed"
                } else {
                    "failed"
                },
                format!("Agent exited with {exit}. Review each report before verification."),
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
/// Owns the child through all error paths, preventing a failed supervisor from leaving it running.
struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        stop_group(self.0.id());
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
/// Keeps the first MiB of output and drains the rest. Split credentials are redacted before writing.
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
                let count = (1024 * 1024usize).saturating_sub(l.1).min(output.len());
                let _ = l.0.write_all(&output.as_bytes()[..count]);
                l.1 += count;
            }
            pending.drain(..end);
        }
        // A single enormous unterminated line is discarded, never partially exposed.
        if pending.len() > 1024 * 1024 {
            pending.clear();
            if let Ok(mut l) = log.lock() {
                l.1 = 1024 * 1024;
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
        });
    }
    Ok(())
}
/// Serves a minimal stdio MCP transport with only three run-scoped reporting tools.
/// Credentials are inherited from the dispatcher, never supplied by an HTTP owner request.
pub fn mcp(store: Workflow, id: &str) -> Result<()> {
    let token = std::env::var("STRATA_REPORT_TOKEN").context("Missing reporting credential")?;
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
                json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"strata","version":"0.3.0"}}),
            ),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools":[
            {"name":"get_run","description":"Read this run's frozen task, comments and rules.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
            {"name":"resolve_comment","description":"Report an addressed comment with a new attributed commit and check results; never verifies it.","inputSchema":{"type":"object","properties":{"comment_id":{"type":"string"},"commit_sha":{"type":"string"},"note":{"type":"string"},"checks":{"type":"string"}},"required":["comment_id","commit_sha","note","checks"],"additionalProperties":false}},
            {"name":"flag_comment","description":"Flag a comment you could not address, explaining the blocker.","inputSchema":{"type":"object","properties":{"comment_id":{"type":"string"},"reason":{"type":"string"}},"required":["comment_id","reason"],"additionalProperties":false}}
            ]})),
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
