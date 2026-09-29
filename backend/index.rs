//! Persistent, size-bounded syntax cache keyed by blob and parser identity.
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
};
pub struct Index {
    db: Option<Connection>,
    memory: HashMap<String, Value>,
    order: VecDeque<String>,
    pending: Vec<(String, String)>,
}
impl Index {
    pub fn new(directory: &Path, namespace: &str) -> Self {
        let result = (|| -> Result<Connection> {
            std::fs::create_dir_all(directory)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
            }
            let path = directory.join(format!("{namespace}.sqlite"));
            let db = Connection::open(&path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            }
            db.busy_timeout(std::time::Duration::from_secs(5))?;
            db.execute_batch(
                "CREATE TABLE IF NOT EXISTS analysis(key TEXT PRIMARY KEY,data TEXT NOT NULL)",
            )?;
            Ok(db)
        })();
        let db = match result {
            Ok(db) => Some(db),
            Err(error) => {
                eprintln!("Strata index unavailable; using memory: {error}");
                None
            }
        };
        Self {
            db,
            memory: HashMap::new(),
            order: VecDeque::new(),
            pending: vec![],
        }
    }
    pub fn get(&self, key: &str) -> Option<Value> {
        if let Some(value) = self.memory.get(key) {
            return Some(value.clone());
        }
        let data: Option<String> = self
            .db
            .as_ref()?
            .query_row("SELECT data FROM analysis WHERE key=?", [key], |row| {
                row.get(0)
            })
            .optional()
            .ok()?;
        serde_json::from_str(&data?).ok()
    }
    pub fn set(&mut self, key: String, value: Value) {
        if !self.memory.contains_key(&key) {
            self.order.push_back(key.clone());
        }
        if self.db.is_some() {
            self.pending.push((key.clone(), value.to_string()));
        }
        self.memory.insert(key, value);
        while self.order.len() > 4000 {
            if let Some(key) = self.order.pop_front() {
                self.memory.remove(&key);
            }
        }
    }
    pub fn flush(&mut self) {
        let result = (|| -> Result<()> {
            let Some(db) = self.db.as_mut() else {
                return Ok(());
            };
            if self.pending.is_empty() {
                return Ok(());
            }
            let tx = db.transaction()?;
            {
                let mut insert =
                    tx.prepare("INSERT OR REPLACE INTO analysis(key,data) VALUES (?,?)")?;
                for (key, data) in &self.pending {
                    insert.execute((key, data))?;
                }
            }
            let mut bytes: i64 = tx.query_row(
                "SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM analysis",
                [],
                |r| r.get(0),
            )?;
            if bytes > 128 * 1024 * 1024 {
                let rows = tx
                    .prepare("SELECT key,length(CAST(data AS BLOB)) FROM analysis ORDER BY rowid")?
                    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for (key, size) in rows {
                    tx.execute("DELETE FROM analysis WHERE key=?", [key])?;
                    bytes -= size;
                    if bytes <= 128 * 1024 * 1024 {
                        break;
                    }
                }
            }
            tx.commit()?;
            Ok(())
        })();
        self.pending.clear();
        if let Err(error) = result {
            eprintln!("Strata index write failed; using memory: {error}");
            self.db = None;
        }
    }
}
