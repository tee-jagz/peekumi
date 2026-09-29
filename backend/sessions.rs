//! Persistent browser sessions, bound to this repository and its current access token.
//! Only session hashes are stored; rotating the access token invalidates remembered browsers.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

/// Thirty days of access after explicitly opening the private pairing link.
pub const MAX_AGE: u64 = 30 * 86400;

#[derive(Serialize, Deserialize)]
struct Saved {
    binding: String,
    sessions: HashMap<String, u64>,
}

/// In-memory session index with an atomic, owner-readable persistence file.
pub struct Sessions {
    path: PathBuf,
    saved: Saved,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl Sessions {
    /// Restores sessions for the same repository and token; rejects unreadable or malformed state.
    pub fn load(path: PathBuf, token: &str, repository: &str) -> Result<Self> {
        let binding = crate::engine::hash(format!("{repository}\0{token}").as_bytes());
        let mut saved = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Saved>(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Saved {
                binding: binding.clone(),
                sessions: HashMap::new(),
            },
            Err(e) => return Err(e.into()),
        };
        if saved.binding != binding {
            saved.sessions.clear();
            saved.binding = binding;
        }
        saved.sessions.retain(|_, expires| *expires > now());
        Ok(Self { path, saved })
    }

    /// Checks a browser cookie without retaining or logging its plaintext credential.
    pub fn contains(&self, session: &str) -> bool {
        !session.is_empty()
            && self
                .saved
                .sessions
                .get(&crate::engine::hash(session.as_bytes()))
                .is_some_and(|expires| *expires > now())
    }

    /// Persists a new session before accepting it; errors leave the current index unchanged.
    pub fn insert(&mut self, session: &str) -> Result<()> {
        let mut sessions = self.saved.sessions.clone();
        sessions.retain(|_, expires| *expires > now());
        if sessions.len() >= 128 {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, expires)| **expires)
                .map(|(key, _)| key.clone())
            {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(crate::engine::hash(session.as_bytes()), now() + MAX_AGE);
        let saved = Saved {
            binding: self.saved.binding.clone(),
            sessions,
        };
        let temporary = self.path.with_extension("json.next");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(&saved)?)?;
        file.sync_all()?;
        std::fs::rename(temporary, &self.path)?;
        self.saved = saved;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn survives_restart_and_rejects_expired_or_rotated_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.json");
        let mut sessions = Sessions::load(path.clone(), "owner", "repo").unwrap();
        sessions.insert("browser-secret").unwrap();
        assert!(
            !std::fs::read_to_string(&path)
                .unwrap()
                .contains("browser-secret")
        );
        let mut restored = Sessions::load(path.clone(), "owner", "repo").unwrap();
        assert!(restored.contains("browser-secret"));
        assert!(!restored.contains("wrong"));
        assert!(
            !Sessions::load(path.clone(), "new-owner", "repo")
                .unwrap()
                .contains("browser-secret")
        );
        assert!(
            !Sessions::load(path, "owner", "other-repo")
                .unwrap()
                .contains("browser-secret")
        );
        restored
            .saved
            .sessions
            .insert(crate::engine::hash(b"browser-secret"), now() - 1);
        assert!(!restored.contains("browser-secret"));
    }
}
