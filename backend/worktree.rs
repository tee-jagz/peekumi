//! Uncommitted changes as a commit that only Peekumi can see.
//!
//! The map compares commits. To show the files that the owner changed but did not commit,
//! Peekumi records the working tree as a commit on top of `HEAD`: the "snapshot". The snapshot
//! has every committed file, with the changed, new and deleted files of `git status` as they
//! are on the disk now. Ignored files stay out, as in a commit.
//!
//! The snapshot's objects go to a private object folder in Peekumi's state folder, never to the
//! repository: Peekumi does not change the repository's objects, index, branches or files. Only
//! read-only Git commands see the private folder (as an alternate object folder, see
//! [`read_env`]). A Git command that can write objects must never use it, because Git does not
//! write an object again when an alternate folder has it.
//!
//! The same working tree gives the same snapshot SHA, so the analysis of a snapshot is reused
//! until a file changes. Peekumi reads symbolic links as links and does not follow them, and it
//! runs no Git filter to read a file. Submodules keep their committed state.
use anyhow::{Context, Result, ensure};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

/// The most changed files in one snapshot.
const MAX_FILES: usize = 5000;
/// When the private object folder is larger than this, Peekumi empties it before the next
/// snapshot. Older snapshots are then unreadable.
const MAX_STORE: u64 = 1 << 30;

/// The private object folder in a repository's state folder.
pub fn objects(state: &Path) -> PathBuf {
    state.join("worktree-objects")
}

/// The environment that lets a read-only Git command read snapshots: the private object folder
/// as an alternate. Never use it for a command that can write objects (see the module text).
pub fn read_env(state: &Path) -> Vec<(OsString, OsString)> {
    let folder = objects(state);
    if !folder.is_dir() {
        return vec![];
    }
    vec![(
        "GIT_ALTERNATE_OBJECT_DIRECTORIES".into(),
        folder.into_os_string(),
    )]
}

/// Runs Git in `repo` with `env`, without hooks, the file system monitor or optional locks.
fn git(
    repo: &Path,
    env: &[(OsString, OsString)],
    args: &[&str],
    input: Vec<u8>,
) -> Result<Vec<u8>> {
    let directory = repo.to_str().context("Non UTF-8 repository path")?;
    let mut all = vec![
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        directory,
    ];
    all.extend_from_slice(args);
    crate::process::run_env("git", &all, None, input, Duration::from_secs(60), env)
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn size(folder: &Path) -> u64 {
    std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => size(&entry.path()),
            _ => entry.metadata().map(|m| m.len()).unwrap_or(0),
        })
        .sum()
}

/// A snapshot of the working tree of `repo`, with `state` as Peekumi's state folder for it:
/// `Some((sha, paths))` with the changed paths, or `None` when nothing is changed or the branch
/// has no commit yet.
///
/// # Errors
/// Git failures, unreadable files and more than 5000 changed files.
pub fn snapshot(repo: &Path, state: &Path) -> Result<Option<(String, Vec<String>)>> {
    let Ok(head) = git(
        repo,
        &[],
        &["rev-parse", "--verify", "HEAD^{commit}"],
        vec![],
    ) else {
        return Ok(None);
    };
    let head = text(head);
    // Porcelain entries: "XY path", one for each changed path, with no renames.
    let status = git(
        repo,
        &[],
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
            "--ignore-submodules=all",
        ],
        vec![],
    )?;
    let paths: Vec<String> = status
        .split(|b| *b == 0)
        .filter(|entry| entry.len() > 3)
        .map(|entry| String::from_utf8_lossy(&entry[3..]).into_owned())
        // A folder entry is a repository inside this one; it is not part of the commit.
        .filter(|path| !path.ends_with('/'))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    if paths.is_empty() {
        return Ok(None);
    }
    ensure!(
        paths.len() <= MAX_FILES,
        "More than {MAX_FILES} files are not committed"
    );

    let store = objects(state);
    if size(&store) > MAX_STORE {
        std::fs::remove_dir_all(&store)?;
    }
    std::fs::create_dir_all(store.join("info"))?;
    std::fs::create_dir_all(store.join("pack"))?;
    let common = text(git(repo, &[], &["rev-parse", "--git-common-dir"], vec![])?);
    let repo_objects = repo.join(common).join("objects").canonicalize()?;
    let index = state.join(format!("worktree-index-{}", std::process::id()));
    let _ = std::fs::remove_file(&index);
    // New objects go to the private folder; the repository's objects are read as an alternate.
    let env: Vec<(OsString, OsString)> = vec![
        (
            "GIT_OBJECT_DIRECTORY".into(),
            store.clone().into_os_string(),
        ),
        (
            "GIT_ALTERNATE_OBJECT_DIRECTORIES".into(),
            repo_objects.into_os_string(),
        ),
        ("GIT_INDEX_FILE".into(), index.clone().into_os_string()),
    ];
    let result = (|| {
        git(repo, &env, &["read-tree", &head], vec![])?;
        // The committed modes, so a file keeps its mode when only its text changed.
        let committed = git(repo, &env, &["ls-files", "-s", "-z"], vec![])?;
        let modes: std::collections::HashMap<String, String> = committed
            .split(|b| *b == 0)
            .filter_map(|entry| {
                let entry = String::from_utf8_lossy(entry);
                let (meta, path) = entry.split_once('\t')?;
                Some((path.to_string(), meta.split(' ').next()?.to_string()))
            })
            .collect();
        let mut records = Vec::new();
        for path in &paths {
            let file = repo.join(path);
            let record = match std::fs::symlink_metadata(&file) {
                Err(_) => format!("0 {}\t{path}\0", "0".repeat(40)),
                Ok(meta) => {
                    let (mode, bytes) = if meta.file_type().is_symlink() {
                        let target = std::fs::read_link(&file)?;
                        (
                            "120000".to_string(),
                            target.as_os_str().as_encoded_bytes().to_vec(),
                        )
                    } else if meta.is_file() {
                        let executable = {
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::PermissionsExt;
                                meta.permissions().mode() & 0o111 != 0
                            }
                            #[cfg(not(unix))]
                            false
                        };
                        let mode = match modes.get(path).map(String::as_str) {
                            Some(m @ ("100644" | "100755")) => m.to_string(),
                            _ if executable => "100755".into(),
                            _ => "100644".into(),
                        };
                        (mode, std::fs::read(&file)?)
                    } else {
                        continue;
                    };
                    let sha = text(git(
                        repo,
                        &env,
                        &["hash-object", "-w", "--no-filters", "--stdin"],
                        bytes,
                    )?);
                    format!("{mode} {sha}\t{path}\0")
                }
            };
            records.extend_from_slice(record.as_bytes());
        }
        git(repo, &env, &["update-index", "-z", "--index-info"], records)?;
        let tree = text(git(repo, &env, &["write-tree"], vec![])?);
        // The commit's dates are the dates of HEAD, so the same files give the same SHA.
        let date = text(git(
            repo,
            &[],
            &["log", "-1", "--format=%ct +0000", &head],
            vec![],
        )?);
        let mut commit_env = env.clone();
        for (key, value) in [
            ("GIT_AUTHOR_NAME", "Peekumi"),
            ("GIT_AUTHOR_EMAIL", "uncommitted@peekumi.invalid"),
            ("GIT_COMMITTER_NAME", "Peekumi"),
            ("GIT_COMMITTER_EMAIL", "uncommitted@peekumi.invalid"),
            ("GIT_AUTHOR_DATE", &date),
            ("GIT_COMMITTER_DATE", &date),
        ] {
            commit_env.push((key.into(), value.into()));
        }
        let commit = text(git(
            repo,
            &commit_env,
            &[
                "commit-tree",
                "--no-gpg-sign",
                &tree,
                "-p",
                &head,
                "-m",
                "Uncommitted changes",
            ],
            vec![],
        )?);
        Ok(Some((commit, paths.clone())))
    })();
    let _ = std::fs::remove_file(&index);
    result
}
