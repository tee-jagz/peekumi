//! The repository map in a task's own text: every folder, file and declaration name at the
//! start commit, with no descriptions and no code. The agent reads the map first, then opens
//! only the parts it needs with the `highlight` and `route` tools (see the lookup module),
//! which add descriptions, signatures, code, callers and calls.
//!
//! A large repository does not fit: the map then folds whole subtrees into one line each
//! ("`frontend/` (folded: 389 files, 2,140 declarations; highlight this folder to open it)"),
//! the largest saving first, and never a subtree that holds a file the instructions are
//! about. A folder `highlight` folds the same way, so each step opens one level.
use crate::App;
use serde_json::{Value, json};

/// The most text the map, or one folder `highlight`, may take (about 3,000 tokens). A larger
/// map costs more than it saves: in the experiments, a 40,000-character map was most of the
/// cost of a run.
pub const BUDGET: usize = 12_000;

/// Names an instruction is about, in order: the anchored declaration, names in backticks, then
/// words that look like identifiers (with `_`, `::` or a lowercase-to-uppercase change).
pub fn names(comments: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut add = |raw: &str| {
        let name = raw
            .trim_matches(|c: char| !c.is_alphanumeric() && c != '_')
            .rsplit(['.', ':'])
            .next()
            .unwrap_or("")
            .trim_end_matches("()")
            .to_string();
        let identifier = name.len() > 1
            && name.len() <= 80
            && name.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_alphanumeric() || c == '_');
        if identifier && !out.contains(&name) {
            out.push(name);
        }
    };
    for c in comments {
        if let Some(symbol) = c["anchor"]["symbol"].as_str() {
            add(symbol);
        }
        let text = c["text"].as_str().unwrap_or("");
        for span in text.split('`').skip(1).step_by(2) {
            add(span.trim_end_matches("()"));
        }
        for word in text.split(|ch: char| ch.is_whitespace() || ",;()[]{}\"'".contains(ch)) {
            let core = word.trim_end_matches(['.', '?', '!', ':']);
            let looks = core.contains('_')
                || core.contains("::")
                || core
                    .chars()
                    .zip(core.chars().skip(1))
                    .any(|(a, b)| a.is_lowercase() && b.is_uppercase());
            if looks && !core.contains('/') {
                add(core);
            }
        }
    }
    out.truncate(12);
    out
}

/// The names-only tree of the files under `prefix` (see `lookup::names_tree`), in at most
/// `budget` characters. While it is too long, one part becomes one line: a whole subtree, or
/// only the files of one folder (its subfolders stay listed). A subtree that holds a `focus`
/// folder stays, and a `focus` folder keeps its files. Each step takes the smallest fold that
/// is enough, or else the fold that saves most. Returns the tree and the number of folds.
pub fn fold(files: &[Value], prefix: &str, focus: &[String], budget: usize) -> (String, usize) {
    let inside = |folder: &str, root: &str| folder == root || folder.starts_with(&format!("{root}/"));
    // Each entry: folder, text, and whether it is a fold.
    let mut entries: Vec<(String, String, bool)> =
        crate::lookup::names_tree(files, prefix).into_iter().map(|(f, t)| (f, t, false)).collect();
    let size = |entries: &[(String, String, bool)]| entries.iter().map(|(_, t, _)| t.len() + 1).sum::<usize>();
    // Every folder under `prefix` and each of its parents is a subtree that can fold.
    let top = prefix.trim_end_matches('/');
    let mut roots: std::collections::BTreeSet<String> = Default::default();
    for (folder, _, _) in &entries {
        let mut at = folder.as_str();
        while !at.is_empty() && at != top {
            roots.insert(at.to_string());
            at = at.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        }
    }
    let count = |keep: &dyn Fn(&str) -> bool| {
        let under: Vec<&Value> = files.iter().filter(|f| keep(folder_of(f["path"].as_str().unwrap_or("")))).collect();
        let declarations: usize = under.iter().map(|f| f["symbols"].as_array().map_or(0, Vec::len)).sum();
        (under.len(), declarations)
    };
    let mut folded = 0;
    loop {
        let over = size(&entries).saturating_sub(budget);
        if over == 0 {
            break;
        }
        // Candidates: (saving, root, line, whole subtree?).
        let mut candidates: Vec<(usize, String, String, bool)> = vec![];
        for root in roots.iter().filter(|r| !focus.iter().any(|f| inside(f, r))) {
            let held: usize = entries.iter().filter(|(f, _, _)| inside(f, root)).map(|(_, t, _)| t.len() + 1).sum();
            let (n, d) = count(&|f| inside(f, root));
            let line = format!("{root}/ (folded: {n} files, {d} declarations; highlight this folder to open it)");
            candidates.push((held.saturating_sub(line.len() + 1), root.clone(), line, true));
        }
        for (folder, text, is_fold) in &entries {
            if *is_fold || folder.is_empty() || focus.contains(folder) || !text.contains('\n') {
                continue;
            }
            let (n, d) = count(&|f| f == folder);
            let line = format!("{folder}/ (files folded: {n} files, {d} declarations; highlight this folder to open it)");
            candidates.push((text.len().saturating_sub(line.len()), folder.clone(), line, false));
        }
        candidates.retain(|c| c.0 > 0);
        let enough = candidates.iter().filter(|c| c.0 >= over).min_by_key(|c| c.0);
        let Some((_, root, line, whole)) = enough.or_else(|| candidates.iter().max_by_key(|c| c.0)).cloned() else {
            break;
        };
        if whole {
            // Folds inside this subtree are now part of the one line.
            folded -= entries.iter().filter(|(f, _, is_fold)| *is_fold && inside(f, &root)).count();
            entries.retain(|(f, _, _)| !inside(f, &root));
            roots.remove(&root);
        } else {
            entries.retain(|(f, _, _)| *f != root);
        }
        entries.push((root, line, true));
        folded += 1;
    }
    entries.sort();
    (entries.into_iter().map(|(_, t, _)| t).collect::<Vec<_>>().join("\n"), folded)
}

/// The folder of a path ("" at the top).
fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(f, _)| f).unwrap_or("")
}

/// The map for a task with `comments` at commit `base`, or an empty string when the analysis
/// is not available.
pub async fn map(app: &App, comments: &[Value], base: &str) -> String {
    let revision = json!(base);
    let Ok(full) = app.engine.call("compare", json!([revision, revision])).await else {
        return String::new();
    };
    let files = full["files"].as_array().cloned().unwrap_or_default();
    // Folders the instructions are about: their anchors, and files that declare their names.
    let wanted = names(comments);
    let mut focus: Vec<String> = comments
        .iter()
        .filter_map(|c| c["anchor"]["path"].as_str())
        .map(|p| folder_of(p).to_string())
        .collect();
    for file in &files {
        let declares = file["symbols"].as_array().into_iter().flatten().any(|s| {
            let name = s["name"].as_str().unwrap_or("");
            wanted.iter().any(|w| name.rsplit(['.', ':']).next() == Some(w.as_str()))
        });
        if declares {
            focus.push(folder_of(file["path"].as_str().unwrap_or("")).to_string());
        }
    }
    let (mut tree, mut folded) = fold(&files, "", &focus, BUDGET);
    if tree.len() > BUDGET {
        // The focus alone is too large (a common name in many folders): fold it too.
        (tree, folded) = fold(&files, "", &[], BUDGET);
    }
    let note = if folded > 0 {
        let parts = if folded == 1 { "1 part is".to_string() } else { format!("{folded} parts are") };
        format!(" {parts} folded to fit; highlight a folded folder to open it.")
    } else {
        String::new()
    };
    format!(
        "Every folder, file and declaration name of this repository at the start commit: names only, no code.{note} Read the map first. To see a part, call highlight with a folder, a file, or a file and a declaration name as the map shows it: it gives the description, signatures, code, callers and calls that you ask for. To see how code connects, call route: what reaches a declaration, or the path from one declaration to another, in one call. Prefer these to a text search and to reading whole files.\n```\n{tree}\n```\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_the_names_an_instruction_is_about() {
        let comments = [json!({
            "anchor": {"symbol": "Workflow::choice"},
            "text": "Which functions call `merge_status` or `lookup::open()`? Also check renderPrRows, the run step and http://x/a_b."
        })];
        assert_eq!(names(&comments), ["choice", "merge_status", "open", "renderPrRows"]);
    }
    #[test]
    fn a_large_tree_folds_whole_subtrees_but_not_the_focus() {
        let file = |path: &str| json!({"path": path, "symbols": (0..20).map(|i| json!({"name": format!("function_number_{i}")})).collect::<Vec<_>>()});
        let mut files = vec![file("main.py")];
        for folder in ["web/a", "web/b", "web/c/d", "api/x", "api/y"] {
            for n in 0..3 {
                files.push(file(&format!("{folder}/f{n}.py")));
            }
        }
        let (open, folded) = fold(&files, "", &[], 1_000_000);
        assert_eq!(folded, 0);
        assert!(open.contains("web/c/d/") && open.contains("  f0.py: function_number_0"));
        let (tree, folded) = fold(&files, "", &["api/x".to_string()], 2_500);
        assert!(tree.len() <= 2_500, "{tree}");
        assert!(folded >= 1);
        assert!(tree.contains("web/ (folded: 9 files, 180 declarations; highlight this folder to open it)"), "{tree}");
        assert!(tree.contains("api/x/\n  f0.py: function_number_0"), "The focus stays open: {tree}");
        assert!(tree.starts_with("./\n  main.py"), "{tree}");
        // A folder highlight folds inside that folder only.
        let (inner, _) = fold(&files, "web/", &[], 1_200);
        assert!(!inner.contains("api/") && inner.contains("web/"), "{inner}");
    }
}
