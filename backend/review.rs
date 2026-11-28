//! The owner's approval of one exact pair of commits, and the blind spots of a review.
//!
//! An approval is one record on a run (`approvalRecord`): the start commit and the head
//! commit that the owner saw, when and by whom, each instruction with the commit that its
//! report names, and a snapshot of the evidence at that moment (the rule check, the files
//! that the agent left uncommitted, CI, and the changed files that can hide a problem). The
//! owner makes it with one request, `POST /api/runs/<id>/approve`, and it is valid only while
//! the run's start and head are still the commits it names. A merge requires a valid record
//! (see the merge module). A change to the head or the start clears it: the events that do so
//! are in [`crate::lifecycle::APPROVAL_CLEARS`].
//!
//! The blind spots that this module finds are facts, not verdicts: the changed files in tests,
//! in CI configuration and in the Peekumi rules ([`tamper`]). A change there can make a check
//! pass without the code being right, so the owner sees them before they approve.
use crate::workflow::{Workflow, active, event, find, find_mut, now, text};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};

/// What CI says about a local task branch: nothing, because CI never ran on it.
const LOCAL_CI: &str = "No CI results for this local branch";

/// The kind of a changed file that can change what a check proves, or `None`:
/// `tests` (test code), `ci` (CI configuration) or `rules` (the Peekumi rule configuration).
pub fn sensitive_kind(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let folders: Vec<&str> = path.split('/').collect();
    let folders = &folders[..folders.len().saturating_sub(1)];
    if crate::rules::CONFIG_FILES.contains(&path) {
        return Some("rules");
    }
    if path.starts_with(".github/workflows/")
        || path.starts_with(".circleci/")
        || path.starts_with(".buildkite/")
        || [".gitlab-ci.yml", "azure-pipelines.yml"].contains(&path)
        || name == "Jenkinsfile"
    {
        return Some("ci");
    }
    let stem_and_ext = name.split_once('.');
    let test_folder = folders
        .iter()
        .any(|f| ["test", "tests", "__tests__", "spec"].contains(f));
    let test_name = stem_and_ext.is_some_and(|(stem, rest)| {
        stem.ends_with("_test")
            || name.contains(".test.")
            || name.contains(".spec.")
            || (stem.starts_with("test_") && rest == "py")
    });
    (test_folder || test_name).then_some("tests")
}

impl Workflow {
    /// The changed files from `start` to `head` that can change what a check proves, as
    /// `{state: "listed", tests, ci, config}` with `{path, status}` for each file (`status` is
    /// Git's letter: A, M, D or T). When Git cannot compare the commits, `{state:
    /// "unavailable", reason}`: never an empty list that looks clean.
    pub fn tamper(&self, start: &str, head: &str) -> Value {
        let listed = self.git(&[
            "diff",
            "--no-renames",
            "--name-status",
            "-z",
            "--end-of-options",
            start,
            head,
        ]);
        let out = match listed {
            Ok(out) => out,
            Err(e) => return json!({"state": "unavailable", "reason": e.to_string()}),
        };
        let mut found = json!({"state": "listed", "tests": [], "ci": [], "config": []});
        let parts: Vec<&str> = out.split('\0').filter(|p| !p.is_empty()).collect();
        for pair in parts.chunks(2) {
            let [status, path] = pair else { continue };
            let key = match sensitive_kind(path) {
                Some("tests") => "tests",
                Some("ci") => "ci",
                Some(_) => "config",
                None => continue,
            };
            found[key]
                .as_array_mut()
                .unwrap()
                .push(json!({"path": path, "status": status.trim()}));
        }
        found
    }

    /// The files that `run` left uncommitted, as `{state: "counted", count}`, or `{state:
    /// "unavailable", reason}` when Peekumi cannot read its worktree (it was removed, the agent
    /// still runs, a later round continues the task, or the task is merged).
    pub fn loose_state(&self, run: &Value) -> Value {
        match self.loose_count(run) {
            Ok(count) => json!({"state": "counted", "count": count}),
            Err(e) => json!({"state": "unavailable", "reason": e.to_string()}),
        }
    }

    /// True when `run` has an approval record for exactly `start`, `head`, and the run's current
    /// owner acceptance check hash (when one is configured).
    pub fn approval_matches(run: &Value, start: &str, head: &str) -> bool {
        let record = &run["approvalRecord"];
        let expected_hash = run["acceptanceCheck"]["commandHash"].as_str();
        let recorded_hash = record["acceptanceHash"].as_str();
        record["start"] == start && record["head"] == head && expected_hash == recorded_hash
    }

    /// `POST /api/runs/<id>/acceptance`: sets or clears an owner-authored shell-free acceptance
    /// check on run `id`. Changing the command clears any existing approval record.
    pub(crate) fn set_acceptance(&self, id: &str, body: &Value) -> Result<Value> {
        let run = self.run(id)?;
        ensure!(
            run["revisedBy"].is_null() && run["merge"].is_null(),
            "Acceptance checks can be edited only on an active or unmerged round"
        );
        let next =
            if body["command"].is_null() || body["command"].as_array().is_some_and(Vec::is_empty) {
                Value::Null
            } else {
                let parsed = crate::rules::parse_acceptance(body)?;
                json!({
                    "command": parsed.command,
                    "expectFailOnStart": parsed.expect_fail_on_start,
                    "timeoutSeconds": parsed.timeout_seconds,
                    "commandHash": parsed.command_hash,
                    "updatedAt": now(),
                    "actor": "owner",
                })
            };
        self.update(|v| {
            let changed =
                find(v, "runs", id)?["acceptanceCheck"]["commandHash"] != next["commandHash"];
            find_mut(v, "runs", id)?["acceptanceCheck"] = next.clone();
            if changed {
                clear_approval(v, id, "acceptance_changed")?;
            }
            Ok(())
        })?;
        Ok(json!({
            "acceptanceCheck": next,
            "status": self.merge_status(id).ok(),
        }))
    }

    /// The rule check of `start..head` for an approval snapshot: its state, reason, summary,
    /// the count of breaks it adds and the counts of what limits it. A check that cannot run is
    /// `not checked` with the reason.
    fn rule_snapshot(&self, start: &str, head: &str) -> Value {
        let checked = match self.rule_checker.get() {
            Some(check) => check(start, head),
            None => Err(anyhow::anyhow!(
                "Rule checks are not available on this server"
            )),
        };
        match checked {
            Ok(c) => {
                let count = |v: &Value| v.as_array().map_or(0, Vec::len);
                json!({
                    "state": c["state"],
                    "reason": c["reason"],
                    "summary": c["summary"],
                    "addedCount": c["addedCount"],
                    "ruleChange": !c["ruleChange"].is_null(),
                    "unresolved": c["limits"]["unresolved"],
                    "unanalysed": count(&c["limits"]["unanalysed"]),
                    "warnings": count(&c["limits"]["warnings"]),
                })
            }
            Err(e) => json!({"state": "not checked", "reason": e.to_string()}),
        }
    }

    /// `POST /api/runs/<id>/approve` with `{start, head, note?}`: the owner approves the
    /// finished work of run `id` at exactly these commits, in one transaction. It refuses when
    /// `start` or `head` is not the run's current pair, when the run is not a finished, latest,
    /// unmerged round, or when an instruction's reported commit is not in `head`. Every
    /// addressed instruction becomes verified, and the run gets one `approvalRecord`. Returns
    /// `{approval, status}` with the new merge status.
    pub(crate) fn approve(&self, id: &str, body: &Value) -> Result<Value> {
        let start = text(body, "start", 64)?.to_string();
        let head = text(body, "head", 64)?.to_string();
        let note = match body["note"].as_str().map(str::trim) {
            None | Some("") => Value::Null,
            Some(_) => json!(text(body, "note", 12000)?),
        };
        let run = self.run(id)?;
        ensure!(!active(&run), "Wait for the run to finish");
        ensure!(
            run["status"] == "completed",
            "Only a finished task can be approved"
        );
        ensure!(
            run["revisedBy"].is_null(),
            "A later round continues this task"
        );
        ensure!(
            run["merge"].is_null() && !self.applied(&run),
            "This task is applied to main; start a new task for further changes"
        );
        let branch = run["branch"].as_str().context("Missing branch")?;
        let current_start = self.start_of(&run)?;
        let current_head = self.resolve(&format!("refs/heads/{branch}"))?;
        ensure!(
            start == current_start && head == current_head,
            "The task changed after you checked it: it is now {}..{}. Check it again, then approve",
            &current_start[..7.min(current_start.len())],
            &current_head[..7.min(current_head.len())]
        );
        // The evidence at this moment. The rule check can take a while, so it runs before the
        // transaction; the transaction checks again that nothing moved.
        let evidence = json!({
            "rules": self.rule_snapshot(&start, &head),
            "verification": crate::verify::approval_snapshot(&self.state, &start, &head),
            "loose": self.loose_state(&run),
            "tamper": self.tamper(&start, &head),
            "ci": {"state": "none", "reason": LOCAL_CI},
        });
        let record = self.update(|v| {
            let r = find(v, "runs", id)?;
            ensure!(
                r["status"] == "completed" && r["revisedBy"].is_null() && r["merge"].is_null(),
                "The task changed after you checked it. Check it again, then approve"
            );
            ensure!(
                r["start"].is_null() || r["start"] == start.as_str(),
                "The task changed after you checked it. Check it again, then approve"
            );
            ensure!(
                self.resolve(&format!("refs/heads/{branch}"))? == head,
                "The task changed after you checked it. Check it again, then approve"
            );
            let acceptance_hash = r["acceptanceCheck"]["commandHash"].clone();
            let mine: Vec<Value> = v["comments"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| {
                    c["runId"] == id
                        && ["addressed", "verified"].contains(&c["status"].as_str().unwrap_or(""))
                })
                .cloned()
                .collect();
            ensure!(!mine.is_empty(), "Nothing in this task is ready to approve");
            let mut comments = vec![];
            for c in &mine {
                let commit = c["report"]["commit"]
                    .as_str()
                    .context("An instruction has no reported commit")?;
                ensure!(
                    !commit.starts_with('-')
                        && self
                            .git(&["merge-base", "--is-ancestor", commit, &head])
                            .is_ok(),
                    "An instruction reports commit {}, which is not in the head {}",
                    &commit[..7.min(commit.len())],
                    &head[..7]
                );
                // What the agent says it checked: a claim, kept apart from Peekumi's evidence.
                comments.push(json!({"id": c["id"], "commit": commit, "claimedChecks": c["report"]["checks"]}));
            }
            let at = now();
            for snapshot in &mine {
                let c = find_mut(v, "comments", snapshot["id"].as_str().unwrap())?;
                if c["status"] == "addressed" {
                    c["verification"] = json!({"note": note, "commit": c["report"]["commit"], "head": head, "at": at, "actor": "owner"});
                    c["status"] = json!("verified");
                    event(c, "owner");
                }
            }
            let record = json!({
                "start": start,
                "head": head,
                "at": at,
                "actor": "owner",
                "note": note,
                "comments": comments,
                "acceptanceHash": acceptance_hash,
                "evidence": evidence,
            });
            find_mut(v, "runs", id)?["approvalRecord"] = record.clone();
            Ok(record)
        })?;
        Ok(json!({"approval": record, "status": self.merge_status(id)?}))
    }

    /// `POST /api/runs/<id>/unapprove`: the owner takes the approval back while the task is
    /// not applied. The record goes to `approvalHistory`, and the verified instructions go
    /// back to review.
    pub(crate) fn unapprove(&self, id: &str) -> Result<Value> {
        let run = self.run(id)?;
        ensure!(!active(&run), "Wait for the run to finish");
        ensure!(
            run["revisedBy"].is_null(),
            "A later round continues this task"
        );
        ensure!(
            run["merge"].is_null() && !self.applied(&run),
            "This task is applied to main; start a new task for further changes"
        );
        self.update(|v| clear_approval(v, id, "unapprove"))?;
        self.merge_status(id)
    }

    /// `GET /api/inbox`: aggregates committed changes waiting on the owner — agent tasks ready
    /// for review/merge, active runs, and local branches ahead of the watched branch (never
    /// uncommitted working-tree edits).
    pub fn inbox(&self) -> Result<Value> {
        let v = self.read()?;
        let default_branch = self.watched.trim_start_matches("refs/heads/").to_string();
        let default_sha = self.resolve(&self.watched).unwrap_or_default();
        let runs = v["runs"].as_array().cloned().unwrap_or_default();
        let comments = v["comments"].as_array().cloned().unwrap_or_default();
        let mut task_branches = std::collections::BTreeSet::new();
        let mut needs_you = Vec::new();
        let mut working = Vec::new();
        let mut recent = Vec::new();

        for run in runs.iter().rev() {
            let status = run["status"].as_str().unwrap_or("");
            if status == "preview" {
                continue;
            }
            if let Some(b) = run["branch"].as_str() {
                task_branches.insert(b.to_string());
            }
            let id = run["id"].as_str().unwrap_or("");
            let is_session = run["kind"] == "session";
            let applied = self.applied(run);
            let title = run["title"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(String::from)
                .or_else(|| {
                    comments
                        .iter()
                        .find(|c| c["runId"] == id)
                        .and_then(|c| c["text"].as_str())
                        .map(|s| s.lines().next().unwrap_or("").chars().take(80).collect())
                })
                .unwrap_or_else(|| run["branch"].as_str().unwrap_or("Task").to_string());

            if active(run) || (is_session && status == "waiting") {
                working.push(json!({
                    "kind": if is_session { "session" } else { "task" },
                    "id": id,
                    "title": title,
                    "branch": run["branch"],
                    "status": status,
                    "agent": run["agent"],
                    "approval": run["approval"],
                    "updatedAt": run["startedAt"],
                }));
                continue;
            }
            if applied || !run["merge"].is_null() {
                if recent.len() < 10 {
                    recent.push(json!({
                        "kind": "task",
                        "id": id,
                        "title": title,
                        "branch": run["branch"],
                        "status": "applied",
                        "updatedAt": run["finishedAt"].as_u64().or(run["startedAt"].as_u64()),
                    }));
                }
                continue;
            }
            if !run["revisedBy"].is_null() || (is_session && status == "cancelled") {
                continue;
            }
            let start = self.start_of(run).unwrap_or_default();
            let head = run["branch"]
                .as_str()
                .and_then(|b| self.resolve(&format!("refs/heads/{b}")).ok())
                .or_else(|| {
                    run["results"]
                        .as_array()
                        .and_then(|a| a.last())
                        .and_then(Value::as_str)
                        .map(String::from)
                })
                .unwrap_or_default();
            let verification = if !head.is_empty() {
                crate::verify::latest_for(&self.state, &start, &head).unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            let tamper = if !start.is_empty() && !head.is_empty() {
                self.tamper(&start, &head)
            } else {
                Value::Null
            };
            let tamper_count = ["tests", "ci", "config"]
                .iter()
                .map(|k| tamper[*k].as_array().map_or(0, Vec::len))
                .sum::<usize>();
            let approval_current = !head.is_empty() && Self::approval_matches(run, &start, &head);
            needs_you.push(json!({
                "kind": "task",
                "id": id,
                "title": title,
                "branch": run["branch"],
                "start": start,
                "head": head,
                "status": status,
                "agent": run["agent"],
                "approvalCurrent": approval_current,
                "tamperCount": tamper_count,
                "verification": verification,
                "updatedAt": run["finishedAt"].as_u64().or(run["startedAt"].as_u64()),
            }));
        }

        // Committed local branches ahead of the watched branch (excluding agent task branches and
        // never including uncommitted working-tree changes).
        if !default_sha.is_empty()
            && let Ok(raw) = self.git(&[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname:short)\t%(objectname)\t%(committerdate:unix)\t%(subject)",
                "refs/heads",
            ])
        {
            for line in raw.lines().take(20) {
                let mut cols = line.splitn(4, '\t');
                let Some(name) = cols.next().filter(|s| !s.is_empty()) else {
                    continue;
                };
                let Some(sha) = cols.next().filter(|s| !s.is_empty()) else {
                    continue;
                };
                let ts: u64 = cols.next().and_then(|s| s.parse().ok()).unwrap_or(0) * 1000;
                let subject = cols.next().unwrap_or("");
                if name == default_branch || task_branches.contains(name) || sha == default_sha {
                    continue;
                }
                // Only include branches with commits not yet on the default branch.
                if self
                    .git(&["merge-base", "--is-ancestor", sha, &default_sha])
                    .is_ok()
                {
                    continue;
                }
                let start = self
                    .git(&["merge-base", &default_sha, sha])
                    .unwrap_or_else(|_| default_sha.clone());
                let verification =
                    crate::verify::latest_for(&self.state, &start, sha).unwrap_or(Value::Null);
                let tamper = self.tamper(&start, sha);
                let tamper_count = ["tests", "ci", "config"]
                    .iter()
                    .map(|k| tamper[*k].as_array().map_or(0, Vec::len))
                    .sum::<usize>();
                needs_you.push(json!({
                    "kind": "branch",
                    "id": format!("branch:{name}"),
                    "name": name,
                    "title": if subject.is_empty() { name.to_string() } else { format!("{name} · {subject}") },
                    "branch": name,
                    "start": start,
                    "head": sha,
                    "tamperCount": tamper_count,
                    "verification": verification,
                    "updatedAt": ts,
                }));
            }
        }

        Ok(json!({
            "defaultBranch": default_branch,
            "defaultSha": default_sha,
            "needsYou": needs_you,
            "working": working,
            "recent": recent,
        }))
    }
}

/// Clears the approval of run `id` in the workflow state `v`, for `cause`, one of the events in
/// [`crate::lifecycle::APPROVAL_CLEARS`]. The record moves to the run's `approvalHistory` with
/// the time and the reason, and each verified instruction of the run goes back to `addressed`,
/// so the owner approves the new pair of commits. Without a record and without a verified
/// instruction it changes nothing.
pub fn clear_approval(v: &mut Value, id: &str, cause: &str) -> Result<()> {
    let Some(reason) = crate::lifecycle::approval_clear_reason(cause) else {
        bail!("Unknown reason to clear an approval: {cause}");
    };
    let r = find_mut(v, "runs", id)?;
    if !r["approvalRecord"].is_null() {
        let mut old = r["approvalRecord"].take();
        old["clearedAt"] = json!(now());
        old["clearedBy"] = json!(cause);
        old["clearedBecause"] = json!(reason);
        if !r["approvalHistory"].is_array() {
            r["approvalHistory"] = json!([]);
        }
        r["approvalHistory"].as_array_mut().unwrap().push(old);
    }
    for c in v["comments"].as_array_mut().unwrap().iter_mut() {
        if c["runId"] == id && c["status"] == "verified" {
            // The approval stays in the instruction's history.
            c["status"] = json!("addressed");
            c["verification"] = Value::Null;
            event(c, "owner");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sensitive_kind;

    #[test]
    fn test_ci_and_rule_files_are_named() {
        for path in [
            "test/a.mjs",
            "src/tests/x.rs",
            "web/__tests__/a.js",
            "spec/model.rb",
            "pkg/thing_test.go",
            "src/app.test.ts",
            "src/app.spec.js",
            "test_api.py",
            "lib/test_api.py",
        ] {
            assert_eq!(sensitive_kind(path), Some("tests"), "{path}");
        }
        for path in [
            ".github/workflows/ci.yml",
            ".gitlab-ci.yml",
            ".circleci/config.yml",
            "azure-pipelines.yml",
            "Jenkinsfile",
            "build/Jenkinsfile",
            ".buildkite/pipeline.yml",
        ] {
            assert_eq!(sensitive_kind(path), Some("ci"), "{path}");
        }
        assert_eq!(sensitive_kind(".peekumi.json"), Some("rules"));
        for path in [
            "src/main.rs",
            "testing.md",
            "contest/a.py",
            "test_api.rs",
            "docs/spec.md",
            ".github/CODEOWNERS",
            "sub/.peekumi.json",
        ] {
            assert_eq!(sensitive_kind(path), None, "{path}");
        }
    }
}
