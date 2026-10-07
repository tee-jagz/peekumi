//! Bridges the shared adapter contract to JavaScript, TypeScript and Svelte script extraction.
use super::*;
/// Syntax adapter for TypeScript source; parsing runs in an installed helper process.
pub struct TypeScript;
impl LanguageAdapter for TypeScript {
    /// Returns the stable registry key used to group analysis batches and cache identities.
    fn id(&self) -> &'static str {
        "typescript"
    }
    /// Returns the human-readable language name used in capability and failure messages.
    fn name(&self) -> &'static str {
        "TypeScript"
    }
    /// Lists filename extensions this adapter can analyze; entries omit the leading dot.
    fn extensions(&self) -> &'static [&'static str] {
        &[
            "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "mjsx", "cjsx", "mtsx", "ctsx",
            "svelte",
        ]
    }
    /// Describes unsupported language behavior so the inspector can explain analysis boundaries.
    fn limitations(&self) -> &'static str {
        "Syntax-level named calls and explicit heritage; dynamic receivers, nested functions and type-checker dispatch are not resolved. Svelte script blocks only; relative and $lib imports. Requires Node and TypeScript."
    }
    /// Probes the installed helper runtime to identify compatible cached syntax.
    /// A failed probe is recorded as unavailable rather than hiding affected files.
    /// The helper script's hash is part of it, so a changed helper rebuilds cached analysis.
    fn identity(&self, config: &Config) -> String {
        format!(
            "{}:{}:{}",
            config.node,
            version(run(
                &config.node,
                &[&config.helper().to_string_lossy(), "--version"],
                None,
                vec![]
            )),
            &crate::hash::hash(include_str!("typescript_ast.mjs"))[..12]
        )
    }
    /// Sends committed source batches to the TypeScript helper through JSON stdin.
    /// Returns ordered syntax results; subprocess failures or invalid response JSON are errors.
    fn analyze(&self, input: &[(String, String)], config: &Config) -> Result<Vec<Value>> {
        let input = json!(
            input
                .iter()
                .map(|(path, source)| json!({"path":path,"source":source}))
                .collect::<Vec<_>>()
        )
        .to_string()
        .into_bytes();
        Ok(serde_json::from_slice(&run(
            &config.node,
            &[&config.helper().to_string_lossy()],
            None,
            input,
        )?)?)
    }
    /// Resolves relative imports and the conventional Svelte $lib alias against tracked files.
    /// Custom aliases and external packages remain unresolved; no package code is loaded.
    fn resolve(&self, file: &str, item: &Value, context: &Resolution) -> Vec<String> {
        let spec = text(&item["specifier"]);
        let paths = &context.paths;
        let mut found = vec![];
        let stem = if spec.starts_with('.') {
            let folder = file.rsplit_once('/').map(|v| v.0).unwrap_or("");
            Some(normalize(&format!("{folder}/{spec}")))
        } else if let Some(suffix) = spec.strip_prefix("$lib/") {
            file.find("/src/")
                .map(|i| format!("{}/src/lib/{suffix}", &file[..i]))
        } else {
            None
        };
        if let Some(stem) = stem {
            let alternate = stem
                .strip_suffix(".js")
                .map(|p| format!("{p}.ts"))
                .unwrap_or(stem.clone());
            'outer: for s in [stem, alternate] {
                for ext in [
                    "",
                    ".ts",
                    ".tsx",
                    ".js",
                    ".jsx",
                    ".mjs",
                    ".svelte",
                    "/index.ts",
                    "/index.js",
                ] {
                    let p = format!("{s}{ext}");
                    if paths.contains(&p) {
                        found.push(p);
                        break 'outer;
                    }
                }
            }
        }
        found
    }
}
