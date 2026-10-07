//! Read-only repository lookups (the code graph and text), served as a Streamable HTTP MCP
//! endpoint on the Peekumi listener at `/mcp/ask`. A grant pins the revisions it may read,
//! carries a random bearer key and allows a bounded number of calls. Ask has one grant while an
//! answer runs; each task run has its own grant on its start commit while it runs, so a task
//! agent can find declarations and what calls or uses them instead of searching text. Every tool reads
//! committed code through the repository worker; none writes state, runs code or reaches another
//! repository. Relationships are static declarations, never runtime behaviour.
use crate::App;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};

/// Tool calls one answer may make before it must reply with what it has.
pub const MAX_CALLS: usize = 30;
/// Tool calls one task run may make.
pub const TASK_CALLS: usize = 300;
/// The open grants of task runs, by key. Shared by the server and the task runner.
pub type Grants = std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, Grant>>>;
/// Tool names as Claude Code sees them through the `peekumi` server.
pub const TOOLS: [&str; 7] = [
    "mcp__peekumi__find_declarations",
    "mcp__peekumi__search_code",
    "mcp__peekumi__read_declaration",
    "mcp__peekumi__read_file",
    "mcp__peekumi__relationships",
    "mcp__peekumi__highlight",
    "mcp__peekumi__route",
];

/// One lookup permission: the key, the revisions it may read, the calls made and the limit.
pub struct Grant {
    pub key: String,
    base: Value,
    head: Value,
    pub calls: Vec<String>,
    /// For each call, the place it read: `{path, symbol?}`, or null (a search with no path).
    /// The app marks it on the map while Ask answers.
    pub places: Vec<Value>,
    limit: usize,
    /// A task run's branch (`peekumi/run-…`): `check_rules` compares its committed work with
    /// the start commit. `None` for Ask.
    branch: Option<String>,
}
impl Grant {
    /// An Ask answer's grant, with [`MAX_CALLS`].
    pub fn new(key: String, base: Value, head: Value) -> Self {
        Self::with_limit(key, base, head, MAX_CALLS)
    }
    /// A grant that allows `limit` calls (a task run uses [`TASK_CALLS`]).
    pub fn with_limit(key: String, base: Value, head: Value, limit: usize) -> Self {
        Self {
            key,
            base,
            head,
            calls: vec![],
            places: vec![],
            limit,
            branch: None,
        }
    }
    /// A task run's grant: the code graph of its start commit, and `check_rules` on `branch`.
    pub fn for_task(key: String, base: Value, branch: Option<String>, limit: usize) -> Self {
        Self {
            branch,
            ..Self::with_limit(key, base.clone(), base, limit)
        }
    }
}

/// The task-only tool: the dependency rules on the work that the agent committed.
fn check_rules_tool() -> Value {
    json!({"name":"check_rules","description":"Check the repository's dependency rules (.peekumi.json) on the work you committed on this task's branch, compared with the start commit. Returns each rule break that your commits add (old breaks are left out), and warnings about rules that check nothing. Commit first: uncommitted changes are not checked. Static relationships only.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}})
}

/// The tools for the grant of `key`: a task's grant also has `check_rules`.
fn tools_for(app: &App, key: &str) -> Value {
    let mut tools = tool_list();
    let task = app
        .workflow
        .grants
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(key)
        .is_some_and(|g| g.branch.is_some());
    if task {
        tools.as_array_mut().unwrap().push(check_rules_tool());
    }
    tools
}

fn tool_list() -> Value {
    let side = json!({"type":"string","enum":["after","before"],"description":"after = the newer compared revision (default), before = the older one"});
    json!([
        {"name":"find_declarations","description":"Search declaration names (functions, methods, classes and types) in this repository at the compared revisions. Case-insensitive substring match; optionally limited to a path prefix. Returns path, name, kind, change status and line.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"path":{"type":"string","description":"Optional file or folder prefix"}},"required":["query"],"additionalProperties":false}},
        {"name":"search_code","description":"Find lines containing exact text (case-sensitive) in the repository's readable files at one compared revision, optionally under a path prefix. Each match names the declaration it sits in. Use it to find where something is used, including references static analysis missed (inside macros, strings or dynamic code).","inputSchema":{"type":"object","properties":{"text":{"type":"string"},"path":{"type":"string","description":"Optional file or folder prefix"},"side":side},"required":["text"],"additionalProperties":false}},
        {"name":"read_declaration","description":"Read one declaration's source with line numbers, from a file at the compared revisions.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"name":{"type":"string"},"side":side},"required":["path","name"],"additionalProperties":false}},
        {"name":"read_file","description":"Read up to 300 numbered lines of a file at the compared revisions.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1},"side":side},"required":["path"],"additionalProperties":false}},
        {"name":"relationships","description":"List static relationships for a file or one of its declarations: what it calls, imports, implements or inherits (outgoing) and what refers to it (incoming), with resolution and source lines. Static declarations, not runtime behaviour; unresolved and ambiguous targets stay uncertain.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"name":{"type":"string","description":"Optional declaration name in that file"}},"required":["path"],"additionalProperties":false}},
        {"name":"highlight","description":"Open one part of the repository map with the details you need. A folder gives its full tree of files and declaration names, and its description. A file gives each declaration's signature and first documentation line, and what uses the file. A declaration (path and name) gives its code, its callers with the calling lines, and what it calls. detail limits the answer, for example [\"callers\"].","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"Folder or file path, as in the map"},"name":{"type":"string","description":"Optional declaration name in that file, as in the map"},"detail":{"type":"array","items":{"type":"string","enum":["description","code","callers","calls"]}}},"required":["path"],"additionalProperties":false}},
        {"name":"route","description":"Follow how code connects, in one call. With only `to`: `entries` lists every entry point that reaches that declaration (a declaration that nothing in the repository calls), with its decorators or attributes such as an HTTP route, and `routes` gives up to 20 caller chains. With `from` too: the call paths from `from` to `to`. Each step gives file and line; lines adds the calling line of each step, after the conditions that hold it (the `if` or `match` lines around the call, such as a path test in a request handler). Callers in test files are left out unless tests is true. Static declarations, not runtime behaviour: a call through a value with no written type is not seen, so check a missing link with a text search.","inputSchema":{"type":"object","properties":{"to":{"type":"object","properties":{"path":{"type":"string"},"name":{"type":"string"}},"required":["path","name"]},"from":{"type":"object","properties":{"path":{"type":"string"},"name":{"type":"string"}},"required":["path","name"]},"depth":{"type":"integer","minimum":1,"maximum":10},"lines":{"type":"boolean"},"tests":{"type":"boolean"}},"required":["to"],"additionalProperties":false}}
    ])
}

/// Handles one JSON-RPC message from the Ask client. Returns `None` for notifications,
/// which the HTTP layer acknowledges with 202 Accepted.
pub async fn handle(app: &App, key: &str, request: Value) -> Option<Value> {
    let id = request.get("id")?.clone();
    let method = request["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": request["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "peekumi-ask", "version": env!("CARGO_PKG_VERSION")}
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools_for(app, key)})),
        "tools/call" => Ok(call(app, key, &request["params"]).await),
        _ => Err(method),
    };
    Some(match result {
        Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
        Err(method) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":format!("Unknown method {method}")}})
        }
    })
}

/// True when `key` opens Ask's grant or a task run's grant on this repository.
pub fn has_grant(app: &App, key: &str) -> bool {
    !key.is_empty()
        && (app
            .ask_grant
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|g| crate::equal(key, &g.key))
            || app
                .workflow
                .grants
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(key))
}

/// The same tools in the function-calling form of chat APIs (OpenRouter), for an Ask engine
/// that runs the lookups itself instead of through MCP.
pub fn function_tools() -> Value {
    json!(tool_list()
        .as_array()
        .unwrap()
        .iter()
        .map(|t| json!({"type":"function","function":{"name":t["name"],"description":t["description"],"parameters":t["inputSchema"]}}))
        .collect::<Vec<_>>())
}

/// The tools in function-calling form for Peekumi's own task agent: the lookups and
/// `check_rules`.
pub fn task_function_tools() -> Value {
    let mut tools = function_tools();
    let t = check_rules_tool();
    tools.as_array_mut().unwrap().push(json!({"type":"function","function":{"name":t["name"],"description":t["description"],"parameters":t["inputSchema"]}}));
    tools
}

/// Runs one lookup for an Ask engine that calls the tools itself, under the open grant and its
/// call limit. Returns the result text and `true` for an error.
pub async fn call_tool(app: &App, name: &str, args: &Value) -> (String, bool) {
    let key = app
        .ask_grant
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|g| g.key.clone())
        .unwrap_or_default();
    let out = call(app, &key, &json!({"name": name, "arguments": args})).await;
    (
        out["content"][0]["text"].as_str().unwrap_or("").to_string(),
        out["isError"] == true,
    )
}

/// Opens a lookup grant for an Ask engine that calls the tools itself (no MCP address needed).
pub fn open(app: &App, base: &Value, head: &Value) {
    *app.ask_grant.lock().unwrap_or_else(|e| e.into_inner()) = Some(Grant::new(
        crate::random_token(),
        base.clone(),
        head.clone(),
    ));
}

fn tool_error(message: &str) -> Value {
    json!({"isError":true,"content":[{"type":"text","text":message}]})
}

/// Records the call against the grant of `key` (Ask's, or a task run's), then performs it
/// without holding the grant lock.
async fn call(app: &App, key: &str, params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or("");
    let args = &params["arguments"];
    let record = |grant: Option<&mut Grant>| match grant {
        None => Err(tool_error("This lookup grant has ended")),
        Some(g) if g.calls.len() >= g.limit => Err(tool_error(
            "Lookup limit reached; continue with the context you have",
        )),
        Some(g) => {
            g.calls.push(describe(name, args));
            g.places.push(place_of(args));
            Ok((g.base.clone(), g.head.clone(), g.branch.clone()))
        }
    };
    let revisions = {
        let mut ask = app.ask_grant.lock().unwrap_or_else(|e| e.into_inner());
        if ask.as_ref().is_some_and(|g| crate::equal(key, &g.key)) {
            record(ask.as_mut())
        } else {
            drop(ask);
            record(
                app.workflow
                    .grants
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get_mut(key),
            )
        }
    };
    let revisions = match revisions {
        Ok(revisions) => revisions,
        Err(error) => return error,
    };
    let result = if name == "check_rules" {
        check_rules(app, &revisions.0, revisions.2.as_deref()).await
    } else {
        run(app, name, args, &revisions.0, &revisions.1).await
    };
    match result {
        Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
        Err(e) => tool_error(&e.to_string()),
    }
}

/// `check_rules`: the rule breaks that the task's committed work adds to its start commit, with
/// the rules' warnings. Errors outside a task, and says so when nothing is committed yet.
async fn check_rules(app: &App, base: &Value, branch: Option<&str>) -> Result<Value> {
    let branch = branch.context("check_rules works only in a task")?;
    let head = app
        .engine
        .call("resolve", json!([format!("refs/heads/{branch}")]))
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    if head == *base {
        return Ok(
            json!({"result":"No commits on the task branch yet. Commit your work, then check again."}),
        );
    }
    let data = app
        .engine
        .call("relationships", json!([base, head, "", "overview"]))
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let checks = &data["checks"];
    let after = &checks["after"];
    if after["state"] != "evaluated" {
        return Ok(json!({"result": if after["state"] == "invalid" {
            format!("The rule configuration is invalid: {}", after["errors"])
        } else {
            "This repository has no .peekumi.json, so there are no rules to check.".into()
        }}));
    }
    let added = checks["added"].as_array().cloned().unwrap_or_default();
    Ok(json!({
        "result": if added.is_empty() {
            "Your commits add no rule break.".to_string()
        } else {
            format!("Your commits add {} rule break{}. Fix each one, or explain it in your report.", added.len(), if added.len() == 1 { "" } else { "s" })
        },
        "head": head,
        "rules": after["rules"],
        "added": added.into_iter().take(50).collect::<Vec<_>>(),
        "warnings": after["warnings"],
    }))
}

/// A short, human description of a call, shown under the answer.
/// The place a lookup reads, for the map: its file and, when it names one, its declaration.
fn place_of(args: &Value) -> Value {
    let target = if args["to"].is_object() {
        &args["to"]
    } else {
        args
    };
    match target["path"].as_str().filter(|p| !p.is_empty()) {
        Some(path) => match target["name"].as_str().filter(|n| !n.is_empty()) {
            Some(name) => json!({"path": path, "symbol": name}),
            None => json!({"path": path}),
        },
        None => Value::Null,
    }
}
fn describe(name: &str, args: &Value) -> String {
    let s = |key: &str| args[key].as_str().unwrap_or("").to_string();
    let file = |key: &str| s(key).rsplit('/').next().unwrap_or("").to_string();
    match name {
        "find_declarations" => format!("Searched for “{}”", s("query")),
        "check_rules" => "Checked the dependency rules".to_string(),
        "search_code" => format!("Searched the code for “{}”", s("text")),
        "read_declaration" => format!("Read {} in {}", s("name"), file("path")),
        "read_file" => format!("Read {}", file("path")),
        "highlight" if !s("name").is_empty() => format!("Opened {} in {}", s("name"), file("path")),
        "highlight" => format!("Opened {}", s("path")),
        "route" if args["from"].is_object() => format!(
            "Route from {} to {}",
            args["from"]["name"].as_str().unwrap_or(""),
            args["to"]["name"].as_str().unwrap_or("")
        ),
        "route" => format!("Routes to {}", args["to"]["name"].as_str().unwrap_or("")),
        "relationships" if !s("name").is_empty() => format!("Relationships of {}", s("name")),
        "relationships" => format!("Relationships of {}", file("path")),
        other => format!("Unknown lookup {other}"),
    }
}

fn argument<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    let value = args[key]
        .as_str()
        .with_context(|| format!("Missing {key}"))?;
    ensure!(
        !value.trim().is_empty() && value.len() <= 1000 && !value.contains('\0'),
        "Invalid {key}"
    );
    Ok(value)
}
fn side(args: &Value) -> Result<&str> {
    match args["side"].as_str().unwrap_or("after") {
        side @ ("after" | "before") => Ok(side),
        _ => bail!("side must be after or before"),
    }
}
/// Bounds a tool result without splitting UTF-8.
fn bounded(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.into();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n… {} more bytes not shown",
        &text[..end],
        text.len() - end
    )
}
/// Numbers lines from `first` (1-based) so answers can cite them.
fn numbered(lines: &[&str], first: usize) -> String {
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{:>5}  {line}", first + i))
        .collect::<Vec<_>>()
        .join("\n")
}

async fn run(app: &App, name: &str, args: &Value, base: &Value, head: &Value) -> Result<Value> {
    let engine = |method: &'static str, call_args: Value| async move {
        app.engine
            .call(method, call_args)
            .await
            .map_err(anyhow::Error::msg)
    };
    match name {
        "find_declarations" => {
            let query = argument(args, "query")?.to_lowercase();
            let prefix = args["path"].as_str().unwrap_or("");
            let full = engine("compare", json!([base, head])).await?;
            let mut matches = vec![];
            for file in full["files"].as_array().context("Missing comparison")? {
                let path = file["path"].as_str().unwrap_or("");
                if !path.starts_with(prefix) {
                    continue;
                }
                for symbol in file["symbols"].as_array().into_iter().flatten() {
                    if symbol["name"]
                        .as_str()
                        .is_some_and(|n| n.to_lowercase().contains(&query))
                    {
                        matches.push(json!({"path":path,"name":symbol["name"],"kind":symbol["kind"],"status":symbol["status"],"line":symbol["start"]}));
                    }
                }
            }
            let more = matches.len().saturating_sub(40);
            matches.truncate(40);
            Ok(json!({"matches":matches,"more":more}))
        }
        "search_code" => {
            let wanted = argument(args, "text")?;
            let revision = if side(args)? == "before" { base } else { head };
            engine(
                "search",
                json!([revision, wanted, args["path"].as_str().unwrap_or("")]),
            )
            .await
        }
        "read_declaration" => {
            let (path, wanted, side) = (
                argument(args, "path")?,
                argument(args, "name")?,
                side(args)?,
            );
            let data = engine("source", json!([base, head, path])).await?;
            let symbol = data["symbols"]
                .as_array()
                .and_then(|symbols| symbols.iter().find(|s| s["name"] == wanted))
                .with_context(|| format!("No declaration named {wanted} in {path}"))?;
            let status = symbol["status"].as_str().unwrap_or("");
            ensure!(
                !(side == "before" && status == "added")
                    && !(side == "after" && status == "removed"),
                "{wanted} does not exist on the {side} side"
            );
            let range = if side == "before" && symbol["before"].is_object() {
                &symbol["before"]
            } else {
                symbol
            };
            let start = range["start"]
                .as_u64()
                .context("Declaration has no line range")? as usize;
            let end = range["end"].as_u64().unwrap_or(start as u64) as usize;
            let source = data[side]
                .as_str()
                .context("No readable source on that side")?;
            let lines: Vec<&str> = source.lines().collect();
            let slice = &lines[start.saturating_sub(1).min(lines.len())..end.min(lines.len())];
            Ok(
                json!({"path":path,"name":wanted,"kind":symbol["kind"],"status":status,"side":side,"lines":format!("{start}-{end}"),"source":bounded(&numbered(slice,start),12000)}),
            )
        }
        "read_file" => {
            let (path, side) = (argument(args, "path")?, side(args)?);
            let data = engine("source", json!([base, head, path])).await?;
            let source = data[side].as_str().with_context(|| {
                if data["analysis"].as_str().is_some_and(|a| a.starts_with("restricted")) {
                    format!("{path} is restricted: its name often holds secrets, so Peekumi never reads it")
                } else {
                    format!("{path} has no readable text on the {side} side (binary, unsupported, oversized or absent)")
                }
            })?;
            let lines: Vec<&str> = source.lines().collect();
            let first = args["start_line"].as_u64().unwrap_or(1).max(1) as usize;
            let last = args["end_line"]
                .as_u64()
                .map(|v| v as usize)
                .unwrap_or(first + 199)
                .min(first + 299)
                .min(lines.len());
            ensure!(
                first <= lines.len().max(1),
                "{path} has {} lines",
                lines.len()
            );
            let slice = &lines[(first - 1).min(lines.len())..last.max(first - 1)];
            Ok(
                json!({"path":path,"side":side,"analysis":data["analysis"],"totalLines":lines.len(),"startLine":first,"endLine":last,"source":bounded(&numbered(slice,first),16000)}),
            )
        }
        "relationships" => {
            let path = argument(args, "path")?;
            let name = args["name"].as_str().filter(|n| !n.is_empty());
            relationship_summary(app, base, head, path, name).await
        }
        "highlight" => highlight(app, args, base, head).await,
        "route" => route(app, args, base, head).await,
        other => bail!("Unknown tool {other}"),
    }
}

/// Summarizes static relationships around a file or declaration as compact lines: outgoing
/// (what it calls, imports, implements or inherits) and incoming (what refers to it).
/// Used both for Ask's initial context and by the `relationships` tool. `callerRefs` lists the
/// distinct declarations that refer to it (`{path, symbol}`); Ask fetches their code.
pub async fn relationship_summary(
    app: &App,
    base: &Value,
    head: &Value,
    path: &str,
    name: Option<&str>,
) -> Result<Value> {
    let data = app
        .engine
        .call("relationships", json!([base, head, path]))
        .await
        .map_err(anyhow::Error::msg)?;
    let targets_here = |edge: &Value| {
        edge["targets"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|t| t["path"] == path && name.is_none_or(|n| t["symbol"] == n))
    };
    let (mut outgoing, mut incoming, mut callers) = (vec![], vec![], vec![]);
    for edge in data["relationships"].as_array().into_iter().flatten() {
        let from_path = edge["source"]["path"].as_str().unwrap_or("");
        let from_symbol = edge["source"]["symbol"].as_str().unwrap_or("");
        let sites = edge["sites"]
            .as_array()
            .map(|s| {
                s.iter()
                    .filter_map(Value::as_u64)
                    .map(|l| l.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        let status = edge["status"].as_str().unwrap_or("unchanged");
        let change = if status == "unchanged" {
            String::new()
        } else {
            format!(", {status}")
        };
        if from_path == path && name.is_none_or(|n| from_symbol == n) {
            let resolved = match edge["resolution"].as_str().unwrap_or("") {
                "resolved" | "ambiguous" => edge["targets"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|t| {
                        format!(
                            "{} · {}",
                            t["path"].as_str().unwrap_or(""),
                            t["symbol"].as_str().unwrap_or("")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" | "),
                _ => "unresolved".into(),
            };
            let ambiguous = if edge["resolution"] == "ambiguous" {
                "ambiguous: "
            } else {
                ""
            };
            outgoing.push(format!(
                "{} {} {} → {ambiguous}{resolved} (line {sites}{change})",
                if from_symbol.is_empty() {
                    "file"
                } else {
                    from_symbol
                },
                edge["kind"].as_str().unwrap_or(""),
                edge["target"].as_str().unwrap_or(""),
            ));
        } else if targets_here(edge) {
            let caller = json!({"path":from_path,"symbol":from_symbol});
            if !from_symbol.is_empty() && !callers.contains(&caller) {
                callers.push(caller);
            }
            incoming.push(format!(
                "{} · {} {} {} (line {sites}{change})",
                from_path,
                if from_symbol.is_empty() {
                    "file"
                } else {
                    from_symbol
                },
                edge["kind"].as_str().unwrap_or(""),
                edge["target"].as_str().unwrap_or(""),
            ));
        }
    }
    let (more_out, more_in) = (
        outgoing.len().saturating_sub(40),
        incoming.len().saturating_sub(40),
    );
    outgoing.truncate(40);
    incoming.truncate(40);
    Ok(json!({
        "subject": match name { Some(n) => format!("{path} · {n}"), None => path.to_string() },
        "outgoing": outgoing, "outgoingNotShown": more_out,
        "incoming": incoming, "incomingNotShown": more_in,
        "note": "Static declarations, not runtime behaviour. Incoming links come only from references Peekumi resolved to this target.",
        "callerRefs": callers
    }))
}

/// The names-only tree of files and declarations under `prefix` ("" for the whole
/// repository): one line per folder, then one line per file with its declaration names.
/// Files without declarations are counted on their folder's line.
pub fn names_tree(files: &[Value], prefix: &str) -> Vec<(String, String)> {
    let mut folders: std::collections::BTreeMap<String, (Vec<String>, usize)> = Default::default();
    for file in files {
        let path = file["path"].as_str().unwrap_or("");
        if !path.starts_with(prefix) {
            continue;
        }
        let (folder, name) = path.rsplit_once('/').unwrap_or(("", path));
        let entry = folders.entry(folder.to_string()).or_default();
        let symbols: Vec<&str> = file["symbols"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| s["name"].as_str())
            .collect();
        if symbols.is_empty() {
            entry.1 += 1;
        } else {
            entry.0.push(format!("  {name}: {}", symbols.join(" ")));
        }
    }
    folders
        .into_iter()
        .map(|(folder, (lines, others))| {
            let mut head = format!("{}/", if folder.is_empty() { "." } else { &folder });
            if others > 0 {
                head.push_str(&format!(
                    " ({others} file{} without declarations)",
                    if others == 1 { "" } else { "s" }
                ));
            }
            (
                folder,
                std::iter::once(head)
                    .chain(lines)
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        })
        .collect()
}

/// Line `number` of a file's source data, numbered as in the other results.
fn line_at(data: &Value, number: u64) -> Option<String> {
    let text = data["after"]
        .as_str()?
        .lines()
        .nth(number.checked_sub(1)? as usize)?;
    Some(format!("{number:>5}  {}", text.trim()))
}
/// The resolved calls into `path` · `name`: each caller's file, declaration and call lines.
async fn calls_into(
    app: &App,
    base: &Value,
    head: &Value,
    path: &str,
    name: &str,
) -> Result<Vec<(String, String, Vec<u64>)>> {
    let data = app
        .engine
        .call("relationships", json!([base, head, path]))
        .await
        .map_err(anyhow::Error::msg)?;
    let mut out: Vec<(String, String, Vec<u64>)> = vec![];
    for edge in data["relationships"].as_array().into_iter().flatten() {
        let into_target = edge["targets"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|t| t["path"] == path && t["symbol"] == name);
        if edge["kind"] != "calls" || !into_target {
            continue;
        }
        let (file, symbol) = (
            edge["source"]["path"].as_str().unwrap_or("").to_string(),
            edge["source"]["symbol"].as_str().unwrap_or("").to_string(),
        );
        let sites: Vec<u64> = edge["sites"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_u64)
            .collect();
        match out.iter_mut().find(|(f, s, _)| *f == file && *s == symbol) {
            Some(entry) => entry.2.extend(sites),
            None => out.push((file, symbol, sites)),
        }
    }
    Ok(out)
}
/// The numbered lines of declaration `symbol` in a file's source data.
fn declaration_lines(data: &Value, symbol: &str) -> Vec<String> {
    let Some(found) = data["symbols"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["name"] == symbol))
    else {
        return vec![];
    };
    let (start, end) = (
        found["start"].as_u64().unwrap_or(1) as usize,
        found["end"].as_u64().unwrap_or(0) as usize,
    );
    data["after"]
        .as_str()
        .unwrap_or("")
        .lines()
        .enumerate()
        .skip(start.saturating_sub(1))
        .take((end + 1).saturating_sub(start))
        .map(|(i, l)| format!("{:>5}  {l}", i + 1))
        .collect()
}

/// `highlight`: one folder, file or declaration of the map, with the details asked for.
async fn highlight(app: &App, args: &Value, base: &Value, head: &Value) -> Result<Value> {
    let path = argument(args, "path")?.trim_end_matches('/').to_string();
    let wanted: Vec<&str> = args["detail"]
        .as_array()
        .map(|d| d.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let want = |what: &str| wanted.is_empty() || wanted.contains(&what);
    let engine = |method: &'static str, call_args: Value| async move {
        app.engine
            .call(method, call_args)
            .await
            .map_err(anyhow::Error::msg)
    };
    let full = engine("compare", json!([base, head])).await?;
    let files = full["files"].as_array().cloned().unwrap_or_default();
    let is_file = files.iter().any(|f| f["path"] == path.as_str());
    if !is_file {
        // A folder: its whole tree, and its description.
        let prefix = if path.is_empty() || path == "." {
            String::new()
        } else {
            format!("{path}/")
        };
        // A large folder folds its biggest subfolders; highlight one of them to go deeper.
        let (tree, folded) =
            crate::graph_brief::fold(&files, &prefix, &[], crate::graph_brief::BUDGET);
        ensure!(
            !tree.is_empty(),
            "No folder or file {path} at this revision"
        );
        let mut out = json!({"folder": path, "tree": tree});
        if folded > 0 {
            out["folded"] = json!(folded);
        }
        if want("description") {
            let directories = engine("directories", json!([base, head]))
                .await
                .unwrap_or_default();
            out["description"] = directories["after"][path.as_str()]["description"].clone();
        }
        return Ok(out);
    }
    let data = engine("source", json!([base, head, path])).await?;
    let details = &data["details"]["after"];
    let Some(name) = args["name"].as_str().filter(|n| !n.is_empty()) else {
        // A file: each declaration's signature and first documentation line.
        let declarations: Vec<Value> = data["symbols"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| {
                let info = details["symbols"]
                    .as_array()
                    .and_then(|d| d.iter().find(|d| d["name"] == s["name"]));
                let mut row = json!({"name": s["name"], "kind": s["kind"], "line": s["start"]});
                if let Some(info) = info {
                    row["signature"] = info["signature"].clone();
                    if want("description") {
                        row["description"] = json!(
                            info["description"]
                                .as_str()
                                .unwrap_or("")
                                .lines()
                                .next()
                                .unwrap_or("")
                        );
                    }
                }
                row
            })
            .collect();
        let mut out =
            json!({"file": path, "analysis": data["analysis"], "declarations": declarations});
        if want("description") {
            out["description"] = details["description"].clone();
        }
        if want("callers") {
            out["usedBy"] =
                relationship_summary(app, base, head, &path, None).await?["incoming"].clone();
        }
        return Ok(out);
    };
    // A declaration: its code, its callers with their calling lines, and what it calls.
    let name = &declared_name(&data, &path, name)?;
    let name = name.as_str();
    let lines = declaration_lines(&data, name);
    ensure!(
        !lines.is_empty(),
        "No declaration {name} in {path}; use the name as the map shows it"
    );
    let mut out = json!({"file": path, "name": name});
    if let Some(info) = details["symbols"]
        .as_array()
        .and_then(|d| d.iter().find(|d| d["name"] == name))
    {
        out["signature"] = info["signature"].clone();
        if want("description") {
            out["description"] = info["description"].clone();
        }
    }
    if want("code") {
        out["code"] = json!(bounded(&lines.join("\n"), 12000));
    }
    if want("callers") || want("calls") {
        let summary = relationship_summary(app, base, head, &path, Some(name)).await?;
        if want("calls") {
            out["calls"] = json!(
                summary["outgoing"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|l| !l.as_str().unwrap_or("").contains("→ unresolved"))
                    .collect::<Vec<_>>()
            );
        }
        if want("callers") {
            let mut callers = vec![];
            for (file, symbol, sites) in calls_into(app, base, head, &path, name)
                .await?
                .into_iter()
                .take(20)
            {
                let source = engine("source", json!([base, head, file]))
                    .await
                    .unwrap_or_default();
                let lines: Vec<String> = sites
                    .iter()
                    .take(3)
                    .filter_map(|n| line_at(&source, *n))
                    .collect();
                callers.push(json!({"file": file, "name": symbol, "lines": lines}));
            }
            out["callers"] = json!(callers);
        }
    }
    Ok(out)
}

/// `route`: chains of calls into a declaration (up to entry points), or from one declaration
/// to another, walked on the server over the whole graph at the commit.
async fn route(app: &App, args: &Value, base: &Value, head: &Value) -> Result<Value> {
    // "path#name", with the name as the graph knows it ("choice" or "Workflow::choice" finds
    // "Workflow.choice" when it is the only match in that file).
    let key = async |node: &Value| -> Result<String> {
        let path = node["path"].as_str().context("Missing path")?;
        let name = node["name"].as_str().context("Missing name")?;
        let data = app
            .engine
            .call("source", json!([base, head, path]))
            .await
            .map_err(anyhow::Error::msg)?;
        Ok(format!("{path}#{}", declared_name(&data, path, name)?))
    };
    let to = key(&args["to"]).await?;
    let depth = args["depth"].as_u64().unwrap_or(6).clamp(1, 10) as usize;
    let all = app
        .engine
        .call("relationships", json!([base, head, "", ""]))
        .await
        .map_err(anyhow::Error::msg)?;
    // Call edges between declarations, with the calling lines. Callers in tests stay out
    // unless they are asked for.
    let tests = args["tests"] == true;
    let mut test_into: std::collections::HashMap<String, std::collections::BTreeSet<String>> =
        Default::default();
    let mut into: std::collections::HashMap<String, Vec<(String, String)>> = Default::default();
    let mut from_map: std::collections::HashMap<String, Vec<(String, String)>> = Default::default();
    for edge in all["relationships"].as_array().into_iter().flatten() {
        if edge["kind"] != "calls" || edge["resolution"] == "unresolved" {
            continue;
        }
        let source = format!(
            "{}#{}",
            edge["source"]["path"].as_str().unwrap_or(""),
            edge["source"]["symbol"].as_str().unwrap_or("")
        );
        let in_test = !tests && is_test(edge["source"]["path"].as_str().unwrap_or(""));
        let lines = edge["sites"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_u64)
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let lines = lines.as_str();
        let note = if edge["resolution"] == "ambiguous" {
            format!("line {lines}, ambiguous")
        } else {
            format!("line {lines}")
        };
        for target in edge["targets"].as_array().into_iter().flatten() {
            let target = format!(
                "{}#{}",
                target["path"].as_str().unwrap_or(""),
                target["symbol"].as_str().unwrap_or("")
            );
            if in_test {
                test_into.entry(target).or_default().insert(source.clone());
                continue;
            }
            into.entry(target.clone())
                .or_default()
                .push((source.clone(), note.clone()));
            from_map
                .entry(source.clone())
                .or_default()
                .push((target, note.clone()));
        }
    }
    const PATHS: usize = 20;
    let mut chains: Vec<Vec<(String, String)>> = vec![];
    if args["from"].is_object() {
        // Depth-first from `from` to `to` over outgoing calls.
        let start = key(&args["from"]).await?;
        let mut stack = vec![(start.clone(), vec![(start, String::new())])];
        while let Some((node, path)) = stack.pop() {
            if chains.len() >= PATHS {
                break;
            }
            if node == to {
                chains.push(path);
                continue;
            }
            if path.len() > depth {
                continue;
            }
            for (next, note) in from_map.get(&node).into_iter().flatten() {
                if !path.iter().any(|(n, _)| n == next) {
                    let mut longer = path.clone();
                    longer.push((next.clone(), note.clone()));
                    stack.push((next.clone(), longer));
                }
            }
        }
    } else {
        // Up from `to` through callers, to entry points or the depth limit.
        let mut stack = vec![vec![(to.clone(), String::new())]];
        while let Some(path) = stack.pop() {
            if chains.len() >= PATHS {
                break;
            }
            let (node, _) = path.last().unwrap();
            let callers: Vec<&(String, String)> = into
                .get(node)
                .into_iter()
                .flatten()
                .filter(|(caller, _)| !path.iter().any(|(n, _)| n == caller))
                .collect();
            if callers.is_empty() || path.len() > depth {
                let mut chain = path.clone();
                chain.reverse();
                if chain.len() > 1 {
                    chains.push(chain);
                }
                continue;
            }
            for (caller, note) in callers {
                let mut longer = path.clone();
                // The note belongs to the call from the caller into the current node.
                longer.last_mut().unwrap().1 = note.clone();
                longer.push((caller.clone(), String::new()));
                stack.push(longer);
            }
        }
    }
    // Text for each chain: "file · name (line N) → …", with calling lines when asked.
    let with_lines = args["lines"] == true;
    let mut text = vec![];
    for chain in &chains {
        let mut steps = vec![];
        for (i, (node, note)) in chain.iter().enumerate() {
            let (file, name) = node.split_once('#').unwrap_or((node, ""));
            let mut step = format!("{file} · {name}");
            // In a reaching chain the note sits on the callee; in a forward path, on the step.
            let call = if args["from"].is_object() {
                note.clone()
            } else {
                chain.get(i + 1).map(|(_, n)| n.clone()).unwrap_or_default()
            };
            if !call.is_empty() && i + 1 < chain.len() {
                step.push_str(&format!(" ({call})"));
            }
            // The calling line itself, from the call site's line number.
            let first_site = call
                .strip_prefix("line ")
                .and_then(|rest| rest.split([',', ' ']).next())
                .and_then(|n| n.parse::<u64>().ok());
            if with_lines
                && i + 1 < chain.len()
                && let Some(number) = first_site
            {
                let source = app
                    .engine
                    .call("source", json!([base, head, file]))
                    .await
                    .unwrap_or_default();
                // The conditions that hold the call (`if path == "/api/ask" {`), then the call.
                for guard in guards(&source, name, number) {
                    step.push_str(&format!("\n      {guard}"));
                }
                if let Some(line) = line_at(&source, number) {
                    step.push_str(&format!("\n      {}", line.trim()));
                }
            }
            steps.push(step);
        }
        text.push(steps.join("\n  → "));
    }
    let mut out = json!({"routes": text, "count": chains.len(), "more": chains.len() >= PATHS});
    // Test callers of the declarations on these chains, which the chains leave out.
    let on_chains: std::collections::HashSet<&String> =
        chains.iter().flatten().map(|(n, _)| n).collect();
    let skipped: std::collections::BTreeSet<&String> = on_chains
        .iter()
        .filter_map(|n| test_into.get(*n))
        .flatten()
        .collect();
    if !args["from"].is_object() {
        // Every entry point that reaches `to` (not only those in the chains above): a
        // declaration with no callers, or one at the depth limit.
        let mut level = vec![to.clone()];
        let mut seen: std::collections::HashSet<String> = [to.clone()].into();
        let mut entries: Vec<(String, bool)> = vec![];
        for step in 0..=depth {
            let mut next = vec![];
            for node in level {
                let callers = into.get(&node).map(Vec::as_slice).unwrap_or_default();
                if node != to && (callers.is_empty() || step == depth) {
                    entries.push((node.clone(), !callers.is_empty()));
                }
                for (caller, _) in callers {
                    if seen.insert(caller.clone()) {
                        next.push(caller.clone());
                    }
                }
            }
            level = next;
        }
        entries.sort();
        const ENTRIES: usize = 80;
        let mut sources: std::collections::HashMap<String, Value> = Default::default();
        let mut listed = vec![];
        for (node, deeper) in entries.iter().take(ENTRIES) {
            let (file, name) = node.split_once('#').unwrap_or((node, ""));
            if !sources.contains_key(file) {
                let data = app
                    .engine
                    .call("source", json!([base, head, file]))
                    .await
                    .unwrap_or_default();
                sources.insert(file.to_string(), data);
            }
            let marks = decorators(&sources[file], name);
            let mut line = format!("{file} · {name}");
            if !marks.is_empty() {
                line.push_str(&format!("  [{}]", marks.join(" ")));
            }
            if *deeper {
                line.push_str("  (depth limit: it has callers)");
            }
            listed.push(line);
        }
        out["entries"] = json!(listed);
        if entries.len() > ENTRIES {
            out["moreEntries"] = json!(entries.len() - ENTRIES);
        }
    }
    if !skipped.is_empty() {
        out["testCallersLeftOut"] = json!(skipped.len());
    }
    Ok(out)
}

/// The declaration that `name` means in a source response: the exact name, or the only
/// declaration whose name ends in it (`choice` or `Workflow::choice` for `Workflow.choice`).
/// No match or several matches is an error that lists the names to choose from.
fn declared_name(data: &Value, path: &str, name: &str) -> Result<String> {
    let names: Vec<&str> = data["symbols"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["name"].as_str())
        .collect();
    let dotted = name.replace("::", ".");
    if let Some(found) = names.iter().find(|n| **n == name || **n == dotted) {
        return Ok(found.to_string());
    }
    let short = dotted.rsplit('.').next().unwrap_or(&dotted);
    let mut matches: Vec<&str> = names
        .iter()
        .copied()
        .filter(|n| n.ends_with(&format!(".{short}")))
        .collect();
    if matches.len() > 1 && dotted.contains('.') {
        // "Workflow.choice" narrows "Workflow as Agent.choice" and "Other.choice" by its owner.
        let owner = dotted.rsplit_once('.').map(|(o, _)| o).unwrap_or("");
        matches.retain(|n| {
            n.starts_with(&format!("{owner}.")) || n.starts_with(&format!("{owner} as "))
        });
    }
    match matches.as_slice() {
        [one] => Ok(one.to_string()),
        [] => anyhow::bail!(
            "No declaration {name} in {path}. Its declarations: {}",
            names
                .iter()
                .take(60)
                .copied()
                .collect::<Vec<_>>()
                .join(", ")
        ),
        several => anyhow::bail!(
            "{name} matches several declarations in {path}: {}. Use one of these names",
            several.join(", ")
        ),
    }
}

/// The conditions around line `number` inside declaration `name`, outermost first: each
/// enclosing line with less indentation that starts with `if`, `else`, `elif`, `match`,
/// `switch`, `case` or `when`, or that is a match arm (`… =>`). At most four, numbered.
fn guards(data: &Value, name: &str, number: u64) -> Vec<String> {
    let Some(found) = data["symbols"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["name"] == name))
    else {
        return vec![];
    };
    let start = found["start"].as_u64().unwrap_or(1) as usize;
    let lines: Vec<&str> = data["after"].as_str().unwrap_or("").lines().collect();
    let number = number as usize;
    let indent = |l: &str| l.len() - l.trim_start().len();
    let Some(mut level) = lines.get(number.wrapping_sub(1)).map(|l| indent(l)) else {
        return vec![];
    };
    let mut out = vec![];
    for index in (start..number.saturating_sub(1)).rev() {
        let line = lines[index];
        let text = line.trim();
        if text.is_empty() || indent(line) >= level {
            continue;
        }
        level = indent(line);
        let keyword = [
            "if ", "if(", "} else", "else", "elif ", "match ", "switch", "case ", "when ",
        ]
        .iter()
        .any(|k| text.starts_with(k));
        if keyword || text.contains("=>") {
            out.push(format!("{:>5}  {text}", index + 1));
            if out.len() == 4 {
                break;
            }
        }
        if level == 0 {
            break;
        }
    }
    out.reverse();
    out
}

/// True for a file of tests: a `test`, `tests`, `__tests__` or `spec` folder, or a name such
/// as `test_x.py`, `x_test.go`, `x.test.ts`, `x.spec.js` or `conftest.py`.
fn is_test(path: &str) -> bool {
    let mut parts = path.split('/').rev();
    let file = parts.next().unwrap_or("");
    let stem = file.split('.').next().unwrap_or("");
    parts.any(|p| matches!(p, "test" | "tests" | "__tests__" | "spec"))
        || stem.starts_with("test_")
        || stem.ends_with("_test")
        || file.contains(".test.")
        || file.contains(".spec.")
        || file == "conftest.py"
}

/// The decorator or attribute lines at the start of `name` in a source response, such as
/// `@router.post("/{run_id}/continue")` or `#[tokio::main]`, joined when one spans lines.
fn decorators(data: &Value, name: &str) -> Vec<String> {
    let Some(found) = data["symbols"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["name"] == name))
    else {
        return vec![];
    };
    let start = found["start"].as_u64().unwrap_or(1) as usize;
    let mut out: Vec<String> = vec![];
    for line in data["after"]
        .as_str()
        .unwrap_or("")
        .lines()
        .skip(start.saturating_sub(1))
        .take(12)
    {
        let text = line.trim();
        if text.starts_with('@') || text.starts_with("#[") {
            out.push(text.to_string());
        } else if let Some(last) = out.last_mut()
            && last.matches(['(', '[']).count() > last.matches([')', ']']).count()
        {
            last.push(' ');
            last.push_str(text);
        } else {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numbered_lines_start_where_asked() {
        assert_eq!(numbered(&["a", "b"], 14), "   14  a\n   15  b");
    }
    #[test]
    fn descriptions_name_the_target_not_the_whole_path() {
        assert_eq!(
            describe("read_declaration", &json!({"path":"a/b/c.py","name":"run"})),
            "Read run in c.py"
        );
        assert_eq!(
            describe("find_declarations", &json!({"query":"flatten"})),
            "Searched for “flatten”"
        );
    }
    #[test]
    fn test_files_are_known_by_folder_and_name() {
        for path in [
            "api/tests/test_run.py",
            "test_x.py",
            "src/__tests__/a.ts",
            "web/a.test.ts",
            "web/a.spec.js",
            "go/a_test.go",
            "conftest.py",
        ] {
            assert!(is_test(path), "{path}");
        }
        for path in [
            "api/app/routers/evaluation.py",
            "backend/testing.rs",
            "latest.py",
            "contest/a.py",
        ] {
            assert!(!is_test(path), "{path}");
        }
    }
    #[test]
    fn decorators_are_read_from_the_start_of_a_declaration() {
        let data = json!({
            "symbols": [{"name": "continue_after_pause", "start": 2}, {"name": "plain", "start": 7}],
            "after": "x = 1\n@router.post(\n    \"/{run_id}/continue\", status_code=202)\n@login_required\ndef continue_after_pause():\n    pass\ndef plain():\n    pass\n"
        });
        assert_eq!(
            decorators(&data, "continue_after_pause"),
            [
                "@router.post( \"/{run_id}/continue\", status_code=202)",
                "@login_required"
            ]
        );
        assert!(decorators(&data, "plain").is_empty());
    }
    #[test]
    fn a_short_name_finds_its_only_declaration() {
        let data = json!({"symbols": [{"name": "Workflow.choice"}, {"name": "run"}, {"name": "A.go"}, {"name": "B as T.go"}]});
        assert_eq!(
            declared_name(&data, "a.rs", "choice").unwrap(),
            "Workflow.choice"
        );
        assert_eq!(
            declared_name(&data, "a.rs", "Workflow::choice").unwrap(),
            "Workflow.choice"
        );
        assert_eq!(declared_name(&data, "a.rs", "run").unwrap(), "run");
        assert_eq!(declared_name(&data, "a.rs", "B::go").unwrap(), "B as T.go");
        assert!(
            declared_name(&data, "a.rs", "go")
                .unwrap_err()
                .to_string()
                .contains("A.go, B as T.go")
        );
        assert!(
            declared_name(&data, "a.rs", "missing")
                .unwrap_err()
                .to_string()
                .contains("Workflow.choice")
        );
    }
    #[test]
    fn guards_are_the_conditions_around_a_call() {
        let data = json!({
            "symbols": [{"name": "handle", "start": 1}],
            "after": "async fn handle() {\n    let x = 1;\n    if path == \"/api/ask\" {\n        log();\n        if body[\"stream\"] == true {\n            tokio::spawn(async move {\n                answer_stream();\n            });\n        }\n        return answer();\n    }\n}\n"
        });
        assert_eq!(
            guards(&data, "handle", 7),
            [
                "    3  if path == \"/api/ask\" {",
                "    5  if body[\"stream\"] == true {"
            ]
        );
        assert_eq!(
            guards(&data, "handle", 10),
            ["    3  if path == \"/api/ask\" {"]
        );
        assert!(guards(&data, "handle", 2).is_empty());
    }
    #[test]
    fn bounded_output_says_what_was_cut() {
        assert!(bounded(&"x".repeat(20), 10).ends_with("10 more bytes not shown"));
    }
}
