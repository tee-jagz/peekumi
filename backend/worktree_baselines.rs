//! Durable integration baselines and the lifetime of their private snapshot objects.
//!
//! Calls run on the repository worker. Only Peekumi state changes. The first capture
//! for a profile, session, turn and repository wins, including across service restarts.
use super::{git, snapshot, text};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path, time::SystemTime};

const IDLE_SECONDS: u64 = 24 * 60 * 60;

/// The integration identity. The repository is its registered canonical-path hash.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub profile: String,
    pub session: String,
    pub turn: String,
    pub repository: String,
}

/// The immutable start revision, frozen rule revision and pre-existing changed paths.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Baseline {
    pub id: String,
    pub binding: Binding,
    pub sha: String,
    pub rules_sha: String,
    pub already_changed: Vec<String>,
    #[serde(default)]
    pub snapshots: std::collections::BTreeSet<String>,
    #[serde(default)]
    pub exceptions: BTreeMap<String, String>,
    last_used: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn load(state: &Path, time: u64) -> Result<BTreeMap<String, Baseline>> {
    let mut entries: BTreeMap<String, Baseline> =
        match std::fs::read(state.join("integration-baselines.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e.into()),
        };
    entries.retain(|_, entry| time.saturating_sub(entry.last_used) < IDLE_SECONDS);
    Ok(entries)
}

fn save(state: &Path, entries: &BTreeMap<String, Baseline>) -> Result<()> {
    std::fs::create_dir_all(state)?;
    let pending = state.join("integration-baselines.pending");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(&pending)?;
    file.write_all(&serde_json::to_vec(entries)?)?;
    file.sync_all()?;
    std::fs::rename(pending, state.join("integration-baselines.json"))?;
    Ok(())
}

pub(super) fn has_active(state: &Path) -> Result<bool> {
    Ok(!load(state, now())?.is_empty())
}

/// Captures through the existing snapshot path, or renews the original baseline on retry.
/// A clean checkout uses HEAD. Unborn repositories and invalid bindings return errors.
/// The rule revision is the same immutable snapshot, including dirty rule files.
pub fn capture_baseline(repo: &Path, state: &Path, binding: Binding) -> Result<Baseline> {
    ensure!(
        [
            &binding.profile,
            &binding.session,
            &binding.turn,
            &binding.repository
        ]
        .iter()
        .all(|v| !v.is_empty() && v.len() <= 256 && !v.contains('\0')),
        "Baseline identity fields must contain 1 to 256 bytes"
    );
    let directory = repo.canonicalize()?;
    let repository = crate::hash::hash(directory.to_string_lossy().as_bytes());
    ensure!(
        binding.repository == repository[..16],
        "Baseline repository does not match registration"
    );
    let id = crate::hash::hash(serde_json::to_vec(&binding)?);
    let time = now();
    let mut entries = load(state, time)?;
    let entry = if let Some(entry) = entries.get_mut(&id) {
        entry.last_used = time;
        entry.clone()
    } else {
        let (sha, already_changed) = match snapshot(repo, state)? {
            Some(snapshot) => snapshot,
            None => (
                text(git(
                    repo,
                    &[],
                    &["rev-parse", "--verify", "HEAD^{commit}"],
                    vec![],
                )?),
                vec![],
            ),
        };
        Baseline {
            id: id.clone(),
            binding,
            rules_sha: sha.clone(),
            sha: sha.clone(),
            already_changed,
            snapshots: [sha.clone()].into_iter().collect(),
            exceptions: BTreeMap::new(),
            last_used: time,
        }
    };
    entries.insert(id, entry.clone());
    save(state, &entries)?;
    Ok(entry)
}

/// Renews a baseline pin by ID. Expired or unknown baselines cannot be reused.
pub fn get_baseline(state: &Path, id: &str) -> Result<Baseline> {
    let mut entries = load(state, now())?;
    let entry = entries
        .get_mut(id)
        .ok_or_else(|| anyhow::anyhow!("Baseline is absent or expired"))?;
    entry.last_used = now();
    let entry = entry.clone();
    save(state, &entries)?;
    Ok(entry)
}

/// Keeps a measured source revision or a reasoned exception attached to its original baseline.
pub fn update_baseline(
    state: &Path,
    id: &str,
    snapshot: Option<&str>,
    exception: Option<(&str, &str)>,
) -> Result<()> {
    let mut entries = load(state, now())?;
    let entry = entries
        .get_mut(id)
        .ok_or_else(|| anyhow::anyhow!("Baseline is absent or expired"))?;
    entry.last_used = now();
    if let Some(snapshot) = snapshot {
        entry.snapshots.insert(snapshot.into());
    }
    if let Some((finding, reason)) = exception {
        ensure!(
            !reason.trim().is_empty() && reason.len() <= 1000,
            "An exception needs a reason of 1 to 1000 bytes"
        );
        entry.exceptions.insert(finding.into(), reason.into());
    }
    save(state, &entries)
}

/// Releases all baseline pins for one profile and session. Other sessions stay pinned.
/// Returns persistence errors. Snapshot objects are reclaimed by the next size check.
pub fn release_session(state: &Path, profile: &str, session: &str) -> Result<()> {
    let mut entries = load(state, now())?;
    entries.retain(|_, entry| entry.binding.profile != profile || entry.binding.session != session);
    save(state, &entries)
}

#[cfg(test)]
#[path = "worktree_baselines_tests.rs"]
mod tests;
