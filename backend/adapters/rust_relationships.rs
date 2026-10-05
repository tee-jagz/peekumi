//! Extracts declaration relationships without compiling Rust or expanding macros.
//!
//! A method call is linked only when its receiver's type is written in the code: `self` and
//! `Self::` (the surrounding `impl` type), a parameter with a declared type, or a field of
//! either (from the struct's declared fields). References and `Arc`, `Rc` and `Box` are seen
//! through. A trait object (`dyn Trait`) links to every implementation, as an ambiguous
//! target. Calls inside macro arguments (`json!`, `format!`, `ensure!`) and closures count
//! for the enclosing function. Everything else stays unresolved, with its reason.
use proc_macro2::{Delimiter, TokenStream, TokenTree};
use quote::ToTokens;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use syn::{
    Item, UseTree,
    spanned::Spanned,
    visit::{self, Visit},
};
/// The type a method call goes to, from a written type: references, `Arc`, `Rc` and `Box`
/// removed, the last path segment kept. A trait object or `impl Trait` gives `dyn Trait`.
/// `None` for anything else (tuples, slices, generic parameters in lower case).
pub fn type_name(ty: &syn::Type) -> Option<String> {
    match ty {
        syn::Type::Reference(r) => type_name(&r.elem),
        syn::Type::Paren(p) => type_name(&p.elem),
        syn::Type::Group(g) => type_name(&g.elem),
        syn::Type::Path(p) if p.qself.is_none() => {
            let last = p.path.segments.last()?;
            let ident = last.ident.to_string();
            if ["Arc", "Rc", "Box"].contains(&ident.as_str())
                && let syn::PathArguments::AngleBracketed(args) = &last.arguments
                && let Some(syn::GenericArgument::Type(inner)) = args.args.first()
            {
                return type_name(inner);
            }
            ident.starts_with(char::is_uppercase).then_some(ident)
        }
        syn::Type::TraitObject(t) => trait_bound(&t.bounds),
        syn::Type::ImplTrait(t) => trait_bound(&t.bounds),
        _ => None,
    }
}
fn trait_bound(bounds: &syn::punctuated::Punctuated<syn::TypeParamBound, syn::token::Plus>) -> Option<String> {
    bounds.iter().find_map(|b| match b {
        syn::TypeParamBound::Trait(t) => t.path.segments.last().map(|s| format!("dyn {}", s.ident)),
        _ => None,
    })
}
/// [`type_name`] for a type written as text, such as a struct field's type.
pub fn type_name_of(written: &str) -> Option<String> {
    syn::parse_str::<syn::Type>(written).ok().as_ref().and_then(type_name)
}
/// The expressions in a macro's arguments: split at top-level commas and semicolons, with
/// a leading `"key":` or `key:` removed (JSON-like and struct-like macros), and braces or
/// brackets opened. Pieces that are not expressions are skipped.
fn macro_exprs(tokens: TokenStream, out: &mut Vec<syn::Expr>) {
    let mut piece: Vec<TokenTree> = vec![];
    let flush = |piece: &mut Vec<TokenTree>, out: &mut Vec<syn::Expr>| {
        let mut start = 0;
        if piece.len() > 2
            && matches!(&piece[0], TokenTree::Literal(_) | TokenTree::Ident(_))
            && matches!(&piece[1], TokenTree::Punct(p) if p.as_char() == ':')
            && !matches!(&piece[2], TokenTree::Punct(p) if p.as_char() == ':')
        {
            start = 2;
        }
        let rest: Vec<TokenTree> = piece[start..].to_vec();
        match rest.as_slice() {
            [TokenTree::Group(g)] if g.delimiter() != Delimiter::Parenthesis => {
                macro_exprs(g.stream(), out)
            }
            [] => {}
            _ => {
                if let Ok(expr) = syn::parse2::<syn::Expr>(rest.into_iter().collect()) {
                    out.push(expr);
                }
            }
        }
        piece.clear();
    };
    for tree in tokens {
        match &tree {
            TokenTree::Punct(p) if p.as_char() == ',' || p.as_char() == ';' => flush(&mut piece, out),
            _ => piece.push(tree),
        }
    }
    flush(&mut piece, out);
}
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
    /// The type of the surrounding `impl`, for `self` and `Self::`.
    self_ty: Option<String>,
    /// Parameters with a declared type that the body does not bind again.
    params: BTreeMap<String, String>,
}
impl Calls<'_> {
    /// The receiver's type and the fields walked from it: `self`, a typed parameter, or a
    /// field of either. `None` when the type is not written in the code.
    fn receiver(&self, expr: &syn::Expr) -> Option<(String, Vec<String>)> {
        match expr {
            syn::Expr::Path(p) if p.qself.is_none() && p.path.segments.len() == 1 => {
                let id = p.path.segments[0].ident.to_string();
                if id == "self" {
                    self.self_ty.clone().map(|t| (t, vec![]))
                } else {
                    self.params.get(&id).cloned().map(|t| (t, vec![]))
                }
            }
            syn::Expr::Field(f) => {
                let (ty, mut fields) = self.receiver(&f.base)?;
                match &f.member {
                    syn::Member::Named(name) => {
                        fields.push(name.to_string());
                        Some((ty, fields))
                    }
                    syn::Member::Unnamed(_) => None,
                }
            }
            syn::Expr::Paren(p) => self.receiver(&p.expr),
            syn::Expr::Reference(r) => self.receiver(&r.expr),
            _ => None,
        }
    }
    /// A call to method `name` of `ty`, after walking `fields`; the resolver finds it.
    fn record_method(&mut self, target: String, ty: String, fields: Vec<String>, name: String, line: usize) {
        self.out.push(json!({"source":self.owner,"target":target,"kind":"calls","line":line,
            "lookup":{"method":{"type":ty,"fields":fields,"name":name}}}));
    }
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
        let target = compact(&node.func);
        let line = node.func.span().start().line;
        // `Self::method(...)` and `Type::method(...)` for a type declared elsewhere.
        let method = match &*node.func {
            syn::Expr::Path(p) if p.qself.is_none() && p.path.segments.len() >= 2 => {
                let segments: Vec<String> = p.path.segments.iter().map(|s| s.ident.to_string()).collect();
                let (owner, name) = (&segments[segments.len() - 2], &segments[segments.len() - 1]);
                let local = format!("{}{}", self.prefix, target.replace("::", "."));
                if owner == "Self" && segments.len() == 2 {
                    self.self_ty.clone().map(|ty| (ty, name.clone()))
                } else if owner.starts_with(char::is_uppercase) && !self.names.contains(&local) {
                    Some((owner.clone(), name.clone()))
                } else {
                    None
                }
            }
            _ => None,
        };
        match method {
            Some((ty, name)) => self.record_method(target, ty, vec![], name, line),
            None => self.record(
                target,
                "calls",
                line,
                !matches!(&*node.func,syn::Expr::Path(p) if p.qself.is_none()),
            ),
        }
        visit::visit_expr_call(self, node);
    }
    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        let target = format!("{}.{}", compact(&node.receiver), node.method);
        let line = node.span().start().line;
        match self.receiver(&node.receiver) {
            Some((ty, fields)) => self.record_method(target, ty, fields, node.method.to_string(), line),
            None => self.record(target, "calls", line, true),
        }
        visit::visit_expr_method_call(self, node);
    }
    /// Macro arguments that are expressions: `json!`, `format!`, `ensure!` and the like.
    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        let mut exprs = vec![];
        macro_exprs(node.tokens.clone(), &mut exprs);
        for expr in &exprs {
            self.visit_expr(expr);
        }
    }
    fn visit_item(&mut self, _: &'ast Item) {}
}
#[allow(clippy::too_many_arguments)]
fn body(
    owner: String,
    prefix: &str,
    sig: &syn::Signature,
    body: &syn::Block,
    names: &BTreeSet<String>,
    uses: &BTreeMap<String, String>,
    out: &mut Vec<Value>,
    self_ty: Option<String>,
) {
    let mut locals = Locals(BTreeSet::new());
    locals.visit_signature(sig);
    locals.visit_block(body);
    // A parameter keeps its declared type only if the body never binds the name again.
    let mut rebound = Locals(BTreeSet::new());
    rebound.visit_block(body);
    let params = sig
        .inputs
        .iter()
        .filter_map(|input| match input {
            syn::FnArg::Typed(p) => match &*p.pat {
                syn::Pat::Ident(id) if !rebound.0.contains(&id.ident.to_string()) => {
                    type_name(&p.ty).map(|t| (id.ident.to_string(), t))
                }
                _ => None,
            },
            syn::FnArg::Receiver(_) => None,
        })
        .collect();
    Calls {
        owner,
        prefix,
        names,
        uses,
        blocked: locals.0,
        out,
        self_ty,
        params,
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
                None,
            ),
            Item::Impl(n) => {
                let owner = n.self_ty.to_token_stream().to_string();
                let self_ty = type_name(&n.self_ty);
                if let Some((None, tr, _)) = &n.trait_ {
                    Calls {
                        owner: format!("{prefix}{owner}"),
                        prefix,
                        names,
                        uses: &uses,
                        blocked: BTreeSet::new(),
                        out,
                        self_ty: None,
                        params: BTreeMap::new(),
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
                            self_ty.clone(),
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
                            self_ty: None,
                            params: BTreeMap::new(),
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
