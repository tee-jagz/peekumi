//! Language-specific syntax analysis behind one shared contract.
mod python;
mod rust;
mod typescript;
use crate::process::run;
use anyhow::Result;
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
};
#[derive(Clone)]
/// Locations of trusted parser executables and the deployed TypeScript helper.
pub struct Config {
    pub python: String,
    pub node: String,
    pub root: PathBuf,
}
impl Config {
    /// Builds the TypeScript helper path relative to the configured deployment root.
    fn helper(&self) -> PathBuf {
        self.root.join("backend/adapters/typescript_ast.mjs")
    }
}
/// Common contract between repository analysis and each language implementation.
/// Adapters declare their capabilities, analyze ordered source batches and resolve imports
/// against one committed tree. They inspect syntax only and never execute inspected code.
pub trait LanguageAdapter: Sync {
    /// Returns the stable registry key used to group analysis batches and cache identities.
    fn id(&self) -> &'static str;
    /// Returns the human-readable language name used in capability and failure messages.
    fn name(&self) -> &'static str;
    /// Lists filename extensions this adapter can analyze; entries omit the leading dot.
    fn extensions(&self) -> &'static [&'static str];
    /// Lists the analysis categories this adapter advertises to the inspector.
    fn capabilities(&self) -> &[&str] {
        &["symbols", "documentation", "explicit types", "imports"]
    }
    /// Describes unsupported language behavior so the inspector can explain analysis boundaries.
    fn limitations(&self) -> &'static str;
    /// Returns a parser/runtime identity used to invalidate cached syntax when the environment changes.
    fn identity(&self, config: &Config) -> String;
    /// Analyzes a batch of `(repository path, source text)` pairs without executing their code.
    /// Returns one JSON syntax result per input, in order. Parse failures should remain explicit results;
    /// helper startup or protocol failures may fail the batch.
    fn analyze(&self, input: &[(String, String)], config: &Config) -> Result<Vec<Value>>;
    /// Resolves one import against the committed tree and returns known repository-relative target paths.
    /// An empty result means unresolved or external; callers must not invent a target.
    fn resolve(&self, file: &str, import: &Value, context: &Resolution) -> Vec<String>;
}
static PYTHON: python::Python = python::Python;
static TYPESCRIPT: typescript::TypeScript = typescript::TypeScript;
static RUST: rust::Rust = rust::Rust;
/// Returns every installed adapter through the common interface.
/// Register new language implementations here so parsing and import resolution use the same registry.
pub fn all() -> [&'static dyn LanguageAdapter; 3] {
    [&PYTHON, &TYPESCRIPT, &RUST]
}
/// Selects an adapter by filename extension, returning None for unsupported file types.
pub fn for_path(path: &str) -> Option<&'static dyn LanguageAdapter> {
    let ext = path.rsplit('.').next().unwrap_or("");
    all()
        .into_iter()
        .find(|adapter| adapter.extensions().contains(&ext))
}
/// Builds adapter names, supported extensions, capabilities and limitations for the inspector.
pub fn descriptors() -> Value {
    json!(all().iter().map(|a|json!({"id":a.id(),"name":a.name(),"extensions":a.extensions(),"capabilities":a.capabilities(),"limitations":a.limitations()})).collect::<Vec<_>>())
}
/// Read-only import lookup context built from one committed file tree.
/// Contains tracked paths and Python dotted-module candidates, including ambiguous matches.
pub struct Resolution {
    paths: BTreeSet<String>,
    modules: HashMap<String, Vec<String>>,
}
impl Resolution {
    /// Indexes tracked paths and Python module suffixes for import resolution within one snapshot.
    pub fn new(paths: BTreeSet<String>) -> Self {
        let mut modules: HashMap<String, Vec<String>> = HashMap::new();
        for p in paths.iter().filter(|p| p.ends_with(".py")) {
            let stem = p.trim_end_matches(".py");
            let stem = stem.strip_suffix("/__init__").unwrap_or(stem);
            let parts: Vec<_> = stem.split('/').collect();
            for i in 0..parts.len() {
                modules
                    .entry(parts[i..].join("."))
                    .or_default()
                    .push(p.clone());
            }
        }
        Self { paths, modules }
    }
}
/// Reads an import metadata string, defaulting to empty for missing or malformed values.
fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
/// Copies an import metadata array, defaulting to an empty list.
fn array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
/// Converts a parser version probe into a cache-identity string, marking failed probes unavailable.
fn version(result: Result<Vec<u8>>) -> String {
    result
        .map(|v| String::from_utf8_lossy(&v).trim().to_string())
        .unwrap_or("unavailable".into())
}
/// Normalizes relative path segments lexically without accessing the filesystem.
/// Preserves leading parent traversals when they cannot be collapsed.
fn normalize(path: &str) -> String {
    let mut out = vec![];
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|v| *v != "..") {
                    out.pop();
                } else {
                    out.push(part)
                }
            }
            _ => out.push(part),
        }
    }
    if out.is_empty() {
        ".".into()
    } else {
        out.join("/")
    }
}
