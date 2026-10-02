//! Versioned dependency constraints evaluated against known static relationships only.
use anyhow::{Result, bail, ensure};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
/// Rule configuration files, preferred first: `.peekumi.json`, then `.strata.json` from before the rename.
pub const CONFIG_FILES: [&str; 2] = [".peekumi.json", ".strata.json"];
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
            .all(|k| ["version", "groups", "rules"].contains(&k.as_str())),
        "Unknown configuration field"
    );
    ensure!(value["version"] == 1, "Expected version 1");
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
            obj.keys()
                .all(|k| ["id", "from", "to", "kinds", "message"].contains(&k.as_str())),
            "Unknown rule field"
        );
        let id = rule["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Rule needs id"))?;
        ensure!(ids.insert(id), "Duplicate rule id {id}");
        let from = rule["from"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Rule from must name a group"))?;
        ensure!(groups.contains_key(from), "Unknown group {from}");
        for to in strings(&rule["to"])? {
            ensure!(groups.contains_key(&to), "Unknown group {to}");
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
    /// Annotates only resolved evidence; unknown targets cannot prove a pass or violation.
    pub fn apply(&self, relations: &mut [Value]) {
        for r in relations {
            if r["resolution"] != "resolved" {
                continue;
            }
            let source = r["source"]["path"].as_str().unwrap_or("");
            let target = r["targets"][0]["path"].as_str().unwrap_or("");
            let mut violations = vec![];
            for rule in &self.rules {
                let from = rule["from"].as_str().unwrap();
                if !rule["kinds"].as_array().unwrap().contains(&r["kind"])
                    || !self.groups[from].iter().any(|p| matches(p, source))
                {
                    continue;
                }
                if rule["to"].as_array().unwrap().iter().any(|group| {
                    self.groups[group.as_str().unwrap()]
                        .iter()
                        .any(|p| matches(p, target))
                }) {
                    violations.push(json!({"id":rule["id"],"message":rule["message"].as_str().unwrap_or("Forbidden dependency")}));
                }
            }
            r["violations"] = json!(violations);
        }
    }
    pub fn count(&self) -> usize {
        self.rules.len()
    }
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
    }
}
