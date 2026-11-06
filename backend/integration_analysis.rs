//! Revision-bound integration impact and finding outcomes. No inspected code executes here.
use super::*;

impl Repository {
    /// Compares the current worktree with the immutable pre-edit baseline and its rules.
    /// Each changed Python declaration has independent before and after coverage evidence.
    pub fn integration_impact(
        &mut self,
        baseline: &str,
        threshold: f64,
        focus: &str,
    ) -> Result<Value> {
        anyhow::ensure!(
            threshold.is_finite() && threshold > 0.0 && threshold <= 100000.0,
            "Invalid CRAP threshold"
        );
        anyhow::ensure!(focus.len() <= 256, "Focus exceeds 256 bytes");
        let start = crate::worktree::get_baseline(&self.state, baseline)?;
        let sha = match crate::worktree::snapshot(&self.directory, &self.state)? {
            Some((sha, _)) => sha,
            None => self.resolve("HEAD")?,
        };
        crate::worktree::update_baseline(&self.state, baseline, Some(&sha), None)?;
        let before = self.snapshot(&start.sha)?;
        let after = self.snapshot(&sha)?;
        let check = self.rule_check(&start.rules_sha, &sha)?;
        let comparison = self.compare(&start.sha, &sha, false)?;
        let files: Vec<_> = array(&comparison["files"])
            .into_iter()
            .filter(|f| f["status"] != "unchanged")
            .collect();
        let (before_scores, mut limits, before_unavailable) = self.integration_scores(&before)?;
        let (after_scores, after_limits, after_unavailable) = self.integration_scores(&after)?;
        // Coverage is required only for declarations that this turn changed.
        limits.clear();
        let mut incomplete = check["state"] != "checked";
        if incomplete {
            limits.push(format!(
                "Frozen rule check is {}: {}",
                text(&check["state"]),
                check["limits"]
            ));
        }
        let hidden_rule_breaks = check["addedCount"]
            .as_u64()
            .unwrap_or(0)
            .saturating_sub(array(&check["added"]).len() as u64);
        if hidden_rule_breaks > 0 {
            limits.push(format!(
                "{hidden_rule_breaks} additional rule breaks exceed the detailed evidence limit"
            ));
        }
        let mut symbols = vec![];
        let mut findings = vec![];
        let mut unknown_risks = BTreeSet::new();
        for file in &files {
            let path = text(&file["path"]);
            for symbol in array(&file["symbols"])
                .into_iter()
                .filter(|s| s["status"] != "unchanged")
            {
                let name = text(&symbol["name"]);
                let key = format!("{path}::{name}");
                let python = path.ends_with(".py")
                    && ["function", "method"].contains(&text(&symbol["kind"]));
                let unknown = |reason: &str| json!({"state":"unknown","reason":reason});
                let a = if symbol["status"] == "added" {
                    json!({"state":"new"})
                } else if python {
                    before_scores.get(&key).cloned().unwrap_or(unknown(
                        "No valid coverage evidence for the baseline snapshot",
                    ))
                } else {
                    unknown("CRAP not available for this language or declaration kind")
                };
                let b = if symbol["status"] == "removed" {
                    json!({"state":"removed"})
                } else if python {
                    after_scores.get(&key).cloned().unwrap_or(unknown(
                        "No valid coverage evidence for the current snapshot",
                    ))
                } else {
                    unknown("CRAP not available for this language or declaration kind")
                };
                if python && b["state"] == "unknown" {
                    unknown_risks.insert(format!("risk:{}", hash(&key)));
                }
                if python && (a["state"] == "unknown" || b["state"] == "unknown") {
                    incomplete = true;
                    limits.push(format!("{key}: coverage or CRAP is unknown"));
                }
                if python && b["crap"].as_f64().is_some_and(|score| score > threshold) {
                    findings.push(json!({"id":format!("risk:{}",hash(&key)),"kind":"crap","path":path,"symbol":name,
                        "message":format!("{key} has CRAP {} (complexity {}, coverage {}%). Add tests with peekumi_measure or simplify it.", b["crap"], b["complexity"], b["coverage"]),"evidence":b}));
                }
                symbols.push(json!({"id":key,"path":path,"name":name,"kind":symbol["kind"],"changed":symbol["status"],"start":symbol["start"],"before":a,"after":b}));
            }
            if path.ends_with(".py") && !text(&file["analysis"]).contains("Python AST") {
                incomplete = true;
                limits.push(format!("{path}: Python graph analysis is unavailable"));
            }
        }
        for rule in array(&check["added"]) {
            let relation = after.relationships.iter().find(|r| {
                r["source"] == rule["source"]
                    && r["targets"][0] == rule["target"]
                    && r["kind"] == rule["kind"]
            });
            let mut line = relation
                .map(|r| r["sites"][0].clone())
                .unwrap_or(Value::Null);
            let path = text(&rule["source"]["path"]);
            if line.is_null()
                && let Some(file) = after.files.get(path)
            {
                let specifiers: BTreeSet<_> = file
                    .imports
                    .iter()
                    .filter(|i| {
                        array(&i["resolved"])
                            .iter()
                            .any(|p| *p == rule["target"]["path"])
                    })
                    .map(|i| text(&i["specifier"]))
                    .collect();
                line = file
                    .import_sites
                    .iter()
                    .find(|s| specifiers.contains(text(&s["specifier"])))
                    .map(|s| s["line"].clone())
                    .unwrap_or(Value::Null);
            }
            let import_line = line
                .as_u64()
                .and_then(|n| {
                    after
                        .files
                        .get(path)?
                        .source
                        .as_ref()?
                        .lines()
                        .nth(n.saturating_sub(1) as usize)
                })
                .unwrap_or("");
            findings.push(json!({"id":format!("rule:{}",hash(rule.to_string())),"kind":"rule","rule":rule["rule"],"source":rule["source"],"target":rule["target"],"line":line,"import_line":import_line,
                "message":format!("{}:{} imports {} and breaks {}: {}",path,line,text(&rule["target"]["path"]),text(&rule["rule"]),text(&rule["message"]))}));
        }
        if !check["ruleChange"].is_null() {
            findings.push(json!({"id":"rules:changed","kind":"rule_change","message":"Dependency rules changed after the baseline; the check still uses the frozen rules","evidence":check["ruleChange"]}));
        }
        crate::integration_evidence::retain_open_risk(
            &self.state,
            baseline,
            &mut findings,
            &unknown_risks,
        )?;
        for finding in &mut findings {
            if let Some(reason) = start.exceptions.get(text(&finding["id"])) {
                finding["exception"] = json!(reason);
            }
        }
        let open = hidden_rule_breaks > 0 || findings.iter().any(|f| f["exception"].is_null());
        let required_python = symbols.iter().any(|s| {
            text(&s["path"]).ends_with(".py") && ["function", "method"].contains(&text(&s["kind"]))
        });
        let unavailable = required_python && (before_unavailable || after_unavailable);
        if required_python {
            limits.extend(after_limits);
        }
        let status = if open {
            "findings"
        } else if !findings.is_empty() {
            "exception"
        } else if unavailable {
            "unavailable"
        } else if incomplete {
            "incomplete"
        } else {
            "passed"
        };
        let changed: BTreeSet<_> = files.iter().map(|f| text(&f["path"])).collect();
        let dependents: Vec<_> = after
            .files
            .values()
            .filter(|f| f.deps.iter().any(|p| changed.contains(p.as_str())))
            .map(|f| f.path.clone())
            .collect();
        Ok(
            json!({"status":status,"limits":limits,"baseline":start.id,"baseline_sha":start.sha,"rules_sha":start.rules_sha,"snapshot_sha":sha,
            "coverage_sha":crate::integration_evidence::for_snapshot(&self.state,&sha)?.filter(|e|e.valid).map(|e|e.snapshot),
            "already_changed":start.already_changed,"changed_files":files,"changed_symbols":symbols,"dependents":dependents,
            "findings":findings,"rule_check":check,"focus":focus,"threshold":threshold}),
        )
    }

    /// Records a reason only for a finding that exists in current measured evidence.
    /// The finding remains visible; this does not create a passed result.
    pub fn integration_exception(
        &mut self,
        baseline: &str,
        threshold: f64,
        finding: &str,
        reason: &str,
    ) -> Result<Value> {
        let current = self.integration_impact(baseline, threshold, "")?;
        anyhow::ensure!(
            array(&current["findings"])
                .iter()
                .any(|f| f["id"] == finding),
            "Finding is absent from current evidence"
        );
        crate::worktree::update_baseline(&self.state, baseline, None, Some((finding, reason)))?;
        self.integration_impact(baseline, threshold, "")
    }

    /// Records a measurement receipt, including failure, under an active baseline.
    pub fn integration_coverage(&mut self, baseline: &str, body: &Value) -> Result<Value> {
        let start = crate::worktree::get_baseline(&self.state, baseline)?;
        let sha = body["snapshot"]
            .as_str()
            .context("Missing source snapshot")?;
        anyhow::ensure!(
            sha == start.sha || start.snapshots.contains(sha),
            "Coverage source is outside this baseline"
        );
        let evidence = crate::integration_evidence::record(&self.state, baseline, body)?;
        Ok(
            json!({"status":"incomplete","limits":if evidence.valid {vec!["Coverage accepted; request impact to check findings"]}else{vec![evidence.reason.as_str()]},"snapshot_sha":evidence.snapshot,"run_id":evidence.run_id,"report_hash":evidence.report_hash,"accepted":evidence.valid}),
        )
    }
}
