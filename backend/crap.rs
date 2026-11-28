//! CRAP (Change Risk Anti-Patterns) scores for Python functions from sandboxed coverage runs.
//!
//! Coverage evidence is written only by Peekumi's own sandboxed verification runner (see
//! `verify::capture_artifacts`), never by an agent report. For each commit that has a
//! recorded LCOV coverage report, this module computes per-function CRAP scores:
//!
//! `CRAP(f) = complexity(f)^2 * (1 - coverage(f))^3 + complexity(f)`
//!
//! When `PEEKUMI_CRAPPER_PATH` is configured, Peekumi invokes the pinned `crapper 0.1.0`
//! package (with parser SHA-256 verification and runtime downloads disabled, adapted from
//! `hermes/day-1`). Otherwise Peekumi computes McCabe cyclomatic complexity statically via
//! the embedded Python AST helper (`crap_python.py`) and combines it with LCOV line coverage.
//!
//! Functions with CRAP > 30 count as risky. Non-Python files explicitly report
//! `"CRAP not available"` with a reason and are listed in `excludedFiles`.

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

/// Scores strictly above this threshold count as risky on the map and in review evidence.
pub const RISKY_THRESHOLD: f64 = 30.0;

/// Coverage report stored by Peekumi's sandboxed verification runner for one exact commit.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CoverageEvidence {
    pub commit: String,
    pub verify_run_id: String,
    pub check_id: String,
    pub artifact_path: String,
    pub report_hash: String,
    pub recorded_at: u64,
    pub report: String,
}

/// Persists LCOV coverage captured from a sandboxed verification run for `commit`.
pub fn store_coverage(
    state: &Path,
    commit: &str,
    verify_run_id: &str,
    check_id: &str,
    artifact_path: &str,
    bytes: &[u8],
) -> Result<()> {
    ensure!(
        commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()),
        "Coverage must bind to a 40-character commit SHA"
    );
    let report = String::from_utf8_lossy(bytes).into_owned();
    // Validate that the file parses as LCOV before storing it as coverage evidence.
    let parsed = parse_lcov(&report)?;
    ensure!(
        !parsed.is_empty(),
        "Coverage report contains no LCOV file records"
    );
    let dir = state.join("verify").join("coverage");
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let evidence = CoverageEvidence {
        commit: commit.to_string(),
        verify_run_id: verify_run_id.to_string(),
        check_id: check_id.to_string(),
        artifact_path: artifact_path.to_string(),
        report_hash: crate::hash::hash(bytes),
        recorded_at: crate::workflow::now(),
        report,
    };
    let target = dir.join(format!("{commit}.json"));
    let pending = dir.join(format!("{commit}.json.pending"));
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&pending)?;
    file.write_all(&serde_json::to_vec(&evidence)?)?;
    file.sync_all()?;
    std::fs::rename(pending, target)?;
    Ok(())
}

/// Reads recorded sandboxed coverage evidence for `commit`, if any.
pub fn load_coverage(state: &Path, commit: &str) -> Result<Option<CoverageEvidence>> {
    if commit.len() != 40 || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(None);
    }
    let path = state
        .join("verify")
        .join("coverage")
        .join(format!("{commit}.json"));
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Parses an LCOV report into `path -> (line_number -> hit_count)`.
/// Normalizes `./` prefixes and absolute sandbox temp paths to repository-relative paths
/// when matched against known snapshot paths later.
pub fn parse_lcov(report: &str) -> Result<BTreeMap<String, BTreeMap<u64, u64>>> {
    let mut files: BTreeMap<String, BTreeMap<u64, u64>> = BTreeMap::new();
    let mut current: Option<String> = None;
    for raw_line in report.lines() {
        let line = raw_line.trim();
        if let Some(sf) = line.strip_prefix("SF:") {
            let normalized = sf.trim().replace('\\', "/");
            let normalized = normalized
                .strip_prefix("./")
                .unwrap_or(&normalized)
                .to_string();
            current = Some(normalized.clone());
            files.entry(normalized).or_default();
        } else if let Some(da) = line.strip_prefix("DA:") {
            if let Some(ref file) = current {
                let mut parts = da.split(',');
                if let (Some(ln), Some(hits)) = (parts.next(), parts.next())
                    && let (Ok(ln), Ok(hits)) =
                        (ln.trim().parse::<u64>(), hits.trim().parse::<u64>())
                {
                    let entry = files.entry(file.clone()).or_default();
                    let slot = entry.entry(ln).or_insert(0);
                    *slot = (*slot).max(hits);
                }
            }
        } else if line == "end_of_record" {
            current = None;
        }
    }
    Ok(files)
}

/// Finds the LCOV line map matching repository-relative `repo_path`.
fn lcov_lines_for<'a>(
    lcov: &'a BTreeMap<String, BTreeMap<u64, u64>>,
    repo_path: &str,
) -> Option<&'a BTreeMap<u64, u64>> {
    if let Some(exact) = lcov.get(repo_path) {
        return Some(exact);
    }
    let suffix = format!("/{repo_path}");
    lcov.iter()
        .find(|(k, _)| k.ends_with(&suffix))
        .map(|(_, v)| v)
}

/// Computes the standard CRAP score: `comp^2 * (1 - cov)^3 + comp`, rounded to 2 decimal places.
pub fn crap_score(complexity: f64, coverage: f64) -> f64 {
    let cov = coverage.clamp(0.0, 1.0);
    let raw = complexity * complexity * (1.0 - cov).powi(3) + complexity;
    (raw * 100.0).round() / 100.0
}

fn python_module(path: &str) -> String {
    let mut path = path
        .strip_prefix("src/")
        .unwrap_or(path)
        .trim_end_matches(".py");
    if path == "__init__" {
        return path.into();
    }
    path = path.strip_suffix("/__init__").unwrap_or(path);
    path.replace('/', ".")
}

/// Computes per-function CRAP scores for Python files at one commit using either the pinned
/// `crapper 0.1.0` binary (when `PEEKUMI_CRAPPER_PATH` is set) or the embedded Python AST
/// complexity + LCOV calculator.
pub fn score_python_commit(
    state: &Path,
    python_bin: &str,
    commit: &str,
    py_files: &[(String, String)],
) -> Result<(BTreeMap<String, Value>, Value, Vec<String>)> {
    let Some(evidence) = load_coverage(state, commit)? else {
        return Ok((
            BTreeMap::new(),
            json!({
                "state": "unavailable",
                "commit": commit,
                "reason": format!("No sandboxed coverage run for commit {}", &commit[..7.min(commit.len())]),
            }),
            vec![],
        ));
    };

    let lcov = parse_lcov(&evidence.report)?;
    let mut limits = Vec::new();

    // Path 1: Pinned crapper 0.1.0 (from hermes/day-1), when explicitly configured.
    if let Some(crapper) = std::env::var_os("PEEKUMI_CRAPPER_PATH")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
    {
        match score_with_crapper(&crapper, state, commit, py_files, &evidence, &lcov) {
            Ok((scores, extra_limits)) => {
                limits.extend(extra_limits);
                let source = json!({
                    "state": "available",
                    "commit": commit,
                    "calculator": "crapper 0.1.0",
                    "verifyRunId": evidence.verify_run_id,
                    "checkId": evidence.check_id,
                    "artifactPath": evidence.artifact_path,
                    "reportHash": evidence.report_hash,
                    "recordedAt": evidence.recorded_at,
                });
                return Ok((scores, source, limits));
            }
            Err(e) => {
                limits.push(format!(
                    "Pinned crapper failed ({e}); fell back to Python AST + LCOV calculation"
                ));
            }
        }
    }

    // Path 2: Embedded Python stdlib AST cyclomatic complexity + LCOV line coverage.
    let payload = json!({
        "files": py_files.iter().map(|(path, source)| json!({"path": path, "source": source})).collect::<Vec<_>>()
    });
    let out = crate::process::run_for(
        python_bin,
        &["-I", "-c", include_str!("crap_python.py")],
        None,
        serde_json::to_vec(&payload)?,
        Duration::from_secs(30),
    )
    .context("Python AST complexity helper failed")?;
    let parsed: Value = serde_json::from_slice(&out)?;
    if let Some(errs) = parsed["errors"].as_array() {
        for err in errs {
            limits.push(format!(
                "Could not parse {}: {}",
                err["path"].as_str().unwrap_or(""),
                err["error"].as_str().unwrap_or("")
            ));
        }
    }
    let mut scores = BTreeMap::new();
    for func in parsed["functions"].as_array().into_iter().flatten() {
        let path = func["path"].as_str().unwrap_or("");
        let name = func["name"].as_str().unwrap_or("");
        let start = func["start"].as_u64().unwrap_or(0);
        let end = func["end"].as_u64().unwrap_or(start);
        let comp = func["complexity"].as_f64().unwrap_or(1.0);
        let key = format!("{path}::{name}");
        let Some(lines) = lcov_lines_for(&lcov, path) else {
            scores.insert(
                key,
                json!({
                    "state": "unavailable",
                    "reason": "Coverage report does not include this file",
                    "complexity": comp,
                    "commit": commit,
                }),
            );
            continue;
        };
        let in_func: Vec<(u64, u64)> = lines.range(start..=end).map(|(l, h)| (*l, *h)).collect();
        if in_func.is_empty() {
            scores.insert(
                key,
                json!({
                    "state": "unavailable",
                    "reason": "Coverage report has no executable lines for this function",
                    "complexity": comp,
                    "commit": commit,
                }),
            );
            continue;
        }
        let covered = in_func.iter().filter(|(_, hits)| *hits > 0).count();
        let total = in_func.len();
        let cov = covered as f64 / total as f64;
        let score = crap_score(comp, cov);
        scores.insert(
            key,
            json!({
                "state": "measured",
                "complexity": comp,
                "coverage": (cov * 1000.0).round() / 1000.0,
                "coveredLines": covered,
                "totalLines": total,
                "crap": score,
                "risky": score > RISKY_THRESHOLD,
                "commit": commit,
                "verifyRunId": evidence.verify_run_id,
                "checkId": evidence.check_id,
                "artifactPath": evidence.artifact_path,
                "reportHash": evidence.report_hash,
                "calculator": "python-ast+lcov",
            }),
        );
    }
    let source = json!({
        "state": "available",
        "commit": commit,
        "calculator": "python-ast+lcov",
        "verifyRunId": evidence.verify_run_id,
        "checkId": evidence.check_id,
        "artifactPath": evidence.artifact_path,
        "reportHash": evidence.report_hash,
        "recordedAt": evidence.recorded_at,
    });
    Ok((scores, source, limits))
}

fn score_with_crapper(
    crapper: &Path,
    state: &Path,
    commit: &str,
    py_files: &[(String, String)],
    evidence: &CoverageEvidence,
    lcov: &BTreeMap<String, BTreeMap<u64, u64>>,
) -> Result<(BTreeMap<String, Value>, Vec<String>)> {
    let checksum = std::env::var("PEEKUMI_CRAPPER_PARSER_SHA256").unwrap_or_default();
    let parser_cache = std::env::var("PEEKUMI_CRAPPER_PARSER_CACHE").unwrap_or_default();
    let key = crate::hash::hash(
        format!(
            "{}:{}:{}:{}:{}",
            commit,
            evidence.report_hash,
            crapper.display(),
            checksum,
            crate::hash::hash(include_bytes!("crapper_helper.py"))
        )
        .as_bytes(),
    );
    let cache = state
        .join("verify")
        .join("crap-cache")
        .join(format!("{key}.json"));
    let entries: Vec<Value> = match std::fs::read(&cache)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(entries) => entries,
        None => {
            let tmp = std::env::temp_dir().join(format!("peekumi-crapper-{}", &key[..12]));
            let _ = std::fs::remove_dir_all(&tmp);
            std::fs::create_dir_all(&tmp)?;
            for (rel, src) in py_files {
                let p = tmp.join(rel);
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(p, src)?;
            }
            let report_path = tmp.join("target/coverage/lcov.info");
            std::fs::create_dir_all(report_path.parent().unwrap())?;
            std::fs::write(&report_path, &evidence.report)?;
            let python = crapper
                .parent()
                .context("Invalid crapper path")?
                .join(if cfg!(windows) {
                    "python.exe"
                } else {
                    "python"
                });
            let paths: Vec<&String> = py_files.iter().map(|(p, _)| p).collect();
            let result = crate::process::run_for(
                python.to_str().context("Invalid crapper interpreter")?,
                &[
                    "-I",
                    "-c",
                    include_str!("crapper_helper.py"),
                    tmp.to_str().context("Invalid analysis path")?,
                    &checksum,
                    &parser_cache,
                ],
                Some(&tmp),
                serde_json::to_vec(&paths)?,
                Duration::from_secs(60),
            );
            let _ = std::fs::remove_dir_all(&tmp);
            let result = result?;
            let entries: Vec<Value> = serde_json::from_slice(&result)?;
            if let Some(parent) = cache.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&cache, serde_json::to_vec(&entries)?);
            entries
        }
    };
    let mut scores = BTreeMap::new();
    let mut matched = BTreeSet::new();
    let mut limits = Vec::new();
    for (path, _) in py_files {
        let module = python_module(path);
        let present = lcov_lines_for(lcov, path).is_some();
        for (idx, entry) in entries.iter().enumerate() {
            let ns = entry[":namespace"].as_str().unwrap_or("");
            let name = entry[":name"].as_str().unwrap_or("");
            let prefix = format!("{module}.");
            if ns == module || ns.starts_with(&prefix) {
                matched.insert(idx);
                let qualified = if ns == module {
                    name.to_string()
                } else {
                    format!("{}.{}", &ns[prefix.len()..], name)
                };
                let full_key = format!("{path}::{qualified}");
                if !present {
                    scores.insert(
                        full_key,
                        json!({
                            "state": "unavailable",
                            "reason": "Coverage report does not mention this file",
                            "commit": commit,
                        }),
                    );
                } else {
                    let score = entry[":crap"].as_f64().unwrap_or(0.0);
                    scores.insert(
                        full_key,
                        json!({
                            "state": "measured",
                            "complexity": entry[":complexity"],
                            "coverage": entry[":coverage"],
                            "crap": score,
                            "risky": score > RISKY_THRESHOLD,
                            "commit": commit,
                            "verifyRunId": evidence.verify_run_id,
                            "checkId": evidence.check_id,
                            "artifactPath": evidence.artifact_path,
                            "reportHash": evidence.report_hash,
                            "calculator": "crapper 0.1.0",
                        }),
                    );
                }
            }
        }
    }
    for (idx, entry) in entries.iter().enumerate() {
        if !matched.contains(&idx) {
            limits.push(format!(
                "Unmatched crapper entry: {}.{}",
                entry[":namespace"].as_str().unwrap_or(""),
                entry[":name"].as_str().unwrap_or("")
            ));
        }
    }
    Ok((scores, limits))
}

/// Language label for unsupported-CRAP reporting.
pub fn language_label(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "py" => "python",
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "svelte" => "svelte",
        "go" => "go",
        "java" => "java",
        "rb" => "ruby",
        "c" | "h" | "cc" | "cpp" => "c/c++",
        "md" | "txt" | "json" | "yml" | "yaml" | "toml" | "css" | "html" => "non-code",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crap_formula_matches_standard_definition_and_risky_threshold() {
        // Complexity 1, 100% coverage -> CRAP = 1.0
        assert_eq!(crap_score(1.0, 1.0), 1.0);
        // Complexity 5, 100% coverage -> CRAP = 5.0
        assert_eq!(crap_score(5.0, 1.0), 5.0);
        // Complexity 5, 0% coverage -> CRAP = 25 + 5 = 30.0 (not > 30)
        assert_eq!(crap_score(5.0, 0.0), 30.0);
        // Complexity 6, 0% coverage -> CRAP = 36 + 6 = 42.0 (> 30 risky)
        assert_eq!(crap_score(6.0, 0.0), 42.0);
        assert!(crap_score(6.0, 0.0) > RISKY_THRESHOLD);
        // Complexity 10, 50% coverage -> 100 * 0.125 + 10 = 22.5
        assert_eq!(crap_score(10.0, 0.5), 22.5);
    }

    #[test]
    fn parses_lcov_records_and_normalizes_paths() {
        let lcov = "TN:\nSF:./pkg/calc.py\nDA:1,1\nDA:2,0\nDA:3,2\nend_of_record\n";
        let parsed = parse_lcov(lcov).unwrap();
        let lines = lcov_lines_for(&parsed, "pkg/calc.py").unwrap();
        assert_eq!(lines.get(&1), Some(&1));
        assert_eq!(lines.get(&2), Some(&0));
        assert_eq!(lines.get(&3), Some(&2));
    }
}
