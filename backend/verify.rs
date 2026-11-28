//! Sandboxed verification runner for repository checks (`peekumi verify` and `/api/verify`).
//!
//! Verification executes the owner's configured checks from `.peekumi.json` at the `start`
//! commit against a private `git archive` copy of the `head` commit (with no `.git` folder).
//! On macOS every prepare and check command runs inside Apple Seatbelt (`/usr/bin/sandbox-exec`).
//! On Linux it uses bubblewrap (`bwrap`). If the sandbox is unavailable or fails to apply,
//! verification stops and reports `blocked` (CLI exit 2): Peekumi never runs repository code
//! without a sandbox.
//!
//! The check phase denies network access, gives the process a private empty `HOME` and `TMPDIR`,
//! clears environment tokens, denies `~/.ssh`, `~/.aws`, `~/.config/gh`, Keychains, the inspected
//! repository and Peekumi's state directory, and mounts any prepared dependency cache read-only.
//! The optional `--prepare` phase runs opt-in inside the sandbox with network enabled and writes
//! only to the private copy and the prepare cache.

use crate::rules::{
    AcceptanceSpec, CheckSpec, ChecksConfig, NewTestSpec, PrepareSpec, parse_checks,
};
use anyhow::{Context, Result, ensure};
use clap::Parser;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use wait_timeout::ChildExt;

/// Maximum bytes kept from the tail of a check's combined stdout and stderr.
pub const OUTPUT_TAIL_BYTES: usize = 65536;
/// Maximum bytes copied for a single captured artifact or coverage report.
const MAX_ARTIFACT_BYTES: u64 = 8 * 1024 * 1024;

/// Common dependency manifests whose changes are surfaced as `manifestsChanged`.
const MANIFEST_NAMES: &[&str] = &[
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.toml",
    "Cargo.lock",
    "pyproject.toml",
    "requirements.txt",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "go.mod",
    "go.sum",
];

/// CLI arguments for `peekumi verify`.
#[derive(Parser, Debug, Clone)]
#[command(
    name = "peekumi verify",
    about = "Run repository verification checks in a sandbox against one exact commit"
)]
pub struct VerifyCli {
    /// Repository directory (defaults to the current working directory).
    #[arg(default_value = ".")]
    pub directory: PathBuf,
    /// Start commit whose `.peekumi.json` defines the checks.
    #[arg(long, default_value = "HEAD~1")]
    pub start: String,
    /// Head commit to archive and check.
    #[arg(long, default_value = "HEAD")]
    pub head: String,
    /// Allow the opt-in prepare phase (with network inside the sandbox) before checks.
    #[arg(long)]
    pub prepare: bool,
    /// Print the complete result record as JSON.
    #[arg(long)]
    pub json: bool,
    /// Optional trusted ref (for example main) to read checks from when start has none.
    #[arg(long)]
    pub config_ref: Option<String>,
    /// Private state directory for persisted verification runs and caches.
    #[arg(long, default_value = ".peekumi")]
    pub state_dir: PathBuf,
}

/// Parameters for one verification run.
#[derive(Clone, Debug)]
pub struct Request {
    pub repo: PathBuf,
    pub state: PathBuf,
    pub start: String,
    pub head: String,
    pub prepare: bool,
    pub trigger: String,
    pub run_id: Option<String>,
    pub config_ref: Option<String>,
    pub acceptance: Option<AcceptanceSpec>,
}

/// Runs read-only Git against `repo` with hooks disabled and returns trimmed UTF-8 stdout.
fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let mut full = vec![
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
    ];
    full.push(repo.to_str().context("Non-UTF-8 repository path")?);
    full.extend_from_slice(args);
    let out = crate::process::run("git", &full, None, vec![])?;
    Ok(String::from_utf8(out)?.trim().to_string())
}

fn resolve_commit(repo: &Path, rev: &str) -> Result<String> {
    ensure!(
        !rev.is_empty() && rev.len() < 256 && !rev.starts_with('-'),
        "Invalid revision"
    );
    git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{rev}^{{commit}}"),
        ],
    )
}

/// Returns true when `ancestor` is an ancestor of (or equal to) `descendant`.
/// Fails closed on any Git error instead of returning false.
fn is_ancestor(repo: &Path, ancestor: &str, descendant: &str) -> Result<bool> {
    let status = Command::new("git")
        .args([
            "--no-optional-locks",
            "--literal-pathspecs",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
        ])
        .arg(repo)
        .args(["merge-base", "--is-ancestor", ancestor, descendant])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("Cannot run git merge-base --is-ancestor")?;
    match status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        other => anyhow::bail!("git merge-base --is-ancestor failed with status {other:?}"),
    }
}

/// Resolves trusted base tips for `configRef` allowlisting (checked-out HEAD and main/master).
fn trusted_branch_tips(repo: &Path) -> Vec<String> {
    ["HEAD", "refs/heads/main", "refs/heads/master"]
        .iter()
        .filter_map(|r| resolve_commit(repo, r).ok())
        .collect()
}

/// Returns true when the start commit has a `.peekumi.json` (or `.strata.json`) containing a
/// `checks` section. Used to decide whether to auto-start verification when an agent reports.
pub fn has_checks_at(repo: &Path, commit: &str) -> bool {
    matches!(load_config_at(repo, commit), Ok(Some((_, Some(_)))))
}

/// Loads `.peekumi.json` (or `.strata.json`) from one exact commit and parses its `checks` section.
fn load_config_at(repo: &Path, commit: &str) -> Result<Option<(String, Option<ChecksConfig>)>> {
    for name in crate::rules::CONFIG_FILES {
        if let Ok(source) = git(repo, &["show", &format!("{commit}:{name}")]) {
            ensure!(source.len() <= 65536, "Configuration exceeds 64 KiB");
            let val: Value = serde_json::from_str(&source)
                .with_context(|| format!("{name} at {} is not valid JSON", &commit[..7]))?;
            if let Some(checks) = val.get("checks").filter(|v| !v.is_null()) {
                let parsed = parse_checks(checks)?;
                return Ok(Some((name.to_string(), Some(parsed))));
            }
            return Ok(Some((name.to_string(), None)));
        }
    }
    Ok(None)
}

/// Materializes `head` into `dest` using `git archive`, producing a clean copy with no `.git`.
fn archive_commit(repo: &Path, head: &str, dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest)?;
    let mut git_cmd = Command::new("git");
    git_cmd
        .args([
            "--no-optional-locks",
            "--literal-pathspecs",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
        ])
        .arg(repo)
        .args(["archive", "--format=tar", head])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut archiver = git_cmd.spawn().context("Cannot run git archive")?;
    let archive_out = archiver
        .stdout
        .take()
        .context("Missing git archive stdout")?;
    let tar = Command::new("tar")
        .args(["-xf", "-"])
        .current_dir(dest)
        .stdin(Stdio::from(archive_out))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("Cannot run tar to extract archive")?;
    let tar_out = tar.wait_with_output()?;
    let git_out = archiver.wait_with_output()?;
    ensure!(
        git_out.status.success(),
        "git archive failed: {}",
        String::from_utf8_lossy(&git_out.stderr).trim()
    );
    ensure!(
        tar_out.status.success(),
        "tar extract failed: {}",
        String::from_utf8_lossy(&tar_out.stderr).trim()
    );
    ensure!(
        !dest.join(".git").exists(),
        "Archive unexpectedly contains .git"
    );
    Ok(())
}

/// RAII cleanup for the temporary sandbox working directory.
struct TempWork(PathBuf);
impl Drop for TempWork {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Fixed-cap tail buffer for combined stdout/stderr so huge output never overflows storage.
struct TailBuffer {
    buf: VecDeque<u8>,
    cap: usize,
    total: usize,
    truncated: bool,
}
impl TailBuffer {
    fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap.min(8192)),
            cap,
            total: 0,
            truncated: false,
        }
    }
    fn push(&mut self, bytes: &[u8]) {
        self.total = self.total.saturating_add(bytes.len());
        if bytes.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&bytes[bytes.len() - self.cap..]);
            self.truncated = true;
            return;
        }
        let overflow = self
            .buf
            .len()
            .saturating_add(bytes.len())
            .saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
            self.truncated = true;
        }
        self.buf.extend(bytes);
    }
    fn into_string(self) -> (String, usize, bool) {
        let bytes: Vec<u8> = self.buf.into_iter().collect();
        (
            String::from_utf8_lossy(&bytes).into_owned(),
            self.total,
            self.truncated,
        )
    }
}

fn sbpl_escape(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// Builds a strict macOS Seatbelt profile.
/// Check phase denies network and mounts cache read-only; prepare phase allows network and
/// writes only to the private copy and prepare cache.
#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn seatbelt_profile(
    src: &Path,
    home: &Path,
    tmp: &Path,
    cache: Option<&Path>,
    repo: &Path,
    state: &Path,
    real_home: Option<&Path>,
    prepare: bool,
) -> String {
    let mut profile = String::from(
        "(version 1)\n\
         (deny default)\n\
         (allow process*)\n\
         (allow sysctl-read)\n\
         (allow mach-lookup)\n\
         (allow ipc-posix-shm)\n\
         (allow signal (target same-sandbox))\n\
         (allow file-read-metadata)\n\
         (allow file-read*\n\
           (literal \"/\")\n\
           (literal \"/etc\")\n\
           (literal \"/var\")\n\
           (literal \"/tmp\")\n\
           (literal \"/private\")\n\
           (literal \"/private/tmp\")\n\
           (literal \"/private/var\")\n\
           (subpath \"/usr\")\n\
           (subpath \"/bin\")\n\
           (subpath \"/sbin\")\n\
           (subpath \"/System\")\n\
           (subpath \"/Library\")\n\
           (subpath \"/opt/homebrew\")\n\
           (subpath \"/Applications/Xcode.app\")\n\
           (subpath \"/dev\")\n\
           (subpath \"/private/var/db\")\n\
           (subpath \"/private/etc\")\n\
           (subpath \"/private/var/select\")\n",
    );
    // Allow read-only access to installed language toolchains in the user's home if present.
    // Never allow reading the user's home directory as a whole.
    if let Some(rh) = real_home {
        for sub in [
            ".cargo",
            ".rustup",
            ".nvm",
            ".pyenv",
            ".rbenv",
            ".local",
            ".asdf",
            ".volta",
            ".mise",
            ".fnm",
            ".bun",
            ".go",
            "go",
            ".conda",
            "miniconda3",
            "anaconda3",
            ".pnpm-store",
            ".sdkman",
            ".uv",
            ".cache/uv",
            ".rye",
        ] {
            let candidate = rh.join(sub);
            if candidate.exists() {
                profile.push_str(&format!("  (subpath \"{}\")\n", sbpl_escape(&candidate)));
            }
        }
    }
    profile.push_str(")\n");

    // Explicitly deny sensitive credential locations, the inspected checkout and Peekumi state.
    profile.push_str("(deny file-read*\n");
    profile.push_str("  (subpath \"/Library/Keychains\")\n");
    profile.push_str(&format!("  (subpath \"{}\")\n", sbpl_escape(repo)));
    profile.push_str(&format!("  (subpath \"{}\")\n", sbpl_escape(state)));
    if let Some(rh) = real_home {
        for secret in [
            ".ssh",
            ".aws",
            ".config/gh",
            ".gnupg",
            ".kube",
            ".netrc",
            ".npmrc",
            ".pypirc",
            "Library/Keychains",
        ] {
            let p = rh.join(secret);
            profile.push_str(&format!("  (subpath \"{}\")\n", sbpl_escape(&p)));
            profile.push_str(&format!("  (literal \"{}\")\n", sbpl_escape(&p)));
        }
    }
    profile.push_str(")\n");

    // Allow reads inside the private copy, private HOME, private TMPDIR and cache.
    profile.push_str("(allow file-read*\n");
    profile.push_str(&format!("  (subpath \"{}\")\n", sbpl_escape(src)));
    profile.push_str(&format!("  (subpath \"{}\")\n", sbpl_escape(home)));
    profile.push_str(&format!("  (subpath \"{}\")\n", sbpl_escape(tmp)));
    if let Some(c) = cache {
        profile.push_str(&format!("  (subpath \"{}\")\n", sbpl_escape(c)));
    }
    profile.push_str(")\n");

    // Allow writes ONLY inside the private copy, private HOME, private TMPDIR, and /dev/null.
    // Cache is writable ONLY during --prepare; in the check phase it stays strictly read-only.
    profile.push_str("(allow file-write*\n");
    profile.push_str(&format!("  (subpath \"{}\")\n", sbpl_escape(src)));
    profile.push_str(&format!("  (subpath \"{}\")\n", sbpl_escape(home)));
    profile.push_str(&format!("  (subpath \"{}\")\n", sbpl_escape(tmp)));
    if prepare && let Some(c) = cache {
        profile.push_str(&format!("  (subpath \"{}\")\n", sbpl_escape(c)));
    }
    profile.push_str(
        "  (literal \"/dev/null\")\n\
         (literal \"/dev/tty\")\n\
         (literal \"/dev/dtracehelper\")\n\
         )\n",
    );

    if prepare {
        profile.push_str("(allow network*)\n");
    } else {
        profile.push_str("(deny network*)\n");
    }
    profile
}

/// Outcome of running one sandboxed command.
struct ExecOutcome {
    exit_code: Option<i32>,
    timed_out: bool,
    sandbox_blocked: Option<String>,
    duration_ms: u64,
    output: String,
    output_bytes: usize,
    output_truncated: bool,
}

fn kill_group(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn sandbox_engine_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "seatbelt"
    }
    #[cfg(target_os = "linux")]
    {
        "bubblewrap"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        "unsupported"
    }
}

/// Probes that the host sandbox binary exists and can start. Never falls back to unsandboxed execution.
fn check_sandbox_available() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        ensure!(
            Path::new("/usr/bin/sandbox-exec").is_file(),
            "macOS Seatbelt (/usr/bin/sandbox-exec) is not available"
        );
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let ok = Command::new("bwrap")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        ensure!(ok, "Linux bubblewrap (bwrap) is not available");
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        bail!("No supported sandbox is available on this platform")
    }
}

/// Executes `argv` inside the OS sandbox with clean env, process-group timeout and tail capture.
#[allow(clippy::too_many_arguments)]
fn run_sandboxed(
    argv: &[String],
    cwd: &Path,
    src: &Path,
    home: &Path,
    tmp: &Path,
    cache: Option<&Path>,
    repo: &Path,
    state: &Path,
    extra_env: &BTreeMap<String, String>,
    timeout_secs: u64,
    prepare: bool,
) -> ExecOutcome {
    let started = Instant::now();
    let real_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|p| p.canonicalize().ok());

    let mut path_parts: Vec<String> = vec![
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
        "/usr/sbin".into(),
        "/sbin".into(),
    ];
    if let Some(ref rh) = real_home {
        for sub in [".cargo/bin", ".local/bin"] {
            let p = rh.join(sub);
            if p.is_dir() {
                path_parts.insert(0, p.to_string_lossy().into_owned());
            }
        }
    }
    let safe_path = path_parts.join(":");

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let profile = seatbelt_profile(
            src,
            home,
            tmp,
            cache,
            repo,
            state,
            real_home.as_deref(),
            prepare,
        );
        let mut c = Command::new("/usr/bin/sandbox-exec");
        c.arg("-p").arg(profile).arg("--").args(argv);
        c
    };

    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = Command::new("bwrap");
        c.args([
            "--die-with-parent",
            "--new-session",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind",
            "/bin",
            "/bin",
            "--ro-bind",
            "/lib",
            "/lib",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--bind",
        ])
        .arg(src)
        .arg(src)
        .arg("--bind")
        .arg(home)
        .arg(home)
        .arg("--bind")
        .arg(tmp)
        .arg(tmp);
        if let Some(cache_dir) = cache {
            c.arg(if prepare { "--bind" } else { "--ro-bind" })
                .arg(cache_dir)
                .arg(cache_dir);
        }
        if !prepare {
            c.arg("--unshare-net");
        }
        c.arg("--").args(argv);
        c
    };

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        return ExecOutcome {
            exit_code: None,
            timed_out: false,
            sandbox_blocked: Some("No supported sandbox on this platform".into()),
            duration_ms: 0,
            output: String::new(),
            output_bytes: 0,
            output_truncated: false,
        };
    }

    cmd.current_dir(cwd)
        .env_clear()
        .env("HOME", home)
        .env("TMPDIR", tmp)
        .env("PATH", &safe_path)
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8")
        .env("TERM", "dumb")
        .env("CI", "true")
        .env("NO_COLOR", "1")
        .env("PEEKUMI_VERIFY", "1")
        .env("CARGO_TARGET_DIR", tmp.join("cargo-target"))
        .env("NPM_CONFIG_CACHE", tmp.join("npm-cache"))
        .env("PIP_CACHE_DIR", tmp.join("pip-cache"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(c) = cache {
        cmd.env("PEEKUMI_VERIFY_CACHE", c);
    }
    if let Some(ref rh) = real_home {
        let rustup = rh.join(".rustup");
        if rustup.is_dir() {
            cmd.env("RUSTUP_HOME", rustup);
        }
    }
    for (k, v) in extra_env {
        cmd.env(k, v);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ExecOutcome {
                exit_code: None,
                timed_out: false,
                sandbox_blocked: Some(format!("Sandbox could not start: {e}")),
                duration_ms: started.elapsed().as_millis() as u64,
                output: String::new(),
                output_bytes: 0,
                output_truncated: false,
            };
        }
    };

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let tail = Arc::new(Mutex::new(TailBuffer::new(OUTPUT_TAIL_BYTES)));
    let read_stream = |stream: Option<Box<dyn Read + Send>>, buf: Arc<Mutex<TailBuffer>>| {
        std::thread::spawn(move || {
            let Some(mut s) = stream else { return };
            let mut chunk = [0u8; 4096];
            loop {
                match s.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut b) = buf.lock() {
                            b.push(&chunk[..n]);
                        }
                    }
                }
            }
        })
    };
    let t_out = read_stream(
        stdout.map(|s| Box::new(s) as Box<dyn Read + Send>),
        tail.clone(),
    );
    let t_err = read_stream(
        stderr.map(|s| Box::new(s) as Box<dyn Read + Send>),
        tail.clone(),
    );

    let limit = Duration::from_secs(timeout_secs);
    let status = match child.wait_timeout(limit) {
        Ok(s) => s,
        Err(e) => {
            kill_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            let _ = t_out.join();
            let _ = t_err.join();
            let (output, output_bytes, output_truncated) = Arc::try_unwrap(tail)
                .ok()
                .and_then(|m| m.into_inner().ok())
                .map(TailBuffer::into_string)
                .unwrap_or_default();
            return ExecOutcome {
                exit_code: None,
                timed_out: false,
                sandbox_blocked: Some(format!("Sandbox wait failed: {e}")),
                duration_ms: started.elapsed().as_millis() as u64,
                output,
                output_bytes,
                output_truncated,
            };
        }
    };

    let timed_out = status.is_none();
    if timed_out {
        kill_group(pid);
        let _ = child.kill();
        let _ = child.wait();
    } else {
        // Ensure any lingering background children in the check's process group are stopped.
        kill_group(pid);
    }
    let _ = t_out.join();
    let _ = t_err.join();

    let (output, output_bytes, output_truncated) = Arc::try_unwrap(tail)
        .ok()
        .and_then(|m| m.into_inner().ok())
        .map(TailBuffer::into_string)
        .unwrap_or_default();

    let exit_code = status.and_then(|s| s.code());
    // Detect Seatbelt failing to apply (exit 71 + sandbox-exec error) and fail closed.
    let sandbox_blocked = if exit_code == Some(71)
        && (output.contains("sandbox-exec:") || output.contains("sandbox_apply"))
    {
        Some(format!(
            "Sandbox failed to apply: {}",
            output.lines().next().unwrap_or("sandbox-exec exited 71")
        ))
    } else {
        None
    };

    ExecOutcome {
        exit_code,
        timed_out,
        sandbox_blocked,
        duration_ms: started.elapsed().as_millis() as u64,
        output,
        output_bytes,
        output_truncated,
    }
}

/// Copies a directory tree recursively, skipping symlinks that point outside `src_root`.
fn copy_tree(from: &Path, to: &Path, root: &Path) -> Result<()> {
    if !from.exists() {
        return Ok(());
    }
    let meta = std::fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        if let Ok(canon) = from.canonicalize()
            && canon.starts_with(root)
            && canon.is_file()
        {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&canon, to)?;
        }
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()), root)?;
        }
    } else if meta.is_file() {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to)?;
    }
    Ok(())
}

/// Computes the prepare cache key from the prepare command and the `cacheKey` file contents in `src`.
fn prepare_cache_key(prep: &PrepareSpec, src: &Path, head: &str) -> String {
    let mut material = format!("prepare:{:?}\n", prep.command);
    if prep.cache_key.is_empty() {
        material.push_str(head);
    } else {
        for rel in &prep.cache_key {
            material.push_str(rel);
            material.push('\n');
            if let Ok(bytes) = std::fs::read(src.join(rel)) {
                material.push_str(&crate::hash::hash(&bytes));
            } else {
                material.push_str("missing");
            }
            material.push('\n');
        }
    }
    crate::hash::hash(material.as_bytes())[..24].to_string()
}

/// Persists a verification run record atomically with mode 0600.
fn save_record(state: &Path, id: &str, record: &Value) -> Result<()> {
    let dir = state.join("verify").join("runs");
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let target = dir.join(format!("{id}.json"));
    let pending = dir.join(format!("{id}.json.pending"));
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&pending)?;
    file.write_all(&serde_json::to_vec_pretty(record)?)?;
    file.sync_all()?;
    std::fs::rename(pending, target)?;
    Ok(())
}

/// Reads one verification run record by ID.
pub fn read_run(state: &Path, id: &str) -> Result<Value> {
    ensure!(
        !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "Invalid verification run id"
    );
    let path = state.join("verify").join("runs").join(format!("{id}.json"));
    let bytes = std::fs::read(&path).context("Verification run not found")?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Lists persisted verification runs, newest first, optionally filtered by `start`, `head`, or task `run_id`.
pub fn list_runs(
    state: &Path,
    head_filter: Option<&str>,
    run_id_filter: Option<&str>,
) -> Result<Vec<Value>> {
    list_runs_filtered(state, None, head_filter, run_id_filter)
}

/// Lists persisted verification runs filtered by optional `start`, `head`, and `run_id`.
pub fn list_runs_filtered(
    state: &Path,
    start_filter: Option<&str>,
    head_filter: Option<&str>,
    run_id_filter: Option<&str>,
) -> Result<Vec<Value>> {
    let dir = state.join("verify").join("runs");
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut runs = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&path)
            && let Ok(val) = serde_json::from_slice::<Value>(&bytes)
        {
            if let Some(s) = start_filter
                && val["start"].as_str() != Some(s)
            {
                continue;
            }
            if let Some(h) = head_filter
                && val["head"].as_str() != Some(h)
            {
                continue;
            }
            if let Some(rid) = run_id_filter
                && val["runId"].as_str() != Some(rid)
            {
                continue;
            }
            runs.push(val);
        }
    }
    runs.sort_by(|a, b| {
        b["startedAt"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&a["startedAt"].as_u64().unwrap_or(0))
    });
    Ok(runs)
}

/// Returns the newest verification run matching `(start, head)` (or matching `head` if `start` is empty).
pub fn latest_for(state: &Path, start: &str, head: &str) -> Option<Value> {
    let runs = list_runs(state, Some(head), None).ok()?;
    if start.is_empty() {
        return runs.into_iter().next();
    }
    runs.into_iter()
        .find(|r| r["start"].as_str() == Some(start))
}

/// Changed files between `start` and `head` including BOTH sides of renames and deletions.
struct DiffSummary {
    /// Every path touched (includes both old and new path on rename, plus deletions).
    all_paths: Vec<String>,
    /// Added or modified paths that exist in `head` (not deleted).
    present_in_head: Vec<String>,
    /// Added or modified standalone test files present in `head`.
    standalone_tests: Vec<String>,
    /// Non-standalone-test files whose diff hunks edit inline tests (e.g. Rust `#[cfg(test)]`).
    inline_test_files: Vec<String>,
}

/// Validates a relative path from Git diff before overlaying onto `start` (no `..`, no `/`, no `.git`).
fn safe_overlay_path(rel: &str) -> bool {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\0') || rel.contains('\\') {
        return false;
    }
    let mut saw_normal = false;
    for comp in Path::new(rel).components() {
        match comp {
            std::path::Component::Normal(seg) => {
                if seg == ".git" {
                    return false;
                }
                saw_normal = true;
            }
            _ => return false,
        }
    }
    saw_normal
}

/// Parses `git diff -M --name-status -z start head` so renames match BOTH sides and deletions stay visible.
fn collect_diff(repo: &Path, start: &str, head: &str) -> Result<DiffSummary> {
    let raw_bytes = crate::process::run(
        "git",
        &[
            "--no-optional-locks",
            "--literal-pathspecs",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            repo.to_str().context("Non-UTF-8 repository path")?,
            "diff",
            "-M",
            "--name-status",
            "-z",
            "--end-of-options",
            start,
            head,
        ],
        None,
        vec![],
    )?;
    let raw = String::from_utf8(raw_bytes)?;
    let tokens: Vec<&str> = raw.split('\0').filter(|s| !s.is_empty()).collect();
    let mut all_paths = Vec::new();
    let mut present_in_head = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let status = tokens[i];
        i += 1;
        if (status.starts_with('R') || status.starts_with('C')) && i + 1 < tokens.len() {
            let old_path = tokens[i];
            let new_path = tokens[i + 1];
            i += 2;
            all_paths.push(old_path.to_string());
            all_paths.push(new_path.to_string());
            present_in_head.push(new_path.to_string());
        } else if i < tokens.len() {
            let p = tokens[i];
            i += 1;
            all_paths.push(p.to_string());
            if !status.starts_with('D') {
                present_in_head.push(p.to_string());
            }
        }
    }
    all_paths.sort();
    all_paths.dedup();
    present_in_head.sort();
    present_in_head.dedup();

    let standalone_tests: Vec<String> = present_in_head
        .iter()
        .filter(|p| crate::review::sensitive_kind(p) == Some("tests"))
        .cloned()
        .collect();

    // Detect inline Rust tests (`#[cfg(test)]`, `mod tests`, `#[test]`) edited in non-test source files.
    let mut inline_test_files = Vec::new();
    for p in &present_in_head {
        if p.ends_with(".rs")
            && crate::review::sensitive_kind(p) != Some("tests")
            && let Ok(patch) = git(
                repo,
                &[
                    "diff",
                    "--no-color",
                    "-U2",
                    "--end-of-options",
                    start,
                    head,
                    "--",
                    p,
                ],
            )
            && patch.lines().any(|line| {
                (line.starts_with('+') || line.starts_with('-'))
                    && !line.starts_with("+++")
                    && !line.starts_with("---")
                    && (line.contains("#[cfg(test)]")
                        || line.contains("#[test]")
                        || line.contains("mod tests"))
            })
        {
            inline_test_files.push(p.clone());
        }
    }

    Ok(DiffSummary {
        all_paths,
        present_in_head,
        standalone_tests,
        inline_test_files,
    })
}

/// Classifies base-overlay failure output as compile/import/syntax/collection/setup error (`true`)
/// rather than a genuine test assertion failure (`false`).
fn is_inconclusive_base_failure(output: &str) -> bool {
    const MARKERS: &[&str] = &[
        "SyntaxError",
        "ImportError",
        "ModuleNotFoundError",
        "ERR_MODULE_NOT_FOUND",
        "Cannot find module",
        "Cannot find package",
        "NameError",
        "ReferenceError",
        "TypeError: Cannot read",
        "error[E",
        "could not compile",
        "ERROR collecting",
        "CollectionError",
        "No such file or directory",
        "command not found",
        "ENOENT",
    ];
    MARKERS.iter().any(|m| output.contains(m))
}

/// Expands `{files}` directly into argv elements prefixed with `./` (never via shell) so
/// filenames starting with `-` can never be parsed as runner flags.
fn expand_new_test_argv(template: &[String], rel_path: &str) -> Vec<String> {
    let prefixed = format!("./{rel_path}");
    template
        .iter()
        .map(|arg| {
            if arg == "{files}" {
                prefixed.clone()
            } else {
                arg.clone()
            }
        })
        .collect()
}

/// Copies a single validated regular file from `src_root/rel` into `dest_root/rel` without
/// following symlinks outside `src_root`.
fn copy_overlay_file(src_root: &Path, dest_root: &Path, rel: &str) -> Result<bool> {
    if !safe_overlay_path(rel) {
        return Ok(false);
    }
    let from = src_root.join(rel);
    let Ok(meta) = std::fs::symlink_metadata(&from) else {
        return Ok(false);
    };
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Ok(false);
    }
    let canon = from.canonicalize()?;
    if !canon.starts_with(src_root) {
        return Ok(false);
    }
    let to = dest_root.join(rel);
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(&canon, &to)?;
    Ok(true)
}

/// Compact snapshot of verification evidence for an approval record.
pub fn approval_snapshot(state: &Path, start: &str, head: &str) -> Value {
    let Some(run) = latest_for(state, start, head) else {
        return json!({"state": "none", "reason": "No verification run for this commit pair"});
    };
    json!({
        "id": run["id"],
        "state": run["state"],
        "summary": run["summary"],
        "reason": run["reason"],
        "configCommit": run["configCommit"],
        "configRef": run["configRef"],
        "configChanged": run["configChanged"],
        "acceptanceResult": run["acceptanceResult"],
        "finishedAt": run["finishedAt"],
        "checks": run["checks"].as_array().map(|list| {
            list.iter().map(|c| json!({
                "id": c["id"],
                "name": c["name"],
                "kind": c["kind"],
                "expected": c["expected"],
                "observed": c["observed"],
                "durationMs": c["durationMs"],
            })).collect::<Vec<_>>()
        }).unwrap_or_default(),
    })
}

/// Captures declared artifacts and coverage reports from `src` into private run storage.
fn capture_artifacts(
    state: &Path,
    run_id: &str,
    head: &str,
    check: &CheckSpec,
    src_canon: &Path,
) -> Vec<Value> {
    let mut captured = Vec::new();
    let mut targets: Vec<(&str, &str)> = check
        .artifacts
        .iter()
        .map(|p| (p.as_str(), "artifact"))
        .collect();
    if let Some(ref cov) = check.coverage {
        targets.push((cov.as_str(), "coverage"));
    }
    let artifact_root = state
        .join("verify")
        .join("runs")
        .join(run_id)
        .join("artifacts")
        .join(&check.id);

    for (rel, kind) in targets {
        let candidate = src_canon.join(rel);
        let Ok(canon) = candidate.canonicalize() else {
            captured.push(json!({
                "path": rel,
                "kind": kind,
                "state": "missing",
            }));
            continue;
        };
        if !canon.starts_with(src_canon) || !canon.is_file() {
            captured.push(json!({
                "path": rel,
                "kind": kind,
                "state": "rejected",
                "reason": "Path is outside the repository copy or not a regular file",
            }));
            continue;
        }
        let Ok(meta) = std::fs::metadata(&canon) else {
            continue;
        };
        if meta.len() > MAX_ARTIFACT_BYTES {
            captured.push(json!({
                "path": rel,
                "kind": kind,
                "state": "too_large",
                "bytes": meta.len(),
            }));
            continue;
        }
        let Ok(bytes) = std::fs::read(&canon) else {
            continue;
        };
        let digest = crate::hash::hash(&bytes);
        let dest = artifact_root.join(rel);
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::write(&dest, &bytes).is_ok() {
            captured.push(json!({
                "path": rel,
                "kind": kind,
                "state": "captured",
                "bytes": bytes.len(),
                "sha256": digest,
                "stored": dest.to_string_lossy(),
            }));
            if kind == "coverage" {
                let _ = crate::crap::store_coverage(state, head, run_id, &check.id, rel, &bytes);
            }
        }
    }
    captured
}

/// Checks whether any file in `changed` is a dependency manifest or listed in `cache_key`.
fn detect_manifest_change(changed: &[String], prep: Option<&PrepareSpec>) -> bool {
    changed.iter().any(|path| {
        let name = path.rsplit('/').next().unwrap_or(path);
        MANIFEST_NAMES.contains(&name)
            || prep.is_some_and(|p| p.cache_key.iter().any(|k| k == path))
    })
}

/// Executes a full verification run synchronously and persists its result record.
pub fn run_sync(req: &Request) -> Result<Value> {
    let id = format!("v{}", &crate::random_token()[..14]);
    run_with_id(&id, req)
}

/// Creates a `"running"` placeholder record and executes verification in a background thread.
pub fn start_background(req: Request) -> Result<Value> {
    let repo = req.repo.canonicalize().context("Cannot open repository")?;
    let start = resolve_commit(&repo, &req.start)?;
    let head = resolve_commit(&repo, &req.head)?;
    let id = format!("v{}", &crate::random_token()[..14]);
    let started_at = crate::workflow::now();
    let initial = json!({
        "id": id,
        "repo": repo,
        "start": start,
        "head": head,
        "runId": req.run_id,
        "trigger": req.trigger,
        "prepare": req.prepare,
        "state": "running",
        "summary": "Running checks in sandbox",
        "reason": Value::Null,
        "configCommit": start,
        "checks": [],
        "startedAt": started_at,
        "finishedAt": Value::Null,
    });
    save_record(&req.state, &id, &initial)?;
    let bg_id = id.clone();
    std::thread::spawn(move || {
        let _ = run_with_id(&bg_id, &req);
    });
    Ok(initial)
}

/// Core verification execution writing final state under `id`.
fn run_with_id(id: &str, req: &Request) -> Result<Value> {
    let started_at = crate::workflow::now();
    let repo = match req.repo.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            let rec = blocked_record(
                id,
                &req.repo,
                &req.start,
                &req.head,
                req,
                started_at,
                format!("Cannot open repository: {e}"),
            );
            let _ = save_record(&req.state, id, &rec);
            return Ok(rec);
        }
    };
    let start = match resolve_commit(&repo, &req.start) {
        Ok(s) => s,
        Err(e) => {
            let rec = blocked_record(
                id,
                &repo,
                &req.start,
                &req.head,
                req,
                started_at,
                format!("Cannot resolve start commit: {e}"),
            );
            let _ = save_record(&req.state, id, &rec);
            return Ok(rec);
        }
    };
    let head = match resolve_commit(&repo, &req.head) {
        Ok(h) => h,
        Err(e) => {
            let rec = blocked_record(
                id,
                &repo,
                &start,
                &req.head,
                req,
                started_at,
                format!("Cannot resolve head commit: {e}"),
            );
            let _ = save_record(&req.state, id, &rec);
            return Ok(rec);
        }
    };
    let state = req
        .state
        .canonicalize()
        .unwrap_or_else(|_| req.state.clone());

    // Fail closed if host sandbox is unavailable.
    if let Err(e) = check_sandbox_available() {
        let rec = blocked_record(
            id,
            &repo,
            &start,
            &head,
            req,
            started_at,
            format!("Sandbox unavailable: {e}"),
        );
        let _ = save_record(&state, id, &rec);
        return Ok(rec);
    }

    // Read checks from START commit by default, or from an explicit owner-chosen trusted ref
    // (never from the unreviewed head commit when head differs from start).
    let (config_commit, config_label) = if let Some(ref cfg_ref) = req.config_ref {
        let resolved = match resolve_commit(&repo, cfg_ref) {
            Ok(c) => c,
            Err(e) => {
                let rec = blocked_record(
                    id,
                    &repo,
                    &start,
                    &head,
                    req,
                    started_at,
                    format!("Cannot resolve config ref {cfg_ref}: {e}"),
                );
                let _ = save_record(&state, id, &rec);
                return Ok(rec);
            }
        };
        let in_unreviewed = (|| -> Result<bool> {
            let anc_of_start = is_ancestor(&repo, &resolved, &start)?;
            let anc_of_head = is_ancestor(&repo, &resolved, &head)?;
            let desc_of_head = head != start && is_ancestor(&repo, &head, &resolved)?;
            if (anc_of_head && !anc_of_start) || desc_of_head {
                return Ok(true);
            }
            if anc_of_start {
                return Ok(false);
            }
            for tip in trusted_branch_tips(&repo) {
                if is_ancestor(&repo, &resolved, &tip)? {
                    return Ok(false);
                }
            }
            Ok(true)
        })();
        match in_unreviewed {
            Ok(true) => {
                let rec = blocked_record(
                    id,
                    &repo,
                    &start,
                    &head,
                    req,
                    started_at,
                    "Untrusted configRef: must be on the default branch or an ancestor of start, and never an unreviewed commit in or after start..head".into(),
                );
                let _ = save_record(&state, id, &rec);
                return Ok(rec);
            }
            Err(e) => {
                let rec = blocked_record(
                    id,
                    &repo,
                    &start,
                    &head,
                    req,
                    started_at,
                    format!("Cannot verify configRef trust: {e}"),
                );
                let _ = save_record(&state, id, &rec);
                return Ok(rec);
            }
            Ok(false) => {}
        }
        (resolved.clone(), format!("{cfg_ref} ({})", &resolved[..7]))
    } else {
        (start.clone(), format!("start commit {}", &start[..7]))
    };
    let (config_file, config) = match load_config_at(&repo, &config_commit) {
        Ok(Some((file, Some(cfg)))) => (file, cfg),
        Ok(Some((file, None))) => {
            let rec = blocked_record(
                id,
                &repo,
                &start,
                &head,
                req,
                started_at,
                format!(
                    "{file} at {} has no checks section",
                    if req.config_ref.is_some() {
                        format!(
                            "{} ({})",
                            req.config_ref.as_deref().unwrap_or(""),
                            &config_commit[..7]
                        )
                    } else {
                        config_label
                    }
                ),
            );
            let _ = save_record(&state, id, &rec);
            return Ok(rec);
        }
        Ok(None) => {
            let rec = blocked_record(
                id,
                &repo,
                &start,
                &head,
                req,
                started_at,
                format!(
                    "No .peekumi.json configuration at {}",
                    if req.config_ref.is_some() {
                        format!(
                            "{} ({})",
                            req.config_ref.as_deref().unwrap_or(""),
                            &config_commit[..7]
                        )
                    } else {
                        config_label
                    }
                ),
            );
            let _ = save_record(&state, id, &rec);
            return Ok(rec);
        }
        Err(e) => {
            let rec = blocked_record(
                id,
                &repo,
                &start,
                &head,
                req,
                started_at,
                format!(
                    "Invalid checks configuration at {}: {e}",
                    &config_commit[..7]
                ),
            );
            let _ = save_record(&state, id, &rec);
            return Ok(rec);
        }
    };

    let diff = match collect_diff(&repo, &start, &head) {
        Ok(d) => d,
        Err(e) => {
            let rec = blocked_record(
                id,
                &repo,
                &start,
                &head,
                req,
                started_at,
                format!(
                    "Cannot compute diff between {} and {}: {e}",
                    &start[..7],
                    &head[..7]
                ),
            );
            let _ = save_record(&state, id, &rec);
            return Ok(rec);
        }
    };
    let changed_files = diff.all_paths.clone();
    let config_changed = changed_files
        .iter()
        .any(|p| crate::rules::CONFIG_FILES.contains(&p.as_str()));
    let manifests_changed = detect_manifest_change(&changed_files, config.prepare.as_ref());

    // Create a private work directory outside both repo and state so Seatbelt paths never collide.
    let temp_root = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    let work_dir = temp_root.join(format!("peekumi-verify-{id}"));
    let _guard = TempWork(work_dir.clone());
    let src = work_dir.join("src");
    let home = work_dir.join("home");
    let tmp = work_dir.join("tmp");
    for d in [&src, &home, &tmp] {
        std::fs::create_dir_all(d)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700));
        }
    }
    let src_canon = src.canonicalize()?;
    let home_canon = home.canonicalize()?;
    let tmp_canon = tmp.canonicalize()?;

    if let Err(e) = archive_commit(&repo, &head, &src_canon) {
        let rec = blocked_record(
            id,
            &repo,
            &start,
            &head,
            req,
            started_at,
            format!("Cannot archive commit {}: {e}", &head[..7]),
        );
        let _ = save_record(&state, id, &rec);
        return Ok(rec);
    }

    let mut notes = Vec::new();
    if let Some(ref cfg_ref) = req.config_ref
        && config_commit != start
    {
        notes.push(format!(
            "Checks ran from {cfg_ref} ({}) instead of start commit {}.",
            &config_commit[..7],
            &start[..7]
        ));
    }
    if config_changed {
        notes.push(format!(
            "{config_file} changed between {} and {}. Checks ran from {}.",
            &start[..7],
            &head[..7],
            &config_commit[..7]
        ));
    }

    // Prepare phase (opt-in only) and read-only cache staging.
    let mut cache_dir_canon: Option<PathBuf> = None;
    let mut prepare_record: Option<Value> = None;
    if let Some(ref prep) = config.prepare {
        let key = prepare_cache_key(prep, &src_canon, &head);
        let cache_root = state.join("verify").join("cache").join(&key);
        if req.prepare {
            std::fs::create_dir_all(&cache_root)?;
            let cache_c = cache_root.canonicalize()?;
            let out = run_sandboxed(
                &prep.command,
                &src_canon,
                &src_canon,
                &home_canon,
                &tmp_canon,
                Some(&cache_c),
                &repo,
                &state,
                &BTreeMap::new(),
                prep.timeout_seconds,
                true,
            );
            if let Some(reason) = out.sandbox_blocked {
                let rec = blocked_record(id, &repo, &start, &head, req, started_at, reason);
                let _ = save_record(&state, id, &rec);
                return Ok(rec);
            }
            let prep_ok = !out.timed_out && out.exit_code == Some(0);
            prepare_record = Some(json!({
                "command": prep.command,
                "observed": if out.timed_out { "timed_out" } else if prep_ok { "passed" } else { "failed" },
                "exitCode": out.exit_code,
                "durationMs": out.duration_ms,
                "timedOut": out.timed_out,
                "output": out.output,
                "outputBytes": out.output_bytes,
                "outputTruncated": out.output_truncated,
                "network": "allowed_for_prepare",
                "cacheKey": key,
            }));
            if !prep_ok {
                let rec = json!({
                    "id": id,
                    "repo": repo,
                    "start": start,
                    "head": head,
                    "runId": req.run_id,
                    "trigger": req.trigger,
                    "prepare": req.prepare,
                    "prepareResult": prepare_record,
                    "state": "blocked",
                    "summary": "Prepare phase failed",
                    "reason": "The prepare phase did not succeed; checks did not run",
                    "configFile": config_file,
                    "configCommit": config_commit,
                    "configRef": req.config_ref,
                    "configChanged": config_changed,
                    "manifestsChanged": manifests_changed,
                    "sandbox": sandbox_info(false, true),
                    "limits": {"outputTailBytes": OUTPUT_TAIL_BYTES, "notes": notes},
                    "checks": [],
                    "startedAt": started_at,
                    "finishedAt": crate::workflow::now(),
                });
                let _ = save_record(&state, id, &rec);
                return Ok(rec);
            }
            for rel in &prep.cache_dirs {
                let _ = copy_tree(&src_canon.join(rel), &cache_c.join(rel), &src_canon);
            }
            cache_dir_canon = Some(cache_c);
        } else if cache_root.is_dir() {
            let cache_c = cache_root.canonicalize()?;
            for rel in &prep.cache_dirs {
                let _ = copy_tree(&cache_c.join(rel), &src_canon.join(rel), &cache_c);
            }
            cache_dir_canon = Some(cache_c);
        } else if manifests_changed {
            notes.push(
                "Dependencies changed since start and no matching cache exists. Run with --prepare if dependencies must be installed."
                    .into(),
            );
        } else {
            notes.push(
                "Prepare is configured but no cache exists yet. Run with --prepare to populate the cache."
                    .into(),
            );
        }
    }

    // Check phase: network denied, cache read-only, clean env, private HOME.
    let mut check_records = Vec::with_capacity(config.items.len());
    let mut any_failed = false;
    let mut sandbox_failure: Option<String> = None;

    for check in &config.items {
        // Scoped `paths` filter from trusted config: matches both old & new rename paths and
        // deletions. Unmatched checks record `skipped` (never `passed`).
        if !check.paths.is_empty()
            && !diff
                .all_paths
                .iter()
                .any(|p| check.paths.iter().any(|g| crate::rules::matches(g, p)))
        {
            check_records.push(json!({
                "id": check.id,
                "name": check.name,
                "kind": "check",
                "command": check.command,
                "expected": check.expect,
                "observed": "skipped",
                "matched": false,
                "skipped": true,
                "paths": check.paths,
                "skipReason": format!("No changed files matched {}", check.paths.join(", ")),
                "exitCode": Value::Null,
                "durationMs": 0,
                "timeoutSeconds": check.timeout_seconds,
                "timedOut": false,
                "output": "",
                "outputBytes": 0,
                "outputTruncated": false,
                "artifacts": [],
            }));
            continue;
        }
        let check_cwd = match &check.cwd {
            Some(rel) => src_canon.join(rel),
            None => src_canon.clone(),
        };
        if !check_cwd.is_dir() {
            any_failed = true;
            check_records.push(json!({
                "id": check.id,
                "name": check.name,
                "kind": "check",
                "command": check.command,
                "expected": check.expect,
                "observed": "failed",
                "matched": false,
                "exitCode": Value::Null,
                "durationMs": 0,
                "timeoutSeconds": check.timeout_seconds,
                "timedOut": false,
                "output": format!("Working directory does not exist: {}", check.cwd.as_deref().unwrap_or(".")),
                "outputBytes": 0,
                "outputTruncated": false,
                "artifacts": [],
            }));
            continue;
        }

        let out = run_sandboxed(
            &check.command,
            &check_cwd,
            &src_canon,
            &home_canon,
            &tmp_canon,
            cache_dir_canon.as_deref(),
            &repo,
            &state,
            &check.env,
            check.timeout_seconds,
            false,
        );
        if let Some(reason) = out.sandbox_blocked {
            sandbox_failure = Some(reason);
            check_records.push(json!({
                "id": check.id,
                "name": check.name,
                "kind": "check",
                "command": check.command,
                "expected": check.expect,
                "observed": "blocked",
                "matched": false,
                "exitCode": out.exit_code,
                "durationMs": out.duration_ms,
                "timeoutSeconds": check.timeout_seconds,
                "timedOut": out.timed_out,
                "output": out.output,
                "outputBytes": out.output_bytes,
                "outputTruncated": out.output_truncated,
                "artifacts": [],
            }));
            break;
        }

        let observed = if out.timed_out {
            "timed_out"
        } else if out.exit_code == Some(0) {
            "passed"
        } else {
            "failed"
        };
        let matched = (check.expect == "pass" && observed == "passed")
            || (check.expect == "fail" && observed == "failed");
        if !matched {
            any_failed = true;
        }
        let artifacts = capture_artifacts(&state, id, &head, check, &src_canon);
        check_records.push(json!({
            "id": check.id,
            "name": check.name,
            "kind": "check",
            "command": check.command,
            "expected": check.expect,
            "observed": observed,
            "matched": matched,
            "exitCode": out.exit_code,
            "durationMs": out.duration_ms,
            "timeoutSeconds": check.timeout_seconds,
            "timedOut": out.timed_out,
            "output": out.output,
            "outputBytes": out.output_bytes,
            "outputTruncated": out.output_truncated,
            "artifacts": artifacts,
        }));
    }

    // Standalone fail-to-pass verification for added/edited standalone test files (Phase 2).
    // Base overlay runs use a fresh isolated archive of `start` with ONLY the standalone test
    // file (and optional `testSupportGlobs`) overlaid, are prefixed with `./` in argv (no shell),
    // and are strictly excluded from commit CRAP coverage.
    if sandbox_failure.is_none()
        && start != head
        && let Some(ref nt) = config.new_tests
    {
        run_standalone_fail_to_pass(
            nt,
            &diff,
            &repo,
            &start,
            &work_dir,
            &src_canon,
            &home_canon,
            &tmp_canon,
            cache_dir_canon.as_deref(),
            &state,
            &mut check_records,
            &mut any_failed,
            &mut sandbox_failure,
        );
    }

    // Owner-authored shell-free acceptance check (Phase 3), bound into approvalRecord by hash.
    let mut acceptance_result = Value::Null;
    if sandbox_failure.is_none()
        && let Some(ref acc) = req.acceptance
    {
        acceptance_result = run_owner_acceptance(
            acc,
            &repo,
            &start,
            &head,
            &work_dir,
            &src_canon,
            &home_canon,
            &tmp_canon,
            cache_dir_canon.as_deref(),
            &state,
            &mut check_records,
            &mut any_failed,
            &mut sandbox_failure,
        );
    }

    let total = check_records.len();
    let passed = check_records
        .iter()
        .filter(|c| c["matched"] == true)
        .count();
    let skipped = check_records
        .iter()
        .filter(|c| c["observed"] == "skipped")
        .count();
    let weak = check_records
        .iter()
        .filter(|c| c["observed"] == "weak_test")
        .count();
    let inconclusive = check_records
        .iter()
        .filter(|c| c["observed"] == "inconclusive")
        .count();
    let (final_state, summary, reason) = if let Some(ref block) = sandbox_failure {
        ("blocked", "Blocked by sandbox".to_string(), json!(block))
    } else if any_failed || weak > 0 {
        let mut parts = vec![format!("{passed} of {total} passed")];
        if weak > 0 {
            parts.push(format!(
                "{weak} weak test{}",
                if weak == 1 { "" } else { "s" }
            ));
        }
        if inconclusive > 0 {
            parts.push(format!("{inconclusive} inconclusive"));
        }
        if skipped > 0 {
            parts.push(format!("{skipped} skipped"));
        }
        ("failed", parts.join(" · "), Value::Null)
    } else if passed == 0 && skipped > 0 && inconclusive == 0 {
        (
            "skipped",
            format!("All {skipped} checks skipped (no passing evidence)"),
            Value::Null,
        )
    } else if passed == 0 && inconclusive > 0 {
        (
            "inconclusive",
            format!("{inconclusive} inconclusive · 0 passed"),
            Value::Null,
        )
    } else if skipped > 0 || inconclusive > 0 {
        let mut parts = vec![format!("{passed} passed")];
        if inconclusive > 0 {
            parts.push(format!("{inconclusive} inconclusive"));
        }
        if skipped > 0 {
            parts.push(format!("{skipped} skipped"));
        }
        ("passed", parts.join(" · "), Value::Null)
    } else {
        (
            "passed",
            format!(
                "All {total} configured check{} passed",
                if total == 1 { "" } else { "s" }
            ),
            Value::Null,
        )
    };

    let record = json!({
        "id": id,
        "repo": repo,
        "start": start,
        "head": head,
        "runId": req.run_id,
        "trigger": req.trigger,
        "prepare": req.prepare,
        "prepareResult": prepare_record,
        "acceptanceResult": acceptance_result,
        "inlineTestFiles": diff.inline_test_files,
        "state": final_state,
        "summary": summary,
        "reason": reason,
        "counts": {
            "total": total,
            "passed": passed,
            "skipped": skipped,
            "weak": weak,
            "inconclusive": inconclusive,
        },
        "configFile": config_file,
        "configCommit": config_commit,
        "configRef": req.config_ref,
        "configChanged": config_changed,
        "manifestsChanged": manifests_changed,
        "sandbox": sandbox_info(cache_dir_canon.is_some(), req.prepare),
        "limits": {
            "outputTailBytes": OUTPUT_TAIL_BYTES,
            "notes": notes,
        },
        "checks": check_records,
        "startedAt": started_at,
        "finishedAt": crate::workflow::now(),
    });
    save_record(&state, id, &record)?;
    Ok(record)
}

fn sandbox_info(has_cache: bool, prepared: bool) -> Value {
    json!({
        "engine": sandbox_engine_name(),
        "network": "denied",
        "prepareNetwork": if prepared { "allowed" } else { "not_run" },
        "readOnlyCache": has_cache,
        "cleanEnv": true,
        "noGitDir": true,
        "privateHome": true,
    })
}

fn blocked_record(
    id: &str,
    repo: &Path,
    start: &str,
    head: &str,
    req: &Request,
    started_at: u64,
    reason: String,
) -> Value {
    json!({
        "id": id,
        "repo": repo,
        "start": start,
        "head": head,
        "runId": req.run_id,
        "trigger": req.trigger,
        "prepare": req.prepare,
        "state": "blocked",
        "summary": "Blocked",
        "reason": reason,
        "configCommit": start,
        "configChanged": false,
        "manifestsChanged": false,
        "sandbox": sandbox_info(false, req.prepare),
        "limits": {"outputTailBytes": OUTPUT_TAIL_BYTES, "notes": []},
        "checks": [],
        "startedAt": started_at,
        "finishedAt": crate::workflow::now(),
    })
}

/// Runs standalone fail-to-pass verification for added/edited test files in `diff`.
#[allow(clippy::too_many_arguments)]
fn run_standalone_fail_to_pass(
    nt: &NewTestSpec,
    diff: &DiffSummary,
    repo: &Path,
    start: &str,
    work_dir: &Path,
    src_canon: &Path,
    home_canon: &Path,
    tmp_canon: &Path,
    cache_dir_canon: Option<&Path>,
    state: &Path,
    check_records: &mut Vec<Value>,
    any_failed: &mut bool,
    sandbox_failure: &mut Option<String>,
) {
    let support_files: Vec<&String> = diff
        .present_in_head
        .iter()
        .filter(|p| {
            nt.test_support_globs
                .iter()
                .any(|g| crate::rules::matches(g, p))
        })
        .collect();

    for (idx, rel) in diff.standalone_tests.iter().enumerate() {
        if !safe_overlay_path(rel) {
            continue;
        }
        let argv = expand_new_test_argv(&nt.command, rel);
        let overlay_dir = work_dir.join(format!("base-overlay-{idx}"));
        if std::fs::create_dir_all(&overlay_dir).is_err() {
            continue;
        }
        let Ok(overlay_canon) = overlay_dir.canonicalize() else {
            continue;
        };
        if archive_commit(repo, start, &overlay_canon).is_err() {
            check_records.push(json!({
                "id": format!("new-test-{idx}"),
                "name": format!("New test · {rel}"),
                "kind": "new_test",
                "file": rel,
                "command": argv,
                "expected": "fail_to_pass",
                "observed": "inconclusive",
                "matched": false,
                "overlay": true,
                "crapExcluded": true,
                "detail": "Could not archive start commit for base overlay",
                "durationMs": 0,
                "output": "",
                "artifacts": [],
            }));
            continue;
        }
        let copied = copy_overlay_file(src_canon, &overlay_canon, rel).unwrap_or(false);
        if !copied {
            continue;
        }
        for sup in &support_files {
            let _ = copy_overlay_file(src_canon, &overlay_canon, sup);
        }

        // 1. Run overlaid test against `start` (base overlay — excluded from CRAP coverage).
        let base_out = run_sandboxed(
            &argv,
            &overlay_canon,
            &overlay_canon,
            home_canon,
            tmp_canon,
            cache_dir_canon,
            repo,
            state,
            &BTreeMap::new(),
            nt.timeout_seconds,
            false,
        );
        if let Some(reason) = base_out.sandbox_blocked {
            *sandbox_failure = Some(reason);
            check_records.push(json!({
                "id": format!("new-test-{idx}"),
                "name": format!("New test · {rel}"),
                "kind": "new_test",
                "file": rel,
                "command": argv,
                "expected": "fail_to_pass",
                "observed": "blocked",
                "matched": false,
                "overlay": true,
                "crapExcluded": true,
                "durationMs": base_out.duration_ms,
                "output": base_out.output,
                "artifacts": [],
            }));
            return;
        }

        // 2. Run exact same argv against `head`.
        let head_out = run_sandboxed(
            &argv,
            src_canon,
            src_canon,
            home_canon,
            tmp_canon,
            cache_dir_canon,
            repo,
            state,
            &BTreeMap::new(),
            nt.timeout_seconds,
            false,
        );
        if let Some(reason) = head_out.sandbox_blocked {
            *sandbox_failure = Some(reason);
            check_records.push(json!({
                "id": format!("new-test-{idx}"),
                "name": format!("New test · {rel}"),
                "kind": "new_test",
                "file": rel,
                "command": argv,
                "expected": "fail_to_pass",
                "observed": "blocked",
                "matched": false,
                "overlay": true,
                "crapExcluded": true,
                "durationMs": base_out.duration_ms + head_out.duration_ms,
                "output": head_out.output,
                "artifacts": [],
            }));
            return;
        }

        let (observed, matched, detail) = if head_out.timed_out || head_out.exit_code != Some(0) {
            *any_failed = true;
            ("failed", false, "Failed on head commit")
        } else if base_out.timed_out {
            (
                "inconclusive",
                false,
                "Timed out on start overlay — not proof",
            )
        } else if base_out.exit_code == Some(0) {
            *any_failed = true;
            (
                "weak_test",
                false,
                "Passed on start commit — does not prove change",
            )
        } else if is_inconclusive_base_failure(&base_out.output) {
            (
                "inconclusive",
                false,
                "Compile/import/setup error on start overlay — not proof",
            )
        } else {
            (
                "fail_to_pass",
                true,
                "Assertion failed on start overlay → passed on head",
            )
        };

        check_records.push(json!({
            "id": format!("new-test-{idx}"),
            "name": format!("New test · {rel}"),
            "kind": "new_test",
            "file": rel,
            "command": argv,
            "expected": "fail_to_pass",
            "observed": observed,
            "matched": matched,
            "overlay": true,
            "crapExcluded": true,
            "detail": detail,
            "baseExitCode": base_out.exit_code,
            "headExitCode": head_out.exit_code,
            "durationMs": base_out.duration_ms + head_out.duration_ms,
            "output": if observed == "failed" { head_out.output } else { base_out.output },
            "artifacts": [],
        }));
    }
}

/// Runs the owner-authored shell-free acceptance check inside the sandbox (Phase 3).
#[allow(clippy::too_many_arguments)]
fn run_owner_acceptance(
    acc: &AcceptanceSpec,
    repo: &Path,
    start: &str,
    head: &str,
    work_dir: &Path,
    src_canon: &Path,
    home_canon: &Path,
    tmp_canon: &Path,
    cache_dir_canon: Option<&Path>,
    state: &Path,
    check_records: &mut Vec<Value>,
    any_failed: &mut bool,
    sandbox_failure: &mut Option<String>,
) -> Value {
    let mut base_failed_ok = true;
    let mut base_exit = Value::Null;
    if acc.expect_fail_on_start && start != head {
        let base_dir = work_dir.join("acceptance-start");
        if std::fs::create_dir_all(&base_dir).is_ok()
            && let Ok(base_canon) = base_dir.canonicalize()
            && archive_commit(repo, start, &base_canon).is_ok()
        {
            let bout = run_sandboxed(
                &acc.command,
                &base_canon,
                &base_canon,
                home_canon,
                tmp_canon,
                cache_dir_canon,
                repo,
                state,
                &BTreeMap::new(),
                acc.timeout_seconds,
                false,
            );
            if let Some(reason) = bout.sandbox_blocked {
                *sandbox_failure = Some(reason);
                return json!({"observed": "blocked", "commandHash": acc.command_hash});
            }
            base_exit = json!(bout.exit_code);
            if bout.exit_code == Some(0) {
                base_failed_ok = false;
            }
        }
    }

    let out = run_sandboxed(
        &acc.command,
        src_canon,
        src_canon,
        home_canon,
        tmp_canon,
        cache_dir_canon,
        repo,
        state,
        &BTreeMap::new(),
        acc.timeout_seconds,
        false,
    );
    if let Some(reason) = out.sandbox_blocked {
        *sandbox_failure = Some(reason);
        return json!({"observed": "blocked", "commandHash": acc.command_hash});
    }
    let (observed, matched, detail) = if out.timed_out {
        *any_failed = true;
        ("timed_out", false, "Owner acceptance check timed out")
    } else if out.exit_code != Some(0) {
        *any_failed = true;
        ("failed", false, "Owner acceptance check failed on head")
    } else if !base_failed_ok {
        *any_failed = true;
        (
            "weak_test",
            false,
            "Owner acceptance check already passed on start commit",
        )
    } else if acc.expect_fail_on_start && start != head {
        (
            "fail_to_pass",
            true,
            "Owner acceptance check failed on start → passed on head",
        )
    } else {
        ("passed", true, "Owner acceptance check passed on head")
    };
    let item = json!({
        "id": "owner-acceptance",
        "name": "Owner acceptance check",
        "kind": "acceptance",
        "command": acc.command,
        "commandHash": acc.command_hash,
        "expectFailOnStart": acc.expect_fail_on_start,
        "expected": if acc.expect_fail_on_start { "fail_to_pass" } else { "pass" },
        "observed": observed,
        "matched": matched,
        "detail": detail,
        "baseExitCode": base_exit,
        "exitCode": out.exit_code,
        "durationMs": out.duration_ms,
        "timedOut": out.timed_out,
        "output": out.output,
        "artifacts": [],
    });
    check_records.push(item.clone());
    item
}

/// Entry point for `peekumi verify --start <rev> --head <rev> [--prepare] [--json]`.
/// Exits 0 when all checks pass, 1 when a check fails, and 2 when blocked.
pub fn cli(args: Vec<String>) -> ! {
    let opts = VerifyCli::parse_from(args);
    let state_dir = if opts.state_dir.is_relative() {
        opts.directory.join(&opts.state_dir)
    } else {
        opts.state_dir.clone()
    };
    let req = Request {
        repo: opts.directory.clone(),
        state: state_dir,
        start: opts.start.clone(),
        head: opts.head.clone(),
        prepare: opts.prepare,
        trigger: "cli".into(),
        run_id: None,
        config_ref: opts.config_ref.clone(),
        acceptance: None,
    };
    let record = match run_sync(&req) {
        Ok(r) => r,
        Err(e) => {
            if opts.json {
                println!("{}", json!({"state": "blocked", "reason": e.to_string()}));
            } else {
                eprintln!("peekumi verify: blocked: {e}");
            }
            std::process::exit(2);
        }
    };
    if opts.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&record).unwrap_or_default()
        );
    } else {
        let state = record["state"].as_str().unwrap_or("blocked");
        let summary = record["summary"].as_str().unwrap_or("");
        println!(
            "peekumi verify: {state} ({summary}) [{}..{}]",
            &record["start"].as_str().unwrap_or("")
                [..7.min(record["start"].as_str().unwrap_or("").len())],
            &record["head"].as_str().unwrap_or("")
                [..7.min(record["head"].as_str().unwrap_or("").len())],
        );
        if let Some(reason) = record["reason"].as_str() {
            println!("Reason: {reason}");
        }
        if let Some(checks) = record["checks"].as_array() {
            for c in checks {
                println!(
                    "  - {} [{}] expected={} observed={} ({}ms)",
                    c["name"].as_str().unwrap_or(""),
                    c["id"].as_str().unwrap_or(""),
                    c["expected"].as_str().unwrap_or("pass"),
                    c["observed"].as_str().unwrap_or("unknown"),
                    c["durationMs"].as_u64().unwrap_or(0),
                );
                if c["matched"] != true
                    && let Some(out) = c["output"].as_str()
                    && !out.trim().is_empty()
                {
                    for line in out.lines().take(20) {
                        println!("      {line}");
                    }
                }
            }
        }
    }
    let code = match record["state"].as_str() {
        Some("passed") => 0,
        Some("failed") => 1,
        _ => 2,
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_checks_and_rejects_unsafe_fields_or_env() {
        let ok = parse_checks(&json!({
            "prepare": {
                "command": ["npm", "ci"],
                "timeoutSeconds": 60,
                "cacheKey": ["package-lock.json"],
                "cacheDirs": ["node_modules"]
            },
            "items": [
                {
                    "id": "unit",
                    "name": "Unit tests",
                    "command": ["pytest", "-q"],
                    "timeoutSeconds": 30,
                    "expect": "pass",
                    "coverage": "coverage/lcov.info",
                    "env": {"PYTEST_ADDOPTS": "-q"}
                }
            ]
        }))
        .unwrap();
        assert_eq!(ok.items.len(), 1);
        assert_eq!(ok.items[0].id, "unit");
        assert!(ok.prepare.is_some());

        // Rejects unknown top-level field
        assert!(
            parse_checks(&json!({"items": [{"id": "a", "command": ["true"]}], "extra": 1}))
                .is_err()
        );
        // Rejects secret-like env vars and PATH/HOME/DYLD overrides
        for bad in [
            "GITHUB_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
            "HOME",
            "PATH",
            "DYLD_INSERT_LIBRARIES",
        ] {
            assert!(
                parse_checks(&json!({
                    "items": [{"id": "a", "command": ["true"], "env": {bad: "x"}}]
                }))
                .is_err(),
                "{bad}"
            );
        }
        // Allows normal non-secret env vars whose names happen to contain PATH, KEY, PASS or AUTH
        for good in [
            "PYTHONPATH",
            "NODE_PATH",
            "GOPATH",
            "CACHE_KEY",
            "BYPASS_CACHE",
            "AUTHOR",
        ] {
            assert!(
                parse_checks(&json!({
                    "items": [{"id": "a", "command": ["true"], "env": {good: "x"}}]
                }))
                .is_ok(),
                "{good}"
            );
        }
        // Rejects path traversal in cwd / coverage / cacheDirs
        assert!(
            parse_checks(&json!({
                "items": [{"id": "a", "command": ["true"], "cwd": "../outside"}]
            }))
            .is_err()
        );
        assert!(
            parse_checks(&json!({
                "items": [{"id": "a", "command": ["true"], "coverage": "/etc/passwd"}]
            }))
            .is_err()
        );
    }

    #[test]
    fn tail_buffer_keeps_only_the_last_bytes() {
        let mut t = TailBuffer::new(5);
        t.push(b"abc");
        t.push(b"defgh");
        let (text, total, truncated) = t.into_string();
        assert_eq!(text, "defgh");
        assert_eq!(total, 8);
        assert!(truncated);
    }

    #[test]
    fn is_ancestor_fails_closed_on_git_error() {
        let err = is_ancestor(
            Path::new("/nonexistent/peekumi-repo-path"),
            "0000000000000000000000000000000000000000",
            "1111111111111111111111111111111111111111",
        );
        assert!(err.is_err());
    }

    #[test]
    fn phase2_and_phase3_parsers_and_argv_guards() {
        // Valid paths + newTests
        let cfg = parse_checks(&json!({
            "newTests": {
                "command": ["node", "--test", "{files}"],
                "testSupportGlobs": ["test/fixtures/**"]
            },
            "items": [
                {"id": "be", "command": ["cargo", "test"], "paths": ["backend/**"]}
            ]
        }))
        .unwrap();
        assert_eq!(cfg.items[0].paths, vec!["backend/**"]);
        assert!(cfg.new_tests.is_some());

        // Reject missing {files} or invalid paths glob; allow shell commands inside the sandbox
        assert!(
            parse_checks(&json!({
                "newTests": {"command": ["sh", "-c", "node --test \"$1\"", "--", "{files}"]},
                "items": [{"id": "a", "command": ["true"]}]
            }))
            .is_ok()
        );
        assert!(
            parse_checks(&json!({
                "newTests": {"command": ["pytest"]},
                "items": [{"id": "a", "command": ["true"]}]
            }))
            .is_err()
        );
        assert!(
            parse_checks(&json!({
                "items": [{"id": "a", "command": ["true"], "paths": ["../escape"]}]
            }))
            .is_err()
        );

        // Leading-dash filenames are prefixed with ./ in argv (never parsed as flags)
        let expanded = expand_new_test_argv(
            &["node".into(), "--test".into(), "{files}".into()],
            "-weird.test.mjs",
        );
        assert_eq!(expanded, vec!["node", "--test", "./-weird.test.mjs"]);

        // Compile/import failures vs genuine assertion failures
        assert!(is_inconclusive_base_failure(
            "ModuleNotFoundError: No module named 'foo'"
        ));
        assert!(is_inconclusive_base_failure(
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module"
        ));
        assert!(!is_inconclusive_base_failure(
            "AssertionError: expected 10 to equal 20"
        ));

        // Phase 3 owner acceptance check allows sandboxed commands and hashes deterministically
        assert!(crate::rules::parse_acceptance(&json!({"command": ["sh", "-c", "true"]})).is_ok());
        let a1 = crate::rules::parse_acceptance(&json!({
            "command": ["python3", "-c", "assert 1 == 1"],
            "expectFailOnStart": true
        }))
        .unwrap();
        let a2 = crate::rules::parse_acceptance(&json!({
            "command": ["python3", "-c", "assert 1 == 1"],
            "expectFailOnStart": false
        }))
        .unwrap();
        assert_ne!(a1.command_hash, a2.command_hash);
    }
}
