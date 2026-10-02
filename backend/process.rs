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
        .env_remove("PEEKUMI_TOKEN")
        .env_remove("PEEKUMI_REPORT_TOKEN")
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

/// Runs `program` like [`run_for`], but hands each stdout line to `on_line` as it arrives, so a
/// caller can relay progress (Ask streams its answer this way). The child is killed once `limit`
/// passes; stdin is written and stderr drained on their own threads.
///
/// # Errors
/// Reports startup, wait, timeout and nonzero-exit failures, as [`run`] does.
pub fn stream_lines(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    input: Vec<u8>,
    limit: Duration,
    mut on_line: impl FnMut(&str),
) -> Result<()> {
    use std::io::{BufRead, BufReader};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    let mut command = Command::new(program);
    command
        .env_remove("PEEKUMI_TOKEN")
        .env_remove("PEEKUMI_REPORT_TOKEN")
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
    let stdout = child.stdout.take().context("Missing stdout")?;
    let mut stderr = child.stderr.take().context("Missing stderr")?;
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let child = Arc::new(Mutex::new(child));
    let (finished, timed_out) = (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
    );
    let watchdog = {
        let (child, finished, timed_out) = (child.clone(), finished.clone(), timed_out.clone());
        std::thread::spawn(move || {
            let started = std::time::Instant::now();
            while !finished.load(Ordering::SeqCst) {
                if started.elapsed() >= limit {
                    timed_out.store(true, Ordering::SeqCst);
                    let _ = child.lock().map(|mut c| c.kill());
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        })
    };
    for line in BufReader::new(stdout).lines() {
        match line {
            Ok(line) => on_line(&line),
            Err(_) => break,
        }
    }
    // Poll rather than block in wait(), so the watchdog can still take the lock and kill.
    let status = loop {
        let state = child
            .lock()
            .map_err(|_| anyhow::anyhow!("Process lock poisoned"))?
            .try_wait()?;
        if let Some(status) = state {
            break status;
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    finished.store(true, Ordering::SeqCst);
    let _ = watchdog.join();
    let _ = writer.join();
    let errors = err.join().unwrap_or_default();
    if timed_out.load(Ordering::SeqCst) {
        bail!("{program} timed out");
    }
    if !status.success() {
        bail!("{program}: {}", String::from_utf8_lossy(&errors).trim());
    }
    Ok(())
}
