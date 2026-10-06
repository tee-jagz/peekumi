//! Shared declaration relationships, conservative target resolution and revision comparison.
use crate::adapters::{LanguageAdapter, Resolution};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
/// Symbol and path evidence from one immutable committed tree.
pub struct Context {
    pub paths: Resolution,
    pub symbols: BTreeMap<String, Vec<Value>>,
    /// The imports of each file, to follow a name that a module imports again (a re-export).
    pub imports: BTreeMap<String, Vec<Value>>,
}
/// The declarations a method call can reach, from the receiver's written type (see the
/// adapters: Rust `self`, typed parameters and fields; Python `self`/`cls`; TypeScript `this`): walk the struct fields named in `fields`, then find `Type.name` and trait
/// implementations `Type as Trait.name`. A trait object (`dyn Trait`) reaches every
/// implementation `… as Trait.name`. A struct that is declared more than once stops the walk.
fn method_targets(file: &str, method: &Value, context: &Context) -> Vec<Value> {
    // A method is looked up only in files of the same language as the call.
    let family = |path: &str| match path.rsplit('.').next().unwrap_or("") {
        "rs" => "rust",
        "py" => "python",
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "svelte" => "script",
        _ => "",
    };
    let language = family(file);
    let symbols = || {
        context
            .symbols
            .iter()
            .filter(move |(path, _)| !language.is_empty() && family(path) == language)
            .flat_map(|(path, list)| list.iter().map(move |s| (path, s)))
    };
    let Some(mut ty) = method["type"].as_str().map(str::to_string) else {
        return vec![];
    };
    for field in method["fields"].as_array().into_iter().flatten() {
        let found: Vec<&Value> = symbols()
            .filter(|(_, s)| {
                s["kind"] == "struct"
                    && s["name"]
                        .as_str()
                        .is_some_and(|n| n.rsplit("::").next() == Some(ty.as_str()))
            })
            .map(|(_, s)| s)
            .collect();
        let [one] = found.as_slice() else {
            return vec![];
        };
        let written = one["details"]["fields"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|f| f["name"] == *field)
            .and_then(|f| f["type"].as_str());
        match written.and_then(crate::adapters::rust_relationships::type_name_of) {
            Some(next) => ty = next,
            None => return vec![],
        }
    }
    let name = method["name"].as_str().unwrap_or("");
    symbols()
        .filter(|(_, s)| {
            let symbol = s["name"].as_str().unwrap_or("");
            match ty.strip_prefix("dyn ") {
                Some(tr) => symbol.ends_with(&format!(" as {tr}.{name}")),
                None => {
                    symbol == format!("{ty}.{name}")
                        || (symbol.starts_with(&format!("{ty} as "))
                            && symbol.ends_with(&format!(".{name}")))
                }
            }
        })
        .map(|(path, s)| json!({"path": path, "symbol": s["name"]}))
        .collect()
}
/// Resolves only lookup evidence emitted by an adapter; it never guesses from a matching basename.
pub fn resolve<A: LanguageAdapter + ?Sized>(
    adapter: &A,
    file: &str,
    raw: &Value,
    context: &Context,
) -> Vec<Value> {
    let lookup = &raw["lookup"];
    if lookup["method"].is_object() {
        return method_targets(file, &lookup["method"], context);
    }
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
        let name = lookup["name"].as_str().unwrap_or("");
        // A module that does not declare the name but imports it by that name (a package
        // `__init__.py` with `from .worker import start`, say) passes it on: follow that
        // import, for at most three steps.
        let mut frontier: Vec<String> = paths.iter().cloned().collect();
        for _ in 0..3 {
            let mut next = vec![];
            for path in frontier {
                if context
                    .symbols
                    .get(&path)
                    .into_iter()
                    .flatten()
                    .any(|s| s["name"] == name)
                {
                    continue;
                }
                for import in context.imports.get(&path).into_iter().flatten() {
                    if import["names"]
                        .as_array()
                        .is_some_and(|n| n.iter().any(|n| n == name))
                    {
                        for found in adapter.resolve(&path, import, &context.paths) {
                            if paths.insert(found.clone()) {
                                next.push(found);
                            }
                        }
                    }
                }
            }
            frontier = next;
        }
        name
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

/// Encodes map-only file pairs without repeating source metadata on both revision sides.
/// Ordinary imports already travel in the file overview; retain them here only for rule evidence.
pub fn compact(before: &[Value], after: &[Value]) -> Vec<Value> {
    compare(before, after)
        .into_iter()
        .filter_map(|r| {
            let source = r["source"]["path"].as_str().unwrap_or("");
            let target = r["targets"][0]["path"].as_str().unwrap_or("");
            let violations = |phase: &str| {
                r[phase]["violations"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            };
            let left = violations("before");
            let right = violations("after");
            if (r["kind"] == "imports" || source == target) && left.is_empty() && right.is_empty() {
                return None;
            }
            Some(json!([
                source,
                target,
                r["kind"],
                r["before"]["count"].as_u64().unwrap_or(0),
                r["after"]["count"].as_u64().unwrap_or(0),
                left,
                right
            ]))
        })
        .collect()
}
