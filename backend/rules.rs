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
    /// The ID of a rule in `current` that already covers the only rule of `self`: each pair of
    /// `paths` and each kind that would break the new rule also breaks that rule, so the new
    /// rule adds nothing. A rule that no pair breaks is not covered (nothing shows that it adds
    /// nothing), and more than 200,000 pairs are not compared.
    pub fn covered_by(&self, current: &Rules, paths: &[&str]) -> Option<String> {
        let rule = self.rules.first()?;
        let kinds = Self::names(rule, "kinds");
        let first = json!(kinds.first()?);
        let sources: Vec<&str> = paths
            .iter()
            .copied()
            .filter(|s| self.in_scope(rule, &first, s))
            .collect();
        if sources.len().saturating_mul(paths.len()) > 200_000 {
            return None;
        }
        let breaks: Vec<(&str, &str)> = sources
            .iter()
            .flat_map(|s| paths.iter().map(move |t| (*s, *t)))
            .filter(|(s, t)| self.breaks(rule, s, t))
            .collect();
        if breaks.is_empty() {
            return None;
        }
        current
            .rules
            .iter()
            .find(|other| {
                kinds.iter().all(|kind| {
                    breaks.iter().all(|(s, t)| {
                        current.in_scope(other, &json!(kind), s) && current.breaks(other, s, t)
                    })
                })
            })
            .map(|other| other["id"].as_str().unwrap_or("").to_string())
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
}
