//! Bridges the shared adapter contract to Python AST extraction and package import resolution.
use super::*;
/// Syntax adapter for Python source; parsing runs in an installed helper process.
pub struct Python;
impl LanguageAdapter for Python {
    /// Returns the stable registry key used to group analysis batches and cache identities.
    fn id(&self) -> &'static str {
        "python"
    }
    /// Returns the human-readable language name used in capability and failure messages.
    fn name(&self) -> &'static str {
        "Python"
    }
    /// Lists filename extensions this adapter can analyze; entries omit the leading dot.
    fn extensions(&self) -> &'static [&'static str] {
        &["py"]
    }
    /// Describes unsupported language behavior so the inspector can explain analysis boundaries.
    fn limitations(&self) -> &'static str {
        "Explicit annotations only; ambiguous imports remain unresolved. Requires Python."
    }
    /// Probes the installed helper runtime to identify compatible cached syntax.
    /// A failed probe is recorded as unavailable rather than hiding affected files.
    fn identity(&self, config: &Config) -> String {
        format!(
            "{}:{}",
            config.python,
            version(run(&config.python, &["--version"], None, vec![]))
        )
    }
    /// Sends committed source batches to the Python helper through JSON stdin.
    /// Returns ordered syntax results; subprocess failures or invalid response JSON are errors.
    fn analyze(&self, input: &[(String, String)], config: &Config) -> Result<Vec<Value>> {
        let input = json!(input.iter().map(|(_, source)| source).collect::<Vec<_>>())
            .to_string()
            .into_bytes();
        Ok(serde_json::from_slice(&run(
            &config.python,
            &["-c", include_str!("python_ast.py")],
            None,
            input,
        )?)?)
    }
    /// Resolves relative Python imports and unique dotted-module matches; ambiguous and external names stay unresolved.
    fn resolve(&self, file: &str, item: &Value, context: &Resolution) -> Vec<String> {
        let spec = text(&item["specifier"]);
        let paths = &context.paths;
        let modules = &context.modules;
        let mut found = vec![];
        let level = item["level"].as_u64().unwrap_or(0) as usize;
        let names = array(&item["names"]);
        if level > 0 {
            let parts: Vec<_> = file.split('/').collect();
            let folder = parts[..parts.len().saturating_sub(level)].join("/");
            let stem = normalize(&format!("{folder}/{}", spec.replace('.', "/")));
            let mut stems = vec![stem.clone()];
            stems.extend(
                names
                    .iter()
                    .filter(|n| text(n) != "*")
                    .map(|n| normalize(&format!("{stem}/{}", text(n)))),
            );
            for s in stems {
                for p in [format!("{s}.py"), format!("{s}/__init__.py")] {
                    if paths.contains(&p) {
                        found.push(p)
                    }
                }
            }
        } else {
            let mut specs = vec![spec.to_string()];
            specs.extend(names.iter().map(|n| format!("{spec}.{}", text(n))));
            for s in specs {
                if let Some(options) = modules.get(&s)
                    && options.len() == 1
                {
                    found.push(options[0].clone());
                }
            }
        }
        found
    }
}
