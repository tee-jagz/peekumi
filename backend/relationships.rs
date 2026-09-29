//! Shared declaration relationships, conservative target resolution and revision comparison.
use crate::adapters::{LanguageAdapter, Resolution};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
/// Symbol and path evidence from one immutable committed tree.
pub struct Context {
    pub paths: Resolution,
    pub symbols: BTreeMap<String, Vec<Value>>,
}
/// Resolves only lookup evidence emitted by an adapter; it never guesses from a matching basename.
pub fn resolve<A: LanguageAdapter + ?Sized>(
    adapter: &A,
    file: &str,
    raw: &Value,
    context: &Context,
) -> Vec<Value> {
    let lookup = &raw["lookup"];
    let mut paths = BTreeSet::new();
    let name = if let Some(local) = lookup["local"].as_str() {
        paths.insert(file.to_string());
        local
    } else {
        let imports = lookup["imports"].as_array().cloned().unwrap_or_else(|| {
            if lookup["import"].is_object() {
                vec![lookup["import"].clone()]
            } else {
                vec![]
            }
        });
        for import in imports {
            paths.extend(adapter.resolve(file, &import, &context.paths));
        }
        lookup["name"].as_str().unwrap_or("")
    };
    let mut targets = vec![];
    for path in paths {
        for symbol in context.symbols.get(&path).into_iter().flatten() {
            let allowed = match raw["kind"].as_str().unwrap_or("") {
                "calls" => ["function", "method", "class", "struct"]
                    .contains(&symbol["kind"].as_str().unwrap_or("")),
                _ => ["class", "type", "trait", "struct", "enum"]
                    .contains(&symbol["kind"].as_str().unwrap_or("")),
            };
            if symbol["name"] == name && allowed {
                targets.push(json!({"path":path,"symbol":name}));
            }
        }
    }
    targets
}
/// Assigns stable identities and source sites to normalized relationships, merging repeated calls.
pub fn normalize(file: &str, raw: &Value, targets: Vec<Value>) -> Value {
    let status = match targets.len() {
        0 => "unresolved",
        1 => "resolved",
        _ => "ambiguous",
    };
    let source = raw["source"].as_str().unwrap_or("");
    let target = raw["target"].as_str().unwrap_or("");
    let kind = raw["kind"].as_str().unwrap_or("calls");
    let id = crate::engine::hash(json!([file, source, kind, target]).to_string());
    json!({"id":id,"source":{"path":file,"symbol":source},"target":target,"kind":kind,"resolution":status,"targets":targets,"sites":[raw["line"].clone()],"reason":if status=="resolved" {"Static declaration match"}else if status=="ambiguous"{"Multiple declarations match"}else{raw["reason"].as_str().unwrap_or("No declaration found in the committed tree")},"violations":[]})
}
/// Compares relationship evidence and rule outcomes, ignoring source-line-only movement.
pub fn compare(before: &[Value], after: &[Value]) -> Vec<Value> {
    let a: BTreeMap<_, _> = before
        .iter()
        .map(|v| (v["id"].as_str().unwrap(), v))
        .collect();
    let b: BTreeMap<_, _> = after
        .iter()
        .map(|v| (v["id"].as_str().unwrap(), v))
        .collect();
    let ids: BTreeSet<_> = a.keys().chain(b.keys()).copied().collect();
    ids.into_iter()
        .map(|id| {
            let left = a.get(id);
            let right = b.get(id);
            let current = right.or(left).unwrap();
            let status = match (left, right) {
                (None, _) => "added",
                (_, None) => "removed",
                (Some(x), Some(y)) => {
                    if ["targets", "resolution", "violations", "count"]
                        .iter()
                        .any(|k| x[k] != y[k])
                    {
                        "changed"
                    } else {
                        "unchanged"
                    }
                }
            };
            let mut value = (*current).clone();
            value["status"] = json!(status);
            value["before"] = json!(left);
            value["after"] = json!(right);
            value
        })
        .collect()
}
/// Reduces resolved relationships to file pairs for the initial map; full evidence stays lazy.
pub fn overview(relations: &[Value]) -> Vec<Value> {
    let mut pairs: BTreeMap<String, Value> = BTreeMap::new();
    for r in relations {
        if r["resolution"] != "resolved" {
            continue;
        }
        let source = r["source"]["path"].as_str().unwrap_or("");
        let target = r["targets"][0]["path"].as_str().unwrap_or("");
        let key = json!([source, target, r["kind"]]).to_string();
        let entry=pairs.entry(key).or_insert_with(||json!({"source":{"path":source,"symbol":""},"target":target,"targets":[{"path":target,"symbol":""}],"kind":r["kind"],"resolution":"resolved","violations":[],"count":0}));
        entry["count"] = json!(entry["count"].as_u64().unwrap() + 1);
        for violation in r["violations"].as_array().into_iter().flatten() {
            let list = entry["violations"].as_array_mut().unwrap();
            if !list.contains(violation) {
                list.push(violation.clone());
            }
        }
    }
    pairs
        .into_iter()
        .map(|(key, mut value)| {
            value["id"] = json!(crate::engine::hash(key));
            value
        })
        .collect()
}
