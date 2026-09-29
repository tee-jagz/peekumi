//! Extracts declaration relationships without compiling Rust or expanding macros.
use quote::ToTokens;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use syn::{
    Item, UseTree,
    spanned::Spanned,
    visit::{self, Visit},
};
fn compact(node: &impl ToTokens) -> String {
    node.to_token_stream().to_string().replace(' ', "")
}
fn bindings(tree: &UseTree, prefix: &str, out: &mut BTreeMap<String, String>) {
    match tree {
        UseTree::Path(p) => bindings(&p.tree, &format!("{prefix}{}::", p.ident), out),
        UseTree::Group(g) => {
            for t in &g.items {
                bindings(t, prefix, out)
            }
        }
        UseTree::Name(n) => {
            out.insert(n.ident.to_string(), format!("{prefix}{}", n.ident));
        }
        UseTree::Rename(n) => {
            out.insert(n.rename.to_string(), format!("{prefix}{}", n.ident));
        }
        UseTree::Glob(_) => {
            out.insert(format!("*{prefix}"), format!("{prefix}*"));
        }
    }
}
struct Locals(BTreeSet<String>);
impl<'ast> Visit<'ast> for Locals {
    fn visit_pat_ident(&mut self, node: &'ast syn::PatIdent) {
        self.0.insert(node.ident.to_string());
        visit::visit_pat_ident(self, node);
    }
    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        self.0.insert(node.sig.ident.to_string());
    }
    fn visit_item_use(&mut self, node: &'ast syn::ItemUse) {
        let mut names = BTreeMap::new();
        bindings(&node.tree, "", &mut names);
        self.0.extend(names.into_keys());
    }
}
struct Calls<'a> {
    owner: String,
    prefix: &'a str,
    names: &'a BTreeSet<String>,
    uses: &'a BTreeMap<String, String>,
    blocked: BTreeSet<String>,
    out: &'a mut Vec<Value>,
}
impl Calls<'_> {
    fn record(&mut self, target: String, kind: &str, line: usize, dynamic: bool) {
        let root = target.split("::").next().unwrap_or("");
        let local = format!("{}{}", self.prefix, target.replace("::", "."));
        let mut entry = json!({"source":self.owner,"target":target,"kind":kind,"line":line});
        if dynamic {
            entry["reason"] = json!("Receiver or qualified dispatch requires type information");
        } else if self.blocked.contains(root) {
            entry["reason"] = json!("Name is shadowed in this scope");
        } else if self.names.contains(&local) {
            entry["lookup"] = json!({"local":local});
        } else if self.prefix.is_empty() {
            let spec = if let Some(binding) = self.uses.get(root) {
                format!("{binding}{}", &target[root.len()..])
            } else {
                target.clone()
            };
            let name = spec.rsplit("::").next().unwrap_or("");
            let candidates = self
                .uses
                .iter()
                .filter(|(k, _)| k.starts_with('*'))
                .map(|(_, v)| json!({"specifier":v,"name":target}))
                .collect::<Vec<_>>();
            if spec.contains("::") {
                entry["lookup"] = json!({"import":{"specifier":spec},"name":name});
            } else if !candidates.is_empty() {
                entry["lookup"] = json!({"imports":candidates,"name":target});
            } else {
                entry["reason"] = json!("External name or unsupported binding");
            }
        } else {
            entry["reason"] = json!("Inline module import resolution is not supported");
        }
        self.out.push(entry);
    }
}
impl<'ast> Visit<'ast> for Calls<'_> {
    fn visit_expr_call(&mut self, node: &'ast syn::ExprCall) {
        self.record(
            compact(&node.func),
            "calls",
            node.func.span().start().line,
            !matches!(&*node.func,syn::Expr::Path(p) if p.qself.is_none()),
        );
        visit::visit_expr_call(self, node);
    }
    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        self.record(
            format!("{}.{}", compact(&node.receiver), node.method),
            "calls",
            node.span().start().line,
            true,
        );
        visit::visit_expr_method_call(self, node);
    }
    fn visit_item(&mut self, _: &'ast Item) {}
    fn visit_expr_closure(&mut self, _: &'ast syn::ExprClosure) {}
}
fn body(
    owner: String,
    prefix: &str,
    sig: &syn::Signature,
    body: &syn::Block,
    names: &BTreeSet<String>,
    uses: &BTreeMap<String, String>,
    out: &mut Vec<Value>,
) {
    let mut locals = Locals(BTreeSet::new());
    locals.visit_signature(sig);
    locals.visit_block(body);
    Calls {
        owner,
        prefix,
        names,
        uses,
        blocked: locals.0,
        out,
    }
    .visit_block(body);
}
fn walk(items: &[Item], prefix: &str, names: &BTreeSet<String>, out: &mut Vec<Value>) {
    let mut uses = BTreeMap::new();
    for item in items {
        if let Item::Use(n) = item {
            bindings(&n.tree, "", &mut uses);
        }
    }
    for item in items {
        match item {
            Item::Fn(n) => body(
                format!("{prefix}{}", n.sig.ident),
                prefix,
                &n.sig,
                &n.block,
                names,
                &uses,
                out,
            ),
            Item::Impl(n) => {
                let owner = n.self_ty.to_token_stream().to_string();
                if let Some((None, tr, _)) = &n.trait_ {
                    Calls {
                        owner: format!("{prefix}{owner}"),
                        prefix,
                        names,
                        uses: &uses,
                        blocked: BTreeSet::new(),
                        out,
                    }
                    .record(
                        compact(tr),
                        "implements",
                        n.span().start().line,
                        false,
                    );
                }
                let owner = if let Some((_, tr, _)) = &n.trait_ {
                    format!("{owner} as {}", tr.to_token_stream())
                } else {
                    owner
                };
                for m in &n.items {
                    if let syn::ImplItem::Fn(f) = m {
                        body(
                            format!("{prefix}{owner}.{}", f.sig.ident),
                            prefix,
                            &f.sig,
                            &f.block,
                            names,
                            &uses,
                            out,
                        );
                    }
                }
            }
            Item::Trait(n) => {
                for parent in &n.supertraits {
                    if let syn::TypeParamBound::Trait(t) = parent {
                        Calls {
                            owner: format!("{prefix}{}", n.ident),
                            prefix,
                            names,
                            uses: &uses,
                            blocked: BTreeSet::new(),
                            out,
                        }
                        .record(
                            compact(&t.path),
                            "inherits",
                            t.span().start().line,
                            false,
                        );
                    }
                }
            }
            Item::Mod(n) => {
                if let Some((_, inner)) = &n.content {
                    walk(inner, &format!("{prefix}{}::", n.ident), names, out)
                }
            }
            _ => {}
        }
    }
}
/// Returns syntax relationships with explicit lookup evidence or an unresolved reason.
pub fn extract(file: &syn::File, symbols: &[Value]) -> Vec<Value> {
    let names = symbols
        .iter()
        .filter_map(|s| s["name"].as_str().map(String::from))
        .collect();
    let mut out = vec![];
    walk(&file.items, "", &names, &mut out);
    out
}
