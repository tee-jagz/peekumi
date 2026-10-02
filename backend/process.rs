//! Bounded subprocess execution for Git, syntax helpers and tool-free Ask.
use anyhow::{Context, Result, bail};
use std::{
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};
use wait_timeout::ChildExt;

/// Runs an installed executable with explicit arguments and byte input, returning stdout.
/// `cwd` optionally changes only the child's working directory. Input and output use separate threads
/// to avoid pipe deadlocks. The direct child is killed if it exceeds the 30-second wait
/// ([`run_for`] sets another limit).
///
/// # Errors
/// Reports startup, output-read, wait, timeout and nonzero-exit failures.
/// Callers must select trusted tools; this helper is not a sandbox for arbitrary inspected code.
pub fn run(program: &str, args: &[&str], cwd: Option<&Path>, input: Vec<u8>) -> Result<Vec<u8>> {
    run_for(program, args, cwd, input, Duration::from_secs(30))
}
/// [`run`] with an explicit time limit, for Ask answers that may make lookup calls.
pub fn run_for(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    input: Vec<u8>,
    limit: Duration,
) -> Result<Vec<u8>> {
    let mut command = Command::new(program);
    command
        .env_remove("STRATA_TOKEN")
        .env_remove("STRATA_REPORT_TOKEN")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("Cannot start {program}"))?;
    let mut stdin = child.stdin.take().context("Missing stdin")?;
    let mut stdout = child.stdout.take().context("Missing stdout")?;
    let mut stderr = child.stderr.take().context("Missing stderr")?;
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });
    let status = child.wait_timeout(limit)?;
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let _ = writer.join();
    let output = out
        .join()
        .map_err(|_| anyhow::anyhow!("Output reader failed"))??;
    let errors = err
        .join()
        .map_err(|_| anyhow::anyhow!("Error reader failed"))??;
    let Some(status) = status else {
        bail!("{program} timed out")
    };
    if !status.success() {
        bail!("{program}: {}", String::from_utf8_lossy(&errors).trim());
    }
    Ok(output)
}
