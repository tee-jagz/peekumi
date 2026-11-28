//! Salvage: work that an agent left uncommitted in its worktree.
//!
//! A task's results are its commits. An agent can finish, fail or be stopped with useful
//! changes that it never committed; a later round starts from the branch tip, so those
//! changes would be lost. Salvage shows them to the owner and, on an explicit owner action,
//! commits exactly the files that the owner saw on the task branch, in the agent's worktree.
//! It never touches the inspected checkout, never runs while the agent runs, and never marks
//! work as approved: the commit changes the head, so it clears an earlier approval, and the
//! commit goes through the normal review.
//!
//! Restricted files (names that often hold secrets, see `engine::restricted`) are listed
//! with a label but are never read and never committed.

use crate::workflow::{Workflow, active, now};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::path::PathBuf;

/// More loose files than this are refused: they are usually generated folders.
const LIMIT: usize = 500;

impl Workflow {
    /// The worktree of run `id` when salvage is possible: the run has ended, no later round
    /// continues it and it is not merged.
    fn salvage_worktree(&self, run: &Value) -> Result<PathBuf> {
        ensure!(!active(run), "Wait for the agent to stop");
        ensure!(
            run["revisedBy"].is_null(),
            "A later round continues this task"
        );
        ensure!(run["merge"].is_null(), "This task is merged");
        let dir = PathBuf::from(
            run["worktree"]
                .as_str()
                .context("This run has no worktree")?,
        );
        ensure!(dir.is_dir(), "The agent's worktree no longer exists");
        Ok(dir)
    }

    /// The number of files that run `run` left uncommitted. An error says why Peekumi cannot
    /// count them (salvage is not possible, or Git cannot read the worktree); the merge status
    /// shows that reason, never a count of 0 (see `review::loose_state`).
    pub(crate) fn loose_count(&self, run: &Value) -> Result<usize> {
        self.salvage_worktree(run)
            .and_then(|dir| self.loose_entries(&dir))
            .map(|entries| entries.len())
    }

    /// The loose entries of a worktree: (path, state) with state `staged`, `changed`,
    /// `deleted` or `new`, from `git status`. Ignored files are not included.
    fn loose_entries(&self, dir: &std::path::Path) -> Result<Vec<(String, &'static str)>> {
        let dir = dir.to_str().context("Worktree path is not UTF-8")?;
        let out = self.git_exact(&[
            "-C",
            dir,
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
        ])?;
        let mut entries = vec![];
        for entry in out.split('\0').filter(|e| e.len() > 3) {
            let (code, path) = entry.split_at(3);
            let code = code.as_bytes();
            let state = if code[0] == b'?' {
                "new"
            } else if code[0] == b'D' || code[1] == b'D' {
                "deleted"
            } else if code[0] != b' ' {
                "staged"
            } else {
                "changed"
            };
            entries.push((path.to_string(), state));
        }
        Ok(entries)
    }

    /// `GET /api/runs/<id>/loose`: the files that the agent left uncommitted, with line
    /// counts, the worktree's commit and a hash of the exact changes, so a salvage commits
    /// only what the owner saw.
    pub(crate) fn loose(&self, id: &str) -> Result<Value> {
        Ok(self.loose_with_text(id)?.0)
    }

    fn loose_with_text(&self, id: &str) -> Result<(Value, Vec<String>)> {
        let run = self.run(id)?;
        let dir = self.salvage_worktree(&run)?;
        let entries = self.loose_entries(&dir)?;
        if entries.len() > LIMIT {
            bail!(
                "The agent left {} loose files, more than {LIMIT}. Commit them from a terminal in {}",
                entries.len(),
                dir.display()
            );
        }
        let wt = dir.to_str().context("Worktree path is not UTF-8")?;
        let head = self.git(&["-C", wt, "rev-parse", "HEAD"])?;
        let mut files = vec![];
        let mut keep = vec![];
        let mut text = format!("{head}\n");
        for (path, state) in entries {
            if crate::engine::restricted(&path) {
                // Never read: the hash uses only the size and the time of the last change.
                let meta = std::fs::metadata(dir.join(&path)).ok();
                let mark = meta
                    .map(|m| (m.len(), m.modified().ok()))
                    .unwrap_or_default();
                text.push_str(&format!("restricted {path} {mark:?}\n"));
                files.push(json!({"path": path, "state": state, "restricted": true}));
                continue;
            }
            let (added, removed) = if state == "new" {
                let content = std::fs::read(dir.join(&path)).unwrap_or_default();
                let content = String::from_utf8_lossy(&content);
                text.push_str(&format!("new {path}\n{content}\n"));
                (Some(content.lines().count() as u64), Some(0))
            } else {
                text.push_str(&self.git(&[
                    "-C",
                    wt,
                    "diff",
                    "--no-ext-diff",
                    "--no-renames",
                    "HEAD",
                    "--",
                    &path,
                ])?);
                text.push('\n');
                let numstat = self.git(&[
                    "-C",
                    wt,
                    "diff",
                    "--no-renames",
                    "--numstat",
                    "HEAD",
                    "--",
                    &path,
                ])?;
                let mut parts = numstat.split('\t');
                (
                    parts.next().and_then(|n| n.parse().ok()),
                    parts.next().and_then(|n| n.parse().ok()),
                )
            };
            files.push(json!({"path": path, "state": state, "added": added, "removed": removed}));
            keep.push(path);
        }
        let hash = crate::hash::hash(text.as_bytes());
        Ok((
            json!({"files": files, "head": head, "hash": hash, "branch": run["branch"]}),
            keep,
        ))
    }

    /// `POST /api/runs/<id>/salvage` with `{message, head, hash}`: commits exactly the loose
    /// files that the owner saw (not restricted ones) on the task branch, in the agent's
    /// worktree, after it checks that nothing changed. The run's results then include the
    /// commit, its approval is cleared, and the commit goes through the normal review.
    pub(crate) fn salvage(&self, id: &str, body: &Value) -> Result<Value> {
        let message = crate::workflow::text(body, "message", 5000)?
            .trim()
            .to_string();
        let (current, paths) = self.loose_with_text(id)?;
        ensure!(
            body["head"] == current["head"] && body["hash"] == current["hash"],
            "The agent's files changed; check them again"
        );
        ensure!(!paths.is_empty(), "No loose files can be kept");
        let run = self.run(id)?;
        let dir = self.salvage_worktree(&run)?;
        let wt = dir.to_str().context("Worktree path is not UTF-8")?;
        let message = format!("{message}\n\nPeekumi-Run: {id}");
        let mut add = vec!["-C", wt, "add", "-A", "--"];
        add.extend(paths.iter().map(String::as_str));
        self.git(&add)?;
        let mut commit = vec![
            "-C",
            wt,
            "commit",
            "--only",
            "--no-verify",
            "-m",
            &message,
            "--",
        ];
        commit.extend(paths.iter().map(String::as_str));
        self.git(&commit)?;
        let sha = self.git(&["-C", wt, "rev-parse", "HEAD"])?;
        let base = run["base"].as_str().context("Missing base")?;
        let results: Vec<String> = self
            .git(&["-C", wt, "rev-list", "--reverse", &format!("{base}..HEAD")])?
            .lines()
            .map(str::to_string)
            .collect();
        self.update(|v| {
            let r = v["runs"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|r| r["id"] == id)
                .context("Not found")?;
            r["results"] = json!(results);
            if !r["salvaged"].is_array() {
                r["salvaged"] = json!([]);
            }
            r["salvaged"]
                .as_array_mut()
                .unwrap()
                .push(json!({"commit": sha, "files": paths, "at": now()}));
            // The head moved: an approval of the earlier head does not cover this commit.
            crate::review::clear_approval(v, id, "salvage")
        })?;
        Ok(json!({"commit": sha, "status": self.merge_status(id)?}))
    }
}
