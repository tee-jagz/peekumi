//! Baseline lifetime, frozen rules and read-only repository regression tests.
use super::*;
use crate::worktree::{cleanup, git, objects, read_env, text};
use std::{collections::BTreeMap, path::PathBuf};

struct Fixture {
    _root: tempfile::TempDir,
    repo: PathBuf,
    state: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let state = root.path().join("private-state");
        std::fs::create_dir(&repo).unwrap();
        let fixture = Self {
            _root: root,
            repo,
            state,
        };
        fixture.git(&["init", "-b", "main"]);
        fixture.git(&["config", "user.name", "Baseline test"]);
        fixture.git(&["config", "user.email", "baseline@example.invalid"]);
        fixture.write("shop.py", "def sale():\n    return 1\n");
        fixture.write(
            ".peekumi.json",
            "{\"version\":1,\"groups\":{},\"rules\":[]}",
        );
        fixture.commit();
        fixture
    }

    fn git(&self, args: &[&str]) -> String {
        text(git(&self.repo, &[], args, vec![]).unwrap())
    }

    fn write(&self, path: &str, source: &str) {
        std::fs::write(self.repo.join(path), source).unwrap();
    }

    fn commit(&self) {
        self.git(&["add", "."]);
        self.git(&["commit", "--no-gpg-sign", "-m", "Fixture"]);
    }

    fn binding(&self) -> Binding {
        Binding {
            profile: "default".into(),
            session: "session-1".into(),
            turn: "turn-1".into(),
            repository: crate::hash::hash(
                self.repo
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .as_bytes(),
            )[..16]
                .into(),
        }
    }

    fn capture(&self) -> Baseline {
        capture_baseline(&self.repo, &self.state, self.binding()).unwrap()
    }

    fn read(&self, sha: &str, path: &str) -> String {
        text(
            git(
                &self.repo,
                &read_env(&self.state),
                &["show", &format!("{sha}:{path}")],
                vec![],
            )
            .unwrap(),
        )
    }
}

/// Record all file bytes and links, including Git objects, refs, index and configuration.
fn contents(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, bool)> {
    fn walk(base: &Path, path: &Path, output: &mut BTreeMap<PathBuf, (Vec<u8>, bool)>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                walk(base, &path, output);
            } else {
                let link = meta.file_type().is_symlink();
                let bytes = if link {
                    std::fs::read_link(&path)
                        .unwrap()
                        .as_os_str()
                        .as_encoded_bytes()
                        .to_vec()
                } else {
                    std::fs::read(&path).unwrap()
                };
                output.insert(
                    path.strip_prefix(base).unwrap().to_path_buf(),
                    (bytes, link),
                );
            }
        }
    }
    let mut output = BTreeMap::new();
    walk(root, root, &mut output);
    output
}

#[test]
fn dirty_start_and_snapshots_do_not_change_repository_contents_or_index_time() {
    let f = Fixture::new();
    f.write("shop.py", "def sale():\n    return 2\n");
    f.write("new.py", "def refund():\n    return 3\n");
    f.git(&["add", "new.py"]);
    let before = contents(&f.repo);
    let index_time = std::fs::metadata(f.repo.join(".git/index"))
        .unwrap()
        .modified()
        .unwrap();
    let baseline = f.capture();
    assert_eq!(baseline.already_changed, ["new.py", "shop.py"]);
    assert_eq!(
        f.read(&baseline.sha, "shop.py"),
        "def sale():\n    return 2"
    );
    assert_eq!(baseline.rules_sha, baseline.sha);
    assert_eq!(f.capture().id, baseline.id);
    assert_eq!(contents(&f.repo), before);
    assert_eq!(
        std::fs::metadata(f.repo.join(".git/index"))
            .unwrap()
            .modified()
            .unwrap(),
        index_time
    );
    assert!(git(&f.repo, &[], &["cat-file", "-e", &baseline.sha], vec![]).is_err());
}

#[test]
fn retry_after_commit_keeps_original_snapshot_and_dirty_rules() {
    let f = Fixture::new();
    let rules = "{\"version\":1,\"groups\":{\"ui\":[\"ui/*\"]},\"rules\":[]}";
    f.write(".peekumi.json", rules);
    f.write("shop.py", "def sale():\n    return 2\n");
    let baseline = f.capture();
    f.commit();
    f.write(".peekumi.json", "{}");
    f.write("shop.py", "def sale():\n    return 99\n");
    let retry = f.capture();
    assert_eq!(retry.sha, baseline.sha);
    assert_eq!(retry.already_changed, baseline.already_changed);
    assert_ne!(retry.sha, f.git(&["rev-parse", "HEAD"]));
    assert_eq!(f.read(&retry.rules_sha, ".peekumi.json"), rules);
    let mut next = f.binding();
    next.turn = "turn-2".into();
    let next = capture_baseline(&f.repo, &f.state, next).unwrap();
    assert_ne!(next.id, baseline.id);
    assert_ne!(next.sha, baseline.sha);
}

#[test]
fn active_baseline_and_rules_survive_cleanup_then_session_release_allows_cleanup() {
    let f = Fixture::new();
    f.write(
        ".peekumi.json",
        "{\"version\":1,\"groups\":{\"ui\":[\"ui/*\"]},\"rules\":[]}",
    );
    let baseline = f.capture();
    let rules = f.read(&baseline.rules_sha, ".peekumi.json");
    let run = crate::integration_evidence::reserve(&f.state, &baseline.id, &baseline.sha).unwrap();
    let report = "SF:shop.py\nDA:1,1\nend_of_record\n";
    crate::integration_evidence::record(&f.state, &baseline.id, &serde_json::json!({
        "run_id":run,"snapshot":baseline.sha,"report":report,"report_hash":crate::hash::hash(report),
        "test_exit":0,"export_exit":0,"fresh_directory":true
    })).unwrap();
    cleanup(&f.state, 0).unwrap();
    assert!(objects(&f.state).is_dir());
    assert_eq!(f.read(&baseline.rules_sha, ".peekumi.json"), rules);
    let evidence = crate::integration_evidence::for_snapshot(&f.state, &baseline.sha)
        .unwrap()
        .unwrap();
    assert!(evidence.valid);
    assert_eq!(evidence.report, report);
    release_session(&f.state, "other-profile", "session-1").unwrap();
    cleanup(&f.state, 0).unwrap();
    assert!(objects(&f.state).is_dir());
    release_session(&f.state, "default", "session-1").unwrap();
    cleanup(&f.state, 0).unwrap();
    assert!(!objects(&f.state).exists());
}

#[test]
fn idle_expiry_and_retry_renewal_are_24_hours() {
    let f = Fixture::new();
    let baseline = f.capture();
    assert!(
        load(&f.state, baseline.last_used + IDLE_SECONDS - 1)
            .unwrap()
            .contains_key(&baseline.id)
    );
    assert!(
        load(&f.state, baseline.last_used + IDLE_SECONDS)
            .unwrap()
            .is_empty()
    );
    let mut entries = load(&f.state, now()).unwrap();
    entries.get_mut(&baseline.id).unwrap().last_used -= IDLE_SECONDS - 10;
    save(&f.state, &entries).unwrap();
    let renewed = f.capture();
    assert!(renewed.last_used > entries[&baseline.id].last_used);
    assert_eq!(renewed.sha, baseline.sha);
}

#[test]
fn identity_scopes_and_repository_registration_are_checked() {
    let f = Fixture::new();
    let baseline = f.capture();
    let mut other = f.binding();
    other.profile = "work".into();
    let other = capture_baseline(&f.repo, &f.state, other).unwrap();
    assert_ne!(other.id, baseline.id);
    release_session(&f.state, "default", "session-1").unwrap();
    assert_eq!(load(&f.state, now()).unwrap().len(), 1);
    let mut wrong = f.binding();
    wrong.repository = "other".into();
    assert!(capture_baseline(&f.repo, &f.state, wrong).is_err());
    let mut empty = f.binding();
    empty.turn.clear();
    assert!(capture_baseline(&f.repo, &f.state, empty).is_err());
}

#[test]
fn clean_start_uses_head_and_corrupt_retention_state_prevents_deletion() {
    let f = Fixture::new();
    let baseline = f.capture();
    assert_eq!(baseline.sha, f.git(&["rev-parse", "HEAD"]));
    assert!(baseline.already_changed.is_empty());
    f.write("shop.py", "def changed():\n    return 2\n");
    crate::worktree::snapshot(&f.repo, &f.state).unwrap();
    std::fs::write(f.state.join("integration-baselines.json"), "broken").unwrap();
    assert!(cleanup(&f.state, 0).is_err());
    assert!(objects(&f.state).exists());
}
