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
pub struct Config {
    pub python: String,
    pub node: String,
    pub root: PathBuf,
}
impl Config {
    fn helper(&self) -> PathBuf {
        self.root.join("backend/adapters/typescript_ast.mjs")
    }
}
/// Adapters inspect syntax only and never execute inspected code.
pub trait LanguageAdapter: Sync {
    fn id(&self) -> &'static str;
    fn extensions(&self) -> &'static [&'static str];
    fn capabilities(&self) -> &[&str] {
        &["symbols", "documentation", "explicit types", "imports"]
    }
    fn limitations(&self) -> &'static str;
    fn identity(&self, config: &Config) -> String;
    fn analyze(&self, input: &[(String, String)], config: &Config) -> Result<Vec<Value>>;
    fn resolve(&self, file: &str, import: &Value, context: &Resolution) -> Vec<String>;
}
static PYTHON: python::Python = python::Python;
static TYPESCRIPT: typescript::TypeScript = typescript::TypeScript;
static RUST: rust::Rust = rust::Rust;
pub fn all() -> [&'static dyn LanguageAdapter; 3] {
    [&PYTHON, &TYPESCRIPT, &RUST]
}
pub fn for_path(path: &str) -> Option<&'static dyn LanguageAdapter> {
    let ext = path.rsplit('.').next().unwrap_or("");
    all()
        .into_iter()
        .find(|adapter| adapter.extensions().contains(&ext))
}
pub fn descriptors() -> Value {
    json!(all().iter().map(|a|json!({"id":a.id(),"extensions":a.extensions(),"capabilities":a.capabilities(),"limitations":a.limitations()})).collect::<Vec<_>>())
}
pub struct Resolution {
    paths: BTreeSet<String>,
    modules: HashMap<String, Vec<String>>,
}
impl Resolution {
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
fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
fn version(result: Result<Vec<u8>>) -> String {
    result
        .map(|v| String::from_utf8_lossy(&v).trim().to_string())
        .unwrap_or("unavailable".into())
}
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
