use super::*;
pub struct TypeScript;
impl LanguageAdapter for TypeScript {
    fn id(&self) -> &'static str {
        "typescript"
    }
    fn name(&self) -> &'static str {
        "TypeScript"
    }
    fn extensions(&self) -> &'static [&'static str] {
        &[
            "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "mjsx", "cjsx", "mtsx", "ctsx",
            "svelte",
        ]
    }
    fn limitations(&self) -> &'static str {
        "Explicit types and JSDoc only; Svelte script blocks only; relative and $lib imports. Requires Node and TypeScript."
    }
    fn identity(&self, config: &Config) -> String {
        format!(
            "{}:{}",
            config.node,
            version(run(
                &config.node,
                &[&config.helper().to_string_lossy(), "--version"],
                None,
                vec![]
            ))
        )
    }
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
