//! Committed Git snapshots, comparisons, directory documentation and language-adapter coordination.
use crate::{
    adapters::{self, Config},
    index::Index,
    process::run,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::Arc,
};
/// Computes a hexadecimal SHA-256 fingerprint for cache namespaces, parser versions and symbol identities.
pub fn hash(data: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(data))
}
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
/// Identifies common secret-bearing filenames whose source must be hidden.
/// Example environment templates remain readable; this is a filename policy, not a content secret scanner.
pub fn restricted(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file).to_lowercase();
    ((name == ".env" || name.starts_with(".env."))
        && ![".example", ".sample", ".template"]
            .iter()
            .any(|s| name.ends_with(s)))
        || [".pem", ".key", ".p12", ".pfx"]
            .iter()
            .any(|s| name.ends_with(s))
        || ["id_rsa", "id_ed25519", "credentials.json"].contains(&name.as_str())
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
    /// Returns subprocess errors; callers choose the read-only Git operation.
    fn git(&self, args: &[&str]) -> Result<Vec<u8>> {
        let directory = self.directory.to_string_lossy();
        let mut command = vec!["-C", &directory];
        command.extend_from_slice(args);
        run("git", &command, None, vec![])
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
    /// Returns checkout identity, available local/remote-tracking branches and first-parent history for the selected head.
    /// Reads refs and objects only; never checks out a branch or fetches remote refs.
    /// An invalid base falls back to the oldest listed commit; an invalid head or unreadable history is an error.
    pub fn metadata(&self, base: &str, head: &str) -> Result<Value> {
        let branch = string(self.git(&["branch", "--show-current"])?);
        let initial_head = self.resolve(head)?;
        let refs = string(self.git(&[
            "for-each-ref",
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
        let log = string(self.git(&[
            "log",
            "--first-parent",
            "-80",
            "--format=%H%x00%h%x00%s%x00%aI%x00%P%x00",
            &initial_head,
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
        let base = self.resolve(base).or_else(|_| {
            commits
                .last()
                .map(|v| text(&v["sha"]).to_string())
                .context("Repository has no commits")
        })?;
        let root = string(self.git(&["rev-parse", "--show-toplevel"])?);
        Ok(
            json!({"name":Path::new(root.trim()).file_name().unwrap_or_default().to_string_lossy(),"branch":if branch.trim().is_empty(){"detached HEAD"}else{branch.trim()},"commits":commits,"initialBase":base,"initialHead":initial_head,"branches":branches,"selectedBranch":selected_branch}),
        )
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
            let data = run(
                "git",
                &[
                    "-C",
                    &self.directory.to_string_lossy(),
                    "cat-file",
                    "--batch",
                ],
                None,
                input.into_bytes(),
            )?;
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
                json!({"base":a.sha,"head":b.sha,"compact":true,"pairs":crate::relationships::compact(&left,&right),"checks":{"before":a.checks,"after":b.checks}}),
            );
        }
        Ok(
            json!({"base":a.sha,"head":b.sha,"relationships":crate::relationships::compare(&left,&right),"checks":{"before":a.checks,"after":b.checks}}),
        )
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
    let config = files.get(".strata.json");
    let mut checks =
        json!({"config":".strata.json","state":"not configured","rules":0,"errors":[]});
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
        ] {
            assert!(restricted(path));
        }
        for path in [".env.example", ".env.local.template", "env.py", "key.ts"] {
            assert!(!restricted(path));
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
