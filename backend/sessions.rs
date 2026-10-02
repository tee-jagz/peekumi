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
    #[serde(default)]
    roles: HashMap<String, String>,
    #[serde(default)]
    names: HashMap<String, String>,
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
                roles: HashMap::new(),
                names: HashMap::new(),
            },
            Err(e) => return Err(e.into()),
        };
        if saved.binding != binding {
            saved.sessions.clear();
            saved.roles.clear();
            saved.names.clear();
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
    #[cfg(test)]
    pub fn insert(&mut self, session: &str) -> Result<()> {
        self.insert_device(session, "owner", "Browser")
    }

    /// Persists device identity and access role alongside the hash; legacy sessions stay owner sessions.
    pub fn insert_device(&mut self, session: &str, role: &str, name: &str) -> Result<()> {
        let mut sessions = self.saved.sessions.clone();
        sessions.retain(|_, expires| *expires > now());
        if sessions.len() >= 128
            && let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, expires)| **expires)
                .map(|(key, _)| key.clone())
        {
            sessions.remove(&oldest);
        }
        sessions.insert(crate::engine::hash(session.as_bytes()), now() + MAX_AGE);
        let mut roles = self.saved.roles.clone();
        let mut names = self.saved.names.clone();
        roles.retain(|id, _| sessions.contains_key(id));
        names.retain(|id, _| sessions.contains_key(id));
        let id = crate::engine::hash(session.as_bytes());
        roles.insert(id.clone(), role.into());
        names.insert(id, name.chars().take(100).collect());
        let saved = Saved {
            binding: self.saved.binding.clone(),
            sessions,
            roles,
            names,
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
    /// Resolves only live credentials; raw session secrets are never returned.
    pub fn role(&self, session: &str) -> Option<&str> {
        self.contains(session).then(|| {
            self.saved
                .roles
                .get(&crate::engine::hash(session.as_bytes()))
                .map(String::as_str)
                .unwrap_or("owner")
        })
    }
    pub fn devices(&self) -> serde_json::Value {
        serde_json::json!(self.saved.sessions.iter().filter(|(_, expires)| **expires > now()).map(|(id, expires)| serde_json::json!({
            "id":id, "expires":expires, "role":self.saved.roles.get(id).map(String::as_str).unwrap_or("owner"), "name":self.saved.names.get(id).map(String::as_str).unwrap_or("Browser")
        })).collect::<Vec<_>>())
    }
    /// Revokes a saved device atomically, without rotating other device sessions.
    pub fn revoke(&mut self, id: &str) -> Result<()> {
        let mut next = serde_json::to_value(&self.saved)?;
        for field in ["sessions", "roles", "names"] {
            next[field].as_object_mut().unwrap().remove(id);
        }
        let temporary = self.path.with_extension("json.next");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(&next)?)?;
        file.sync_all()?;
        std::fs::rename(temporary, &self.path)?;
        self.saved = serde_json::from_value(next)?;
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
