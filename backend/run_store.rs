//! The run store as the runner and the task agent see it: the part of the workflow store
//! that starts, supervises and closes agent runs.
//!
//! The runner and the task agent are below the workflow core, so they use this trait and not
//! the `Workflow` type. The run_store_impl module implements it for `Workflow`; each method calls the
//! `Workflow` method or function with the same name.
use anyhow::Result;
use serde_json::Value;
use std::path::Path;

/// What the runner and the task agent read and change in the workflow store.
pub trait RunStore {
    /// The inspected repository.
    fn repo(&self) -> &Path;
    /// The private state folder of this repository.
    fn state(&self) -> &Path;
    /// The code graph lookup grants of running tasks, by key.
    fn grants(&self) -> &crate::lookup::Grants;
    /// What the agent providers read from the server's settings (see `agents::registry`).
    fn agents(&self) -> crate::agents::Settings<'_>;
    /// Reads the current workflow state.
    fn read(&self) -> Result<Value>;
    /// Applies a complete state transition atomically.
    fn update<T>(&self, f: impl FnOnce(&mut Value) -> Result<T>) -> Result<T>;
    /// Runs Git in the repository with hooks disabled. The output is trimmed.
    fn git(&self, args: &[&str]) -> Result<String>;
    /// Reads one run, with its credential hash.
    fn run(&self, id: &str) -> Result<Value>;
    /// Saves runner progress in a run.
    fn patch_run(&self, id: &str, patch: Value) -> Result<Value>;
    /// Ends a run and marks every unanswered comment Unreported.
    fn finish(&self, id: &str, status: &str, message: &str, results: Value) -> Result<Value>;
    /// Accepts a report from the active run with the reporting credential `token`.
    fn report(&self, id: &str, token: &str, tool: &str, args: &Value) -> Result<Value>;
    /// Asks the owner whether a session's agent may run a tool, and waits for the answer.
    fn request_approval(&self, id: &str, token: &str, args: &Value) -> Result<Value>;
    /// Takes a session's waiting messages: the turn number, the messages and the run.
    fn take_turn(&self, id: &str, token_hash: &str) -> Result<Option<(u64, Vec<Value>, Value)>>;
    /// Closes a session turn. Returns true when more messages wait.
    fn close_turn(
        &self,
        id: &str,
        results: Value,
        summary: Option<String>,
        conversation: Option<String>,
        note: Option<String>,
    ) -> Result<bool>;
    /// Starts the turn of a session that waited for the repository, when no agent holds it.
    fn wake_sessions(&self);
    /// Milliseconds since the Unix epoch.
    fn now() -> u64;
    /// True when a run holds the repository slot.
    fn active(r: &Value) -> bool;
    /// The entry with `id` in the list `key` of the state `v`.
    fn find_mut<'a>(v: &'a mut Value, key: &str, id: &str) -> Result<&'a mut Value>;
}
