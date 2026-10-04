//! Read-only repository lookups for Ask, served as a Streamable HTTP MCP endpoint on the Peekumi
//! listener at `/mcp/ask`. A grant exists only while one Ask answer runs: it pins the compared
//! revisions, carries a random bearer key and allows a bounded number of calls. Every tool reads
//! committed code through the repository worker; none writes state, runs code or reaches another
//! repository. Relationships are static declarations, never runtime behaviour.
use crate::App;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};

/// Tool calls one answer may make before it must reply with what it has.
pub const MAX_CALLS: usize = 30;
/// Tool names as Claude Code sees them through the `peekumi` server.
pub const TOOLS: [&str; 5] = [
    "mcp__peekumi__find_declarations",
    "mcp__peekumi__search_code",
    "mcp__peekumi__read_declaration",
    "mcp__peekumi__read_file",
    "mcp__peekumi__relationships",
];

/// One Ask answer's lookup permission: the key, the revisions it may read and the calls made.
pub struct Grant {
    pub key: String,
    base: Value,
    head: Value,
    pub calls: Vec<String>,
}
impl Grant {
    pub fn new(key: String, base: Value, head: Value) -> Self {
        Self {
            key,
            base,
            head,
            calls: vec![],
        }
    }
}

fn tool_list() -> Value {
    let side = json!({"type":"string","enum":["after","before"],"description":"after = the newer compared revision (default), before = the older one"});
    json!([
        {"name":"find_declarations","description":"Search declaration names (functions, methods, classes and types) in this repository at the compared revisions. Case-insensitive substring match; optionally limited to a path prefix. Returns path, name, kind, change status and line.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"path":{"type":"string","description":"Optional file or folder prefix"}},"required":["query"],"additionalProperties":false}},
        {"name":"search_code","description":"Find lines containing exact text (case-sensitive) in the repository's readable files at one compared revision, optionally under a path prefix. Each match names the declaration it sits in. Use it to find where something is used, including references static analysis missed (inside macros, strings or dynamic code).","inputSchema":{"type":"object","properties":{"text":{"type":"string"},"path":{"type":"string","description":"Optional file or folder prefix"},"side":side},"required":["text"],"additionalProperties":false}},
        {"name":"read_declaration","description":"Read one declaration's source with line numbers, from a file at the compared revisions.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"name":{"type":"string"},"side":side},"required":["path","name"],"additionalProperties":false}},
        {"name":"read_file","description":"Read up to 300 numbered lines of a file at the compared revisions.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1},"side":side},"required":["path"],"additionalProperties":false}},
        {"name":"relationships","description":"List static relationships for a file or one of its declarations: what it calls, imports, implements or inherits (outgoing) and what refers to it (incoming), with resolution and source lines. Static declarations, not runtime behaviour; unresolved and ambiguous targets stay uncertain.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"name":{"type":"string","description":"Optional declaration name in that file"}},"required":["path"],"additionalProperties":false}}
    ])
}

/// Handles one JSON-RPC message from the Ask client. Returns `None` for notifications,
/// which the HTTP layer acknowledges with 202 Accepted.
pub async fn handle(app: &App, request: Value) -> Option<Value> {
    let id = request.get("id")?.clone();
    let method = request["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": request["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "peekumi-ask", "version": env!("CARGO_PKG_VERSION")}
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tool_list()})),
        "tools/call" => Ok(call(app, &request["params"]).await),
        _ => Err(method),
    };
    Some(match result {
        Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
        Err(method) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":format!("Unknown method {method}")}})
        }
    })
}

fn tool_error(message: &str) -> Value {
    json!({"isError":true,"content":[{"type":"text","text":message}]})
}

/// Records the call against the grant, then performs it without holding the grant lock.
async fn call(app: &App, params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or("");
    let args = &params["arguments"];
    let revisions = {
        let mut grant = app.ask_grant.lock().unwrap_or_else(|e| e.into_inner());
        match grant.as_mut() {
            None => return tool_error("This lookup grant has ended"),
            Some(g) if g.calls.len() >= MAX_CALLS => {
                return tool_error("Lookup limit reached; answer with the context you have");
            }
            Some(g) => {
                g.calls.push(describe(name, args));
                (g.base.clone(), g.head.clone())
            }
        }
    };
    match run(app, name, args, &revisions.0, &revisions.1).await {
        Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
        Err(e) => tool_error(&e.to_string()),
    }
}

/// A short, human description of a call, shown under the answer.
fn describe(name: &str, args: &Value) -> String {
    let s = |key: &str| args[key].as_str().unwrap_or("").to_string();
    let file = |key: &str| s(key).rsplit('/').next().unwrap_or("").to_string();
    match name {
        "find_declarations" => format!("Searched for “{}”", s("query")),
        "search_code" => format!("Searched the code for “{}”", s("text")),
        "read_declaration" => format!("Read {} in {}", s("name"), file("path")),
        "read_file" => format!("Read {}", file("path")),
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
                format!("{path} has no readable text on the {side} side (binary, unsupported, oversized or absent)")
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
    fn bounded_output_says_what_was_cut() {
        assert!(bounded(&"x".repeat(20), 10).ends_with("10 more bytes not shown"));
    }
}
