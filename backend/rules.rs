//! Versioned dependency constraints evaluated against known static relationships only.
//!
//! A rule has one of three forms, each limited to its relationship `kinds`:
//! - `from` + `to`: files in `from` must not use files in the `to` groups (a deny rule);
//! - `from` + `only`: files in `from` may use only files in `from` or in the `only` groups,
//!   so a file in a new folder is outside the allowed set until someone decides;
//! - `layers`: groups from the top layer to the bottom one; a file in a layer must not use a
//!   layer above it.
//!
//! Only resolved relationships can break a rule. `coverage` reports, for each rule, how many
//! relationships it checked, how many broke it and how many in its scope stayed unresolved, and
//! warns about groups that match no file and rules that checked nothing, so a typo cannot pass
//! silently.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};
/// Rule configuration files, preferred first: `.peekumi.json`, then `.strata.json` from before the rename.
pub const CONFIG_FILES: [&str; 2] = [".peekumi.json", ".strata.json"];
/// Maximum timeout allowed for a single check or prepare command (30 minutes).
pub const MAX_TIMEOUT_SECS: u64 = 1800;
/// Default timeout for a check command.
pub const DEFAULT_CHECK_TIMEOUT_SECS: u64 = 120;
/// Default timeout for a prepare command.
pub const DEFAULT_PREPARE_TIMEOUT_SECS: u64 = 300;
/// Parsed `checks` configuration from `.peekumi.json`.
#[derive(Clone, Debug)]
pub struct ChecksConfig {
    pub prepare: Option<PrepareSpec>,
    pub new_tests: Option<NewTestSpec>,
    pub items: Vec<CheckSpec>,
}
/// Optional dependency installation phase.
#[derive(Clone, Debug)]
pub struct PrepareSpec {
    pub command: Vec<String>,
    pub timeout_seconds: u64,
    pub cache_key: Vec<String>,
    pub cache_dirs: Vec<String>,
}
/// Optional standalone fail-to-pass runner for new or edited test files.
#[derive(Clone, Debug)]
pub struct NewTestSpec {
    pub command: Vec<String>,
    pub timeout_seconds: u64,
    pub test_support_globs: Vec<String>,
}
/// Owner-authored shell-free acceptance check bound into `approvalRecord`.
#[derive(Clone, Debug)]
pub struct AcceptanceSpec {
    pub command: Vec<String>,
    pub expect_fail_on_start: bool,
    pub timeout_seconds: u64,
    pub command_hash: String,
}
/// One verification check command.
#[derive(Clone, Debug)]
pub struct CheckSpec {
    pub id: String,
    pub name: String,
    pub command: Vec<String>,
    pub timeout_seconds: u64,
    pub expect: String,
    pub cwd: Option<String>,
    pub paths: Vec<String>,
    pub artifacts: Vec<String>,
    pub coverage: Option<String>,
    pub env: BTreeMap<String, String>,
}
/// Validates a relative path inside the archived repository copy (no leading `/`, no `..`, no NUL).
fn relative_path(raw: &str, field: &str) -> Result<String> {
    let trimmed = raw.trim();
    ensure!(
        !trimmed.is_empty() && trimmed.len() <= 256 && !trimmed.contains('\0'),
        "Invalid {field} path"
    );
    ensure!(
        !trimmed.starts_with('/') && !trimmed.contains('\\'),
        "{field} must be a relative path"
    );
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            _ => bail!("{field} cannot escape the repository copy"),
        }
    }
    Ok(trimmed.to_string())
}
fn command_argv(value: &Value, field: &str) -> Result<Vec<String>> {
    let arr = value
        .as_array()
        .with_context(|| format!("{field} must be a nonempty string array"))?;
    ensure!(
        !arr.is_empty() && arr.len() <= 64,
        "{field} must have between 1 and 64 arguments"
    );
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let s = item
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
            .with_context(|| format!("{field} entries must be nonempty strings"))?;
        out.push(s.to_string());
    }
    Ok(out)
}
fn timeout_value(value: &Value, default_secs: u64) -> Result<u64> {
    if value.is_null() {
        return Ok(default_secs);
    }
    let secs = value
        .as_u64()
        .context("timeoutSeconds must be a positive integer")?;
    ensure!(
        (1..=MAX_TIMEOUT_SECS).contains(&secs),
        "timeoutSeconds must be between 1 and {MAX_TIMEOUT_SECS}"
    );
    Ok(secs)
}
fn string_paths(value: &Value, field: &str, max: usize) -> Result<Vec<String>> {
    if value.is_null() {
        return Ok(vec![]);
    }
    let arr = value
        .as_array()
        .with_context(|| format!("{field} must be a string array"))?;
    ensure!(arr.len() <= max, "At most {max} entries in {field}");
    arr.iter()
        .map(|v| {
            let s = v
                .as_str()
                .with_context(|| format!("{field} entries must be strings"))?;
            relative_path(s, field)
        })
        .collect()
}
fn glob_patterns(value: &Value, field: &str, max: usize) -> Result<Vec<String>> {
    if value.is_null() {
        return Ok(vec![]);
    }
    let arr = value
        .as_array()
        .with_context(|| format!("{field} must be a string array"))?;
    ensure!(arr.len() <= max, "At most {max} entries in {field}");
    let mut out = Vec::with_capacity(arr.len());
    for v in arr {
        let p = v
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .with_context(|| format!("{field} entries must be nonempty strings"))?;
        ensure!(
            p.len() <= 256
                && !p.starts_with('/')
                && !p.contains("..")
                && !p.contains(['[', ']', '{', '}', '\\', '\0']),
            "{field}: use relative path globs with only * and ? wildcards"
        );
        out.push(p.to_string());
    }
    Ok(out)
}
/// Validates an owner-authored acceptance check command and computes its SHA-256 hash.
/// Commands execute inside the OS sandbox (Seatbelt / bwrap) with no network and a clean environment.
pub fn parse_acceptance(value: &Value) -> Result<AcceptanceSpec> {
    let obj = value
        .as_object()
        .context("Acceptance check must be an object")?;
    ensure!(
        obj.keys()
            .all(|k| ["command", "expectFailOnStart", "timeoutSeconds"].contains(&k.as_str())),
        "Unknown acceptance check field"
    );
    let command = command_argv(&value["command"], "acceptance.command")?;
    let expect_fail_on_start = match value.get("expectFailOnStart") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        _ => bail!("acceptance.expectFailOnStart must be a boolean"),
    };
    let timeout_seconds = timeout_value(&value["timeoutSeconds"], DEFAULT_CHECK_TIMEOUT_SECS)?;
    let canonical = serde_json::to_string(&json!({
        "command": command,
        "expectFailOnStart": expect_fail_on_start,
    }))?;
    let command_hash = crate::hash::hash(canonical.as_bytes());
    Ok(AcceptanceSpec {
        command,
        expect_fail_on_start,
        timeout_seconds,
        command_hash,
    })
}
fn safe_env_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 64 {
        return false;
    }
    if !key
        .bytes()
        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        return false;
    }
    const EXACT_FORBIDDEN: &[&str] = &[
        "HOME",
        "PATH",
        "TMPDIR",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_AUDIT",
        "IFS",
        "BASH_ENV",
        "ENV",
    ];
    if EXACT_FORBIDDEN.contains(&key) || key.starts_with("DYLD_") {
        return false;
    }
    const SECRET_SEGMENTS: &[&str] = &[
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "COOKIE",
        "CREDENTIAL",
        "CREDENTIALS",
        "API_KEY",
        "ACCESS_KEY",
        "PRIVATE_KEY",
        "AUTH_KEY",
        "AUTH_HEADER",
    ];
    !SECRET_SEGMENTS.iter().any(|bad| {
        key == *bad
            || key.ends_with(&format!("_{bad}"))
            || key.starts_with(&format!("{bad}_"))
            || key.contains(&format!("_{bad}_"))
    })
}
/// Validates and parses the `checks` object of `.peekumi.json`.
/// Rejects unknown fields, unsafe paths, secret-like env keys and invalid timeouts.
pub fn parse_checks(value: &Value) -> Result<ChecksConfig> {
    let obj = value
        .as_object()
        .context("checks configuration must be an object")?;
    ensure!(
        obj.keys()
            .all(|k| ["prepare", "newTests", "items"].contains(&k.as_str())),
        "Unknown checks field"
    );
    let prepare = if let Some(prep) = obj.get("prepare").filter(|v| !v.is_null()) {
        let pobj = prep
            .as_object()
            .context("checks.prepare must be an object")?;
        ensure!(
            pobj.keys().all(|k| {
                ["command", "timeoutSeconds", "cacheKey", "cacheDirs"].contains(&k.as_str())
            }),
            "Unknown checks.prepare field"
        );
        Some(PrepareSpec {
            command: command_argv(&prep["command"], "checks.prepare.command")?,
            timeout_seconds: timeout_value(&prep["timeoutSeconds"], DEFAULT_PREPARE_TIMEOUT_SECS)?,
            cache_key: string_paths(&prep["cacheKey"], "checks.prepare.cacheKey", 32)?,
            cache_dirs: string_paths(&prep["cacheDirs"], "checks.prepare.cacheDirs", 16)?,
        })
    } else {
        None
    };
    let new_tests = if let Some(nt) = obj.get("newTests").filter(|v| !v.is_null()) {
        let nobj = nt
            .as_object()
            .context("checks.newTests must be an object")?;
        ensure!(
            nobj.keys()
                .all(|k| ["command", "timeoutSeconds", "testSupportGlobs"].contains(&k.as_str())),
            "Unknown checks.newTests field"
        );
        let command = command_argv(&nt["command"], "checks.newTests.command")?;
        ensure!(
            command.iter().any(|a| a == "{files}"),
            "checks.newTests.command must contain a literal \"{{files}}\" argument"
        );
        Some(NewTestSpec {
            command,
            timeout_seconds: timeout_value(&nt["timeoutSeconds"], DEFAULT_CHECK_TIMEOUT_SECS)?,
            test_support_globs: glob_patterns(
                &nt["testSupportGlobs"],
                "checks.newTests.testSupportGlobs",
                32,
            )?,
        })
    } else {
        None
    };
    let raw_items = value["items"]
        .as_array()
        .context("checks.items must be a nonempty array")?;
    ensure!(
        !raw_items.is_empty() && raw_items.len() <= 32,
        "checks.items must contain between 1 and 32 checks"
    );
    let mut ids = BTreeSet::new();
    let mut items = Vec::with_capacity(raw_items.len());
    for item in raw_items {
        let iobj = item.as_object().context("Each check must be an object")?;
        ensure!(
            iobj.keys().all(|k| [
                "id",
                "name",
                "command",
                "timeoutSeconds",
                "expect",
                "cwd",
                "paths",
                "artifacts",
                "coverage",
                "env"
            ]
            .contains(&k.as_str())),
            "Unknown check field"
        );
        let id = item["id"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 64
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            })
            .context("Check needs a valid id")?
            .to_string();
        ensure!(ids.insert(id.clone()), "Duplicate check id {id}");
        let name = match item["name"].as_str() {
            Some(s) if !s.trim().is_empty() && s.len() <= 120 => s.trim().to_string(),
            None if item["name"].is_null() => id.clone(),
            _ => bail!("Check {id} has an invalid name"),
        };
        let command = command_argv(&item["command"], &format!("check {id} command"))?;
        let timeout_seconds = timeout_value(&item["timeoutSeconds"], DEFAULT_CHECK_TIMEOUT_SECS)?;
        let expect = match item["expect"].as_str() {
            None if item["expect"].is_null() => "pass".to_string(),
            Some("pass") => "pass".to_string(),
            Some("fail") => "fail".to_string(),
            _ => bail!("Check {id} expect must be pass or fail"),
        };
        let cwd = match item["cwd"].as_str() {
            None if item["cwd"].is_null() => None,
            Some(s) => Some(relative_path(s, "check cwd")?),
            _ => bail!("Check {id} cwd must be a relative path"),
        };
        let paths = glob_patterns(&item["paths"], &format!("check {id} paths"), 32)?;
        let artifacts = string_paths(&item["artifacts"], "check artifacts", 16)?;
        let coverage = match item["coverage"].as_str() {
            None if item["coverage"].is_null() => None,
            Some(s) => Some(relative_path(s, "check coverage")?),
            _ => bail!("Check {id} coverage must be a relative path"),
        };
        let mut env = BTreeMap::new();
        if let Some(map) = item.get("env").filter(|v| !v.is_null()) {
            let eobj = map
                .as_object()
                .with_context(|| format!("Check {id} env must be an object"))?;
            ensure!(eobj.len() <= 32, "At most 32 env entries per check");
            for (k, v) in eobj {
                ensure!(safe_env_key(k), "Check {id} env key {k} is not allowed");
                let val = v
                    .as_str()
                    .filter(|s| s.len() <= 1024 && !s.contains('\0'))
                    .with_context(|| format!("Check {id} env {k} must be a string"))?;
                env.insert(k.clone(), val.to_string());
            }
        }
        items.push(CheckSpec {
            id,
            name,
            command,
            timeout_seconds,
            expect,
            cwd,
            paths,
            artifacts,
            coverage,
            env,
        });
    }
    Ok(ChecksConfig {
        prepare,
        new_tests,
        items,
    })
}
/// The kinds of a rule and the pairs of files (source, target) that would break it (see
/// [`Rules::breaking_pairs`]).
pub type Breaks<'a> = (Vec<String>, Vec<(&'a str, &'a str)>);
/// Compiled path groups and directional deny rules from the committed root configuration.
pub struct Rules {
    groups: BTreeMap<String, Vec<String>>,
    rules: Vec<Value>,
}
fn strings(value: &Value) -> Result<Vec<String>> {
    let values = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Expected a nonempty string array"))?;
    ensure!(!values.is_empty(), "Empty list");
    values
        .iter()
        .map(|v| {
            v.as_str()
                .filter(|s| !s.is_empty())
                .map(String::from)
                .ok_or_else(|| anyhow::anyhow!("Expected nonempty string"))
        })
        .collect()
}
/// Validates configuration strictly so typos cannot silently disable a constraint.
pub fn parse(source: &str) -> Result<Rules> {
    ensure!(source.len() <= 65536, "Rule configuration exceeds 64 KiB");
    let value: Value = serde_json::from_str(source)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Configuration must be an object"))?;
    ensure!(
        object
            .keys()
            .all(|k| ["version", "groups", "rules", "checks"].contains(&k.as_str())),
        "Unknown configuration field"
    );
    ensure!(value["version"] == 1, "Expected version 1");
    if let Some(checks) = object.get("checks").filter(|v| !v.is_null()) {
        parse_checks(checks)?;
    }
    let groups = value["groups"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Expected groups object"))?
        .iter()
        .map(|(k, v)| Ok((k.clone(), strings(v)?)))
        .collect::<Result<BTreeMap<_, _>>>()?;
    for patterns in groups.values() {
        ensure!(patterns.len() <= 100, "At most 100 patterns per group");
        for p in patterns {
            ensure!(
                p.len() <= 256
                    && !p.starts_with('/')
                    && !p.contains("..")
                    && !p.contains(['[', ']', '{', '}', '\\']),
                "Use relative path globs with only * and ? wildcards"
            );
        }
    }
    let rules = value["rules"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Expected rules array"))?
        .clone();
    ensure!(
        rules.len() <= 100 && groups.len() <= 100,
        "At most 100 groups and rules"
    );
    let mut ids = BTreeSet::new();
    for rule in &rules {
        let obj = rule
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("Rule must be an object"))?;
        ensure!(
            obj.keys().all(|k| {
                ["id", "from", "to", "only", "layers", "kinds", "message"].contains(&k.as_str())
            }),
            "Unknown rule field"
        );
        let id = rule["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Rule needs id"))?;
        ensure!(ids.insert(id), "Duplicate rule id {id}");
        let forms = ["to", "only", "layers"]
            .iter()
            .filter(|k| obj.contains_key(**k))
            .count();
        ensure!(
            forms == 1,
            "Rule {id} needs exactly one of to, only or layers"
        );
        if obj.contains_key("layers") {
            ensure!(
                !obj.contains_key("from"),
                "Rule {id}: a layers rule has no from"
            );
            let layers = strings(&rule["layers"])?;
            ensure!(
                layers.len() >= 2,
                "Rule {id}: layers needs two or more groups"
            );
            for group in &layers {
                ensure!(groups.contains_key(group), "Unknown group {group}");
            }
        } else {
            let from = rule["from"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Rule from must name a group"))?;
            ensure!(groups.contains_key(from), "Unknown group {from}");
            let field = if obj.contains_key("to") { "to" } else { "only" };
            for to in strings(&rule[field])? {
                ensure!(groups.contains_key(&to), "Unknown group {to}");
            }
        }
        for kind in strings(&rule["kinds"])? {
            ensure!(
                ["imports", "calls", "implements", "inherits"].contains(&kind.as_str()),
                "Unknown relationship kind {kind}"
            );
        }
        if !rule["message"].is_null() && !rule["message"].is_string() {
            bail!("Rule message must be text");
        }
    }
    Ok(Rules { groups, rules })
}
/// Matches path globs without filesystem traversal: * stays in a segment, ** crosses directories.
pub fn matches(pattern: &str, path: &str) -> bool {
    let p = pattern.as_bytes();
    let s = path.as_bytes();
    let mut cache = BTreeMap::new();
    fn go(
        p: &[u8],
        s: &[u8],
        i: usize,
        j: usize,
        cache: &mut BTreeMap<(usize, usize), bool>,
    ) -> bool {
        if let Some(v) = cache.get(&(i, j)) {
            return *v;
        }
        let value = if i == p.len() {
            j == s.len()
        } else if p[i] == b'*' {
            let double = p.get(i + 1) == Some(&b'*');
            let next = i + if double { 2 } else { 1 };
            go(p, s, next, j, cache)
                || (double && p.get(next) == Some(&b'/') && go(p, s, next + 1, j, cache))
                || (j < s.len() && (double || s[j] != b'/') && go(p, s, i, j + 1, cache))
        } else {
            j < s.len()
                && (p[i] == s[j] || (p[i] == b'?' && s[j] != b'/'))
                && go(p, s, i + 1, j + 1, cache)
        };
        cache.insert((i, j), value);
        value
    }
    go(p, s, 0, 0, &mut cache)
}
impl Rules {
    /// True when `path` is in `group`.
    fn has(&self, group: &str, path: &str) -> bool {
        self.groups[group].iter().any(|p| matches(p, path))
    }
    /// The names in a rule's string list `field`.
    fn names<'a>(rule: &'a Value, field: &str) -> Vec<&'a str> {
        rule[field]
            .as_array()
            .map(|list| list.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default()
    }
    /// The position of `path` in a layers rule: its first matching layer, from the top.
    fn layer(&self, rule: &Value, path: &str) -> Option<usize> {
        Self::names(rule, "layers")
            .iter()
            .position(|group| self.has(group, path))
    }
    /// True when a relationship from `source` of `kind` is in the rule's scope: the rule looks
    /// at it, whatever its target.
    fn in_scope(&self, rule: &Value, kind: &Value, source: &str) -> bool {
        rule["kinds"].as_array().unwrap().contains(kind)
            && match rule["from"].as_str() {
                Some(from) => self.has(from, source),
                None => self.layer(rule, source).is_some(),
            }
    }
    /// True when a resolved relationship from `source` to `target`, in scope, breaks the rule.
    /// A file that uses itself (a call inside one file) never does: a rule is about one part
    /// using another, also when its `to` groups hold the file.
    fn breaks(&self, rule: &Value, source: &str, target: &str) -> bool {
        if source == target {
            return false;
        }
        if rule.get("layers").is_some() {
            return matches!(
                (self.layer(rule, source), self.layer(rule, target)),
                (Some(from), Some(to)) if to < from
            );
        }
        let from = rule["from"].as_str().unwrap();
        if rule.get("only").is_some() {
            return !self.has(from, target)
                && !Self::names(rule, "only")
                    .iter()
                    .any(|group| self.has(group, target));
        }
        Self::names(rule, "to")
            .iter()
            .any(|group| self.has(group, target))
    }
    /// Annotates only resolved evidence; unknown targets cannot prove a pass or violation.
    pub fn apply(&self, relations: &mut [Value]) {
        for r in relations {
            if r["resolution"] != "resolved" {
                continue;
            }
            let source = r["source"]["path"].as_str().unwrap_or("").to_string();
            let target = r["targets"][0]["path"].as_str().unwrap_or("").to_string();
            let violations: Vec<Value> = self
                .rules
                .iter()
                .filter(|rule| self.in_scope(rule, &r["kind"], &source))
                .filter(|rule| self.breaks(rule, &source, &target))
                .map(|rule| json!({"id":rule["id"],"message":rule["message"].as_str().unwrap_or("Forbidden dependency")}))
                .collect();
            r["violations"] = json!(violations);
        }
    }
    /// For each rule: the relationships in its scope that it checked, the ones that broke it
    /// and the ones in its scope that stayed unresolved (`relations` after `apply`). Also the
    /// warnings: a group that matches none of `paths`, and a rule that checked nothing.
    pub fn coverage(&self, relations: &[Value], paths: &[&str]) -> (Vec<Value>, Vec<String>) {
        let mut warnings: Vec<String> = self
            .groups
            .iter()
            .filter(|(_, patterns)| {
                !paths
                    .iter()
                    .any(|path| patterns.iter().any(|p| matches(p, path)))
            })
            .map(|(name, _)| format!("Group \"{name}\" matches no file. Check its patterns."))
            .collect();
        let coverage = self
            .rules
            .iter()
            .map(|rule| {
                let (mut checked, mut broke, mut unresolved) = (0, 0, 0);
                for r in relations {
                    let source = r["source"]["path"].as_str().unwrap_or("");
                    if !self.in_scope(rule, &r["kind"], source) {
                        continue;
                    }
                    if r["resolution"] == "resolved" {
                        checked += 1;
                        broke += r["violations"]
                            .as_array()
                            .is_some_and(|v| v.iter().any(|v| v["id"] == rule["id"]))
                            as usize;
                    } else {
                        unresolved += 1;
                    }
                }
                if checked == 0 {
                    warnings.push(format!(
                        "Rule \"{}\" checked no relationship. Check its groups and kinds.",
                        rule["id"].as_str().unwrap_or("")
                    ));
                }
                json!({"id":rule["id"],"checked":checked,"broke":broke,"unresolved":unresolved})
            })
            .collect();
        (coverage, warnings)
    }
    pub fn count(&self) -> usize {
        self.rules.len()
    }
    /// True when some rule looks at relationships that start in `path`, for any kind.
    pub fn watches(&self, path: &str) -> bool {
        self.rules.iter().any(|rule| match rule["from"].as_str() {
            Some(from) => self.has(from, path),
            None => self.layer(rule, path).is_some(),
        })
    }
    /// The number of relationships in `relations` that some rule looks at but that stayed
    /// unresolved, so no rule can judge them. Each counts once, also when several rules look
    /// at it.
    pub fn unresolved_in_scope(&self, relations: &[Value]) -> usize {
        relations
            .iter()
            .filter(|r| {
                r["resolution"] != "resolved"
                    && self.rules.iter().any(|rule| {
                        self.in_scope(rule, &r["kind"], r["source"]["path"].as_str().unwrap_or(""))
                    })
            })
            .count()
    }
    /// The pairs of `paths` (source, target) that would break the only rule of `self`, and its
    /// kinds. `None` when it has no rule, or more than 200,000 pairs would need a check.
    pub fn breaking_pairs<'a>(&self, paths: &[&'a str]) -> Option<Breaks<'a>> {
        let rule = self.rules.first()?;
        let kinds: Vec<String> = Self::names(rule, "kinds")
            .into_iter()
            .map(String::from)
            .collect();
        let first = json!(kinds.first()?);
        let sources: Vec<&str> = paths
            .iter()
            .copied()
            .filter(|s| self.in_scope(rule, &first, s))
            .collect();
        if sources.len().saturating_mul(paths.len()) > 200_000 {
            return None;
        }
        let pairs = sources
            .iter()
            .flat_map(|s| paths.iter().map(move |t| (*s, *t)))
            .filter(|(s, t)| self.breaks(rule, s, t))
            .collect();
        Some((kinds, pairs))
    }
    /// True when `rule` breaks for each of `pairs` and each of `kinds`.
    fn breaks_each(&self, rule: &Value, kinds: &[String], pairs: &[(&str, &str)]) -> bool {
        kinds.iter().all(|kind| {
            pairs
                .iter()
                .all(|(s, t)| self.in_scope(rule, &json!(kind), s) && self.breaks(rule, s, t))
        })
    }
    /// True when the only rule of `self` breaks for each of `pairs` and each of `kinds` (see
    /// [`Rules::breaking_pairs`]): it covers a rule with those breaks. A rule with no break
    /// is never covered, because nothing shows that it adds nothing.
    pub fn covers(&self, kinds: &[String], pairs: &[(&str, &str)]) -> bool {
        !pairs.is_empty()
            && self
                .rules
                .first()
                .is_some_and(|rule| self.breaks_each(rule, kinds, pairs))
    }
    /// The ID of a rule in `current` that already covers the only rule of `self`: each pair of
    /// `paths` and each kind that would break the new rule also breaks that rule, so the new
    /// rule adds nothing.
    pub fn covered_by(&self, current: &Rules, paths: &[&str]) -> Option<String> {
        let (kinds, pairs) = self.breaking_pairs(paths)?;
        if pairs.is_empty() {
            return None;
        }
        current
            .rules
            .iter()
            .find(|other| current.breaks_each(other, &kinds, &pairs))
            .map(|other| other["id"].as_str().unwrap_or("").to_string())
    }
}
/// One plain sentence for a rule check (the engine's `rule_check`): what the work adds, what
/// limits the check, and a rule change. The agent and the session conversation read it.
pub fn check_summary(check: &Value) -> String {
    if check["state"] == "not checked" {
        return format!(
            "Not checked: {}",
            check["reason"]
                .as_str()
                .unwrap_or("the rules could not be read.")
        );
    }
    let count = check["addedCount"].as_u64().unwrap_or(0);
    let mut text = match count {
        0 => "The work adds no rule break.".to_string(),
        1 => "The work adds 1 rule break.".to_string(),
        n => format!("The work adds {n} rule breaks."),
    };
    if check["state"] == "limited" {
        let limits = &check["limits"];
        let unresolved = limits["unresolved"].as_u64().unwrap_or(0);
        let files = ["start", "head"]
            .iter()
            .map(|at| limits["gaps"][at].as_array().map_or(0, Vec::len))
            .max()
            .unwrap_or(0)
            + limits["unanalysed"].as_array().map_or(0, Vec::len);
        let warnings = limits["warnings"].as_array().map_or(0, Vec::len);
        let mut parts = vec![];
        if unresolved > 0 {
            parts.push(format!(
                "{unresolved} unresolved relationship{}",
                plural(unresolved)
            ));
        }
        if files > 0 {
            parts.push(format!(
                "{files} file{} with no analysis",
                plural(files as u64)
            ));
        }
        if warnings > 0 {
            parts.push(format!(
                "{warnings} rule warning{}",
                plural(warnings as u64)
            ));
        }
        text.push_str(&format!(
            " Some code in the rules' scope could not be judged: {}.",
            parts.join(", ")
        ));
    }
    if let Some(files) = check["ruleChange"]["files"].as_array() {
        let names: Vec<&str> = files.iter().filter_map(Value::as_str).collect();
        text.push_str(&format!(
            " The work changes {}. The check uses the rules at the start commit, and the owner decides about the change.",
            names.join(" and ")
        ));
    }
    text
}
/// "s" for a count other than 1.
fn plural(n: u64) -> &'static str {
    if n == 1 { "" } else { "s" }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_globs_respect_boundaries() {
        assert!(matches("backend/**", "backend/adapters/rust.rs"));
        assert!(matches("**/*.rs", "main.rs"));
        assert!(!matches("backend/*.rs", "backend/adapters/rust.rs"));
        assert!(!matches("frontend/**", "test/frontend/app.js"));
    }
    #[test]
    fn invalid_configuration_is_not_a_clean_check() {
        assert!(parse(r#"{"version":1,"groups":{},"rules":[{"id":"bad","from":"missing","to":["x"],"kinds":["calls"]}]}"#).is_err());
        // One form only, and a layers rule has two or more layers and no from.
        let groups = r#""groups":{"a":["a/**"],"b":["b/**"]}"#;
        for rule in [
            r#"{"id":"r","from":"a","to":["b"],"only":["b"],"kinds":["calls"]}"#,
            r#"{"id":"r","from":"a","kinds":["calls"]}"#,
            r#"{"id":"r","layers":["a"],"kinds":["calls"]}"#,
            r#"{"id":"r","from":"a","layers":["a","b"],"kinds":["calls"]}"#,
        ] {
            let source = format!(r#"{{"version":1,{groups},"rules":[{rule}]}}"#);
            assert!(parse(&source).is_err(), "{rule}");
        }
    }
    fn relation(source: &str, target: &str, resolution: &str) -> Value {
        json!({"source":{"path":source},"targets":[{"path":target}],"kind":"imports","resolution":resolution})
    }
    fn broken(rules: &Rules, source: &str, target: &str) -> Vec<String> {
        let mut list = [relation(source, target, "resolved")];
        rules.apply(&mut list);
        list[0]["violations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap().to_string())
            .collect()
    }
    #[test]
    fn only_and_layers_rules_fail_closed() {
        let rules = parse(
            r#"{"version":1,"groups":{"routes":["routes/**"],"services":["services/**"],"store":["store/**"],"shared":["shared/**"]},
            "rules":[{"id":"services-only","from":"services","only":["store","shared"],"kinds":["imports"]},
                     {"id":"layered","layers":["routes","services","store"],"kinds":["imports"]}]}"#,
        )
        .unwrap();
        assert!(broken(&rules, "services/a.py", "store/b.py").is_empty());
        assert!(
            broken(&rules, "services/a.py", "services/c.py").is_empty(),
            "Its own group"
        );
        assert_eq!(
            broken(&rules, "services/a.py", "newfolder/x.py"),
            ["services-only"],
            "A new folder is outside"
        );
        assert_eq!(
            broken(&rules, "services/a.py", "routes/r.py"),
            ["services-only", "layered"]
        );
        assert!(
            broken(&rules, "routes/r.py", "store/b.py").is_empty(),
            "A layer may use those below it"
        );
        assert_eq!(broken(&rules, "store/b.py", "routes/r.py"), ["layered"]);
        let overlapping = parse(
            r#"{"version":1,"groups":{"features":["features/**"]},
            "rules":[{"id":"apart","from":"features","to":["features"],"kinds":["imports"]}]}"#,
        )
        .unwrap();
        assert!(
            broken(&overlapping, "features/a.js", "features/a.js").is_empty(),
            "A file that uses itself is not a break"
        );
        assert_eq!(
            broken(&overlapping, "features/a.js", "features/b.js"),
            ["apart"]
        );
        assert!(
            broken(&rules, "newfolder/x.py", "routes/r.py").is_empty(),
            "Outside every layer"
        );
    }
    #[test]
    fn a_narrower_rule_is_covered_by_a_current_rule() {
        let current = parse(
            r#"{"version":1,"groups":{"ui":["ui/**"],"db":["db/**"]},
            "rules":[{"id":"ui-no-db","from":"ui","to":["db"],"kinds":["imports","calls"]}]}"#,
        )
        .unwrap();
        let paths = ["ui/a.py", "ui/b.py", "db/c.py", "lib/d.py"];
        let proposal = |rule: &str| {
            parse(&format!(
                r#"{{"version":1,"groups":{{"ui":["ui/**"],"view":["ui/a.py"],"db":["db/**"],"lib":["lib/**"]}},"rules":[{rule}]}}"#
            ))
            .unwrap()
        };
        let narrower = proposal(r#"{"id":"n","from":"view","to":["db"],"kinds":["calls"]}"#);
        assert_eq!(
            narrower.covered_by(&current, &paths),
            Some("ui-no-db".to_string())
        );
        let wider = proposal(r#"{"id":"w","from":"ui","to":["db","lib"],"kinds":["calls"]}"#);
        assert_eq!(wider.covered_by(&current, &paths), None, "lib/ is new");
        let other_kind = proposal(r#"{"id":"k","from":"ui","to":["db"],"kinds":["inherits"]}"#);
        assert_eq!(other_kind.covered_by(&current, &paths), None);
        let nothing = proposal(r#"{"id":"x","from":"lib","to":["view"],"kinds":["calls"]}"#);
        assert_eq!(
            nothing.covered_by(&current, &paths),
            None,
            "Not covered: ui-no-db does not check lib/"
        );
    }
    #[test]
    fn coverage_counts_each_rule_and_warns_about_rules_that_cover_nothing() {
        let rules = parse(
            r#"{"version":1,"groups":{"ui":["ui/**"],"db":["db/**"],"typo":["uii/**"]},
            "rules":[{"id":"ui-no-db","from":"ui","to":["db"],"kinds":["imports"]},
                     {"id":"dead","from":"typo","to":["db"],"kinds":["imports"]}]}"#,
        )
        .unwrap();
        let mut relations = vec![
            relation("ui/a.js", "db/b.js", "resolved"),
            relation("ui/a.js", "ui/c.js", "resolved"),
            relation("ui/a.js", "lodash", "unresolved"),
        ];
        rules.apply(&mut relations);
        let (coverage, warnings) = rules.coverage(&relations, &["ui/a.js", "ui/c.js", "db/b.js"]);
        assert_eq!(
            coverage[0],
            json!({"id":"ui-no-db","checked":2,"broke":1,"unresolved":1})
        );
        assert_eq!(
            coverage[1],
            json!({"id":"dead","checked":0,"broke":0,"unresolved":0})
        );
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("\"typo\" matches no file"))
        );
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("\"dead\" checked no relationship"))
        );
        assert_eq!(warnings.len(), 2);
    }

    #[test]
    fn a_rule_check_summary_never_reads_as_clean_when_the_check_did_not_run() {
        let not_run = json!({"state":"not checked","reason":"The rules at the start commit are invalid: bad"});
        assert_eq!(
            check_summary(&not_run),
            "Not checked: The rules at the start commit are invalid: bad"
        );
        let clean = json!({"state":"checked","addedCount":0,"ruleChange":null});
        assert_eq!(check_summary(&clean), "The work adds no rule break.");
        let limited = json!({"state":"limited","addedCount":2,"ruleChange":null,"limits":{
            "unresolved":3,"warnings":[],"gaps":{"start":[],"head":[{"path":"a.py"}]},"unanalysed":["b.go"]}});
        assert_eq!(
            check_summary(&limited),
            "The work adds 2 rule breaks. Some code in the rules' scope could not be judged: 3 unresolved relationships, 2 files with no analysis."
        );
        let changed =
            json!({"state":"checked","addedCount":1,"ruleChange":{"files":[".peekumi.json"]}});
        assert!(check_summary(&changed).ends_with(
            "The work changes .peekumi.json. The check uses the rules at the start commit, and the owner decides about the change."
        ));
    }
}
