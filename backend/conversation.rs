//! Conversations: what the owner and an agent said and did in a run, as one neutral list of
//! items, whatever the provider.
//!
//! A run's log (`runs/<id>/output.log`) holds the provider's own events (Claude Code's
//! stream-json, Codex's JSON events, or Peekumi's own task agent) and Peekumi's events
//! (`peekumi.owner`, `peekumi.turn`, `peekumi.rules`, `peekumi.error`). Each provider has a
//! [`Conversation`] adapter that turns its events into items; Peekumi's events are read for
//! every provider. The app renders only items, so it never needs to know which agent runs.
//!
//! An item is one of:
//! - `{kind: "owner", text, anchors, turn}`: the owner's message;
//! - `{kind: "text", text}`: the agent's words;
//! - `{kind: "step", activity?, label, code?, note?, output?, failed?, done?, files, changed,
//!   targets}`: one tool call, where `activity` is reading, searching, editing, creating or
//!   running, and `targets` are the places it looks at, `{path, symbol?}`;
//! - `{kind: "end", status, turn}`: the end of a turn (completed, cancelled or failed);
//! - `{kind: "rules", check, turn}`: Peekumi's rule check after a turn;
//! - `{kind: "error", text}` and `{kind: "cost", cost}`.
//!
//! A [`Translator`] reads a log incrementally and numbers each change: an item that is added
//! or changed (a step gets its output) gets the next number. The app asks for the changes
//! after the last number it has (see [`Translator::since`]), so it never downloads the whole
//! log again. A new translator (for example after a restart) has a new `epoch`; the app then
//! reads the whole list again.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// What a provider's conversation can do. The app shows its controls by these, never by the
/// provider's name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// The agent's words arrive while it writes them, not only at the end of a turn.
    pub stream_text: bool,
    /// A message sent while a turn runs waits and goes with the next turn.
    pub queue_while_busy: bool,
    /// A message sent while a turn runs reaches the agent in that turn.
    pub steer: bool,
    /// The owner can stop a turn.
    pub interrupt: bool,
    /// The agent asks the owner before a command outside its rules.
    pub approvals: bool,
    /// The owner can send images.
    pub images: bool,
    /// A later turn continues the same conversation.
    pub resume: bool,
    /// The provider reports what a turn cost.
    pub cost: bool,
}

/// The changes that an adapter makes to the item list.
#[derive(Default)]
pub struct Items {
    list: Vec<Value>,
    /// For each item, the number of its last change.
    changed: Vec<u64>,
    /// The number of the last change.
    seq: u64,
    /// Steps that wait for their result, by the provider's tool call ID.
    steps: HashMap<String, usize>,
}

impl Items {
    /// Adds an item; returns its index.
    pub fn push(&mut self, item: Value) -> usize {
        self.seq += 1;
        self.list.push(item);
        self.changed.push(self.seq);
        self.list.len() - 1
    }
    /// Changes the item at `index` in place.
    pub fn update(&mut self, index: usize, change: impl FnOnce(&mut Value)) {
        if let Some(item) = self.list.get_mut(index) {
            change(item);
            self.seq += 1;
            self.changed[index] = self.seq;
        }
    }
}

/// A provider's adapter for its conversation: it turns one event of the provider into items.
/// Peekumi's own events are read before it (see [`Translator`]).
pub trait Conversation: Send {
    /// Reads one event of the run's log.
    fn read(&mut self, event: &Value, items: &mut Items);
}

/// The adapter for a run's agent. An unknown agent reads every known format.
pub fn adapter(agent: &str) -> Box<dyn Conversation> {
    match agent {
        "claude" => Box::new(ClaudeStream),
        "codex" => Box::new(CodexEvents),
        "openrouter" => Box::new(OwnAgent),
        _ => Box::new(Every),
    }
}

/// Reads a run's log incrementally into items, and numbers each change.
pub struct Translator {
    epoch: String,
    offset: u64,
    /// The start of a line that has no end yet.
    rest: Vec<u8>,
    items: Items,
    agent: String,
    conversation: Box<dyn Conversation>,
}

impl Translator {
    /// A translator for a run of `agent`, at the start of its log.
    pub fn new(agent: &str) -> Self {
        Self {
            epoch: crate::random_token()[..12].to_string(),
            offset: 0,
            rest: vec![],
            items: Items::default(),
            agent: agent.to_string(),
            conversation: adapter(agent),
        }
    }
    /// Reads what the log at `path` gained since the last read. A log that got shorter (it was
    /// replaced) starts a new translator with a new epoch.
    pub fn read_from(&mut self, path: &Path) -> anyhow::Result<()> {
        let Ok(mut file) = std::fs::File::open(path) else {
            return Ok(());
        };
        let length = file.metadata()?.len();
        if length < self.offset {
            *self = Self::new(&self.agent.clone());
        }
        if length == self.offset {
            return Ok(());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut added = vec![];
        file.take(length - self.offset).read_to_end(&mut added)?;
        self.offset = length;
        self.rest.extend_from_slice(&added);
        // Only whole lines: the end of a line that is still being written waits.
        if let Some(end) = self.rest.iter().rposition(|b| *b == b'\n') {
            let lines: Vec<u8> = self.rest.drain(..=end).collect();
            for line in lines.split(|b| *b == b'\n') {
                self.line(line);
            }
        }
        Ok(())
    }
    /// Reads one line of the log; a line that is not JSON is left out.
    fn line(&mut self, line: &[u8]) {
        let Ok(event) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        if !peekumi_event(&event, &mut self.items) {
            self.conversation.read(&event, &mut self.items);
        }
    }
    /// The changes after `after` for a reader at `epoch`: `{epoch, seq, total, patches:
    /// [{index, item}]}`. A reader with another epoch, or with nothing yet, gets the whole
    /// list as `items`.
    pub fn since(&self, after: u64, epoch: Option<&str>) -> Value {
        let base =
            json!({"epoch": self.epoch, "seq": self.items.seq, "total": self.items.list.len()});
        let mut out = base;
        if after == 0 || epoch != Some(self.epoch.as_str()) || after > self.items.seq {
            out["items"] = json!(self.items.list);
            return out;
        }
        out["patches"] = json!(
            self.items
                .changed
                .iter()
                .enumerate()
                .filter(|(_, n)| **n > after)
                .map(|(index, _)| json!({"index": index, "item": self.items.list[index]}))
                .collect::<Vec<_>>()
        );
        out
    }
    /// All items, in order.
    #[cfg(test)]
    pub fn items(&self) -> &[Value] {
        &self.items.list
    }
}

/// Reads one of Peekumi's own events; false for any other event.
fn peekumi_event(event: &Value, items: &mut Items) -> bool {
    let kind = event["type"].as_str().unwrap_or("");
    match kind {
        "peekumi.owner" => {
            for m in event["messages"].as_array().into_iter().flatten() {
                let mut item = json!({"kind": "owner"});
                set(&mut item, "text", m["text"].clone());
                item["anchors"] = if m["anchors"].is_array() {
                    m["anchors"].clone()
                } else {
                    json!([])
                };
                set(&mut item, "turn", event["turn"].clone());
                items.push(item);
            }
            true
        }
        "peekumi.turn" => {
            let mut item = json!({"kind": "end"});
            set(&mut item, "status", event["status"].clone());
            set(&mut item, "turn", event["turn"].clone());
            items.push(item);
            true
        }
        "peekumi.rules" => {
            let mut item = json!({"kind": "rules"});
            item["check"] = if event["check"].is_object() {
                event["check"].clone()
            } else {
                json!({})
            };
            set(&mut item, "turn", event["turn"].clone());
            items.push(item);
            true
        }
        "peekumi.error" => {
            let mut item = json!({"kind": "error"});
            set(&mut item, "text", event["message"].clone());
            items.push(item);
            true
        }
        _ => false,
    }
}

/// Claude Code's stream-json: text and tool calls in `assistant` events, their results in
/// `user` events, and the cost in the `result` event.
struct ClaudeStream;
impl Conversation for ClaudeStream {
    fn read(&mut self, event: &Value, items: &mut Items) {
        error_event(event, items);
        claude(event, items);
    }
}

/// Codex's JSON events: each finished item (`item.completed`), and errors.
struct CodexEvents;
impl Conversation for CodexEvents {
    fn read(&mut self, event: &Value, items: &mut Items) {
        if error_event(event, items) {
            return;
        }
        if event["type"] == "item.completed" {
            finished_item(&event["item"], items);
        }
    }
}

/// Peekumi's own task agent (OpenRouter): one finished item on each line, with no type.
struct OwnAgent;
impl Conversation for OwnAgent {
    fn read(&mut self, event: &Value, items: &mut Items) {
        if error_event(event, items) {
            return;
        }
        if event["type"].is_null() {
            finished_item(&event["item"], items);
        }
    }
}

/// Every known format, for a run whose agent has no adapter.
struct Every;
impl Conversation for Every {
    fn read(&mut self, event: &Value, items: &mut Items) {
        if error_event(event, items) {
            return;
        }
        claude(event, items);
        if event["type"] == "item.completed" || event["type"].is_null() {
            finished_item(&event["item"], items);
        }
    }
}

/// A provider's error event, `{type: "error", message}`. True when it was one.
fn error_event(event: &Value, items: &mut Items) -> bool {
    if event["type"] == "error" && truthy(&event["message"]) {
        items.push(json!({"kind": "error", "text": event["message"]}));
        return true;
    }
    false
}

/// Claude Code's events.
fn claude(event: &Value, items: &mut Items) {
    match event["type"].as_str() {
        Some("assistant") => {
            for part in event["message"]["content"].as_array().into_iter().flatten() {
                if part["type"] == "text"
                    && part["text"].as_str().is_some_and(|t| !t.trim().is_empty())
                {
                    items.push(json!({"kind": "text", "text": part["text"]}));
                } else if part["type"] == "tool_use"
                    && let Some(step) = claude_step(part)
                {
                    let index = items.push(step);
                    if let Some(id) = part["id"].as_str() {
                        items.steps.insert(id.to_string(), index);
                    }
                }
            }
        }
        Some("user") => {
            for part in event["message"]["content"].as_array().into_iter().flatten() {
                if part["type"] != "tool_result" {
                    continue;
                }
                let Some(index) = part["tool_use_id"]
                    .as_str()
                    .and_then(|id| items.steps.get(id).copied())
                else {
                    continue;
                };
                let output = result_text(&part["content"]);
                let failed = part["is_error"] == true;
                items.update(index, |step| {
                    // A Write over a file that exists edits it (Claude Code says "updated").
                    if step["activity"] == "creating" && says_updated(&output) {
                        step["activity"] = json!("editing");
                    }
                    step["output"] = json!(output);
                    step["failed"] = json!(failed);
                    step["done"] = json!(true);
                });
            }
        }
        Some("result") => {
            if event["is_error"] == true {
                let text = if truthy(&event["result"]) {
                    event["result"].clone()
                } else {
                    json!("The agent stopped with an error.")
                };
                items.push(json!({"kind": "error", "text": text}));
            }
            let cost = event["total_cost_usd"]
                .as_f64()
                .filter(|c| *c != 0.0)
                .map_or(json!(0), |c| json!(c));
            items.push(json!({"kind": "cost", "cost": cost}));
        }
        _ => {}
    }
}

/// One Claude Code tool call as a step: a short label, the command or pattern, and the files it
/// read or changed. Peekumi's own bookkeeping calls are left out (None).
fn claude_step(part: &Value) -> Option<Value> {
    let input = &part["input"];
    let mut step = json!({"kind": "step", "files": [], "changed": [], "targets": []});
    set(&mut step, "id", part["id"].clone());
    let file = relative(
        input["file_path"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or(input["notebook_path"].as_str())
            .unwrap_or(""),
    );
    let at = |paths: Vec<String>| {
        json!(
            paths
                .into_iter()
                .filter(|p| !p.is_empty())
                .map(|path| json!({"path": path}))
                .collect::<Vec<_>>()
        )
    };
    let name = part["name"].as_str().unwrap_or("");
    let mut with = |fields: Value| {
        for (key, value) in fields.as_object().unwrap() {
            if !value.is_null() {
                step[key.as_str()] = value.clone();
            }
        }
    };
    match name {
        "Read" => with(json!({
            "activity": "reading", "label": format!("Read {}", file_name(&file)),
            "files": [file], "targets": at(vec![file.clone()]),
        })),
        "Edit" | "MultiEdit" => with(json!({
            "activity": "editing", "label": format!("Edited {}", file_name(&file)),
            "files": [file], "changed": [file], "targets": at(vec![file.clone()]),
        })),
        "Write" => with(json!({
            "activity": "creating", "label": format!("Wrote {}", file_name(&file)),
            "files": [file], "changed": [file], "targets": at(vec![file.clone()]),
        })),
        "Bash" => with(json!({
            "activity": "running", "label": "Ran", "code": input["command"],
            "note": input["description"],
            "targets": at(paths_in(input["command"].as_str().unwrap_or(""))),
        })),
        "Glob" => with(json!({
            "activity": "searching", "label": "Listed files", "code": input["pattern"],
            "targets": at(paths_in(input["path"].as_str().unwrap_or(""))),
        })),
        "Grep" => with(json!({
            "activity": "searching", "label": "Searched", "code": input["pattern"],
            "targets": at(paths_in(input["path"].as_str().unwrap_or(""))),
        })),
        "TodoWrite" | "mcp__peekumi__get_run" => return None,
        _ if name.starts_with("mcp__peekumi_graph__") => {
            let tool = &name["mcp__peekumi_graph__".len()..];
            let target = [
                &input["to"]["name"],
                &input["name"],
                &input["query"],
                &input["text"],
                &input["path"],
            ]
            .into_iter()
            .find(|v| truthy(v))
            .cloned()
            .unwrap_or(json!(""));
            let path = if truthy(&input["path"]) {
                input["path"].clone()
            } else {
                input["to"]["path"].clone()
            };
            // A map lookup names the file and, often, the declaration: that is where it looks.
            let here = truthy(&input["path"])
                .then(|| json!({"path": input["path"], "name": input["name"]}));
            let targets: Vec<Value> =
                [Some(input["from"].clone()), Some(input["to"].clone()), here]
                    .into_iter()
                    .flatten()
                    .filter(|t| truthy(&t["path"]))
                    .map(|t| {
                        let mut place = json!({"path": t["path"]});
                        if truthy(&t["name"]) {
                            place["symbol"] = t["name"].clone();
                        }
                        place
                    })
                    .collect();
            with(json!({
                "activity": "reading", "label": format!("Map · {tool}"), "code": target,
                "files": if truthy(&path) { json!([path]) } else { json!([]) },
                "targets": targets,
            }))
        }
        _ => with(json!({"label": name})),
    }
    Some(step)
}

/// A finished item of Codex or of Peekumi's own agent, as an item of the conversation.
fn finished_item(item: &Value, items: &mut Items) {
    match item["type"].as_str() {
        Some("agent_message") if item["text"].as_str().is_some_and(|t| !t.trim().is_empty()) => {
            items.push(json!({"kind": "text", "text": item["text"]}));
        }
        Some("command_execution") => {
            let command = shell_body(item["command"].as_str().unwrap_or(""));
            let mut step = json!({
                "kind": "step", "activity": "running", "label": "Ran", "code": command,
                "failed": item["exit_code"].as_f64().is_some_and(|code| code != 0.0),
                "done": true, "files": [], "changed": [],
                "targets": paths_in(&command).into_iter().map(|path| json!({"path": path})).collect::<Vec<_>>(),
            });
            set(&mut step, "output", item["aggregated_output"].clone());
            items.push(step);
        }
        Some("file_change") => {
            let paths: Vec<String> = match item["changes"].as_array() {
                Some(changes) => changes
                    .iter()
                    .map(|c| relative(c["path"].as_str().unwrap_or("")))
                    .collect(),
                None => vec![relative(item["path"].as_str().unwrap_or(""))],
            };
            let failed = item["status"] == "failed";
            // Only new files: creating. Any other change: editing.
            let created = item["changes"]
                .as_array()
                .is_some_and(|c| c.iter().all(|c| c["kind"] == "add"));
            let names: Vec<String> = paths.iter().map(|p| file_name(p)).collect();
            items.push(json!({
                "kind": "step",
                "activity": if created { "creating" } else { "editing" },
                "label": format!("{} {}", if failed { "Could not change" } else { "Changed" }, names.join(", ")),
                "files": paths,
                "changed": if failed { json!([]) } else { json!(paths) },
                "targets": paths.iter().map(|path| json!({"path": path})).collect::<Vec<_>>(),
                "done": true,
                "failed": failed,
            }));
        }
        Some("mcp_tool_call") if item["server"] == "peekumi_graph" => {
            let mut step = json!({
                "kind": "step", "activity": "reading",
                "label": format!("Map · {}", item["tool"].as_str().unwrap_or("undefined")),
                "done": true, "files": [], "changed": [], "targets": [],
            });
            let args = &item["arguments"];
            if truthy(&args["path"]) {
                let mut place = json!({"path": args["path"]});
                if !args["name"].is_null() {
                    place["symbol"] = args["name"].clone();
                }
                step["targets"] = json!([place]);
            }
            items.push(step);
        }
        _ => {}
    }
}

/// Sets `key` unless the value is null, as JavaScript leaves an undefined field out of JSON.
fn set(item: &mut Value, key: &str, value: Value) {
    if !value.is_null() {
        item[key] = value;
    }
}

/// JavaScript's truthiness for a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The text of a Claude Code tool result, which is a string or a list of text parts.
fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(s) => s.clone(),
                _ => part["text"].as_str().unwrap_or("").to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// True when `text` has the word "updated", in any case.
fn says_updated(text: &str) -> bool {
    let lower = text.to_lowercase();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    lower.match_indices("updated").any(|(at, _)| {
        lower[..at].chars().next_back().is_none_or(|c| !word(c))
            && lower[at + 7..].chars().next().is_none_or(|c| !word(c))
    })
}

/// The command inside `/bin/<shell> -lc '<command>'`, the form in which Codex reports it.
fn shell_body(command: &str) -> String {
    if let Some(rest) = command.strip_prefix("/bin/")
        && let Some(space) = rest.find(" -lc '")
        && rest[..space]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !rest[..space].is_empty()
        && rest.ends_with('\'')
        && rest.len() >= space + 7
    {
        return rest[space + 6..rest.len() - 1].to_string();
    }
    command.to_string()
}

/// A path inside the run's worktree, relative to the repository.
fn relative(path: &str) -> String {
    match path.rsplit_once("/worktree/") {
        Some((_, rest)) => rest.to_string(),
        None => path.to_string(),
    }
}

/// The last part of a relative path.
fn file_name(path: &str) -> String {
    relative(path).rsplit('/').next().unwrap_or("").to_string()
}

/// File and folder paths named in a command or a search, relative to the repository: what the
/// agent looks at when it runs `sed -n 1,40p backend/lookup.rs` or `grep -rn x backend/`.
/// Options, variables, URLs, globs and paths outside the worktree are left out. At most four.
fn paths_in(text: &str) -> Vec<String> {
    let separator = |c: char| c.is_whitespace() || "'\"`;|&()<>=,".contains(c);
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut found: Vec<String> = vec![];
    for raw in text.split(separator) {
        let mut token = relative(raw);
        if let Some(rest) = token.strip_prefix("./") {
            token = rest.to_string();
        }
        token = strip_line_number(&token);
        if token.ends_with([':', ',', '.']) {
            token.pop();
        }
        // `backend/` names a folder.
        let folder = token.ends_with('/')
            && token.len() > 1
            && token[..token.len() - 1]
                .chars()
                .all(|c| word(c) || c == '.' || c == '-');
        if token.ends_with('/') {
            token.pop();
        }
        if token.is_empty()
            || token.chars().count() > 200
            || token.starts_with(['-', '$', '~', '/'])
            || token.contains("://")
            || token.contains("..")
            || token.contains(['*', '?', '{', '}', '[', ']', '\\'])
        {
            continue;
        }
        if !folder && !token.contains('/') && !simple_file(&token) {
            continue;
        }
        if version_like(&token) {
            continue;
        }
        if !found.contains(&token) {
            found.push(token);
        }
    }
    found.truncate(4);
    found
}

/// The token without a trailing `:<line>` or `:<line>:<column>`.
fn strip_line_number(token: &str) -> String {
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    if let Some((head, last)) = token.rsplit_once(':')
        && digits(last)
    {
        if let Some((front, middle)) = head.rsplit_once(':')
            && digits(middle)
        {
            return front.to_string();
        }
        return head.to_string();
    }
    token.to_string()
}

/// A name such as `main.rs`: word characters, dots and dashes, then a dot and an extension of
/// one to six letters or digits.
fn simple_file(token: &str) -> bool {
    let Some((stem, ext)) = token.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
        && (1..=6).contains(&ext.len())
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

/// A version number such as `1.2` or `0.162.1`.
fn version_like(token: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    parts.len() >= 2
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items_of(agent: &str, log: &str) -> Vec<Value> {
        let dir = std::env::temp_dir().join(format!("pk-conv-{}", crate::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("output.log");
        std::fs::write(&path, log).unwrap();
        let mut t = Translator::new(agent);
        t.read_from(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        t.items().to_vec()
    }

    #[test]
    fn paths_in_keeps_files_and_folders_and_leaves_out_the_rest() {
        assert_eq!(
            paths_in("sed -n 1,40p backend/lookup.rs && grep -rn x backend/ ./a/b.js:12:3"),
            vec!["backend/lookup.rs", "backend", "a/b.js"]
        );
        assert!(paths_in("--flag $HOME ~/x /abs/y https://x.io/a 1.2.3 *.rs ../up").is_empty());
        assert_eq!(
            paths_in("cat README.md main.rs:9"),
            vec!["README.md", "main.rs"]
        );
    }

    #[test]
    fn a_claude_step_gets_its_result_and_a_change_is_numbered() {
        let log = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"},{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/x/worktree/a/b.txt"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"File updated"}]}]}}
{"type":"result","total_cost_usd":0.5}
"#;
        let items = items_of("claude", log);
        assert_eq!(items[0], json!({"kind":"text","text":"Hi"}));
        assert_eq!(items[1]["activity"], "editing");
        assert_eq!(items[1]["label"], "Wrote b.txt");
        assert_eq!(items[1]["targets"], json!([{"path":"a/b.txt"}]));
        assert_eq!(items[1]["done"], true);
        assert_eq!(items[2], json!({"kind":"cost","cost":0.5}));
    }

    #[test]
    fn codex_items_and_peekumi_events_read_the_same_way() {
        let log = r#"{"type":"peekumi.owner","turn":1,"messages":[{"text":"Go","anchors":[]}]}
{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc 'cat src/a.rs'","aggregated_output":"x","exit_code":1}}
{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"/w/worktree/n.rs","kind":"add"}],"status":"completed"}}
{"type":"peekumi.turn","turn":1,"status":"completed"}
"#;
        let items = items_of("codex", log);
        assert_eq!(
            items[0],
            json!({"kind":"owner","text":"Go","anchors":[],"turn":1})
        );
        assert_eq!(items[1]["code"], "cat src/a.rs");
        assert_eq!(items[1]["failed"], true);
        assert_eq!(items[1]["targets"], json!([{"path":"src/a.rs"}]));
        assert_eq!(items[2]["activity"], "creating");
        assert_eq!(items[2]["label"], "Changed n.rs");
        assert_eq!(
            items[3],
            json!({"kind":"end","status":"completed","turn":1})
        );
    }

    #[test]
    fn since_gives_only_the_changes_after_a_number_in_the_same_epoch() {
        let dir = std::env::temp_dir().join(format!("pk-conv-{}", crate::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("output.log");
        std::fs::write(&path, "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"a\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}]}}\n{\"type\":\"assist").unwrap();
        let mut t = Translator::new("claude");
        t.read_from(&path).unwrap();
        let first = t.since(0, None);
        assert_eq!(first["items"].as_array().unwrap().len(), 1);
        let (epoch, seq) = (
            first["epoch"].as_str().unwrap().to_string(),
            first["seq"].as_u64().unwrap(),
        );
        // The half line waits; the result changes step 0 only.
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        use std::io::Write;
        writeln!(
            f,
            "ant\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"Done\"}}]}}}}"
        )
        .unwrap();
        writeln!(f, "{{\"type\":\"user\",\"message\":{{\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"a\",\"content\":\"ok\"}}]}}}}").unwrap();
        t.read_from(&path).unwrap();
        let next = t.since(seq, Some(&epoch));
        let patches = next["patches"].as_array().unwrap();
        assert_eq!(patches.len(), 2);
        assert_eq!(patches[0]["index"], 0);
        assert_eq!(patches[0]["item"]["output"], "ok");
        assert_eq!(patches[1]["item"], json!({"kind":"text","text":"Done"}));
        // Another epoch reads everything again.
        assert!(t.since(seq, Some("old")).get("items").is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
