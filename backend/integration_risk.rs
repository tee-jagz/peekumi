//! Score lookup through crapper. LCOV presence is checked before upstream scores are used.
use super::*;

impl Repository {
    /// Returns score rows for one exact source snapshot and coverage run.
    /// Missing evidence stays unknown. Crapper only sees a private materialization.
    pub(super) fn integration_scores(
        &self,
        snapshot: &Snapshot,
    ) -> Result<(Value, Vec<String>, bool)> {
        let Some(evidence) = crate::integration_evidence::for_snapshot(&self.state, &snapshot.sha)?
        else {
            return Ok((
                json!({}),
                vec![format!("No coverage evidence for {}", snapshot.sha)],
                false,
            ));
        };
        if !evidence.valid {
            return Ok((json!({}), vec![evidence.reason], false));
        }
        let crapper = std::env::var_os("PEEKUMI_CRAPPER_PATH").map(PathBuf::from);
        let Some(crapper) = crapper.filter(|p| p.is_absolute() && p.is_file()) else {
            return Ok((
                json!({}),
                vec!["Configured crapper is unavailable".into()],
                true,
            ));
        };
        let checksum = std::env::var("PEEKUMI_CRAPPER_PARSER_SHA256").unwrap_or_default();
        let parser_cache = std::env::var("PEEKUMI_CRAPPER_PARSER_CACHE").unwrap_or_default();
        let key = hash(format!(
            "{}:{}:{}:{}:{}",
            snapshot.sha,
            evidence.report_hash,
            crapper.display(),
            checksum,
            hash(include_bytes!("crapper_helper.py"))
        ));
        let cache = self
            .state
            .join("integration-metrics")
            .join(format!("{key}.json"));
        let entries: Vec<Value> = match std::fs::read(&cache)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
        {
            Some(entries) => entries,
            None => {
                let (folder, _) = self.private_copy(snapshot)?;
                let report = folder.0.join("target/coverage/lcov.info");
                std::fs::create_dir_all(report.parent().unwrap())?;
                std::fs::write(&report, &evidence.report)?;
                let python =
                    crapper
                        .parent()
                        .context("Invalid crapper path")?
                        .join(if cfg!(windows) {
                            "python.exe"
                        } else {
                            "python"
                        });
                let paths: Vec<_> = snapshot
                    .files
                    .values()
                    .filter(|f| {
                        f.path.ends_with(".py")
                            && f.source.is_some()
                            && ["100644", "100755"].contains(&f.mode.as_str())
                    })
                    .map(|f| f.path.clone())
                    .collect();
                let result = crate::process::run_for(
                    python.to_str().context("Invalid crapper interpreter")?,
                    &[
                        "-I",
                        "-c",
                        include_str!("crapper_helper.py"),
                        folder.0.to_str().context("Invalid analysis path")?,
                        &checksum,
                        &parser_cache,
                    ],
                    Some(&folder.0),
                    serde_json::to_vec(&paths)?,
                    std::time::Duration::from_secs(60),
                );
                let result = match result {
                    Ok(output) => output,
                    Err(_) => return Ok((json!({}), vec!["Crapper did not provide scores; check its pinned installation and parser checksum".into()], true)),
                };
                let entries: Vec<Value> = serde_json::from_slice(&result)?;
                std::fs::create_dir_all(cache.parent().unwrap())?;
                std::fs::write(&cache, serde_json::to_vec(&entries)?)?;
                entries
            }
        };
        let lcov = crate::integration_evidence::parse_lcov(&evidence.report)?;
        let mut scores = json!({});
        let mut limits = vec![];
        let mut matched = BTreeSet::new();
        for file in snapshot.files.values().filter(|f| f.path.ends_with(".py")) {
            let module = python_module(&file.path);
            for symbol in file
                .symbols
                .iter()
                .filter(|s| ["function", "method"].contains(&text(&s["kind"])))
            {
                let key = format!("{}::{}", file.path, text(&symbol["name"]));
                let full = format!("{module}.{}", text(&symbol["name"]));
                let candidates: Vec<_> = entries
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| {
                        format!("{}.{}", text(&e[":namespace"]), text(&e[":name"])) == full
                    })
                    .collect();
                let present = lcov.get(&file.path).is_some_and(|lines| {
                    lines.iter().any(|line| {
                        *line >= symbol["start"].as_u64().unwrap_or(0)
                            && *line <= symbol["end"].as_u64().unwrap_or(0)
                    })
                });
                if !present {
                    scores[&key] = json!({"state":"unknown","reason":"Coverage report does not mention this file or function","snapshot":snapshot.sha,"run_id":evidence.run_id});
                } else if let [(index, entry)] = candidates.as_slice() {
                    matched.insert(*index);
                    scores[&key] = json!({"state":"measured","complexity":entry[":complexity"],"coverage":entry[":coverage"],"crap":entry[":crap"],"snapshot":snapshot.sha,"coverage_sha":evidence.snapshot,"run_id":evidence.run_id,"report_hash":evidence.report_hash});
                } else {
                    scores[&key] = json!({"state":"unknown","reason":"Crapper symbol mapping is absent or ambiguous","snapshot":snapshot.sha});
                }
            }
        }
        for (index, entry) in entries.iter().enumerate() {
            if !matched.contains(&index) {
                limits.push(format!(
                    "Unmatched crapper entry: {}.{}",
                    text(&entry[":namespace"]),
                    text(&entry[":name"])
                ));
            }
        }
        Ok((scores, limits, false))
    }
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
