//! Committed Git snapshots, comparisons, directory documentation and language-adapter coordination.
use crate::{
    adapters::{self, Config},
    hash::hash,
    index::Index,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::Arc,
};
/// Decodes subprocess output as UTF-8, replacing invalid bytes rather than failing repository inspection.
fn string(data: Vec<u8>) -> String {
    String::from_utf8_lossy(&data).into_owned()
}
/// Reads a JSON string, returning an empty string when the value is absent or has another type.
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
/// Copies a JSON array, returning an empty list when the value is absent or has another type.
fn array(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
/// Identifies common secret-bearing filenames whose source must be hidden: environment files,
/// private keys and keystores, and the credential files of common tools (npm, netrc, AWS,
/// PostgreSQL, Docker, Git, PyPI, cloud service accounts, Terraform state).
/// Example environment templates remain readable; this is a filename policy, not a content secret scanner.
/// The engine keeps no source for these files, so Source, Ask and code search all omit it.
pub fn restricted(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file).to_lowercase();
    let template = [".example", ".sample", ".template", ".dist"]
        .iter()
        .any(|s| name.ends_with(s));
    let env =
        name == ".env" || name == ".envrc" || name.starts_with(".env.") || name.ends_with(".env");
    let key_file = [
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".p8",
        ".jks",
        ".keystore",
        ".ppk",
        ".kdbx",
        ".tfstate",
        ".tfvars",
    ]
    .iter()
    .any(|s| name.ends_with(s));
    // A private SSH key, also a copy of one (`id_rsa.bak`); the public key stays readable.
    let ssh_key = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]
        .iter()
        .any(|k| name.starts_with(k))
        && !name.ends_with(".pub");
    let credentials = [
        "credentials",
        "credentials.json",
        ".npmrc",
        ".netrc",
        "_netrc",
        ".pgpass",
        ".pypirc",
        ".git-credentials",
        ".dockercfg",
        ".htpasswd",
        "terraform.tfstate.backup",
        ".terraformrc",
        "terraform.rc",
        ".yarnrc.yml",
        "application_default_credentials.json",
    ]
    .contains(&name.as_str());
    let service_account = name.ends_with(".json")
        && (name.contains("service-account")
            || name.contains("service_account")
            || name.contains("serviceaccount"));
    let lower = file.to_lowercase();
    let tool_config = lower.ends_with(".docker/config.json") || lower.ends_with(".kube/config");
    ((env || key_file) && !template) || ssh_key || credentials || service_account || tool_config
}
#[derive(Clone, Default)]
/// One tracked Git entry and its optional syntax analysis.
/// Retains unsupported or unreadable entries so the map still accounts for every tracked file.
struct File {
    path: String,
    mode: String,
    oid: String,
    size: u64,
    analysis: String,
    source: Option<String>,
    symbols: Vec<Value>,
    imports: Vec<Value>,
    relationships: Vec<Value>,
    details: Option<Value>,
    deps: Vec<String>,
}
impl File {
    /// Installs an adapter result on this file, replacing symbols, imports, declaration details and analysis status.
    fn apply(&mut self, v: Value) {
        self.symbols = array(&v["symbols"]);
        self.imports = array(&v["imports"]);
        self.relationships = array(&v["relationships"]);
        self.details = v.get("details").cloned();
        self.analysis = text(&v["analysis"]).into();
    }
    /// Builds the lazy declaration payload, including each symbol's name and documentation.
    /// This richer metadata is returned when a file is opened rather than in the initial overview.
    fn details(&self) -> Value {
        let mut v = self.details.clone().unwrap_or(json!({}));
        v["symbols"] = json!(
            self.symbols
                .iter()
                .map(|s| {
                    let mut d = s.get("details").cloned().unwrap_or(json!({}));
                    d["name"] = s["name"].clone();
                    d
                })
                .collect::<Vec<_>>()
        );
        v
    }
}
/// An immutable committed file tree with syntax analysis and imports resolved within that tree.
struct Snapshot {
    sha: String,
    files: BTreeMap<String, File>,
    relationships: Vec<Value>,
    checks: Value,
}
/// Coordinates read-only Git inspection, language adapters and bounded analysis caches.
/// Owns repository-specific state on the worker thread; inspected source is never executed.
pub struct Repository {
    pub directory: PathBuf,
    /// The private state folder, which also keeps the snapshots of uncommitted changes (see the
    /// worktree module).
    state: PathBuf,
    parser_config: Config,
    index: Index,
    cache: VecDeque<Arc<Snapshot>>,
    comparisons: VecDeque<(String, bool, Value)>,
    version: String,
    identities: HashMap<String, String>,
    pub parsed: u64,
    pub reused: u64,
    pub snapshots: u64,
}
impl Repository {
    /// Creates repository analysis state and opens its private syntax index.
    /// `directory` identifies the inspected repository; `state` stores the cache, while `parser_root`,
    /// `python` and `node` locate installed helpers. No snapshot is parsed until requested.
    ///
    /// # Errors
    /// Returns an error if repository or relative parser-root paths cannot be resolved.
    pub fn new(
        directory: PathBuf,
        state: &Path,
        parser_root: PathBuf,
        python: String,
        node: String,
    ) -> Result<Self> {
        let directory = directory.canonicalize()?;
        let parser_root = if parser_root.is_absolute() {
            parser_root
        } else {
            std::env::current_dir()?.join(parser_root)
        };
        let helper = std::fs::read(parser_root.join("backend/adapters/typescript_ast.mjs"))
            .unwrap_or_default();
        let version = hash(
            [
                include_bytes!("engine.rs").as_slice(),
                include_bytes!("adapters/rust.rs").as_slice(),
                include_bytes!("adapters/rust_relationships.rs").as_slice(),
                include_bytes!("relationships.rs").as_slice(),
                include_bytes!("rules.rs").as_slice(),
                include_bytes!("adapters/python_ast.py").as_slice(),
                include_bytes!("adapters/mod.rs").as_slice(),
                include_bytes!("adapters/python.rs").as_slice(),
                include_bytes!("adapters/typescript.rs").as_slice(),
                helper.as_slice(),
            ]
            .concat(),
        );
        let index = Index::new(
            &state.join("index-rust"),
            &hash(directory.to_string_lossy().as_bytes()),
        );
        Ok(Self {
            directory,
            state: state.to_path_buf(),
            parser_config: Config {
                python,
                node,
                root: parser_root,
            },
            index,
            cache: VecDeque::new(),
            comparisons: VecDeque::new(),
            version,
            identities: HashMap::new(),
            parsed: 0,
            reused: 0,
            snapshots: 0,
        })
    }
    /// Runs Git against this repository with explicit arguments and captures stdout.
    /// Returns subprocess errors; callers choose the read-only Git operation. Git also reads
    /// the snapshots of uncommitted changes, so it must never write objects here.
    fn git(&self, args: &[&str]) -> Result<Vec<u8>> {
        self.git_with(args, vec![])
    }
    fn git_with(&self, args: &[&str], input: Vec<u8>) -> Result<Vec<u8>> {
        let directory = self.directory.to_string_lossy();
        let mut command = vec!["-C", &directory];
        command.extend_from_slice(args);
        crate::process::run_env(
            "git",
            &command,
            None,
            input,
            std::time::Duration::from_secs(30),
            &crate::worktree::read_env(&self.state),
        )
    }
    /// Resolves a branch, tag or commit reference to a full commit SHA.
    /// Rejects empty, option-like, oversized or NUL-containing references and returns Git resolution errors.
    pub fn resolve(&self, reference: &str) -> Result<String> {
        if reference.is_empty()
            || reference.starts_with('-')
            || reference.encode_utf16().count() > 200
            || reference.contains('\0')
        {
            bail!("Invalid Git revision")
        }
        Ok(string(self.git(&[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ])?)
        .trim()
        .into())
    }
    /// Returns checkout identity, available local/remote-tracking branches (most recent commit first) and first-parent history for the selected head.
    /// `main` names the main branch and its merge base with the head, or is null.
    /// Reads refs and objects only; never checks out a branch or fetches remote refs.
    /// An invalid base falls back to the oldest listed commit; an invalid head or unreadable history is an error.
    pub fn metadata(&self, base: &str, head: &str) -> Result<Value> {
        let branch = string(self.git(&["branch", "--show-current"])?);
        let initial_head = self.resolve(head)?;
        let refs = string(self.git(&[
            "for-each-ref",
            // Most recent first: the branches people work on are at the top of the list.
            "--sort=-committerdate",
            "--format=%(refname)%00%(objectname)%00%(symref)",
            "refs/heads",
            "refs/remotes",
        ])?);
        let branches: Vec<Value> = refs
            .lines()
            .filter_map(|line| {
                let fields: Vec<_> = line.split('\0').collect();
                if fields.len() < 3 || !fields[2].is_empty() {
                    return None;
                }
                let remote = fields[0].starts_with("refs/remotes/");
                let name = fields[0]
                    .trim_start_matches("refs/heads/")
                    .trim_start_matches("refs/remotes/");
                Some(json!({"ref":fields[0], "name":name, "sha":fields[1], "remote":remote}))
            })
            .collect();
        let selected_branch = branches
            .iter()
            .find(|b| {
                text(&b["ref"]) == head
                    || text(&b["name"]) == head
                    || (head == "HEAD"
                        && !b["remote"].as_bool().unwrap_or(false)
                        && text(&b["name"]) == branch.trim())
            })
            .cloned();
        let (mut commits, more) = self.first_parents(&initial_head, false)?;
        // The checked-out branch also has its uncommitted changes.
        let checked_out = head == "HEAD"
            || selected_branch.as_ref().is_some_and(|b| {
                !b["remote"].as_bool().unwrap_or(true) && text(&b["name"]) == branch.trim()
            });
        // A snapshot that fails (too many files, say) leaves out only the uncommitted changes.
        let snapshot = checked_out
            .then(|| crate::worktree::snapshot(&self.directory, &self.state))
            .and_then(|done| {
                done.unwrap_or_else(|e| {
                    eprintln!("Uncommitted changes: {e}");
                    None
                })
            });
        // The newest commit carries them: its map includes them (see the frontend).
        if let (Some((sha, paths)), Some(newest)) = (snapshot, commits.first_mut()) {
            newest["uncommitted"] = json!({"sha": sha, "paths": paths});
        }
        let base = self.resolve(base).or_else(|_| {
            commits
                .last()
                .map(|v| text(&v["sha"]).to_string())
                .context("Repository has no commits")
        })?;
        let root = string(self.git(&["rev-parse", "--show-toplevel"])?);
        // "This branch against main": where the head left the main branch (the pull request
        // view). The local main comes first, then the remote one; null when neither exists or
        // the histories share no commit.
        let main = [
            "refs/heads/main",
            "refs/heads/master",
            "refs/remotes/origin/main",
            "refs/remotes/origin/master",
        ]
        .iter()
        .find_map(|r| branches.iter().find(|b| text(&b["ref"]) == *r))
        .and_then(|b| {
            let fork = self
                .git(&["merge-base", text(&b["sha"]), &initial_head])
                .ok()?;
            Some(json!({"name": b["name"], "base": string(fork).trim()}))
        });
        Ok(
            json!({"name":Path::new(root.trim()).file_name().unwrap_or_default().to_string_lossy(),"branch":if branch.trim().is_empty(){"detached HEAD"}else{branch.trim()},"commits":commits,"moreCommits":more,"initialBase":base,"initialHead":initial_head,"branches":branches,"selectedBranch":selected_branch,"main":main}),
        )
    }
    /// Returns one page of the first-parent history from `start`, newest first, and whether
    /// older commits exist. With `after`, the page starts at `start`'s first parent, so the
    /// interface can load the history page by page.
    fn first_parents(&self, start: &str, after: bool) -> Result<(Vec<Value>, bool)> {
        const PAGE: usize = 80;
        let count = format!("-{}", PAGE + 1 + usize::from(after));
        let log = string(self.git(&[
            "log",
            "--first-parent",
            &count,
            "--format=%H%x00%h%x00%s%x00%aI%x00%P%x00",
            "--end-of-options",
            start,
        ])?);
        let values: Vec<_> = log.trim().split('\0').collect();
        let mut commits = vec![];
        for fields in values.chunks(5) {
            if fields.len() < 5 {
                break;
            }
            let parent = fields[4].split(' ').next().filter(|p| !p.is_empty());
            commits.push(json!({"sha":fields[0].trim(),"short":fields[1],"subject":fields[2],"time":fields[3],"parent":parent}));
        }
        if after && !commits.is_empty() {
            commits.remove(0);
        }
        let more = commits.len() > PAGE;
        commits.truncate(PAGE);
        Ok((commits, more))
    }
    /// The page of first-parent history before commit `before` (older commits for Time and
    /// the comparison pickers): `{commits, more}`.
    pub fn earlier_commits(&self, before: &str) -> Result<Value> {
        let (commits, more) = self.first_parents(&self.resolve(before)?, true)?;
        Ok(json!({"commits": commits, "more": more}))
    }
    /// Loads an immutable snapshot, reusing up to six cached revisions.
    /// Symbolic references are resolved again so advancing HEAD is visible; cache misses read committed Git objects.
    fn snapshot(&mut self, reference: &str) -> Result<Arc<Snapshot>> {
        if let Some(snapshot) = self.cache.iter().find(|s| s.sha == reference) {
            return Ok(snapshot.clone());
        }
        let sha = self.resolve(reference)?;
        if let Some(snapshot) = self.cache.iter().find(|s| s.sha == sha) {
            return Ok(snapshot.clone());
        }
        let snapshot = Arc::new(self.build(sha)?);
        self.cache.push_back(snapshot.clone());
        while self.cache.len() > 6 {
            self.cache.pop_front();
        }
        Ok(snapshot)
    }
    /// Reads a committed tree and batches uncached source through the language adapter registry.
    /// Labels restricted, binary, oversized and unsupported entries without losing them from the map.
    /// Updates the syntax index and resolves imports in this tree; Git read failures return an error.
    fn build(&mut self, sha: String) -> Result<Snapshot> {
        self.snapshots += 1;
        let tree = string(self.git(&["ls-tree", "-rlz", &sha])?);
        let mut files = BTreeMap::new();
        let mut candidates = vec![];
        for line in tree.split('\0').filter(|s| !s.is_empty()) {
            let (header, path) = line.split_once('\t').context("Invalid Git tree")?;
            let parts: Vec<_> = header.split_whitespace().collect();
            if parts.len() != 4 {
                bail!("Invalid Git tree entry")
            }
            let mut file = File {
                path: path.into(),
                mode: parts[0].into(),
                oid: parts[2].into(),
                size: parts[3].parse().unwrap_or(0),
                ..File::default()
            };
            file.analysis = if restricted(path) {
                "restricted · source hidden"
            } else if file.mode == "120000" {
                "symlink · not followed"
            } else if parts[1] != "blob" {
                "submodule · not expanded"
            } else if file.size > 512 * 1024 {
                "large file · source omitted"
            } else {
                candidates.push(path.to_string());
                "file-level analysis"
            }
            .into();
            files.insert(path.to_string(), file);
        }
        if !candidates.is_empty() {
            let input = candidates
                .iter()
                .map(|p| format!("{}\n", files[p].oid))
                .collect::<String>();
            let data = self.git_with(&["cat-file", "--batch"], input.into_bytes())?;
            let mut offset = 0;
            let mut batches: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
            for path in candidates {
                let newline = offset
                    + data
                        .get(offset..)
                        .context("Truncated Git data")?
                        .iter()
                        .position(|b| *b == b'\n')
                        .context("Truncated Git header")?;
                let size = String::from_utf8_lossy(&data[offset..newline])
                    .split_whitespace()
                    .nth(2)
                    .context("Missing blob size")?
                    .parse::<usize>()?;
                let raw = data
                    .get(newline + 1..newline + 1 + size)
                    .context("Truncated blob")?;
                offset = newline + size + 2;
                let file = files.get_mut(&path).unwrap();
                if raw.contains(&0) {
                    file.analysis = "binary · source omitted".into();
                    continue;
                }
                file.source = Some(String::from_utf8_lossy(raw).into_owned());
                let Some(adapter) = adapters::for_path(&path) else {
                    continue;
                };
                let identity = self
                    .identities
                    .entry(adapter.id().into())
                    .or_insert_with(|| adapter.identity(&self.parser_config));
                let ext = path.rsplit('.').next().unwrap_or("");
                let key = format!("{}:{identity}:{ext}:{}", self.version, file.oid);
                if let Some(value) = self.index.get(&key) {
                    file.apply(value);
                    self.reused += 1;
                } else {
                    batches
                        .entry(adapter.id().into())
                        .or_default()
                        .push((path, key));
                }
            }
            let mut jobs = vec![];
            for adapter in adapters::all() {
                let Some(missing) = batches.remove(adapter.id()) else {
                    continue;
                };
                let input = missing
                    .iter()
                    .map(|(p, _)| (p.clone(), files[p].source.clone().unwrap()))
                    .collect::<Vec<_>>();
                let config = self.parser_config.clone();
                jobs.push((
                    adapter,
                    missing,
                    std::thread::spawn(move || adapter.analyze(&input, &config)),
                ));
            }
            for (adapter, missing, job) in jobs {
                match job
                    .join()
                    .unwrap_or_else(|_| Err(anyhow::anyhow!("Parser worker failed")))
                {
                    Ok(values) if values.len() == missing.len() => {
                        for ((p, key), value) in missing.into_iter().zip(values) {
                            self.index.set(key, value.clone());
                            files.get_mut(&p).unwrap().apply(value);
                            self.parsed += 1;
                        }
                    }
                    _ => {
                        for (p, _) in missing {
                            files.get_mut(&p).unwrap().analysis =
                                format!("{} unavailable · file-level analysis", adapter.name());
                        }
                    }
                }
            }
        }
        self.index.flush();
        resolve_imports(&mut files);
        let (relationships, checks) = analyze_relationships(&files);
        Ok(Snapshot {
            sha,
            files,
            relationships,
            checks,
        })
    }
    /// Finds lines containing `query` (case-sensitive, literal) in readable files of one committed
    /// revision, optionally under a path prefix. Each match names the innermost declaration it sits
    /// in, so call sites the static analysis cannot resolve (inside macros, say) are still found.
    /// Returns at most 40 matches and how many more there were.
    pub fn search(&mut self, revision: &str, query: &str, prefix: &str) -> Result<Value> {
        anyhow::ensure!(
            !query.is_empty() && query.len() <= 200,
            "Search text must be 1 to 200 characters"
        );
        let snapshot = self.snapshot(revision)?;
        let (mut matches, mut total) = (vec![], 0usize);
        for file in snapshot.files.values() {
            if !file.path.starts_with(prefix) {
                continue;
            }
            let Some(source) = file.source.as_deref() else {
                continue;
            };
            for (index, line) in source.lines().enumerate() {
                if !line.contains(query) {
                    continue;
                }
                total += 1;
                if matches.len() >= 40 {
                    continue;
                }
                let number = index as u64 + 1;
                let within = file
                    .symbols
                    .iter()
                    .filter(|s| {
                        s["start"].as_u64().is_some_and(|start| start <= number)
                            && s["end"].as_u64().is_some_and(|end| end >= number)
                    })
                    .min_by_key(|s| {
                        s["end"].as_u64().unwrap_or(0) - s["start"].as_u64().unwrap_or(0)
                    })
                    .map(|s| s["name"].clone())
                    .unwrap_or(Value::Null);
                let text: String = line.trim().chars().take(160).collect();
                matches.push(json!({"path":file.path,"line":number,"within":within,"text":text}));
            }
        }
        Ok(json!({"matches":matches,"more":total.saturating_sub(matches.len())}))
    }
    /// Returns directory descriptions at both revisions plus available adapter capabilities.
    /// Descriptions come from committed READMEs or Python package docstrings; snapshot failures are propagated.
    pub fn directories(&mut self, base: &str, head: &str) -> Result<Value> {
        let a = self.snapshot(base)?;
        let b = self.snapshot(head)?;
        Ok(
            json!({"before":directory_descriptions(&a),"after":directory_descriptions(&b),"adapters":adapters::descriptors()}),
        )
    }
    /// Returns static relationships and rule outcomes for both committed revisions.
    /// Overview aggregates file pairs; a file query includes incoming, outgoing and unresolved evidence.
    pub fn relationships(
        &mut self,
        base: &str,
        head: &str,
        path: &str,
        overview: bool,
    ) -> Result<Value> {
        let a = self.snapshot(base)?;
        let b = self.snapshot(head)?;
        let select = |snapshot: &Snapshot| -> Vec<Value> {
            if overview && path.is_empty() {
                return crate::relationships::overview(&snapshot.relationships);
            }
            let values = snapshot
                .relationships
                .iter()
                .filter(|r| {
                    path.is_empty()
                        || r["source"]["path"] == path
                        || r["targets"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|t| t["path"] == path)
                })
                .cloned()
                .collect::<Vec<_>>();
            if overview {
                crate::relationships::overview(&values)
            } else {
                values
            }
        };
        let left = select(&a);
        let right = select(&b);
        if overview {
            return Ok(
                json!({"base":a.sha,"head":b.sha,"compact":true,"pairs":crate::relationships::compact(&left,&right),"checks":{"before":a.checks,"after":b.checks,"added":added_breaks(&a.relationships,&b.relationships)}}),
            );
        }
        Ok(
            json!({"base":a.sha,"head":b.sha,"relationships":crate::relationships::compare(&left,&right),"checks":{"before":a.checks,"after":b.checks,"added":added_breaks(&a.relationships,&b.relationships)}}),
        )
    }
    /// The proposed fixes for the rule breaks at `head` (see [`propose_fixes`]), and the state of
    /// its rule configuration.
    pub fn fixes(&mut self, head: &str) -> Result<Value> {
        let b = self.snapshot(head)?;
        Ok(json!({"head": b.sha, "checks": b.checks, "fixes": propose_fixes(&b.relationships)}))
    }
    /// Tries a proposed rule at `head` without a commit: `proposal` is `{groups, rule}`, added
    /// to the committed `.peekumi.json` (or to an empty one). A group name that the file uses
    /// for other patterns gets a new name (`ui-2`), so the rule keeps its own files and the
    /// file's group stays as it is; a warning says so. Returns what the rule would check now
    /// (`checked`, `broke`, `unresolved`), up to five of its breaks (`examples`), the warnings
    /// about its own groups and rule, the groups and the rule as it uses them (`groups`,
    /// `rule`), and the whole configuration with it (`config`).
    ///
    /// # Errors
    /// A rule ID that the configuration already has, a rule that checks the same files as a
    /// current rule or that a current rule covers, and any configuration that the rule engine
    /// refuses.
    pub fn rule_trial(&mut self, head: &str, proposal: &Value) -> Result<Value> {
        let b = self.snapshot(head)?;
        let committed = crate::rules::CONFIG_FILES
            .iter()
            .find_map(|name| b.files.get(*name)?.source.as_deref())
            .filter(|source| crate::rules::parse(source).is_ok())
            .and_then(|source| serde_json::from_str::<Value>(source).ok());
        let mut config =
            committed.unwrap_or_else(|| json!({"version": 1, "groups": {}, "rules": []}));
        let groups = proposal["groups"]
            .as_object()
            .context("The proposal needs groups")?;
        // The rules as they are now, before the proposal joins them.
        let current = crate::rules::parse(&config.to_string()).ok();
        // A group that the rule file has with the same patterns is that group. A group name
        // that the file uses for other patterns gets a new name: the rule keeps its own files,
        // and the file's group stays as it is (another rule can depend on it).
        let mut used = serde_json::Map::new();
        let mut adopted = vec![];
        let mut rule = proposal["rule"].clone();
        for (name, patterns) in groups {
            let mut chosen = name.clone();
            if config["groups"]
                .get(name)
                .is_some_and(|existing| existing != patterns)
            {
                chosen = (2..)
                    .map(|n| format!("{name}-{n}"))
                    .find(|n| config["groups"].get(n).is_none_or(|g| g == patterns))
                    .unwrap_or_default();
                adopted.push(format!(
                    "Group \"{name}\" has other patterns in the rule file, so this rule uses a new group \"{chosen}\" with its own patterns."
                ));
                rename_group(&mut rule, name, &chosen);
            }
            if config["groups"].get(&chosen).is_none() {
                config["groups"][&chosen] = patterns.clone();
            }
            used.insert(chosen, patterns.clone());
        }
        let rule = &rule;
        let id = rule["id"].as_str().unwrap_or("");
        if config["rules"]
            .as_array()
            .is_some_and(|rules| rules.iter().any(|r| r["id"] == id))
        {
            bail!("A rule with the ID \"{id}\" already exists");
        }
        let paths: Vec<&str> = b.files.keys().map(String::as_str).collect();
        // Only files that a language adapter reads can be in a relationship.
        let code: Vec<&str> = paths
            .iter()
            .copied()
            .filter(|path| adapters::for_path(path).is_some())
            .collect();
        let key = rule_key(&config["groups"], rule, &paths);
        if let Some(same) = config["rules"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| rule_key(&config["groups"], r, &paths) == key)
        {
            bail!(
                "It checks the same files as the rule \"{}\"",
                same["id"].as_str().unwrap_or("")
            );
        }
        config["rules"]
            .as_array_mut()
            .context("The configuration has no rules list")?
            .push(rule.clone());
        crate::rules::parse(&config.to_string())?;
        // The rule alone, with every group, so its numbers are its own.
        let alone = crate::rules::parse(
            &json!({"version": 1, "groups": config["groups"], "rules": [rule]}).to_string(),
        )?;
        if let Some(by) = current.and_then(|current| alone.covered_by(&current, &code)) {
            bail!("The rule \"{by}\" already covers it: each break of it also breaks that rule");
        }
        let mut relations = b.relationships.clone();
        for r in &mut relations {
            r["violations"] = json!([]);
        }
        alone.apply(&mut relations);
        let (coverage, warnings) = alone.coverage(&relations, &paths);
        let own: Vec<&String> = used.keys().collect();
        let warnings: Vec<String> = adopted
            .into_iter()
            .chain(warnings.into_iter().filter(|w| {
                own.iter().any(|g| w.contains(&format!("\"{g}\"")))
                    || w.contains(&format!("\"{id}\""))
            }))
            .collect();
        let examples: Vec<Value> = relations
            .iter()
            .filter(|r| !array(&r["violations"]).is_empty())
            .take(5)
            .map(|r| json!({"source": r["source"]["path"], "target": r["targets"][0]["path"], "kind": r["kind"]}))
            .collect();
        let numbers = &coverage[0];
        Ok(json!({
            "id": id,
            "key": key,
            "scope": rule_shape(&config["groups"], rule, &paths, false),
            "checked": numbers["checked"],
            "broke": numbers["broke"],
            "unresolved": numbers["unresolved"],
            "warnings": warnings,
            "examples": examples,
            "groups": used,
            "rule": rule,
            "config": config,
        }))
    }
    /// For each of `proposals` (`[{groups, rule}]`) at `head`: the index of a different
    /// proposal that covers it (each of its breaks also breaks that one), or null. Of two
    /// proposals that cover each other, the first one stays. A group name that the committed
    /// rule file has keeps the file's patterns, as in [`Repository::rule_trial`].
    pub fn rule_overlaps(&mut self, head: &str, proposals: &Value) -> Result<Value> {
        let b = self.snapshot(head)?;
        let groups = crate::rules::CONFIG_FILES
            .iter()
            .find_map(|name| b.files.get(*name)?.source.as_deref())
            .filter(|source| crate::rules::parse(source).is_ok())
            .and_then(|source| serde_json::from_str::<Value>(source).ok())
            .map(|config| config["groups"].clone())
            .unwrap_or_else(|| json!({}));
        let code: Vec<&str> = b
            .files
            .keys()
            .map(String::as_str)
            .filter(|path| adapters::for_path(path).is_some())
            .collect();
        Ok(json!(overlaps(&groups, &array(proposals), &code)))
    }
    /// The dependency cycles between files at `head`: each group of two or more files that
    /// reach each other through resolved relationships, the largest first (at most 10, each
    /// with at most 10 of its files and its `size`).
    pub fn cycles(&mut self, head: &str) -> Result<Value> {
        let b = self.snapshot(head)?;
        Ok(json!(file_cycles(&b.relationships)))
    }
    /// Compares two Git revisions and returns file statuses and dependency changes.
    /// `overview` replaces full symbol lists with counts and compact previews for the initial map.
    /// Caches up to six comparison results; invalid revisions or snapshot failures return an error.
    pub fn compare(&mut self, base: &str, head: &str, overview: bool) -> Result<Value> {
        let a = self.snapshot(base)?;
        let b = self.snapshot(head)?;
        let key = format!("{}:{}", a.sha, b.sha);
        if let Some((_, _, value)) = self
            .comparisons
            .iter()
            .find(|(k, v, _)| k == &key && *v == overview)
        {
            return Ok(value.clone());
        }
        let paths: BTreeSet<_> = a.files.keys().chain(b.files.keys()).collect();
        let mut paths: Vec<_> = paths.into_iter().collect();
        paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let files: Vec<_> = paths
            .into_iter()
            .map(|p| compare_file(p, a.files.get(p), b.files.get(p), overview))
            .collect();
        let value = json!({"base":a.sha,"head":b.sha,"files":files});
        self.comparisons.push_back((key, overview, value.clone()));
        while self.comparisons.len() > 6 {
            self.comparisons.pop_front();
        }
        Ok(value)
    }
    /// Returns before/after source, symbol metadata and a unified diff for one repository-relative path.
    /// Disables external diff drivers and text conversion. Unreadable entries omit source;
    /// a missing path, invalid revision or Git failure returns an error.
    pub fn source(&mut self, base: &str, head: &str, path: &str) -> Result<Value> {
        let a = self.snapshot(base)?;
        let b = self.snapshot(head)?;
        let before = a.files.get(path);
        let after = b.files.get(path);
        let current = after.or(before).context("File not present in comparison")?;
        let readable = before.into_iter().chain(after).all(|f| f.source.is_some());
        let patch = if readable {
            string(self.git(&[
                "--no-pager",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--unified=4",
                &a.sha,
                &b.sha,
                "--",
                &format!(":(literal){path}"),
            ])?)
        } else {
            String::new()
        };
        Ok(
            json!({"path":path,"before":before.and_then(|f|f.source.as_ref()),"after":after.and_then(|f|f.source.as_ref()),"patch":patch,"analysis":current.analysis,"symbols":compare_symbols(before,after),"imports":current.imports,"details":{"before":before.map(File::details),"after":after.map(File::details)}}),
        )
    }
    /// Returns analysis counters for parsed blobs, reused results and built snapshots.
    /// These are operational counters, not code-quality or health measurements.
    pub fn metrics(&self) -> Value {
        json!({"parsed":self.parsed,"reused":self.reused,"snapshots":self.snapshots})
    }
}
/// Classifies optional before/after identities as added, removed, unchanged or changed.
fn status<T: PartialEq>(a: Option<T>, b: Option<T>) -> &'static str {
    match (a, b) {
        (None, _) => "added",
        (_, None) => "removed",
        (Some(a), Some(b)) if a == b => "unchanged",
        _ => "changed",
    }
}
/// Matches symbols by qualified name within a file and compares their hashes.
/// Preserves old line ranges for removed or changed symbols while keeping documentation out of this payload.
fn compare_symbols(a: Option<&File>, b: Option<&File>) -> Vec<Value> {
    let mut names = vec![];
    let mut seen = BTreeSet::new();
    let mut before = HashMap::new();
    let mut after = HashMap::new();
    for s in a.into_iter().flat_map(|f| &f.symbols) {
        let name = text(&s["name"]);
        before.insert(name, s);
        if seen.insert(name) {
            names.push(name)
        }
    }
    for s in b.into_iter().flat_map(|f| &f.symbols) {
        let name = text(&s["name"]);
        after.insert(name, s);
        if seen.insert(name) {
            names.push(name)
        }
    }
    names.into_iter().map(|name|{let a=before.get(name).copied();let b=after.get(name).copied();let cur=b.or(a).unwrap();let mut v=json!({"name":name,"kind":cur["kind"],"start":cur["start"],"end":cur["end"],"status":status(a.map(|v|&v["hash"]),b.map(|v|&v["hash"])),"before":a.map(|v|json!({"start":v["start"],"end":v["end"]}))});if v["status"]=="changed"&&let(Some(a),Some(b))=(a,b){v["changes"]=changes(a,b);}v}).collect()
}
/// Names which parts of a changed declaration differ: `signature` (parameters, return type,
/// bases or fields), `documentation` (authored doc comments or docstrings) and
/// `implementation` (the body without documentation). This is a syntactic comparison, not a
/// behavioural one; a change outside these parts, such as a decorator, yields an empty list.
fn changes(a: &Value, b: &Value) -> Value {
    let shape = |v: &Value| {
        let mut details = v["details"].clone();
        if let Some(fields) = details.as_object_mut() {
            fields.remove("description");
            fields.remove("provenance");
        }
        details
    };
    let mut parts = Vec::new();
    if shape(a) != shape(b) {
        parts.push("signature");
    }
    if a["details"]["description"] != b["details"]["description"] {
        parts.push("documentation");
    }
    if a["body"] != b["body"] {
        parts.push("implementation");
    }
    json!(parts)
}
/// Builds one comparison entry from optional before/after files.
/// Includes both dependency sets and either full symbols or compact overview previews.
fn compare_file(path: &str, a: Option<&File>, b: Option<&File>, overview: bool) -> Value {
    let cur = b.or(a).unwrap();
    let symbols = compare_symbols(a, b);
    let mut v = json!({"path":path,"status":status(a.map(|f|(&f.mode,&f.oid)),b.map(|f|(&f.mode,&f.oid))),"size":cur.size,"analysis":cur.analysis,"deps":b.map(|f|f.deps.clone()).unwrap_or_default(),"beforeDeps":a.map(|f|f.deps.clone()).unwrap_or_default(),"readable":cur.source.is_some()});
    if overview {
        v["symbolCount"] = json!(symbols.len());
        v["symbolPreview"] = json!(
            symbols
                .iter()
                .take(22)
                .map(|s| match s.get("changes") {
                    Some(changes) => json!({"status":s["status"],"changes":changes}),
                    None => json!({"status":s["status"]}),
                })
                .collect::<Vec<_>>()
        );
    } else {
        v["symbols"] = json!(symbols);
        v["imports"] = json!(cur.imports);
    }
    v
}
// Descriptions come only from committed documentation in this exact directory.
/// Selects documentation from each exact directory in one committed snapshot.
/// Prefers README variants over Python package docstrings and limits descriptions to 600 characters.
/// Each result names its source file and revision; child-directory documentation is never inherited.
fn directory_descriptions(snapshot: &Snapshot) -> Value {
    let mut descriptions = BTreeMap::new();
    let mut candidates = snapshot
        .files
        .values()
        .filter_map(|file| {
            let name = file.path.rsplit('/').next()?.to_ascii_lowercase();
            let priority = match name.as_str() {
                "readme.md" => 0,
                "readme.rst" => 1,
                "readme.txt" => 2,
                "readme" => 3,
                "__init__.py" => 4,
                _ => return None,
            };
            Some((priority, file))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(priority, file)| (*priority, &file.path));
    for (priority, file) in candidates {
        let directory = file.path.rsplit_once('/').map(|v| v.0).unwrap_or("");
        if descriptions.contains_key(directory) {
            continue;
        }
        let Some(source) = file.source.as_deref() else {
            continue;
        };
        let description = if priority == 4 {
            file.details
                .as_ref()
                .map(|v| text(&v["description"]))
                .unwrap_or("")
                .to_string()
        } else {
            document_summary(source)
        };
        let summary = description.chars().take(600).collect::<String>();
        if summary.trim().is_empty() {
            continue;
        }
        descriptions.insert(directory,json!({"description":summary,"path":file.path,"revision":snapshot.sha,"provenance":if priority==4 {"Python package docstring"} else {"Directory README"}}));
    }
    json!(descriptions)
}
/// Extracts the first prose block used as a directory description.
/// Skips fenced code, headings, images, badges, rules and lines of pure HTML markup; returns
/// plain text, not rendered Markdown.
fn document_summary(source: &str) -> String {
    let mut lines = vec![];
    let mut fence = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        if trimmed.is_empty() {
            if !lines.is_empty() {
                break;
            }
            continue;
        }
        // Headings, images, badges, rules and lines of pure HTML markup (a centred logo, say)
        // are decoration, not the description.
        if trimmed.starts_with('#')
            || trimmed.starts_with("![")
            || trimmed.starts_with("[![")
            || trimmed.starts_with("<!--")
            || (trimmed.starts_with('<') && trimmed.ends_with('>'))
            || trimmed.chars().all(|c| c == '=' || c == '-')
        {
            continue;
        }
        lines.push(trimmed);
    }
    lines.join(" ")
}
/// Builds resolved declaration evidence and checks only the committed root rule configuration.
fn analyze_relationships(files: &BTreeMap<String, File>) -> (Vec<Value>, Value) {
    let context = crate::relationships::Context {
        paths: adapters::Resolution::new(files.keys().cloned().collect()),
        symbols: files
            .iter()
            .map(|(p, f)| (p.clone(), f.symbols.clone()))
            .collect(),
        imports: files
            .iter()
            .map(|(p, f)| (p.clone(), f.imports.clone()))
            .collect(),
    };
    let mut merged: BTreeMap<String, Value> = BTreeMap::new();
    for file in files.values() {
        let Some(adapter) = adapters::for_path(&file.path) else {
            continue;
        };
        let mut values = file
            .relationships
            .iter()
            .map(|raw| {
                crate::relationships::normalize(
                    &file.path,
                    raw,
                    adapter.resolve_relationship(&file.path, raw, &context),
                )
            })
            .collect::<Vec<_>>();
        for import in &file.imports {
            let spec = text(&import["specifier"]);
            let paths = array(&import["resolved"]);
            if paths.is_empty() {
                values.push(crate::relationships::normalize(&file.path,&json!({"source":"","target":spec,"kind":"imports","reason":"External or unresolved import"}),vec![]));
            }
            for path in paths {
                values.push(crate::relationships::normalize(&file.path,&json!({"source":"","target":format!("{spec} → {}",text(&path)),"kind":"imports"}),vec![json!({"path":path,"symbol":""})]));
            }
        }
        for value in values {
            let id = text(&value["id"]).to_string();
            if let Some(previous) = merged.get_mut(&id) {
                for site in array(&value["sites"]) {
                    if !previous["sites"].as_array().unwrap().contains(&site) {
                        previous["sites"].as_array_mut().unwrap().push(site);
                    }
                }
            } else {
                merged.insert(id, value);
            }
        }
    }
    let mut values = merged.into_values().collect::<Vec<_>>();
    // `.peekumi.json` holds dependency rules; `.strata.json` is read in repositories that
    // configured rules before the rename.
    let (name, config) = crate::rules::CONFIG_FILES
        .iter()
        .find_map(|name| files.get(*name).map(|file| (*name, Some(file))))
        .unwrap_or((crate::rules::CONFIG_FILES[0], None));
    let mut checks = json!({"config":name,"state":"not configured","rules":0,"errors":[]});
    if let Some(file) = config {
        match file
            .source
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("Rule configuration is unreadable"))
            .and_then(crate::rules::parse)
        {
            Ok(rules) => {
                rules.apply(&mut values);
                checks["state"] = json!("evaluated");
                checks["rules"] = json!(rules.count());
                let paths: Vec<&str> = files.keys().map(String::as_str).collect();
                let (coverage, warnings) = rules.coverage(&values, &paths);
                checks["coverage"] = json!(coverage);
                checks["warnings"] = json!(warnings);
            }
            Err(error) => {
                checks["state"] = json!("invalid");
                checks["errors"] = json!([error.to_string()]);
            }
        }
    }
    checks["unresolved"] = json!(
        values
            .iter()
            .filter(|r| r["resolution"] != "resolved")
            .count()
    );
    checks["violations"] = json!(
        values
            .iter()
            .map(|r| array(&r["violations"]).len())
            .sum::<usize>()
    );
    checks["analysisGaps"] = json!(
        files
            .values()
            .filter(|f| adapters::for_path(&f.path).is_some()
                && (f.source.is_none()
                    || f.analysis.contains("unavailable")
                    || f.analysis.contains("parse error")))
            .map(|f| json!({"path":f.path,"reason":f.analysis}))
            .collect::<Vec<_>>()
    );
    (values, checks)
}
/// Renames group `from` to `to` where `rule` names it: in `from`, `to`, `only` and `layers`.
fn rename_group(rule: &mut Value, from: &str, to: &str) {
    if rule["from"] == from {
        rule["from"] = json!(to);
    }
    // `get_mut`, not indexing: an index adds a missing field as null.
    for field in ["to", "only", "layers"] {
        if let Some(list) = rule.get_mut(field).and_then(Value::as_array_mut) {
            for name in list.iter_mut().filter(|n| *n == from) {
                *name = json!(to);
            }
        }
    }
}

/// What a rule checks, as a short hash. Two rules with the same key check the same thing,
/// whatever their IDs and group names: the same form and kinds, the same source files and the
/// same target files. Only files that a language adapter reads count, because only they can
/// be in a relationship. The target groups of a `to` or `only` rule count as one set. When the
/// source is one file, that file leaves the target set: a file that uses itself never breaks a
/// rule. A group that matches no file yet counts by its patterns. Without `kinds`, the key is
/// the rule's scope: the same files, whatever kinds it checks.
fn rule_key(groups: &Value, rule: &Value, paths: &[&str]) -> String {
    rule_shape(groups, rule, paths, true)
}
/// See [`rule_key`].
fn rule_shape(groups: &Value, rule: &Value, paths: &[&str], with_kinds: bool) -> String {
    let patterns = |name: &Value| -> Vec<&str> {
        groups[name.as_str().unwrap_or("")]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect()
    };
    let files = |name: &Value| -> BTreeSet<&str> {
        let patterns = patterns(name);
        paths
            .iter()
            .copied()
            .filter(|path| adapters::for_path(path).is_some())
            .filter(|path| patterns.iter().any(|p| crate::rules::matches(p, path)))
            .collect()
    };
    // A group's files, or its patterns when it matches none.
    let set = |name: &Value| -> Value {
        let found = files(name);
        if found.is_empty() {
            let mut sorted = patterns(name);
            sorted.sort_unstable();
            json!({"patterns": sorted})
        } else {
            json!(found)
        }
    };
    // The target groups as one set of files, and the patterns of those that match none.
    let targets = |field: &str, source: &BTreeSet<&str>| -> Value {
        let (mut all, mut future) = (BTreeSet::new(), BTreeSet::new());
        for name in array(&rule[field]) {
            let found = files(&name);
            if found.is_empty() {
                future.extend(patterns(&name));
            }
            all.extend(found);
        }
        if source.len() == 1 {
            all.retain(|f| !source.contains(f));
        }
        json!({"files": all, "patterns": future})
    };
    let mut kinds: Vec<String> = array(&rule["kinds"])
        .iter()
        .map(|k| text(k).to_string())
        .collect();
    kinds.sort_unstable();
    if !with_kinds {
        kinds.clear();
    }
    let shape = if rule.get("layers").is_some() {
        json!({"layers": array(&rule["layers"]).iter().map(set).collect::<Vec<_>>(), "kinds": kinds})
    } else {
        let source = files(&rule["from"]);
        let field = if rule.get("only").is_some() {
            "only"
        } else {
            "to"
        };
        json!({"from": set(&rule["from"]), field: targets(field, &source), "kinds": kinds})
    };
    hash(shape.to_string().as_bytes())[..16].to_string()
}

/// See [`Repository::rule_overlaps`]: `groups` are the rule file's groups and `code` the files
/// that a language adapter reads.
fn overlaps(groups: &Value, proposals: &[Value], code: &[&str]) -> Vec<Option<usize>> {
    let rules: Vec<Option<crate::rules::Rules>> = proposals
        .iter()
        .map(|p| {
            let mut all = groups.clone();
            for (name, patterns) in p["groups"].as_object()? {
                if all.get(name).is_none() {
                    all[name] = patterns.clone();
                }
            }
            crate::rules::parse(
                &json!({"version": 1, "groups": all, "rules": [p["rule"]]}).to_string(),
            )
            .ok()
        })
        .collect();
    let breaks: Vec<Option<crate::rules::Breaks>> = rules
        .iter()
        .map(|r| r.as_ref()?.breaking_pairs(code))
        .collect();
    let covers = |by: usize, of: usize| -> bool {
        match (&rules[by], &breaks[of]) {
            (Some(rule), Some((kinds, pairs))) => rule.covers(kinds, pairs),
            _ => false,
        }
    };
    (0..proposals.len())
        .map(|i| (0..proposals.len()).find(|&j| j != i && covers(j, i) && !(j > i && covers(i, j))))
        .collect()
}

/// The groups of files that depend on each other in a cycle (strongly connected components of
/// the resolved file graph, Kosaraju's method without recursion). A file that uses itself is
/// not a cycle.
fn file_cycles(relationships: &[Value]) -> Vec<Value> {
    let mut index: BTreeMap<&str, usize> = BTreeMap::new();
    let mut edges: BTreeSet<(usize, usize)> = BTreeSet::new();
    for r in relationships {
        if r["resolution"] != "resolved" {
            continue;
        }
        let (source, target) = (text(&r["source"]["path"]), text(&r["targets"][0]["path"]));
        if source.is_empty() || target.is_empty() || source == target {
            continue;
        }
        let next = index.len();
        let a = *index.entry(source).or_insert(next);
        let next = index.len();
        let b = *index.entry(target).or_insert(next);
        edges.insert((a, b));
    }
    let n = index.len();
    let (mut out, mut back) = (vec![vec![]; n], vec![vec![]; n]);
    for &(a, b) in &edges {
        out[a].push(b);
        back[b].push(a);
    }
    // First pass: the order in which each node's depth-first search finishes.
    let (mut seen, mut order) = (vec![false; n], Vec::with_capacity(n));
    for start in 0..n {
        if seen[start] {
            continue;
        }
        seen[start] = true;
        let mut stack = vec![(start, 0)];
        while let Some((node, next)) = stack.pop() {
            if let Some(&child) = out[node].get(next) {
                stack.push((node, next + 1));
                if !seen[child] {
                    seen[child] = true;
                    stack.push((child, 0));
                }
            } else {
                order.push(node);
            }
        }
    }
    // Second pass, on the reversed graph in reverse finish order: each tree is one component.
    let names: Vec<&str> = {
        let mut names = vec![""; n];
        for (name, &i) in &index {
            names[i] = name;
        }
        names
    };
    let mut component = vec![usize::MAX; n];
    let mut groups: Vec<Vec<&str>> = vec![];
    for &start in order.iter().rev() {
        if component[start] != usize::MAX {
            continue;
        }
        let id = groups.len();
        let mut members = vec![];
        let mut stack = vec![start];
        component[start] = id;
        while let Some(node) = stack.pop() {
            members.push(names[node]);
            for &parent in &back[node] {
                if component[parent] == usize::MAX {
                    component[parent] = id;
                    stack.push(parent);
                }
            }
        }
        groups.push(members);
    }
    let mut cycles: Vec<Vec<&str>> = groups.into_iter().filter(|g| g.len() > 1).collect();
    for cycle in &mut cycles {
        cycle.sort_unstable();
    }
    cycles.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));
    cycles
        .into_iter()
        .take(10)
        .map(|files| json!({"size": files.len(), "files": files.iter().take(10).collect::<Vec<_>>()}))
        .collect()
}

/// Proposed fixes for the rule breaks at revision `head`: the breaks grouped by the rule and the
/// declaration they reach, because one change there (move it, or reach it through an allowed
/// module) fixes them all. Each fix is `{id, rule, message, target, kinds, count, sources,
/// anchor, text}`, most breaks first. `text` is an instruction for an agent, which the owner can
/// edit; `anchor` is the target declaration (or its file). No model writes them: the same
/// breaks give the same fixes.
pub fn propose_fixes(relationships: &[Value]) -> Vec<Value> {
    #[derive(Default)]
    struct Group {
        message: String,
        kinds: BTreeSet<String>,
        count: usize,
        sources: BTreeSet<String>,
    }
    let mut groups: BTreeMap<(String, String, String), Group> = BTreeMap::new();
    for r in relationships {
        for v in array(&r["violations"]) {
            let target = &r["targets"][0];
            let key = (
                v["id"].as_str().unwrap_or("").to_string(),
                target["path"].as_str().unwrap_or("").to_string(),
                target["symbol"].as_str().unwrap_or("").to_string(),
            );
            let group = groups.entry(key).or_default();
            group.message = v["message"].as_str().unwrap_or("").to_string();
            group
                .kinds
                .insert(r["kind"].as_str().unwrap_or("").to_string());
            // One for each relationship, as the map counts them (a relationship can have
            // several call lines).
            group.count += 1;
            group
                .sources
                .insert(r["source"]["path"].as_str().unwrap_or("").to_string());
        }
    }
    let mut fixes: Vec<Value> = groups
        .into_iter()
        .map(|((rule, path, symbol), g)| {
            let file = path.rsplit('/').next().unwrap_or(&path).to_string();
            // A method is moved with its type: `Engine.call` → `Engine`.
            let owner = symbol.split('.').next().unwrap_or(&symbol).to_string();
            let target = if symbol.is_empty() {
                file.clone()
            } else {
                format!("{symbol} in {file}")
            };
            let noun = match (g.kinds.len(), g.kinds.iter().next().map(String::as_str)) {
                (1, Some("calls")) => ["call", "calls"],
                (1, Some("imports")) => ["import", "imports"],
                (1, Some("implements")) => ["implementation", "implementations"],
                (1, Some("inherits")) => ["inheritance", "inheritances"],
                _ => ["relationship", "relationships"],
            }[usize::from(g.count != 1)];
            let names: Vec<&str> = g.sources.iter().map(String::as_str).collect();
            let from = match names.len() {
                1 => names[0].to_string(),
                n if n <= 3 => format!("{} and {}", names[..n - 1].join(", "), names[n - 1]),
                n => format!("{} and {} other files", names[..2].join(", "), n - 2),
            };
            let what = if symbol.is_empty() { file.clone() } else { owner.clone() };
            let text = format!(
                "Fix the {rule} rule break at {target}: {count} {noun} from {from} reach it. The rule says: \"{message}\" Move {what} to a place that the rule allows, for example a module in a lower layer that both sides can use, or reach it through a module that the rule allows. If you add a file, add it to the right group in .peekumi.json. Keep the behaviour the same, and run the tests.",
                count = g.count,
                message = g.message,
            );
            let anchor = if symbol.is_empty() {
                json!({"kind": "file", "path": path})
            } else {
                json!({"kind": "symbol", "path": path, "symbol": symbol})
            };
            json!({
                "id": hash(json!([rule, path, symbol]).to_string())[..16],
                "rule": rule,
                "message": g.message,
                "target": {"path": path, "symbol": symbol},
                "kinds": g.kinds,
                "count": g.count,
                "sources": names,
                "anchor": anchor,
                "text": text,
            })
        })
        .collect();
    fixes.sort_by(|a, b| b["count"].as_u64().cmp(&a["count"].as_u64()));
    fixes
}
/// The rule breaks in `after` that `before` did not have: the same relationship (by its stable
/// identity) breaking the same rule counts once, so old breaks stay out of a review. Each is
/// `{rule, message, kind, source, target}`.
pub fn added_breaks(before: &[Value], after: &[Value]) -> Vec<Value> {
    let old: BTreeSet<(String, String)> = before
        .iter()
        .flat_map(|r| {
            array(&r["violations"])
                .iter()
                .map(|v| (r["id"].to_string(), v["id"].to_string()))
                .collect::<Vec<_>>()
        })
        .collect();
    after
        .iter()
        .flat_map(|r| {
            array(&r["violations"])
                .iter()
                .filter(|v| !old.contains(&(r["id"].to_string(), v["id"].to_string())))
                .map(|v| json!({"rule":v["id"],"message":v["message"],"kind":r["kind"],"source":r["source"],"target":r["targets"][0]}))
                .collect::<Vec<_>>()
        })
        .collect()
}
/// Delegates every file's imports to its registered language adapter.
/// Updates resolved targets and unique non-self dependency edges using only the current snapshot.
fn resolve_imports(files: &mut BTreeMap<String, File>) {
    let context = adapters::Resolution::new(files.keys().cloned().collect());
    for file in files.values_mut() {
        let Some(adapter) = adapters::for_path(&file.path) else {
            continue;
        };
        let mut deps = BTreeSet::new();
        for item in &mut file.imports {
            let mut found = adapter.resolve(&file.path, item, &context);
            let mut seen = BTreeSet::new();
            found.retain(|p| seen.insert(p.clone()));
            for p in &found {
                if p != &file.path {
                    deps.insert(p.clone());
                }
            }
            item["resolved"] = json!(found);
        }
        file.deps = deps.into_iter().collect();
        file.deps
            .sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_renamed_group_changes_only_its_own_names() {
        let mut deny = json!({"id":"r","from":"ui","to":["ui","db"],"kinds":["calls"]});
        rename_group(&mut deny, "ui", "ui-2");
        assert_eq!(
            deny,
            json!({"id":"r","from":"ui-2","to":["ui-2","db"],"kinds":["calls"]}),
            "No field is added, and other groups stay"
        );
        let mut layers = json!({"id":"l","layers":["ui","db"],"kinds":["calls"]});
        rename_group(&mut layers, "db", "db-2");
        assert_eq!(layers["layers"], json!(["ui", "db-2"]));
        assert!(layers.get("to").is_none() && layers.get("from").is_none());
    }
    #[test]
    fn a_proposal_that_another_covers_joins_it() {
        let groups = json!({"ui":["ui/**"],"db":["db/**"]});
        let code = ["ui/a.py", "ui/b.py", "db/c.py", "lib/d.py"];
        let proposal = |groups: Value, rule: Value| json!({"groups": groups, "rule": rule});
        let proposals = [
            proposal(
                json!({}),
                json!({"id":"wide","from":"ui","to":["db"],"kinds":["calls","imports"]}),
            ),
            proposal(
                json!({"a":["ui/a.py"]}),
                json!({"id":"part","from":"a","to":["db"],"kinds":["calls"]}),
            ),
            proposal(
                json!({"lib":["lib/**"]}),
                json!({"id":"other","from":"lib","to":["ui"],"kinds":["calls"]}),
            ),
            proposal(
                json!({"front":["ui/**"]}),
                json!({"id":"same","from":"front","to":["db"],"kinds":["imports","calls"]}),
            ),
        ];
        assert_eq!(
            overlaps(&groups, &proposals, &code),
            vec![None, Some(0), None, Some(0)],
            "A part joins the wider rule; of two equal rules, the first stays"
        );
    }
    #[test]
    fn cycles_are_groups_of_files_that_reach_each_other() {
        let r = |a: &str, b: &str| json!({"resolution":"resolved","source":{"path":a},"targets":[{"path":b}]});
        let relationships = vec![
            r("a", "b"),
            r("b", "c"),
            r("c", "a"),
            r("c", "d"),
            r("d", "d"),
            r("e", "f"),
            r("f", "e"),
            json!({"resolution":"unresolved","source":{"path":"d"},"targets":[{"path":"a"}]}),
        ];
        assert_eq!(
            file_cycles(&relationships),
            vec![
                json!({"size": 3, "files": ["a", "b", "c"]}),
                json!({"size": 2, "files": ["e", "f"]}),
            ]
        );
    }
    #[test]
    fn rules_that_check_the_same_files_have_the_same_key() {
        let groups = json!({"ui":["ui/**"],"view":["ui/*.py"],"db":["db/**"],"later":["later/**"]});
        let paths = ["ui/a.py", "db/b.py", "db/c.py", "db/notes.md"];
        let key = |rule: Value| rule_key(&groups, &rule, &paths);
        assert_eq!(
            key(json!({"from":"ui","to":["db"],"kinds":["calls","imports"]})),
            key(json!({"from":"view","to":["db"],"kinds":["imports","calls"]})),
            "Other names, same files"
        );
        assert_ne!(
            key(json!({"from":"ui","to":["db"],"kinds":["calls"]})),
            key(json!({"from":"ui","only":["db"],"kinds":["calls"]}))
        );
        assert_ne!(
            key(json!({"from":"later","to":["db"],"kinds":["calls"]})),
            key(json!({"from":"ui","to":["db"],"kinds":["calls"]})),
            "A group that matches no file yet keeps its patterns"
        );
        let split =
            json!({"ui":["ui/**"],"b":["db/b.py"],"c":["db/c.py"],"all":["**"],"db":["db/**"]});
        let key = |rule: Value| rule_key(&split, &rule, &paths);
        assert_eq!(
            key(json!({"from":"ui","to":["b","c"],"kinds":["calls"]})),
            key(json!({"from":"ui","to":["db"],"kinds":["calls"]})),
            "Target groups count as one set, and a file that no adapter reads does not count"
        );
        assert_eq!(
            key(json!({"from":"ui","to":["all"],"kinds":["calls"]})),
            key(json!({"from":"ui","to":["db"],"kinds":["calls"]})),
            "A single source file leaves the target set"
        );
        let scope = |rule: Value| rule_shape(&split, &rule, &paths, false);
        assert_eq!(
            scope(json!({"from":"ui","to":["db"],"kinds":["calls"]})),
            scope(json!({"from":"ui","to":["db"],"kinds":["imports","inherits"]})),
            "The scope is the files, whatever the kinds"
        );
    }
    use super::*;
    #[test]
    fn readme_summaries_skip_decorative_markup() {
        let readme = "<p align=\"center\"><img src=\"logo.svg\" alt=\"Logo\"></p>\n\n# Name\n\n[![CI](https://x/badge.svg)](https://x)\n\nExplore a repository from your phone.\nSecond line.\n\nLater paragraph.";
        assert_eq!(
            document_summary(readme),
            "Explore a repository from your phone. Second line."
        );
    }
    #[test]
    fn source_restrictions_preserve_examples() {
        for path in [
            ".env",
            "nested/.env.prod",
            "secret.KEY",
            "a/id_rsa",
            "credentials.json",
            "home/.npmrc",
            ".netrc",
            ".aws/credentials",
            "keys/id_ecdsa",
            "id_dsa",
            ".pgpass",
            "release.jks",
            "gcp/service-account-prod.json",
            ".docker/config.json",
            "infra/terraform.tfstate",
            "production.env",
            ".envrc",
            "prod.tfvars",
            "home/.kube/config",
            "gcloud/application_default_credentials.json",
            ".terraformrc",
            ".yarnrc.yml",
            "keys/id_rsa.bak",
        ] {
            assert!(restricted(path), "{path}");
        }
        for path in [
            ".env.example",
            ".env.local.template",
            "env.py",
            "key.ts",
            "id_rsa.pub",
            "credentials.py",
            "package.json",
            "docker/config.json",
            "keyboard.rs",
            "kube/config.go",
            "variables.tf",
        ] {
            assert!(!restricted(path), "{path}");
        }
    }
    #[test]
    fn imports_resolve_in_their_own_tree_and_path() {
        let mut files = BTreeMap::new();
        for path in ["a/use.py", "a/model.py", "b/use.py"] {
            files.insert(
                path.into(),
                File {
                    path: path.into(),
                    ..File::default()
                },
            );
        }
        for path in ["a/use.py", "b/use.py"] {
            files.get_mut(path).unwrap().imports =
                vec![json!({"specifier":"model","level":1,"names":["Model"]})];
        }
        resolve_imports(&mut files);
        assert_eq!(files["a/use.py"].deps, vec!["a/model.py"]);
        assert!(files["b/use.py"].deps.is_empty());
        files.insert(
            "b/model.py".into(),
            File {
                path: "b/model.py".into(),
                ..File::default()
            },
        );
        resolve_imports(&mut files);
        assert_eq!(files["b/use.py"].deps, vec!["b/model.py"]);
    }
    #[test]
    fn symbol_comparisons_preserve_removed_ranges_and_metadata_privacy() {
        let a = File {
            symbols: vec![
                json!({"name":"f","kind":"function","start":2,"end":8,"hash":"a","details":{"description":"private metadata"}}),
            ],
            ..File::default()
        };
        let b = File {
            symbols: vec![json!({"name":"f","kind":"function","start":3,"end":9,"hash":"b"})],
            ..File::default()
        };
        let changed = compare_symbols(Some(&a), Some(&b));
        assert_eq!(changed[0]["status"], "changed");
        assert_eq!(changed[0]["before"], json!({"start":2,"end":8}));
        assert!(changed[0].get("details").is_none());
        assert_eq!(compare_symbols(Some(&a), None)[0]["status"], "removed");
    }
}
