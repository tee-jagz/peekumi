//! Compact real-path graph for the Hermes pane. Unknown and unresolved data stay explicit.
use super::*;

impl Repository {
    /// Returns at most 300 real folder, file and symbol nodes, with bounded edges.
    /// A focus keeps its files and direct neighbors. Hidden nodes remain counted by folder.
    pub fn integration_map(
        &mut self,
        baseline: &str,
        threshold: f64,
        focus: &str,
    ) -> Result<Value> {
        let impact = self.integration_impact(baseline, threshold, focus)?;
        let before = self.snapshot(text(&impact["baseline_sha"]))?;
        let after = self.snapshot(text(&impact["snapshot_sha"]))?;
        let (scores, score_limits, _) = self.integration_scores(&after)?;
        let (old_scores, _, _) = self.integration_scores(&before)?;
        let changed: BTreeSet<_> = array(&impact["changed_files"])
            .iter()
            .map(|f| text(&f["path"]).to_string())
            .collect();
        let focused = focus.split("::").next().unwrap_or("");
        let mut included = BTreeSet::new();
        if !focused.is_empty() {
            for file in after
                .files
                .values()
                .chain(before.files.values())
                .filter(|f| f.path == focused || f.path.starts_with(&format!("{focused}/")))
            {
                included.insert(file.path.clone());
                included.extend(file.deps.clone());
                included.extend(
                    after
                        .files
                        .values()
                        .filter(|f| f.deps.contains(&file.path))
                        .map(|f| f.path.clone()),
                );
            }
        }
        let paths: BTreeSet<_> = before
            .files
            .keys()
            .chain(after.files.keys())
            .filter(|p| focused.is_empty() || included.contains(*p))
            .cloned()
            .collect();
        let mut nodes = BTreeMap::<String, Value>::new();
        nodes.insert("folder:".into(),json!({"id":"folder:","kind":"folder","path":"","name":self.directory.file_name().unwrap_or_default().to_string_lossy(),"parent":null,"changed":false,"crap":null}));
        for path in paths {
            let current = after
                .files
                .get(&path)
                .or_else(|| before.files.get(&path))
                .unwrap();
            let parts: Vec<_> = path.split('/').collect();
            for index in 1..parts.len() {
                let folder = parts[..index].join("/");
                let id = format!("folder:{folder}");
                nodes.entry(id.clone()).or_insert_with(||json!({"id":id,"kind":"folder","path":folder,"name":parts[index-1],"parent":format!("folder:{}",parts[..index-1].join("/")),"changed":false,"crap":null}));
            }
            let file_id = format!("file:{path}");
            let mut functions = vec![];
            let symbols = compare_symbols(before.files.get(&path), after.files.get(&path));
            for symbol in symbols {
                let key = format!("{path}::{}", text(&symbol["name"]));
                let unknown = json!({"state":"unknown","reason":if path.ends_with(".py"){"No valid coverage evidence"}else{"CRAP not available for this language"}});
                let a = if symbol["status"] == "added" {
                    json!({"state":"new"})
                } else {
                    old_scores.get(&key).cloned().unwrap_or(unknown.clone())
                };
                let b = if symbol["status"] == "removed" {
                    json!({"state":"removed"})
                } else {
                    scores.get(&key).cloned().unwrap_or(unknown)
                };
                let id = format!("symbol:{key}");
                let data = json!({"id":id,"kind":"symbol","symbol_kind":symbol["kind"],"path":path,"name":symbol["name"],"parent":file_id,"changed":symbol["status"]!="unchanged","change":symbol["status"],"before":a,"after":b,"crap":b["crap"],"reason":b["reason"],"line":symbol["start"]});
                functions.push(data.clone());
                nodes.insert(id, data);
            }
            let parent = format!(
                "folder:{}",
                path.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
            );
            let omitted = ["restricted", "symlink", "submodule", "large file", "binary"]
                .iter()
                .any(|kind| current.analysis.starts_with(kind));
            let reason = if path.ends_with(".py") || omitted {
                current.analysis.as_str()
            } else {
                "CRAP not available for this language"
            };
            nodes.insert(file_id.clone(), json!({"id":file_id,"kind":"file","path":path,"name":parts.last(),"parent":parent,"changed":changed.contains(&path),"analysis":current.analysis,"reason":reason,"functions":functions.iter().take(60).collect::<Vec<_>>(),"function_count":functions.len(),"crap":null}));
        }
        let symbol_data: Vec<_> = nodes
            .values()
            .filter(|n| n["kind"] == "symbol")
            .cloned()
            .collect();
        for node in nodes.values_mut().filter(|n| n["kind"] != "symbol") {
            let path = text(&node["path"]).to_string();
            let children: Vec<_> = symbol_data
                .iter()
                .filter(|s| {
                    text(&s["path"]) == path
                        || node["kind"] == "folder"
                            && (path.is_empty()
                                || text(&s["path"]).starts_with(&format!("{path}/")))
                })
                .collect();
            node["crap"] = children
                .iter()
                .filter_map(|s| s["crap"].as_f64())
                .max_by(f64::total_cmp)
                .map_or(Value::Null, |n| json!(n));
            node["unknown_count"] = json!(
                children
                    .iter()
                    .filter(|s| s["after"]["state"] == "unknown"
                        && ["function", "method"].contains(&text(&s["symbol_kind"])))
                    .count()
            );
            if node["unknown_count"].as_u64().unwrap_or(0) > 0 {
                node["known_worst_crap"] = node["crap"].clone();
                node["crap"] = Value::Null;
            }
            node["changed"] = json!(changed.iter().any(|p| p == &path
                || node["kind"] == "folder"
                    && (path.is_empty() || p.starts_with(&format!("{path}/")))));
        }
        let mut ordered: Vec<_> = nodes.values().cloned().collect();
        ordered.sort_by_key(|n| {
            (
                !n["changed"].as_bool().unwrap_or(false),
                text(&n["path"]).split('/').count(),
                text(&n["id"]).to_string(),
            )
        });
        let mut selected = BTreeMap::<String, Value>::new();
        selected.insert("folder:".into(), nodes["folder:"].clone());
        for node in ordered {
            let mut chain = vec![node.clone()];
            let mut parent = text(&node["parent"]).to_string();
            while !parent.is_empty() && !selected.contains_key(&parent) {
                let Some(ancestor) = nodes.get(&parent) else {
                    break;
                };
                chain.push(ancestor.clone());
                parent = text(&ancestor["parent"]).to_string();
            }
            let needed = chain
                .iter()
                .filter(|n| !selected.contains_key(text(&n["id"])))
                .count();
            if selected.len() + needed <= 300 {
                for item in chain {
                    selected.insert(text(&item["id"]).into(), item);
                }
            }
        }
        let mut edges = vec![];
        for relation in &after.relationships {
            let source = format!("file:{}", text(&relation["source"]["path"]));
            if !selected.contains_key(&source) {
                continue;
            }
            let targets = array(&relation["targets"]);
            if targets.is_empty() {
                edges.push(json!({"id":relation["id"],"source":source,"target":null,"kind":relation["kind"],"resolution":relation["resolution"],"reason":relation["reason"],"label":relation["target"],"sites":relation["sites"]}));
            } else {
                for target in targets {
                    let target_id = format!("file:{}", text(&target["path"]));
                    if !selected.contains_key(&target_id) {
                        continue;
                    }
                    let rule = array(&impact["findings"]).into_iter().find(|f| {
                        f["kind"] == "rule"
                            && f["source"] == relation["source"]
                            && f["target"] == target
                    });
                    edges.push(json!({"id":format!("{}:{}",text(&relation["id"]),target_id),"source":source,"target":target_id,"kind":relation["kind"],"resolution":relation["resolution"],"sites":relation["sites"],"rule_break":rule}));
                }
            }
        }
        let mut limits = array(&impact["limits"]);
        limits.extend(score_limits.into_iter().map(|s| json!(s)));
        let hidden = nodes.len() - selected.len();
        if hidden > 0 {
            limits.push(json!(format!("Map capped at 300 nodes; {hidden} nodes are aggregated into their real folders. Use focus to inspect them.")));
        }
        if edges.len() > 600 {
            limits.push(json!(format!("Map shows 600 of {} edges", edges.len())));
        }
        let mut aggregation = BTreeMap::<String, usize>::new();
        for (id, node) in &nodes {
            if !selected.contains_key(id) {
                *aggregation.entry(text(&node["parent"]).into()).or_default() += 1;
            }
        }
        Ok(
            json!({"status":impact["status"],"limits":limits,"baseline":baseline,"baseline_sha":impact["baseline_sha"],"snapshot_sha":impact["snapshot_sha"],"coverage_sha":impact["coverage_sha"],"threshold":threshold,"focus":focus,
            "nodes":selected.into_values().collect::<Vec<_>>(),"edges":edges.into_iter().take(600).collect::<Vec<_>>(),"aggregation":aggregation,"hidden_nodes":hidden,"findings":impact["findings"],"changed_symbols":impact["changed_symbols"],"already_changed":impact["already_changed"]}),
        )
    }
}
