use super::*;
pub struct Python;
impl LanguageAdapter for Python {
    fn id(&self) -> &'static str {
        "python"
    }
    fn name(&self) -> &'static str {
        "Python"
    }
    fn extensions(&self) -> &'static [&'static str] {
        &["py"]
    }
    fn limitations(&self) -> &'static str {
        "Explicit annotations only; ambiguous imports remain unresolved. Requires Python."
    }
    fn identity(&self, config: &Config) -> String {
        format!(
            "{}:{}",
            config.python,
            version(run(&config.python, &["--version"], None, vec![]))
        )
    }
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
