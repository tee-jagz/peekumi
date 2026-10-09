//! The `RunStore` implementation for `Workflow` (see the run_store module).
use crate::{
    agents,
    run_store::RunStore,
    workflow::{Workflow, active, find_mut, now},
};
use anyhow::Result;
use serde_json::Value;
use std::path::Path;

/// The runner's and the task agent's view of this store (see the run_store module). Each
/// method calls the `Workflow` method or function with the same name.
impl RunStore for Workflow {
    fn repo(&self) -> &Path {
        &self.repo
    }
    fn state(&self) -> &Path {
        &self.state
    }
    fn grants(&self) -> &crate::lookup::Grants {
        &self.grants
    }
    fn agents(&self) -> agents::Settings<'_> {
        self.agent_settings()
    }
    fn read(&self) -> Result<Value> {
        Workflow::read(self)
    }
    fn update<T>(&self, f: impl FnOnce(&mut Value) -> Result<T>) -> Result<T> {
        Workflow::update(self, f)
    }
    fn git(&self, args: &[&str]) -> Result<String> {
        Workflow::git(self, args)
    }
    fn run(&self, id: &str) -> Result<Value> {
        Workflow::run(self, id)
    }
    fn patch_run(&self, id: &str, patch: Value) -> Result<Value> {
        Workflow::patch_run(self, id, patch)
    }
    fn finish(&self, id: &str, status: &str, message: &str, results: Value) -> Result<Value> {
        Workflow::finish(self, id, status, message, results)
    }
    fn report(&self, id: &str, token: &str, tool: &str, args: &Value) -> Result<Value> {
        Workflow::report(self, id, token, tool, args)
    }
    fn request_approval(&self, id: &str, token: &str, args: &Value) -> Result<Value> {
        Workflow::request_approval(self, id, token, args)
    }
    fn take_turn(&self, id: &str, token_hash: &str) -> Result<Option<(u64, Vec<Value>, Value)>> {
        Workflow::take_turn(self, id, token_hash)
    }
    fn close_turn(
        &self,
        id: &str,
        results: Value,
        summary: Option<String>,
        conversation: Option<String>,
        note: Option<String>,
    ) -> Result<bool> {
        Workflow::close_turn(self, id, results, summary, conversation, note)
    }
    fn wake_sessions(&self) {
        Workflow::wake_sessions(self)
    }
    fn now() -> u64 {
        now()
    }
    fn active(r: &Value) -> bool {
        active(r)
    }
    fn find_mut<'a>(v: &'a mut Value, key: &str, id: &str) -> Result<&'a mut Value> {
        find_mut(v, key, id)
    }
}
