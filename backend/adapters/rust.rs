//! Syntax-only Rust inspection. Macros are never expanded or executed.
use quote::ToTokens;
use serde_json::{Value, json};
use syn::{
    Attribute, Expr, FnArg, Item, Lit, Meta, ReturnType, Signature, UseTree, spanned::Spanned,
};
fn code(node: &impl ToTokens) -> String {
    node.to_token_stream().to_string()
}
fn docs(attrs: &[Attribute]) -> String {
    attrs
        .iter()
        .filter_map(|a| {
            if !a.path().is_ident("doc") {
                return None;
            }
            if let Meta::NameValue(v) = &a.meta
                && let Expr::Lit(l) = &v.value
                && let Lit::Str(s) = &l.lit
            {
                Some(s.value().trim().to_string())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn info(attrs: &[Attribute], signature: String) -> Value {
    json!({"description":docs(attrs),"signature":signature,"provenance":"Rust documentation / declarations"})
}
fn function(sig: &Signature, attrs: &[Attribute]) -> Value {
    let mut value = info(attrs, code(sig));
    value["async"] = json!(sig.asyncness.is_some());
    value["parameters"] = json!(
        sig.inputs
            .iter()
            .map(|arg| match arg {
                FnArg::Receiver(r) => json!({"name":"self","type":code(&r.ty)}),
                FnArg::Typed(p) => json!({"name":code(&p.pat),"type":code(&p.ty)}),
            })
            .collect::<Vec<_>>()
    );
    value["returns"] = json!(match &sig.output {
        ReturnType::Default => "()".into(),
        ReturnType::Type(_, ty) => code(ty),
    });
    value
}
fn add(symbols: &mut Vec<Value>, node: &impl ToTokens, name: String, kind: &str, details: Value) {
    let tokens = node.to_token_stream();
    let span = node.span();
    symbols.push(json!({"name":name,"kind":kind,"start":span.start().line,"end":span.end().line,"hash":crate::engine::hash(tokens.to_string()),"details":details}));
}
fn use_paths(tree: &UseTree, prefix: &str, imports: &mut Vec<Value>) {
    match tree {
        UseTree::Path(p) => use_paths(&p.tree, &format!("{prefix}{}::", p.ident), imports),
        UseTree::Group(g) => {
            for item in &g.items {
                use_paths(item, prefix, imports)
            }
        }
        UseTree::Name(n) => imports.push(json!({"specifier":format!("{prefix}{}",n.ident)})),
        UseTree::Rename(n) => imports.push(json!({"specifier":format!("{prefix}{}",n.ident)})),
        UseTree::Glob(_) => imports.push(json!({"specifier":format!("{prefix}*")})),
    }
}
fn walk(items: &[Item], prefix: &str, symbols: &mut Vec<Value>, imports: &mut Vec<Value>) {
    for item in items {
        match item {
            Item::Fn(n) => add(
                symbols,
                n,
                format!("{prefix}{}", n.sig.ident),
                "function",
                function(&n.sig, &n.attrs),
            ),
            Item::Struct(n) => {
                let mut details = info(
                    &n.attrs,
                    format!("{} struct {}{}", code(&n.vis), n.ident, code(&n.generics))
                        .trim()
                        .to_string(),
                );
                details["fields"]=json!(n.fields.iter().enumerate().map(|(i,f)|json!({"name":f.ident.as_ref().map(ToString::to_string).unwrap_or(i.to_string()),"type":code(&f.ty)})).collect::<Vec<_>>());
                add(
                    symbols,
                    n,
                    format!("{prefix}{}", n.ident),
                    "struct",
                    details,
                );
            }
            Item::Enum(n) => {
                let mut details = info(&n.attrs, format!("enum {}{}", n.ident, code(&n.generics)));
                details["fields"] = json!(
                    n.variants
                        .iter()
                        .map(|v| json!({"name":v.ident.to_string(),"type":code(&v.fields)}))
                        .collect::<Vec<_>>()
                );
                add(symbols, n, format!("{prefix}{}", n.ident), "enum", details);
            }
            Item::Trait(n) => {
                add(
                    symbols,
                    n,
                    format!("{prefix}{}", n.ident),
                    "trait",
                    info(&n.attrs, format!("trait {}{}", n.ident, code(&n.generics))),
                );
                for member in &n.items {
                    if let syn::TraitItem::Fn(f) = member {
                        add(
                            symbols,
                            f,
                            format!("{prefix}{}.{}", n.ident, f.sig.ident),
                            "method",
                            function(&f.sig, &f.attrs),
                        );
                    }
                }
            }
            Item::Impl(n) => {
                let owner = if let Some((_, tr, _)) = &n.trait_ {
                    format!("{} as {}", code(&n.self_ty), code(tr))
                } else {
                    code(&n.self_ty)
                };
                for member in &n.items {
                    match member {
                        syn::ImplItem::Fn(f) => add(
                            symbols,
                            f,
                            format!("{prefix}{owner}.{}", f.sig.ident),
                            "method",
                            function(&f.sig, &f.attrs),
                        ),
                        syn::ImplItem::Const(c) => add(
                            symbols,
                            c,
                            format!("{prefix}{owner}.{}", c.ident),
                            "constant",
                            info(&c.attrs, format!("const {}: {}", c.ident, code(&c.ty))),
                        ),
                        _ => {}
                    }
                }
            }
            Item::Type(n) => add(
                symbols,
                n,
                format!("{prefix}{}", n.ident),
                "type",
                info(&n.attrs, code(n)),
            ),
            Item::Const(n) => add(
                symbols,
                n,
                format!("{prefix}{}", n.ident),
                "constant",
                info(&n.attrs, format!("const {}: {}", n.ident, code(&n.ty))),
            ),
            Item::Static(n) => add(
                symbols,
                n,
                format!("{prefix}{}", n.ident),
                "variable",
                info(&n.attrs, format!("static {}: {}", n.ident, code(&n.ty))),
            ),
            Item::Mod(n) => {
                add(
                    symbols,
                    n,
                    format!("{prefix}{}", n.ident),
                    "module",
                    info(&n.attrs, format!("mod {}", n.ident)),
                );
                if let Some((_, items)) = &n.content {
                    walk(items, &format!("{prefix}{}::", n.ident), symbols, imports)
                } else if prefix.is_empty() {
                    imports.push(json!({"specifier":format!("self::{}",n.ident),"module":true}));
                }
            }
            Item::Use(n) => use_paths(&n.tree, "", imports),
            _ => {}
        }
    }
}
pub fn analyze(source: &str) -> Value {
    match syn::parse_file(source) {
        Ok(file) => {
            let mut symbols = vec![];
            let mut imports = vec![];
            walk(&file.items, "", &mut symbols, &mut imports);
            json!({"symbols":symbols,"imports":imports,"analysis":"Rust AST · macros not expanded","details":{"description":docs(&file.attrs),"provenance":"Rust module documentation"}})
        }
        Err(e) => json!({"symbols":[],"imports":[],"analysis":format!("parse error: {e}")}),
    }
}
pub fn resolve(file: &str, spec: &str, paths: &std::collections::BTreeSet<String>) -> Vec<String> {
    let directory = file.rsplit_once('/').map(|p| p.0).unwrap_or("");
    let filename = file.rsplit('/').next().unwrap_or(file);
    let mut crate_dir = directory;
    loop {
        let has_root = ["main.rs", "lib.rs"].iter().any(|name| {
            paths.contains(&if crate_dir.is_empty() {
                name.to_string()
            } else {
                format!("{crate_dir}/{name}")
            })
        });
        if has_root || crate_dir.is_empty() {
            break;
        }
        crate_dir = crate_dir.rsplit_once('/').map(|p| p.0).unwrap_or("");
    }
    let module_dir = if ["main.rs", "lib.rs", "mod.rs"].contains(&filename) {
        directory.to_string()
    } else {
        format!("{directory}/{}", filename.trim_end_matches(".rs"))
            .trim_start_matches('/')
            .to_string()
    };
    let mut parts: Vec<_> = spec.split("::").collect();
    let mut base = crate_dir.to_string();
    if parts.first() == Some(&"crate") {
        parts.remove(0);
    } else if parts.first() == Some(&"self") {
        parts.remove(0);
        base = module_dir;
    } else if parts.first() == Some(&"super") {
        base = module_dir;
        while parts.first() == Some(&"super") {
            parts.remove(0);
            base = base.rsplit_once('/').map(|p| p.0).unwrap_or("").into();
        }
    }
    while let Some(last) = parts.last() {
        if *last == "*" || *last == "self" {
            parts.pop();
        } else {
            break;
        }
    }
    loop {
        let stem = [base.as_str(), &parts.join("/")]
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("/");
        for candidate in [format!("{stem}.rs"), format!("{stem}/mod.rs")] {
            if paths.contains(&candidate) {
                return vec![candidate];
            }
        }
        if parts.pop().is_none() {
            break;
        }
    }
    vec![]
}
/// Native Rust implementation of the common language contract.
pub struct Rust;
impl super::LanguageAdapter for Rust {
    fn id(&self) -> &'static str {
        "rust"
    }
    fn extensions(&self) -> &'static [&'static str] {
        &["rs"]
    }
    fn limitations(&self) -> &'static str {
        "Macros and conditional compilation are not evaluated; conventional module paths only."
    }
    fn identity(&self, _: &super::Config) -> String {
        "syn2".into()
    }
    fn analyze(&self, input: &[(String, String)], _: &super::Config) -> anyhow::Result<Vec<Value>> {
        Ok(input.iter().map(|(_, source)| analyze(source)).collect())
    }
    fn resolve(&self, file: &str, item: &Value, context: &super::Resolution) -> Vec<String> {
        resolve(
            file,
            item["specifier"].as_str().unwrap_or(""),
            &context.paths,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_rust_contracts_without_running_code() {
        let result = analyze(
            "//! Repository services.\n/// A service.\npub struct Service { pub count: usize }\nimpl Service {\n/// Run input.\npub async fn run(&self, value: &str) -> Result<usize, Error> { todo!() }\n}\nuse crate::{engine::Repository, index::Index};\n",
        );
        assert_eq!(result["details"]["description"], "Repository services.");
        assert_eq!(
            result["symbols"][0]["details"]["fields"][0]["type"],
            "usize"
        );
        let method = &result["symbols"][1];
        assert_eq!(method["name"], "Service.run");
        assert_eq!(method["start"], 5);
        assert_eq!(method["details"]["description"], "Run input.");
        assert_eq!(method["details"]["parameters"][1]["name"], "value");
        assert!(
            method["details"]["returns"]
                .as_str()
                .unwrap()
                .contains("Result")
        );
        assert_eq!(
            result["imports"][0]["specifier"],
            "crate::engine::Repository"
        );
    }
    #[test]
    fn resolves_crate_and_relative_modules() {
        let paths = ["rust/main.rs", "rust/engine.rs", "rust/engine/nested.rs"]
            .map(String::from)
            .into_iter()
            .collect();
        assert_eq!(
            resolve("rust/main.rs", "self::engine", &paths),
            vec!["rust/engine.rs"]
        );
        assert_eq!(
            resolve("rust/engine/nested.rs", "super::Repository", &paths),
            vec!["rust/engine.rs"]
        );
        assert!(resolve("rust/main.rs", "serde_json::Value", &paths).is_empty());
    }
}
