//! Coverage evidence bound to an exported source snapshot and one measurement run.
//! The configured measurement client attests command exits and fresh-folder provenance.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Clone, Deserialize, Serialize)]
pub struct Evidence {
    pub snapshot: String,
    pub run_id: String,
    pub report_hash: String,
    pub report: String,
    pub test_exit: i64,
    pub export_exit: i64,
    pub valid: bool,
    pub reason: String,
}

fn read(state: &Path, name: &str) -> Result<Value> {
    match std::fs::read(state.join(name)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}

fn save(state: &Path, name: &str, value: &Value) -> Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(state)?;
    let pending = state.join(format!("{name}.pending"));
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&pending)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    std::fs::rename(pending, state.join(name))?;
    Ok(())
}

/// Creates a one-use receipt for an export. It expires with the baseline pin.
pub fn reserve(state: &Path, baseline: &str, snapshot: &str) -> Result<String> {
    let mut runs = read(state, "integration-measurements.json")?;
    let id = crate::random_token();
    if runs.get("runs").is_none() {
        runs["runs"] = json!({});
    }
    runs["runs"][&id] = json!({"baseline":baseline,"snapshot":snapshot});
    save(state, "integration-measurements.json", &runs)?;
    Ok(id)
}

/// Accepts one report only for the source exported for this run. Failed commands are
/// recorded as failed evidence. The client must use a new folder and fresh report.
pub fn record(state: &Path, baseline: &str, body: &Value) -> Result<Evidence> {
    let run_id = body["run_id"].as_str().context("Missing coverage run ID")?;
    let snapshot = body["snapshot"]
        .as_str()
        .context("Missing source snapshot")?;
    let mut runs = read(state, "integration-measurements.json")?;
    ensure!(
        runs["runs"][run_id]["baseline"] == baseline
            && runs["runs"][run_id]["snapshot"] == snapshot,
        "Coverage run does not match the exported source"
    );
    let report = body["report"].as_str().unwrap_or("");
    ensure!(
        report.len() <= 4 * 1024 * 1024,
        "Coverage report exceeds 4 MiB"
    );
    let report_hash = crate::hash::hash(report);
    let test_exit = body["test_exit"].as_i64().unwrap_or(-1);
    let export_exit = body["export_exit"].as_i64().unwrap_or(-1);
    let fingerprint = crate::hash::hash(
        json!([
            baseline,
            snapshot,
            run_id,
            report_hash,
            test_exit,
            export_exit,
            body["fresh_directory"],
            body["report_hash"]
        ])
        .to_string(),
    );
    if !runs["runs"][run_id]["submitted"].is_null() {
        ensure!(
            runs["runs"][run_id]["fingerprint"] == fingerprint,
            "Measurement receipt was already consumed with different evidence"
        );
        return Ok(serde_json::from_value(
            runs["runs"][run_id]["submitted"].clone(),
        )?);
    }
    let valid = test_exit == 0
        && export_exit == 0
        && body["fresh_directory"] == true
        && body["report_hash"] == report_hash
        && !report.is_empty()
        && parse_lcov(report).is_ok();
    let entry = Evidence {
        snapshot: snapshot.into(),
        run_id: run_id.into(),
        report_hash,
        report: if valid { report.into() } else { String::new() },
        test_exit,
        export_exit,
        valid,
        reason: if valid {
            String::new()
        } else {
            "Measurement failed, report is absent or provenance is invalid".into()
        },
    };
    if runs.get("coverage").is_none() {
        runs["coverage"] = json!({});
    }
    runs["coverage"][snapshot] = serde_json::to_value(&entry)?;
    let mut receipt = entry.clone();
    receipt.report.clear();
    runs["runs"][run_id]["submitted"] = serde_json::to_value(receipt)?;
    runs["runs"][run_id]["fingerprint"] = json!(fingerprint);
    save(state, "integration-measurements.json", &runs)?;
    Ok(entry)
}

/// Returns only evidence for this exact snapshot. Other source revisions stay unknown.
pub fn for_snapshot(state: &Path, sha: &str) -> Result<Option<Evidence>> {
    let saved = read(state, "integration-measurements.json")?;
    saved["coverage"]
        .get(sha)
        .map(|v| serde_json::from_value(v.clone()).map_err(Into::into))
        .transpose()
}

/// Carries an open measured risk through missing or stale coverage. Only new valid
/// scores or a source comparison without that declaration can remove the finding.
pub fn retain_open_risk(
    state: &Path,
    baseline: &str,
    findings: &mut Vec<Value>,
    unknown: &BTreeSet<String>,
) -> Result<()> {
    let mut saved = read(state, "integration-open-risk.json")?;
    for mut old in saved[baseline].as_array().cloned().unwrap_or_default() {
        let id = old["id"].as_str().unwrap_or("");
        if unknown.contains(id) && !findings.iter().any(|f| f["id"] == id) {
            if old["stale"] != true {
                old["message"] = json!(format!(
                    "{} Current coverage is unknown; this finding remains open from the prior measurement.",
                    old["message"]
                        .as_str()
                        .unwrap_or("Measured risk remains open.")
                ));
            }
            old["stale"] = json!(true);
            findings.push(old);
        }
    }
    saved[baseline] = json!(
        findings
            .iter()
            .filter(|f| f["kind"] == "crap")
            .collect::<Vec<_>>()
    );
    save(state, "integration-open-risk.json", &saved)
}

/// Read source-file line evidence before trusting upstream's absent-coverage fallback.
/// LCOV paths must be relative to the exported root. Absolute or escaping paths fail.
pub fn parse_lcov(report: &str) -> Result<BTreeMap<String, BTreeSet<u64>>> {
    let mut files = BTreeMap::<String, BTreeSet<u64>>::new();
    let mut path = None;
    for line in report.lines() {
        if let Some(file) = line.strip_prefix("SF:") {
            ensure!(
                !file.is_empty()
                    && !file.contains('\\')
                    && Path::new(file)
                        .components()
                        .all(|c| matches!(c, std::path::Component::Normal(_))),
                "LCOV source paths must stay inside the snapshot"
            );
            path = Some(file.to_string());
            files.entry(file.into()).or_default();
        } else if let Some(value) = line.strip_prefix("DA:") {
            let (line, hits) = value.split_once(',').context("Invalid LCOV line record")?;
            let number: u64 = line.parse()?;
            let _: u64 = hits.split(',').next().unwrap_or("").parse()?;
            ensure!(number > 0, "Invalid LCOV source line");
            files
                .get_mut(path.as_ref().context("LCOV line has no source file")?)
                .unwrap()
                .insert(number);
        } else if line == "end_of_record" {
            path = None;
        }
    }
    ensure!(!files.is_empty(), "LCOV has no source records");
    Ok(files)
}
