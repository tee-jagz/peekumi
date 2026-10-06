//! Agents: the providers that answer questions (Ask) and change code (tasks), behind one
//! interface.
//!
//! Each [`Agent`] says which jobs it can do, which models it has and the effort levels of each
//! model, whether it is ready on this computer, and how to start it for a task. An agent finds
//! its models itself, from the provider (`codex debug models`, `claude --help`); only when the
//! provider gives nothing does it use a short built-in list, marked `source: "built-in"`.
//! Discovered lists are kept for ten minutes.
//!
//! The owner chooses a provider, then one of its models, then an effort, for each job. The app
//! keeps that choice on the device and sends it with each Ask question, task preview and
//! commit message request as `using: {agent, model, effort}`; the server checks it here and
//! uses its defaults when there is none. A task keeps the choice it started with for all its
//! rounds.
//!
//! The app reads everything it shows from `GET /api/agents` and never lists providers or
//! models itself. To add a provider (for example an API such as OpenRouter), implement
//! [`Agent`] and add it to [`registry`]. A provider that answers questions over an API, not
//! through a CLI, also needs its own Ask engine in the ask module, which today runs Claude Code.
use crate::workflow::Workflow;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
};

/// The two jobs an agent can do.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Job {
    /// Read-only answers about the repository.
    Ask,
    /// Changes to the code in a separate worktree.
    Task,
}
impl Job {
    /// The job's name in the API and the saved settings.
    pub fn key(self) -> &'static str {
        match self {
            Job::Ask => "ask",
            Job::Task => "task",
        }
    }
}

/// A model of an agent. `id: None` is the agent's own default model. `efforts` are the levels
/// this model accepts; the app also offers `auto`, which passes none.
#[derive(Clone)]
pub struct Model {
    pub id: Option<String>,
    pub label: String,
    pub note: String,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}

/// Whether an agent can run now, and if not, what the owner can do about it.
pub struct Status {
    pub ready: bool,
    pub reason: Option<String>,
}

/// What the runner gives an agent to start a task, besides the worktree and the task text
/// on stdin: the chosen model and effort, and the Peekumi reporting bridge (an MCP server
/// that is this executable with `args`, authorized by `token`).
pub struct Launch<'a> {
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub bridge: &'a Path,
    pub args: &'a [String],
    pub token: &'a str,
    /// The task's code graph endpoint and its run-scoped key (see the lookup module), when the
    /// task has the graph.
    pub graph: Option<(&'a str, &'a str)>,
    /// One turn of a session (a conversation with the owner), or `None` for a task.
    pub session: Option<SessionTurn<'a>>,
}

/// One turn of a session: the agent continues the same conversation in the same worktree.
pub struct SessionTurn<'a> {
    /// The agent's conversation ID: Peekumi's own UUID for Claude Code, set on the first turn;
    /// the thread ID that Codex reported, for later turns.
    pub conversation: Option<&'a str>,
    /// True on the first turn, which starts the conversation.
    pub first: bool,
    /// True when the owner allowed every command: no command waits for a question.
    pub allow_all: bool,
}

/// Commands a session agent may run with no question: Git on its own branch and common test
/// runners. Any other command waits for the owner (Claude Code), see the runner's `approve`.
pub const SESSION_COMMANDS: [&str; 14] = [
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(git add:*)",
    "Bash(git commit:*)",
    "Bash(npm test:*)",
    "Bash(npm run test:*)",
    "Bash(cargo test:*)",
    "Bash(cargo check:*)",
    "Bash(pytest:*)",
    "Bash(python -m pytest:*)",
    "Bash(go test:*)",
    "Bash(node --test:*)",
];
/// The graph tools as an agent sees them through the `peekumi_graph` MCP server.
pub const GRAPH_TOOLS: [&str; 7] = [
    "mcp__peekumi_graph__highlight",
    "mcp__peekumi_graph__route",
    "mcp__peekumi_graph__find_declarations",
    "mcp__peekumi_graph__read_declaration",
    "mcp__peekumi_graph__relationships",
    "mcp__peekumi_graph__search_code",
    "mcp__peekumi_graph__read_file",
];

/// One provider that Peekumi can use. Implementations must not run the inspected checkout's
/// code and must keep the agent inside the worktree the runner gives it.
pub trait Agent: Send + Sync {
    /// Stable ID, saved in choices and runs (`claude`, `codex`).
    fn id(&self) -> &'static str;
    /// Full name, such as "Claude Code".
    fn label(&self) -> &'static str;
    /// Short name for summaries, such as "Claude".
    fn short(&self) -> &'static str;
    /// The jobs this agent can do.
    fn jobs(&self) -> &'static [Job];
    /// The models for `job`, best first, and `true` when they came from the provider (not the
    /// built-in list). The owner can also type any model name.
    fn models(&self, job: Job) -> (Vec<Model>, bool);
    /// Checks that the agent is installed and signed in. May run a short command.
    fn status(&self) -> Status;
    /// The command that starts this agent on a task, with the reporting bridge connected.
    /// `None` for a provider that cannot do tasks.
    fn task_command(&self, launch: &Launch) -> Option<Command>;
    /// False for a provider that has no model of its own, so the owner must choose one.
    fn has_default_model(&self) -> bool {
        true
    }
    /// True for a provider that is only an API: Peekumi's own task agent (the task_agent
    /// module) does its tasks, in place of a command.
    fn runs_in_process(&self) -> bool {
        false
    }
    /// A short line the app shows for this provider in `job`'s list, when the job works in a
    /// way the owner should know.
    fn note(&self, _job: Job) -> Option<&'static str> {
        None
    }
    /// For a provider that needs an API key: whether one is set, its last four characters, and
    /// whether it comes from the environment (then the app cannot replace it).
    fn key(&self) -> Option<Value> {
        None
    }
}

/// Runs a provider's own command with a short time limit; `None` when it fails.
fn ask_provider(executable: &str, args: &[&str]) -> Option<String> {
    crate::process::run_for(executable, args, None, vec![], Duration::from_secs(15))
        .ok()
        .map(|out| String::from_utf8_lossy(&out).into_owned())
}

/// Discovered model lists for ten minutes, by agent and executable.
fn cached(key: String, find: impl FnOnce() -> Option<Vec<Model>>) -> Option<Vec<Model>> {
    static CACHE: Mutex<Option<HashMap<String, (Instant, Vec<Model>)>>> = Mutex::new(None);
    if let Some((at, models)) = CACHE
        .lock()
        .ok()?
        .get_or_insert_with(HashMap::new)
        .get(&key)
        && at.elapsed() < Duration::from_secs(600)
    {
        return Some(models.clone());
    }
    let models = find()?;
    if let Ok(mut cache) = CACHE.lock() {
        cache
            .get_or_insert_with(HashMap::new)
            .insert(key, (Instant::now(), models.clone()));
    }
    Some(models)
}

/// The words in parentheses after `--effort` in a `--help` text: "(low, medium, high)".
fn help_efforts(help: &str) -> Vec<String> {
    let Some(start) = help.find("--effort") else {
        return vec![];
    };
    let rest = &help[start..help.len().min(start + 400)];
    let (Some(open), Some(close)) = (rest.find('('), rest.find(')')) else {
        return vec![];
    };
    if close < open {
        return vec![];
    }
    rest[open + 1..close]
        .split(',')
        .map(str::trim)
        .filter(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase()))
        .map(str::to_string)
        .collect()
}

/// The quoted aliases in the `--model` description of a `--help` text: 'opus', 'sonnet'.
fn help_aliases(help: &str) -> Vec<String> {
    let Some(start) = help.find("--model") else {
        return vec![];
    };
    let rest = &help[start..help.len().min(start + 400)];
    let end = rest[2..].find("\n  -").map(|i| i + 2).unwrap_or(rest.len());
    rest[..end]
        .split('\'')
        .skip(1)
        .step_by(2)
        .filter(|w| {
            !w.is_empty()
                && w.len() < 40
                && w.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-[]".contains(&b))
        })
        .map(str::to_string)
        .collect()
}

/// Claude Code: answers questions (see the ask module) and does tasks.
pub struct ClaudeCode {
    pub executable: String,
}
impl Agent for ClaudeCode {
    fn id(&self) -> &'static str {
        "claude"
    }
    fn label(&self) -> &'static str {
        "Claude Code"
    }
    fn short(&self) -> &'static str {
        "Claude"
    }
    fn jobs(&self) -> &'static [Job] {
        &[Job::Ask, Job::Task]
    }
    /// The model aliases and effort levels that `claude --help` names. Claude Code has no
    /// command that lists models; an alias always means the latest model of that family.
    fn models(&self, _: Job) -> (Vec<Model>, bool) {
        let found = cached(format!("claude:{}", self.executable), || {
            let help = ask_provider(&self.executable, &["--help"])?;
            let (aliases, efforts) = (help_aliases(&help), help_efforts(&help));
            (!aliases.is_empty()).then(|| {
                aliases
                    .into_iter()
                    .map(|alias| Model {
                        label: format!("{}{}", alias[..1].to_uppercase(), &alias[1..]),
                        note: "The latest model of this family".into(),
                        id: Some(alias),
                        efforts: efforts.clone(),
                        default_effort: None,
                    })
                    .collect()
            })
        });
        match found {
            Some(models) => (models, true),
            None => (
                ["sonnet", "opus"]
                    .map(|alias| Model {
                        id: Some(alias.into()),
                        label: format!("{}{}", alias[..1].to_uppercase(), &alias[1..]),
                        note: "The latest model of this family".into(),
                        efforts: ["low", "medium", "high"].map(String::from).to_vec(),
                        default_effort: None,
                    })
                    .to_vec(),
                false,
            ),
        }
    }
    fn status(&self) -> Status {
        match ask_provider(&self.executable, &["auth", "status"]) {
            None if ask_provider(&self.executable, &["--version"]).is_none() => Status {
                ready: false,
                reason: Some("Not installed. Install Claude Code on your computer".into()),
            },
            Some(out)
                if serde_json::from_str::<Value>(&out).is_ok_and(|s| s["loggedIn"] == false) =>
            {
                Status {
                    ready: false,
                    reason: Some("Not signed in. Run claude auth login on your computer".into()),
                }
            }
            _ => Status {
                ready: true,
                reason: None,
            },
        }
    }
    fn task_command(&self, launch: &Launch) -> Option<Command> {
        let mut c = Command::new(&self.executable);
        let mut tools = "Read,Edit,Write,Glob,Grep,Bash,mcp__peekumi__get_run,mcp__peekumi__resolve_comment,mcp__peekumi__flag_comment".to_string();
        if let Some(session) = &launch.session {
            // A session asks the owner before any command outside its list: manual mode, no
            // user or project settings that could allow more, and Peekumi's approve tool. No
            // command rule goes to Claude Code: every command reaches the approve tool, and
            // Peekumi alone judges it against the list and the owner's rules.
            let mut allowed: Vec<String> = [
                "Read",
                "Edit",
                "Write",
                "Glob",
                "Grep",
                "mcp__peekumi__get_run",
            ]
            .iter()
            .map(|t| t.to_string())
            .collect();
            if launch.graph.is_some() {
                allowed.extend(GRAPH_TOOLS.iter().map(|t| t.to_string()));
            }
            if session.allow_all {
                allowed.push("Bash".into());
            }
            tools = allowed.join(",");
        } else if launch.graph.is_some() {
            tools = format!("{tools},{}", GRAPH_TOOLS.join(","));
        }
        // "Allow all" works as a task does; any other request (a web fetch, say) still reaches
        // Peekumi's approve tool, which allows it at once in this mode.
        let mode = match &launch.session {
            Some(session) if !session.allow_all => "manual",
            _ => "acceptEdits",
        };
        c.args([
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            mode,
            "--strict-mcp-config",
            "--allowedTools",
            &tools,
        ]);
        if let Some(session) = &launch.session {
            c.args([
                "--setting-sources",
                "",
                "--permission-prompt-tool",
                "mcp__peekumi__approve",
            ]);
            // The owner may take a while to answer on the phone.
            c.env("MCP_TOOL_TIMEOUT", "1000000");
            let conversation = session.conversation?;
            c.args([
                if session.first {
                    "--session-id"
                } else {
                    "--resume"
                },
                conversation,
            ]);
        }
        if let Some(model) = launch.model {
            c.args(["--model", model]);
        }
        if let Some(effort) = launch.effort {
            c.args(["--effort", effort]);
        }
        // `alwaysLoad` puts these few tools in the first prompt. Otherwise Claude Code shows only
        // their names until the agent loads them, and an agent often searches text first.
        let mut servers = json!({"peekumi":{"command":launch.bridge,"args":launch.args,"env":{"PEEKUMI_REPORT_TOKEN":launch.token},"alwaysLoad":true}});
        if let Some((url, key)) = launch.graph {
            servers["peekumi_graph"] = json!({"type":"http","url":url,"headers":{"Authorization":format!("Bearer {key}")},"alwaysLoad":true});
        }
        c.arg("--mcp-config")
            .arg(json!({"mcpServers": servers}).to_string());
        Some(c)
    }
}

/// Codex: does tasks with its approval-review preset.
pub struct Codex {
    pub executable: String,
}
impl Agent for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn label(&self) -> &'static str {
        "Codex"
    }
    fn short(&self) -> &'static str {
        "Codex"
    }
    fn jobs(&self) -> &'static [Job] {
        &[Job::Task]
    }
    /// The listed models of `codex debug models`, in Codex's own order, each with its effort
    /// levels and default effort.
    fn models(&self, _: Job) -> (Vec<Model>, bool) {
        let found = cached(format!("codex:{}", self.executable), || {
            let raw = ask_provider(&self.executable, &["debug", "models"])?;
            let catalog: Value = serde_json::from_str(&raw).ok()?;
            let mut listed: Vec<&Value> = catalog["models"]
                .as_array()?
                .iter()
                .filter(|m| m["visibility"] == "list" && m["slug"].is_string())
                .collect();
            listed.sort_by_key(|m| m["priority"].as_i64().unwrap_or(i64::MAX));
            let models: Vec<Model> = listed
                .into_iter()
                .map(|m| Model {
                    id: m["slug"].as_str().map(str::to_string),
                    label: m["display_name"]
                        .as_str()
                        .or(m["slug"].as_str())
                        .unwrap_or("")
                        .to_string(),
                    note: m["description"].as_str().unwrap_or("").to_string(),
                    efforts: m["supported_reasoning_levels"]
                        .as_array()
                        .map(|levels| {
                            levels
                                .iter()
                                .filter_map(|l| l["effort"].as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                    default_effort: m["default_reasoning_level"].as_str().map(str::to_string),
                })
                .collect();
            (!models.is_empty()).then_some(models)
        });
        match found {
            Some(models) => (models, true),
            None => (
                vec![Model {
                    id: None,
                    label: "Default model".into(),
                    note: "The model Codex uses on its own".into(),
                    efforts: ["low", "medium", "high"].map(String::from).to_vec(),
                    default_effort: None,
                }],
                false,
            ),
        }
    }
    fn status(&self) -> Status {
        if ask_provider(&self.executable, &["--version"]).is_none() {
            return Status {
                ready: false,
                reason: Some("Not installed. Install Codex on your computer".into()),
            };
        }
        match ask_provider(&self.executable, &["login", "status"]) {
            Some(_) => Status {
                ready: true,
                reason: None,
            },
            None => Status {
                ready: false,
                reason: Some("Not signed in. Run codex login on your computer".into()),
            },
        }
    }
    fn task_command(&self, launch: &Launch) -> Option<Command> {
        let mut c = Command::new(&self.executable);
        // This preset already selects workspace-write and automatic approval review.
        // Codex rejects combining it with the separate --sandbox option.
        c.args(["exec", "--approve-for-me", "--json", "--color", "never"]);
        if let Some(model) = launch.model {
            c.args(["--model", model]);
        }
        if let Some(effort) = launch.effort {
            c.arg("-c")
                .arg(format!("model_reasoning_effort={}", json!(effort)));
        }
        c.arg("-c").arg(format!(
            "mcp_servers.peekumi.command={}",
            json!(launch.bridge)
        ));
        c.arg("-c")
            .arg(format!("mcp_servers.peekumi.args={}", json!(launch.args)));
        c.arg("-c")
            .arg("mcp_servers.peekumi.env_vars=[\"PEEKUMI_REPORT_TOKEN\"]");
        // The code graph over streamable HTTP; Codex reads the run's key from the environment.
        if let Some((url, key)) = launch.graph {
            c.arg("-c")
                .arg(format!("mcp_servers.peekumi_graph.url={}", json!(url)));
            c.arg("-c")
                .arg("mcp_servers.peekumi_graph.bearer_token_env_var=\"PEEKUMI_GRAPH_TOKEN\"");
            c.env("PEEKUMI_GRAPH_TOKEN", key);
        }
        // A later session turn continues the thread that the first turn started.
        if let Some(session) = &launch.session
            && !session.first
        {
            c.args(["resume", session.conversation?]);
        }
        c.arg("-");
        Some(c)
    }
}

/// OpenRouter: any of its models that can use tools, with the owner's API key, and no other
/// program. For Ask, Peekumi calls its API and runs the read-only lookups itself (see the ask
/// module). For tasks, Peekumi's own task agent (the task_agent module) runs the model in the
/// worktree. Requests go through `curl`; the key reaches it on stdin, never as an argument.
#[derive(Clone)]
pub struct OpenRouter {
    /// The API address: `PEEKUMI_OPENROUTER_URL`, else https://openrouter.ai/api/v1.
    pub base: String,
    /// The file that holds the key, readable only by the owner.
    pub key_file: std::path::PathBuf,
}
impl OpenRouter {
    pub fn new(store: &Workflow) -> Self {
        Self {
            base: std::env::var("PEEKUMI_OPENROUTER_URL")
                .unwrap_or_else(|_| "https://openrouter.ai/api/v1".into())
                .trim_end_matches('/')
                .to_string(),
            key_file: store.secrets.join("openrouter-key"),
        }
    }
    /// The key from `PEEKUMI_OPENROUTER_KEY`, else from the key file, with `true` for the
    /// environment.
    fn secret(&self) -> Option<(String, bool)> {
        if let Ok(key) = std::env::var("PEEKUMI_OPENROUTER_KEY")
            && !key.trim().is_empty()
        {
            return Some((key.trim().to_string(), true));
        }
        std::fs::read_to_string(&self.key_file)
            .ok()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .map(|k| (k, false))
    }
    /// One API request through `curl`. `key` authorizes it (none for the public model list);
    /// `body` is sent as JSON; `line` receives each line as it arrives (for streamed answers).
    /// Returns the whole response text. A request body goes through a private temporary file.
    pub fn request(
        &self,
        path: &str,
        key: Option<&str>,
        body: Option<&Value>,
        limit: Duration,
        mut line: impl FnMut(&str),
    ) -> Result<String> {
        let mut config = format!(
            "url = \"{}{path}\"\nsilent\nshow-error\nfail-with-body\n",
            self.base
        );
        if let Some(key) = key {
            ensure!(
                valid_key(key),
                "The OpenRouter key has characters that are not allowed"
            );
            config.push_str(&format!("header = \"Authorization: Bearer {key}\"\n"));
        }
        let file = match body {
            Some(body) => {
                let dir = std::env::temp_dir().join("peekumi-openrouter");
                std::fs::create_dir_all(&dir)?;
                let file = dir.join(crate::random_token());
                {
                    use std::io::Write;
                    let mut options = std::fs::OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    options
                        .open(&file)?
                        .write_all(body.to_string().as_bytes())?;
                }
                config.push_str("header = \"Content-Type: application/json\"\n");
                config.push_str(&format!("data-binary = \"@{}\"\n", file.display()));
                Some(file)
            }
            None => None,
        };
        let mut text = String::new();
        let result = crate::process::stream_lines(
            "curl",
            &["--no-buffer", "--config", "-"],
            None,
            config.into_bytes(),
            limit,
            |l| {
                line(l);
                text.push_str(l);
                text.push('\n');
            },
        );
        if let Some(file) = file {
            let _ = std::fs::remove_file(file);
        }
        result.map_err(|e| {
            // An API error carries a JSON body with a message; show that, not curl's text.
            serde_json::from_str::<Value>(text.trim())
                .ok()
                .and_then(|v| {
                    v["error"]["message"]
                        .as_str()
                        .map(|m| anyhow::anyhow!("OpenRouter: {m}"))
                })
                .unwrap_or_else(|| anyhow::anyhow!("Cannot reach OpenRouter: {e}"))
        })?;
        Ok(text)
    }
    /// Tests `key` with OpenRouter, then saves it in the key file, readable only by the owner.
    pub fn save_key(&self, key: &str) -> Result<()> {
        let key = key.trim();
        ensure!(valid_key(key), "This does not look like an OpenRouter key");
        self.request("/key", Some(key), None, Duration::from_secs(20), |_| {})
            .map_err(|_| anyhow::anyhow!("OpenRouter did not accept this key"))?;
        let temp = self.key_file.with_extension("new");
        {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(&temp)?.write_all(key.as_bytes())?;
        }
        std::fs::rename(temp, &self.key_file)?;
        Ok(())
    }
    /// Removes the saved key. A key from the environment stays.
    pub fn remove_key(&self) -> Result<()> {
        match std::fs::remove_file(&self.key_file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
    /// One answer without tools or streaming, for short jobs such as a commit message.
    pub fn complete(
        &self,
        model: &str,
        effort: Option<&str>,
        system: &str,
        user: &str,
    ) -> Result<String> {
        let key = self.key_or_error()?;
        let mut request = json!({"model": model, "stream": false, "messages": [
            {"role": "system", "content": system}, {"role": "user", "content": user}]});
        if let Some(effort) = effort {
            request["reasoning"] = json!({"effort": effort});
        }
        let raw = self.request(
            "/chat/completions",
            Some(&key),
            Some(&request),
            Duration::from_secs(60),
            |_| {},
        )?;
        let response: Value =
            serde_json::from_str(raw.trim()).context("OpenRouter returned invalid JSON")?;
        response["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_string)
            .context("OpenRouter returned no answer")
    }
    /// The key for a request, or an error that tells the owner to add one.
    pub fn key_or_error(&self) -> Result<String> {
        self.secret()
            .map(|(k, _)| k)
            .context("Add your OpenRouter key in Agents")
    }
}
/// An API key: letters, digits and `-_.`, so it is safe inside the curl configuration.
fn valid_key(key: &str) -> bool {
    (10..=300).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
/// "$0.15" for a price per token given as text, per million tokens.
fn per_million(price: &Value) -> Option<String> {
    let value: f64 = price.as_str()?.parse().ok()?;
    let million = value * 1_000_000.0;
    Some(if million >= 10.0 {
        format!("${million:.0}")
    } else {
        format!("${million:.2}")
    })
}
impl Agent for OpenRouter {
    fn id(&self) -> &'static str {
        "openrouter"
    }
    fn label(&self) -> &'static str {
        "OpenRouter"
    }
    fn short(&self) -> &'static str {
        "OpenRouter"
    }
    fn jobs(&self) -> &'static [Job] {
        &[Job::Ask, Job::Task]
    }
    /// The models of OpenRouter's public list that can use tools, as it orders them, with
    /// their context size and price. Reasoning models get effort levels.
    fn models(&self, _: Job) -> (Vec<Model>, bool) {
        let found = cached(format!("openrouter:{}", self.base), || {
            let raw = self
                .request("/models", None, None, Duration::from_secs(20), |_| {})
                .ok()?;
            let list: Value = serde_json::from_str(&raw).ok()?;
            let models: Vec<Model> = list["data"]
                .as_array()?
                .iter()
                .filter(|m| {
                    m["supported_parameters"]
                        .as_array()
                        .is_some_and(|p| p.iter().any(|x| x == "tools"))
                        && m["id"].as_str().is_some_and(valid_model)
                })
                .map(|m| {
                    let parameters = m["supported_parameters"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let mut note = vec![];
                    if let Some(context) = m["context_length"].as_u64() {
                        note.push(format!("{}K context", context / 1000));
                    }
                    match (
                        per_million(&m["pricing"]["prompt"]),
                        per_million(&m["pricing"]["completion"]),
                    ) {
                        (Some(input), Some(output)) if input == "$0.00" && output == "$0.00" => {
                            note.push("Free".into())
                        }
                        (Some(input), Some(output)) => {
                            note.push(format!("{input} in / {output} out per million tokens"))
                        }
                        _ => {}
                    }
                    Model {
                        id: m["id"].as_str().map(str::to_string),
                        label: m["name"]
                            .as_str()
                            .or(m["id"].as_str())
                            .unwrap_or("")
                            .to_string(),
                        note: note.join(" · "),
                        efforts: if parameters.iter().any(|p| p == "reasoning") {
                            ["low", "medium", "high"].map(String::from).to_vec()
                        } else {
                            vec![]
                        },
                        default_effort: None,
                    }
                })
                .collect();
            (!models.is_empty()).then_some(models)
        });
        match found {
            Some(models) => (models, true),
            None => (vec![], false),
        }
    }
    fn status(&self) -> Status {
        match self.secret() {
            Some(_) => Status {
                ready: true,
                reason: None,
            },
            None => Status {
                ready: false,
                reason: Some("Add your OpenRouter key".into()),
            },
        }
    }
    fn task_command(&self, _: &Launch) -> Option<Command> {
        None
    }
    fn runs_in_process(&self) -> bool {
        true
    }
    fn has_default_model(&self) -> bool {
        false
    }
    fn note(&self, job: Job) -> Option<&'static str> {
        (job == Job::Task).then_some(
            "Peekumi runs the model itself. It reads, searches, edits and commits files in the task's own worktree. It cannot run commands or tests.",
        )
    }
    fn key(&self) -> Option<Value> {
        Some(match self.secret() {
            Some((key, environment)) => {
                json!({"set": true, "end": &key[key.len().saturating_sub(4)..], "fromEnvironment": environment})
            }
            None => json!({"set": false}),
        })
    }
}

/// Every provider this server knows, in the order the app lists them.
pub fn registry(store: &Workflow) -> Vec<Box<dyn Agent>> {
    vec![
        Box::new(ClaudeCode {
            executable: store.claude.clone(),
        }),
        Box::new(Codex {
            executable: store.codex.clone(),
        }),
        Box::new(OpenRouter::new(store)),
    ]
}

/// The agent with `id`, if this server has it.
pub fn find(store: &Workflow, id: &str) -> Option<Box<dyn Agent>> {
    registry(store).into_iter().find(|a| a.id() == id)
}

/// A typed model name: letters, digits and `._:/@-[]`, at most 100 characters, so it is safe
/// as one command argument.
fn valid_model(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/@-[]".contains(&b))
}

impl Workflow {
    /// The default choice for `job`: Claude Code with the server's Ask model and effort for
    /// Ask, and Codex with its own model for tasks.
    pub fn default_choice(&self, job: Job) -> Value {
        match job {
            Job::Ask => {
                json!({"agent": "claude", "model": self.ask_default[0], "effort": self.ask_default[1]})
            }
            Job::Task => json!({"agent": "codex", "model": null, "effort": "auto"}),
        }
    }
    /// The choice the app sent for `job` (`using: {agent, model, effort}`), checked: a known
    /// agent that can do the job, a safe model name or none, and `auto` or an effort word that
    /// the agent itself checks. Without one, the default.
    pub fn choice(&self, job: Job, using: &Value) -> Result<Value> {
        if using.is_null() {
            return Ok(self.default_choice(job));
        }
        let id = using["agent"].as_str().context("Choose an agent")?;
        let agent = find(self, id).context("Unknown agent")?;
        ensure!(
            agent.jobs().contains(&job),
            "{} cannot do this job",
            agent.label()
        );
        ensure!(
            agent.has_default_model() || using["model"].is_string(),
            "Choose a model for {} in Agents",
            agent.label()
        );
        let model = match &using["model"] {
            Value::Null => Value::Null,
            Value::String(name) => {
                let name = name.trim();
                ensure!(
                    valid_model(name),
                    "Use only letters, digits and ._:/@-[] in a model name"
                );
                json!(name)
            }
            _ => anyhow::bail!("Invalid model"),
        };
        let effort = using["effort"].as_str().unwrap_or("auto");
        ensure!(
            !effort.is_empty()
                && effort.len() <= 16
                && effort.bytes().all(|b| b.is_ascii_lowercase()),
            "Unknown effort"
        );
        Ok(json!({"agent": id, "model": model, "effort": effort}))
    }
    /// `GET /api/agents`: every provider with its jobs, status and models for each job (each
    /// model with its effort levels), and the default choice for each job.
    /// `PUT /api/agents/openrouter-key` with `{key}` tests and saves an OpenRouter key;
    /// `DELETE` on the same path removes it. Both return the `GET` body.
    pub fn agents_route(&self, method: &str, path: &str, body: &Value) -> Result<Value> {
        if path == "/api/agents/openrouter-key" {
            let provider = OpenRouter::new(self);
            match method {
                "PUT" => provider.save_key(body["key"].as_str().context("Paste the key")?)?,
                "DELETE" => provider.remove_key()?,
                _ => anyhow::bail!("Unsupported key operation"),
            }
            return self.agents_route("GET", "/api/agents", &Value::Null);
        }
        ensure!(
            method == "GET" && path == "/api/agents",
            "Unsupported agents operation"
        );
        let agents: Vec<Value> = registry(self)
            .iter()
            .map(|a| {
                let status = a.status();
                let mut models = json!({});
                let mut discovered = true;
                for job in a.jobs() {
                    let (list, found) = a.models(*job);
                    discovered &= found;
                    models[job.key()] = json!(list.iter().map(|m| json!({"id": m.id, "label": m.label, "note": m.note, "efforts": m.efforts, "defaultEffort": m.default_effort})).collect::<Vec<_>>());
                }
                json!({
                    "id": a.id(), "label": a.label(), "short": a.short(),
                    "jobs": a.jobs().iter().map(|j| j.key()).collect::<Vec<_>>(),
                    "defaultModel": a.has_default_model(),
                    "notes": {"ask": a.note(Job::Ask), "task": a.note(Job::Task)},
                    "key": a.key(),
                    "models": models,
                    "source": if discovered { "agent" } else { "built-in" },
                    "status": {"ready": status.ready, "reason": status.reason},
                })
            })
            .collect();
        Ok(json!({
            "agents": agents,
            "defaults": {"ask": self.default_choice(Job::Ask), "task": self.default_choice(Job::Task)},
        }))
    }
}

/// The model and effort flags of a choice: `None` for the agent's default model, and for `auto`.
pub fn flags(choice: &Value) -> (Option<String>, Option<String>) {
    (
        choice["model"].as_str().map(str::to_string),
        choice["effort"]
            .as_str()
            .filter(|e| *e != "auto")
            .map(str::to_string),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_efforts_and_aliases_from_help() {
        let help = "  --effort <level>    Effort level for the current session\n                      (low, medium, high, xhigh, max)\n  --model <model>     Model for the current session. Provide\n                      an alias for the latest model (e.g.\n                      'fable', 'opus', or 'sonnet') or a\n                      model's full name.\n  -n, --name <name>   Set a name\n";
        assert_eq!(
            help_efforts(help),
            ["low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(help_aliases(help), ["fable", "opus", "sonnet"]);
        assert!(help_efforts("no flag here").is_empty());
        assert!(valid_model("claude-opus-4[1m]") && !valid_model("--bad") && !valid_model("a b"));
    }
}
