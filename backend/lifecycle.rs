//! The life cycle of runs and comments, in one place.
//!
//! The workflow store keeps runs and comments as JSON with a `status` string. Many modules
//! change those strings (`workflow`, `runner`, `merge`, `agent_session`). This module states
//! every status that may exist and every change between them, with the event that causes it.
//! `Workflow::update` calls [`check`] on each transaction, so a change that is not in these
//! tables, or a status that is not known, is rejected before it is saved.
//!
//! Merge readiness is not a stored state: `merge` derives it from Git and the approval.
//!
//! The owner's approval is a record on a run (`approvalRecord`, see the review module), not a
//! status. It names the exact start and head commits. Only a completed run can hold one, and
//! [`APPROVAL_CLEARS`] lists every event that clears it, because the event changes the commits
//! that the owner approved.

use anyhow::{Result, bail};
use serde_json::Value;
use std::collections::HashMap;

/// The statuses of a run (a task, a task preview or a session).
pub const RUN: &[&str] = &[
    "preview",
    "starting",
    "running",
    "waiting",
    "interrupted",
    "completed",
    "failed",
    "cancelled",
];

/// The statuses of a comment (an owner instruction).
pub const COMMENT: &[&str] = &[
    "draft",
    "with_agent",
    "addressed",
    "flagged",
    "unreported",
    "verified",
    "deleted",
];

/// Statuses a new run may start with, and why.
const RUN_START: &[(&str, &str)] = &[
    ("preview", "the owner previews a task"),
    (
        "starting",
        "the owner starts a revision round, or a merge conflict starts a round",
    ),
    ("running", "the owner starts a session with a first message"),
];

/// Every allowed change of a run's status: from, to, the event.
const RUN_MOVES: &[(&str, &str, &str)] = &[
    (
        "preview",
        "starting",
        "the owner dispatches the previewed task",
    ),
    ("starting", "running", "the runner starts the agent"),
    ("starting", "failed", "the agent could not start"),
    (
        "starting",
        "cancelled",
        "the owner stops the task before the agent runs",
    ),
    (
        "starting",
        "interrupted",
        "the service restarts during the start",
    ),
    (
        "running",
        "completed",
        "the agent exits with success, or the owner ends a session for review",
    ),
    ("running", "failed", "the agent exits with an error"),
    (
        "running",
        "cancelled",
        "the owner stops the agent, or the time limit ends it",
    ),
    ("running", "waiting", "a session turn ends"),
    (
        "running",
        "interrupted",
        "the service restarts while the agent runs",
    ),
    (
        "waiting",
        "running",
        "the owner sends a session message, or the repository becomes free",
    ),
    (
        "waiting",
        "completed",
        "the owner ends a session and sends it to review",
    ),
    (
        "waiting",
        "cancelled",
        "the owner ends a session without review",
    ),
    ("waiting", "failed", "a session fails between turns"),
    (
        "waiting",
        "interrupted",
        "the service restarts while a session waits",
    ),
    (
        "interrupted",
        "failed",
        "the old task process exits after a restart",
    ),
    (
        "interrupted",
        "running",
        "a session's interrupted turn closes with messages waiting",
    ),
    (
        "interrupted",
        "waiting",
        "a session's interrupted turn closes",
    ),
];

/// Every allowed change of a comment's status: from, to, the event.
const COMMENT_MOVES: &[(&str, &str, &str)] = &[
    (
        "draft",
        "with_agent",
        "a task, round or session takes the instruction",
    ),
    ("draft", "deleted", "the owner deletes a draft"),
    (
        "draft",
        "flagged",
        "undoing a merge restores the earlier status",
    ),
    (
        "draft",
        "unreported",
        "undoing a merge restores the earlier status",
    ),
    (
        "with_agent",
        "addressed",
        "the agent reports a commit, or the owner ends a session for review",
    ),
    (
        "with_agent",
        "flagged",
        "the agent cannot do the instruction",
    ),
    ("with_agent", "unreported", "the run ends without a report"),
    ("addressed", "verified", "the owner approves the work"),
    ("addressed", "draft", "the owner reopens the instruction"),
    (
        "verified",
        "addressed",
        "the owner withdraws approval, or a conflict round, a clean update or a salvage commit changes the approved commits",
    ),
    (
        "flagged",
        "draft",
        "the owner reopens the instruction, or a merge reopens it",
    ),
    (
        "flagged",
        "deleted",
        "the owner deletes a flagged instruction",
    ),
    (
        "flagged",
        "with_agent",
        "a revision or conflict round takes it again",
    ),
    (
        "unreported",
        "draft",
        "the owner reopens the instruction, or a merge reopens it",
    ),
    (
        "unreported",
        "with_agent",
        "a revision or conflict round takes it again",
    ),
];

/// Every event that clears a run's approval record, and why. Each one changes the start or
/// the head commit, so the owner must approve the new pair (see `review::clear_approval`).
pub const APPROVAL_CLEARS: &[(&str, &str)] = &[
    (
        "update",
        "a clean Update with main adds a merge commit to the head and moves the start",
    ),
    (
        "salvage",
        "a salvage commit adds the agent's loose files to the head",
    ),
    (
        "acceptance_changed",
        "the owner changed or removed the task's acceptance check",
    ),
    ("unapprove", "the owner takes the approval back"),
];

/// The reason for an event in [`APPROVAL_CLEARS`], or `None` for an unknown event.
pub fn approval_clear_reason(event: &str) -> Option<&'static str> {
    APPROVAL_CLEARS
        .iter()
        .find(|(e, _)| *e == event)
        .map(|(_, r)| *r)
}

/// True while a run holds its repository: an agent process may still exist.
pub fn active(status: &str) -> bool {
    ["starting", "running", "interrupted"].contains(&status)
}

/// The event that explains a change, or `None` when the change is not allowed.
/// `from` is `None` for a new item.
pub fn reason(kind: Kind, from: Option<&str>, to: &str) -> Option<&'static str> {
    match (kind, from) {
        (Kind::Run, None) => RUN_START.iter().find(|(s, _)| *s == to).map(|(_, r)| *r),
        (Kind::Comment, None) => match to {
            "draft" => Some("the owner writes an instruction"),
            "with_agent" => Some("a session's first message becomes its instruction"),
            _ => None,
        },
        (Kind::Run, Some(f)) => RUN_MOVES
            .iter()
            .find(|(a, b, _)| *a == f && *b == to)
            .map(|m| m.2),
        (Kind::Comment, Some(f)) => COMMENT_MOVES
            .iter()
            .find(|(a, b, _)| *a == f && *b == to)
            .map(|m| m.2),
    }
}

/// The two kinds of item that have a life cycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Run,
    Comment,
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Kind::Run => "runs",
            Kind::Comment => "comments",
        }
    }
    fn known(self) -> &'static [&'static str] {
        match self {
            Kind::Run => RUN,
            Kind::Comment => COMMENT,
        }
    }
}

/// The status of every run and comment, by kind and id. Taken before a transaction.
pub type Statuses = HashMap<(Kind, String), String>;

/// Reads the status of every run and comment in a workflow state.
pub fn statuses(state: &Value) -> Statuses {
    let mut out = Statuses::new();
    for kind in [Kind::Run, Kind::Comment] {
        for item in state[kind.key()].as_array().into_iter().flatten() {
            if let (Some(id), Some(status)) = (item["id"].as_str(), item["status"].as_str()) {
                out.insert((kind, id.to_string()), status.to_string());
            }
        }
    }
    out
}

/// Checks a transaction: every status in `after` must be known, and every new item or
/// changed status must be an allowed start or move. Items that disappear are not checked
/// (a new preview replaces an unsent one). Returns an error that names the change.
pub fn check(before: &Statuses, after: &Value) -> Result<()> {
    for kind in [Kind::Run, Kind::Comment] {
        for item in after[kind.key()].as_array().into_iter().flatten() {
            let id = item["id"].as_str().unwrap_or("");
            let Some(to) = item["status"].as_str() else {
                bail!("A {kind:?} has no status: {id}");
            };
            if !kind.known().contains(&to) {
                bail!("Unknown {kind:?} status {to:?}: {id}");
            }
            if kind == Kind::Run && !item["approvalRecord"].is_null() && to != "completed" {
                bail!("Run {id} holds an approval but is {to}; only a completed run can");
            }
            let from = before.get(&(kind, id.to_string())).map(String::as_str);
            if from == Some(to) {
                continue;
            }
            if reason(kind, from, to).is_none() {
                bail!(
                    "{kind:?} {id} cannot change from {} to {to}",
                    from.unwrap_or("nothing")
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(runs: &[(&str, &str)], comments: &[(&str, &str)]) -> Value {
        let items = |list: &[(&str, &str)]| {
            list.iter()
                .map(|(id, s)| json!({"id": id, "status": s}))
                .collect::<Vec<_>>()
        };
        json!({"runs": items(runs), "comments": items(comments)})
    }

    #[test]
    fn every_move_uses_known_statuses_and_has_a_reason() {
        for (kind, moves) in [(Kind::Run, RUN_MOVES), (Kind::Comment, COMMENT_MOVES)] {
            for (from, to, why) in moves {
                assert!(
                    kind.known().contains(from) && kind.known().contains(to),
                    "{from} -> {to}"
                );
                assert!(!why.is_empty());
                assert_eq!(reason(kind, Some(from), to), Some(*why));
            }
        }
        for (start, _) in RUN_START {
            assert!(RUN.contains(start));
        }
    }

    #[test]
    fn every_status_can_be_reached() {
        for (kind, moves, known) in [
            (Kind::Run, RUN_MOVES, RUN),
            (Kind::Comment, COMMENT_MOVES, COMMENT),
        ] {
            for s in known {
                let start = reason(kind, None, s).is_some();
                assert!(
                    start || moves.iter().any(|m| m.1 == *s),
                    "{kind:?} {s} is unreachable"
                );
            }
        }
    }

    #[test]
    fn finished_runs_and_deleted_comments_stay_put() {
        for end in ["completed", "failed", "cancelled"] {
            for to in RUN {
                assert_eq!(reason(Kind::Run, Some(end), to), None, "{end} -> {to}");
            }
        }
        for to in COMMENT {
            assert_eq!(reason(Kind::Comment, Some("deleted"), to), None);
        }
    }

    #[test]
    fn only_a_completed_run_holds_an_approval_and_each_clear_has_a_reason() {
        let approved = |status: &str| json!({"runs": [{"id": "r", "status": status, "approvalRecord": {"start": "a", "head": "b"}}], "comments": []});
        let before = statuses(&state(&[("r", "completed")], &[]));
        check(&before, &approved("completed")).unwrap();
        let before = statuses(&state(&[("r", "running")], &[]));
        assert!(check(&before, &approved("running")).is_err());
        for (event, why) in APPROVAL_CLEARS {
            assert_eq!(approval_clear_reason(event), Some(*why));
        }
        assert_eq!(approval_clear_reason("merge"), None);
    }

    #[test]
    fn check_accepts_allowed_changes() {
        let before = statuses(&state(&[("r", "preview")], &[("c", "draft")]));
        let after = state(
            &[("r", "starting"), ("n", "running")],
            &[("c", "with_agent"), ("d", "draft")],
        );
        check(&before, &after).unwrap();
    }

    #[test]
    fn check_rejects_disallowed_and_unknown_statuses() {
        let before = statuses(&state(&[("r", "completed")], &[("c", "deleted")]));
        let err = check(&before, &state(&[("r", "running")], &[]))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("cannot change from completed to running"),
            "{err}"
        );
        assert!(check(&before, &state(&[], &[("c", "draft")])).is_err());
        assert!(check(&Statuses::new(), &state(&[("x", "done")], &[])).is_err());
        assert!(check(&Statuses::new(), &state(&[("x", "completed")], &[])).is_err());
        assert!(check(&Statuses::new(), &json!({"runs": [{"id": "x"}]})).is_err());
    }
}
