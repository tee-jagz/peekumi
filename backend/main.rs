//! Authenticated HTTP API, embedded frontend and repository worker.
mod adapters;
mod ask;
mod engine;
mod index;
mod lookup;
mod process;
mod pull_requests;
mod relationships;
mod rules;
mod runner;
mod sessions;
mod workflow;
use anyhow::{Context, Result, ensure};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::Response,
};
use clap::Parser;
use engine::Repository;
use rand::RngCore;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, Write},
    path::PathBuf,
    sync::Arc,
};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_stream::StreamExt as _;

#[derive(Parser, Clone)]
#[command(
    name = "peekumi",
    version,
    about = "Explore committed repository structure from your phone"
)]
/// Launch configuration for the repository, listener, private state and installed parser helpers.
struct Options {
    directory: PathBuf,
    /// Additional local checkouts served at the same address, each with isolated state.
    #[arg(long = "repo")]
    repositories: Vec<PathBuf>,
    #[arg(long)]
    isolate_primary: bool,
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 4317)]
    port: u16,
    #[arg(long, default_value = "HEAD~1")]
    base: String,
    #[arg(long, default_value = "HEAD")]
    head: String,
    #[arg(long)]
    secure_cookie: bool,
    /// Private state directory; `.peekumi` by default, or an existing `.strata` from before the rename.
    #[arg(long, default_value = ".peekumi")]
    state_dir: PathBuf,
    #[arg(long,env = "PEEKUMI_PARSER_ROOT",default_value=env!("CARGO_MANIFEST_DIR"))]
    parser_root: PathBuf,
    #[arg(long, env = "PEEKUMI_PYTHON", default_value = "python3")]
    python: String,
    #[arg(long, env = "PEEKUMI_NODE", default_value = "node")]
    node: String,
    #[arg(long, env = "PEEKUMI_TOKEN", hide_env_values = true, hide = true)]
    token: Option<String>,
    #[arg(long, hide = true)]
    stdio: bool,
    /// Installed agent executable; invoked only after an explicit run dispatch.
    #[arg(long, env = "PEEKUMI_CODEX", default_value = "codex")]
    codex: String,
    #[arg(long, env = "PEEKUMI_CLAUDE", default_value = "claude")]
    claude: String,
    /// Model for Ask answers: a fast model by default; set `opus` for slower, deeper answers.
    #[arg(long, env = "PEEKUMI_ASK_MODEL", default_value = "sonnet")]
    ask_model: String,
    /// Reasoning effort for Ask answers (low, medium or high): more effort checks more before
    /// it answers, and takes longer.
    #[arg(long, env = "PEEKUMI_ASK_EFFORT", default_value = "low")]
    ask_effort: String,
    #[arg(long, env = "PEEKUMI_GH", default_value = "gh")]
    github: String,
    #[arg(long, hide = true)]
    report_run: Option<String>,
}
/// One queued repository operation with JSON arguments and a channel for its result.
struct Work {
    method: String,
    args: Value,
    reply: oneshot::Sender<Result<Value, String>>,
}
#[derive(Clone)]
/// An asynchronous handle to the dedicated repository worker.
/// Keeps blocking Git, parser and SQLite work off the HTTP runtime threads.
struct Engine {
    sender: mpsc::Sender<Work>,
}
impl Engine {
    /// Moves the repository into a worker thread and creates a queue capped at 32 operations.
    fn start(mut repo: Repository) -> Self {
        let (sender, mut receiver) = mpsc::channel::<Work>(32);
        std::thread::spawn(move || {
            while let Some(work) = receiver.blocking_recv() {
                let result =
                    dispatch(&mut repo, &work.method, &work.args).map_err(|e| e.to_string());
                let _ = work.reply.send(result);
            }
        });
        Self { sender }
    }
    /// Queues a named repository operation and asynchronously waits for its JSON result.
    /// Returns operation errors or a worker-stopped error if either channel closes.
    async fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        let (reply, receive) = oneshot::channel();
        self.sender
            .send(Work {
                method: method.into(),
                args,
                reply,
            })
            .await
            .map_err(|_| "Repository worker stopped".to_string())?;
        receive
            .await
            .map_err(|_| "Repository worker stopped".to_string())?
    }
}
/// Reads a positional string argument from the internal JSON protocol, defaulting to empty.
fn argument(args: &Value, index: usize) -> &str {
    args[index].as_str().unwrap_or("")
}
/// Routes an internal operation name to the repository API.
/// Returns an error for unknown operations or failed repository work.
fn dispatch(repo: &mut Repository, method: &str, args: &Value) -> Result<Value> {
    match method {
        "resolve" => Ok(json!(repo.resolve(argument(args, 0))?)),
        "metadata" => repo.metadata(
            args[0].as_str().unwrap_or("HEAD~1"),
            args[1].as_str().unwrap_or("HEAD"),
        ),
        "compare" => repo.compare(
            argument(args, 0),
            argument(args, 1),
            args[2]["view"] == "overview",
        ),
        "source" => repo.source(argument(args, 0), argument(args, 1), argument(args, 2)),
        "relationships" => repo.relationships(
            argument(args, 0),
            argument(args, 1),
            argument(args, 2),
            args[3] == "overview",
        ),
        "directories" => repo.directories(argument(args, 0), argument(args, 1)),
        "search" => repo.search(argument(args, 0), argument(args, 1), argument(args, 2)),
        "metrics" => Ok(repo.metrics()),
        _ => anyhow::bail!("Unknown repository operation"),
    }
}
/// Shared HTTP state: repository worker, access token, expiring sessions and launch options.
struct App {
    engine: Engine,
    workflow: workflow::Workflow,
    ask_lock: Arc<Mutex<()>>,
    /// Read-only lookup permission for the Ask answer in progress; `None` between answers.
    ask_grant: std::sync::Mutex<Option<lookup::Grant>>,
    token: String,
    reader_token: String,
    cookie_name: String,
    sessions: Arc<Mutex<sessions::Sessions>>,
    options: Options,
    /// Holds this repository's state folder against other services; released when removed.
    _lock: std::fs::File,
}
/// What every repository on one listener shares: credentials, sessions, and the options a
/// repository added while running starts from.
#[derive(Clone)]
struct Shared {
    options: Options,
    cookie_name: String,
    access_token: String,
    reader_token: String,
    sessions: Arc<Mutex<sessions::Sessions>>,
}
/// One listener with independent repository workers and a shared device session registry.
/// Repositories can be added and removed while it runs; the primary one is fixed.
struct Fleet {
    primary: Arc<App>,
    repositories: std::sync::RwLock<HashMap<String, Arc<App>>>,
    shared: Shared,
    _lock: std::fs::File,
}
impl Fleet {
    fn get(&self, id: &str) -> Option<Arc<App>> {
        self.repositories.read().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
    }
    fn all(&self) -> Vec<(String, Arc<App>)> {
        let map = self.repositories.read().unwrap_or_else(|e| e.into_inner());
        map.iter().map(|(id, app)| (id.clone(), app.clone())).collect()
    }
}
/// A repository's stable identifier: the start of a hash of its canonical path.
fn repository_id(directory: &std::path::Path) -> String {
    engine::hash(directory.to_string_lossy().as_bytes())[..16].to_string()
}
/// Options for a repository served beside the primary one: its own private state folder,
/// comparing its latest commit with its parent.
fn repository_options(base: &Options, directory: PathBuf) -> Options {
    let mut options = base.clone();
    options.state_dir = base.state_dir.join("repositories").join(repository_id(&directory));
    options.directory = directory;
    options.base = "HEAD~1".into();
    options.head = "HEAD".into();
    options
}
/// Opens one repository for serving: its analysis worker, its locked private state folder,
/// the watched branch, its workflow store and recovery of interrupted agent runs.
/// `repository` reuses an already opened primary repository.
fn open_repository(
    shared: &Shared,
    config: Options,
    repository: Option<Repository>,
) -> Result<(String, Arc<App>)> {
    let repository = match repository {
        Some(repo) => repo,
        None => Repository::new(
            config.directory.clone(),
            &config.state_dir,
            config.parser_root.clone(),
            config.python.clone(),
            config.node.clone(),
        )?,
    };
    repository.resolve("HEAD")?;
    let id = repository_id(&repository.directory);
    std::fs::create_dir_all(&config.state_dir)?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(config.state_dir.join("workflow-service.lock"))?;
    lock.try_lock()
        .context("Another Peekumi service is using this state directory")?;
    let watched = if config.head == "HEAD" {
        String::from_utf8(
            process::run(
                "git",
                &["symbolic-ref", "-q", "HEAD"],
                Some(&repository.directory),
                vec![],
            )
            .unwrap_or_default(),
        )?
        .trim()
        .to_string()
    } else {
        config.head.clone()
    };
    let workflow = workflow::Workflow::new(
        &repository.directory,
        &config.state_dir,
        if watched.is_empty() {
            &config.head
        } else {
            &watched
        },
        &config.codex,
        &config.claude,
    )?;
    runner::recover(workflow.clone())?;
    let app = Arc::new(App {
        cookie_name: shared.cookie_name.clone(),
        workflow,
        ask_lock: Arc::new(Mutex::new(())),
        ask_grant: std::sync::Mutex::new(None),
        engine: Engine::start(repository),
        token: shared.access_token.clone(),
        reader_token: shared.reader_token.clone(),
        sessions: shared.sessions.clone(),
        options: config,
        _lock: lock,
    });
    Ok((id, app))
}

/// The loopback origin of this listener, set once after binding. Ask's lookup client connects
/// here; an unspecified bind address (0.0.0.0 or ::) is reached through loopback.
static LOCAL_ORIGIN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
fn local_origin() -> Option<&'static str> {
    LOCAL_ORIGIN.get().map(String::as_str)
}
fn loopback_origin(address: std::net::SocketAddr) -> String {
    let ip = match address.ip() {
        std::net::IpAddr::V4(ip) if ip.is_unspecified() => std::net::Ipv4Addr::LOCALHOST.into(),
        std::net::IpAddr::V6(ip) if ip.is_unspecified() => std::net::Ipv6Addr::LOCALHOST.into(),
        ip => ip,
    };
    format!("http://{}", std::net::SocketAddr::new(ip, address.port()))
}
/// Serves Ask's read-only lookup tools over Streamable HTTP MCP. Only the key of an answer in
/// progress is accepted; it never authenticates any other route and ends with the answer.
async fn ask_lookup(fleet: &Fleet, request: Request, gzip: bool) -> Response {
    if request.method() != Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Use POST", gzip).await;
    }
    let key = header(request.headers(), "authorization")
        .strip_prefix("Bearer ")
        .unwrap_or("");
    let app = fleet.all().into_iter().map(|(_, app)| app).find(|app| {
        !key.is_empty()
            && app
                .ask_grant
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .is_some_and(|grant| equal(key, &grant.key))
    });
    let Some(app) = app else {
        return error(StatusCode::UNAUTHORIZED, "No Ask answer is in progress", gzip).await;
    };
    let body = match to_bytes(request.into_body(), 65536).await {
        Ok(body) => body,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "Request too large", gzip).await,
    };
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, "Invalid JSON", gzip).await;
    };
    match lookup::handle(&app, message).await {
        Some(reply) => json_response(StatusCode::OK, reply, gzip, None).await,
        None => respond(StatusCode::ACCEPTED, "application/json", vec![], gzip, None).await,
    }
}
/// Generates 32 random bytes encoded as hexadecimal for access and session tokens.
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
/// Compares token bytes with the constant-time equality primitive; unequal lengths are rejected.
fn equal(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}
/// Reads a valid UTF-8 request header, returning an empty string when missing or invalid.
fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}
/// Returns an embedded frontend asset from the fixed public route allowlist.
/// Unknown paths return None rather than reading arbitrary files from disk.
fn asset(path: &str) -> Option<(&'static str, &'static [u8])> {
    match path {
        "/" => Some(("text/html", include_bytes!("../frontend/index.html"))),
        "/app.js" => Some(("text/javascript", include_bytes!("../frontend/app.js"))),
        "/icons.js" => Some(("text/javascript", include_bytes!("../frontend/icons.js"))),
        "/model.js" => Some(("text/javascript", include_bytes!("../frontend/model.js"))),
        "/ask.js" => Some(("text/javascript", include_bytes!("../frontend/ask.js"))),
        "/workflow.js" => Some(("text/javascript", include_bytes!("../frontend/workflow.js"))),
        "/canvas.js" => Some(("text/javascript", include_bytes!("../frontend/canvas.js"))),
        "/select.js" => Some(("text/javascript", include_bytes!("../frontend/select.js"))),
        "/text.js" => Some(("text/javascript", include_bytes!("../frontend/text.js"))),
        "/peek.js" => Some(("text/javascript", include_bytes!("../frontend/peek.js"))),
        "/style.css" => Some(("text/css", include_bytes!("../frontend/style.css"))),
        "/manifest.webmanifest" => Some((
            "application/manifest+json",
            include_bytes!("../frontend/manifest.webmanifest"),
        )),
        "/pwa.js" => Some(("text/javascript", include_bytes!("../frontend/pwa.js"))),
        "/icon-192.png" => Some(("image/png", include_bytes!("../frontend/icon-192.png"))),
        "/icon-512.png" => Some(("image/png", include_bytes!("../frontend/icon-512.png"))),
        "/favicon.svg" => Some(("image/svg+xml", include_bytes!("../frontend/favicon.svg"))),
        _ => None,
    }
}
/// Checks explicit gzip acceptance and honors a zero quality value as an opt-out.
fn gzip_accepted(headers: &HeaderMap) -> bool {
    header(headers, "accept-encoding").split(',').any(|entry| {
        let entry = entry.to_lowercase();
        let mut parts = entry.trim().split(';');
        if parts.next().unwrap_or("").trim().to_lowercase() != "gzip" {
            return false;
        }
        let quality = parts.find_map(|p| p.trim().strip_prefix("q=").map(str::to_string));
        quality.is_none_or(|q| q.parse::<f64>().is_ok_and(|v| v > 0.0))
    })
}
/// Constructs an HTTP response with private-cache and browser security headers.
/// Compresses accepted bodies of at least 1 KiB on the blocking pool and optionally sets a session cookie.
/// Encoding failures produce an internal-server-error response.
async fn respond(
    status: StatusCode,
    kind: &str,
    body: Vec<u8>,
    gzip: bool,
    cookie: Option<String>,
) -> Response {
    let compressed = gzip && body.len() >= 1024;
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
        if !compressed {
            return Ok(body);
        }
        let mut encoder = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
        encoder.write_all(&body)?;
        encoder.finish()
    })
    .await;
    let (body, status, compressed) = match result {
        Ok(Ok(body)) => (body, status, compressed),
        _ => (
            b"{\"error\":\"Response encoding failed\"}".to_vec(),
            StatusCode::INTERNAL_SERVER_ERROR,
            false,
        ),
    };
    let length = body.len();
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    for (name, value) in [
        ("content-type", kind),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        ("cache-control", "no-store"),
        ("vary", "Accept-Encoding"),
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    ] {
        headers.insert(
            axum::http::HeaderName::from_static(name),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    headers.insert("content-length", length.into());
    if compressed {
        headers.insert("content-encoding", HeaderValue::from_static("gzip"));
    }
    if let Some(cookie) = cookie {
        headers.insert("set-cookie", HeaderValue::from_str(&cookie).unwrap());
    }
    response
}
/// Serializes a JSON API result and sends it through the common response/header policy.
async fn json_response(
    status: StatusCode,
    value: Value,
    gzip: bool,
    cookie: Option<String>,
) -> Response {
    respond(
        status,
        "application/json",
        value.to_string().into_bytes(),
        gzip,
        cookie,
    )
    .await
}
/// Where a repository keeps the Ask conversation for one branch (or commit, when the view is
/// detached): a private file named by a hash of the branch, so any ref name is safe. The
/// watched branch is used when none is given. `None` for an unusable branch name.
fn ask_history_file(app: &App, branch: Option<&str>) -> Option<PathBuf> {
    let branch = branch.unwrap_or(&app.workflow.watched);
    if branch.is_empty() || branch.len() > 256 || branch.contains('\0') {
        return None;
    }
    let id = &engine::hash(branch.as_bytes())[..16];
    Some(app.options.state_dir.join("ask-history").join(format!("{id}.json")))
}
/// Keeps one branch's Ask conversation in the repository's private state folder, so reloading
/// the page, updating the app or switching device does not lose it. Accepts at most 100
/// messages; the request size limit bounds the rest. Writes a private file atomically.
fn save_ask_history(file: &std::path::Path, body: &Value) -> Result<()> {
    let messages = body["messages"]
        .as_array()
        .context("Missing messages")?;
    ensure!(messages.len() <= 100, "Too many messages");
    ensure!(
        messages
            .iter()
            .all(|m| ["user", "assistant"].contains(&m["role"].as_str().unwrap_or(""))
                && m["text"].is_string()),
        "Invalid message"
    );
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let staged = file.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut out = options.open(&staged)?;
    std::io::Write::write_all(&mut out, json!({"messages": messages}).to_string().as_bytes())?;
    out.sync_all()?;
    std::fs::rename(&staged, file)?;
    Ok(())
}
/// Formats an API failure as a JSON error using the supplied HTTP status.
async fn error(code: StatusCode, message: &str, gzip: bool) -> Response {
    json_response(code, json!({"error":message}), gzip, None).await
}
/// Serves assets, pairs sessions, and authenticates inspection and owner workflow requests.
/// Rejects cross-origin writes before dispatching blocking repository or workflow operations.
async fn handle(State(fleet): State<Arc<Fleet>>, request: Request) -> Response {
    let app = fleet.primary.clone();
    let gzip = gzip_accepted(request.headers());
    let path = request.uri().path().to_string();
    if request.method() == Method::GET && path == "/sw.js" {
        let assets: Vec<u8> = [
            "/",
            "/app.js",
            "/icons.js",
            "/model.js",
            "/ask.js",
            "/workflow.js",
            "/canvas.js",
            "/select.js",
            "/text.js",
            "/peek.js",
            "/style.css",
            "/pwa.js",
            "/manifest.webmanifest",
            "/favicon.svg",
            "/icon-192.png",
            "/icon-512.png",
        ]
        .iter()
        .flat_map(|path| asset(path).unwrap().1.iter().copied())
        .chain(include_bytes!("../frontend/sw.js").iter().copied())
        .collect();
        let script = include_str!("../frontend/sw.js")
            .replace("__PEEKUMI_BUILD__", &engine::hash(&assets)[..16]);
        return respond(
            StatusCode::OK,
            "text/javascript",
            script.into_bytes(),
            gzip,
            None,
        )
        .await;
    }
    if request.method() == Method::GET
        && let Some((kind, bytes)) = asset(&path)
    {
        return respond(StatusCode::OK, kind, bytes.to_vec(), gzip, None).await;
    }
    if path == "/mcp/ask" {
        return ask_lookup(&fleet, request, gzip).await;
    }
    if request.method() == Method::POST && path == "/api/session" {
        let origin = header(request.headers(), "origin");
        if !origin.is_empty() {
            let valid = url::Url::parse(origin).ok().is_some_and(|url| {
                let host = url.host_str().unwrap_or("");
                let host = if let Some(port) = url.port() {
                    format!("{host}:{port}")
                } else {
                    host.into()
                };
                host == header(request.headers(), "host")
            });
            if !valid {
                return error(StatusCode::FORBIDDEN, "Origin rejected", gzip).await;
            }
        }
        let body = match to_bytes(request.into_body(), 2048).await {
            Ok(body) => body,
            Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "Request too large", gzip).await,
        };
        let payload: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid JSON", gzip).await,
        };
        let supplied = payload["token"].as_str().unwrap_or("");
        let role = if equal(supplied, &app.token) {
            "owner"
        } else if equal(supplied, &app.reader_token) {
            "reader"
        } else {
            return error(
                StatusCode::UNAUTHORIZED,
                "Access token not recognised",
                gzip,
            )
            .await;
        };
        let session = random_token();
        if let Err(e) = app.sessions.lock().await.insert_device(
            &session,
            role,
            payload["name"].as_str().unwrap_or("Browser"),
        ) {
            eprintln!("Unable to save browser session: {e}");
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Unable to save browser session",
                gzip,
            )
            .await;
        }
        let cookie = format!(
            "{}={session}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}{}",
            app.cookie_name,
            sessions::MAX_AGE,
            if app.options.secure_cookie {
                "; Secure"
            } else {
                ""
            }
        );
        return json_response(StatusCode::OK, json!({"ok":true}), gzip, Some(cookie)).await;
    }
    let bearer = header(request.headers(), "authorization")
        .strip_prefix("Bearer ")
        .unwrap_or("");
    // The current cookie wins; one saved before the rename is only a fallback, so a stale
    // former cookie left in the browser cannot shadow a fresh pairing.
    let cookies: Vec<&str> = header(request.headers(), "cookie")
        .split(';')
        .map(str::trim)
        .collect();
    let named = |name: String| {
        let prefix = format!("{name}=");
        cookies.iter().find_map(|c| c.strip_prefix(&prefix))
    };
    let session = named(app.cookie_name.clone())
        .or_else(|| named(app.cookie_name.replacen("peekumi_", "strata_", 1)))
        .unwrap_or("");
    let role = if equal(bearer, &app.token) {
        Some("owner".to_string())
    } else if equal(bearer, &app.reader_token) {
        Some("reader".to_string())
    } else {
        app.sessions.lock().await.role(session).map(str::to_string)
    };
    let Some(role) = role else {
        return error(
            StatusCode::UNAUTHORIZED,
            "Connect with the access link printed by Peekumi",
            gzip,
        )
        .await;
    };
    if role == "reader"
        && (request.method() != Method::GET
            || path == "/api/devices"
            || path == "/api/workflow"
            || path == "/api/ask/history"
            || path.starts_with("/api/runs")
            || path.starts_with("/api/comments"))
    {
        return error(
            StatusCode::FORBIDDEN,
            "This device has read-only access",
            gzip,
        )
        .await;
    }
    if path == "/api/devices" && request.method() == Method::GET {
        return json_response(
            StatusCode::OK,
            app.sessions.lock().await.devices(),
            gzip,
            None,
        )
        .await;
    }
    if path.starts_with("/api/devices/") && request.method() == Method::DELETE {
        let origin = header(request.headers(), "origin");
        if header(request.headers(), "sec-fetch-site") == "cross-site"
            || (!origin.is_empty()
                && url::Url::parse(origin).ok().is_none_or(|u| {
                    u[url::Position::BeforeHost..url::Position::AfterPort]
                        != *header(request.headers(), "host")
                }))
        {
            return error(StatusCode::FORBIDDEN, "Origin rejected", gzip).await;
        }
        return match app
            .sessions
            .lock()
            .await
            .revoke(path.trim_start_matches("/api/devices/"))
        {
            Ok(()) => json_response(StatusCode::OK, json!({"ok":true}), gzip, None).await,
            Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string(), gzip).await,
        };
    }
    // Serving another repository exposes more of this Mac, so only the owner access token held
    // by the local `peekumi` command may change the set; paired devices cannot.
    if (path == "/api/repositories" && request.method() == Method::POST)
        || (path.starts_with("/api/repositories/") && request.method() == Method::DELETE)
    {
        if !equal(bearer, &app.token) {
            return error(
                StatusCode::FORBIDDEN,
                "Repositories are added and removed with the peekumi command on the host",
                gzip,
            )
            .await;
        }
        if request.method() == Method::DELETE {
            let id = path.trim_start_matches("/api/repositories/").to_string();
            let Some(repo) = fleet.get(&id) else {
                return error(StatusCode::NOT_FOUND, "Repository is not registered", gzip).await;
            };
            if Arc::ptr_eq(&repo, &fleet.primary) {
                return error(
                    StatusCode::CONFLICT,
                    "The first repository changes only when Peekumi restarts",
                    gzip,
                )
                .await;
            }
            let busy = repo.workflow.read().ok().is_some_and(|v| {
                v["runs"]
                    .as_array()
                    .is_some_and(|runs| runs.iter().any(workflow::active))
            });
            if busy {
                return error(
                    StatusCode::CONFLICT,
                    "An agent run is still active in this repository",
                    gzip,
                )
                .await;
            }
            fleet
                .repositories
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return json_response(StatusCode::OK, json!({"id":id,"removed":true}), gzip, None).await;
        }
        let body = match to_bytes(request.into_body(), 4096).await {
            Ok(body) => body,
            Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "Request too large", gzip).await,
        };
        let requested = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|v| v["path"].as_str().map(PathBuf::from));
        let Some(directory) = requested.and_then(|p| p.canonicalize().ok()) else {
            return error(StatusCode::BAD_REQUEST, "Give the path of a repository on this Mac", gzip).await;
        };
        let name = directory.file_name().unwrap_or_default().to_string_lossy().to_string();
        let id = repository_id(&directory);
        if fleet.get(&id).is_some() {
            return json_response(StatusCode::OK, json!({"id":id,"name":name,"added":false}), gzip, None).await;
        }
        let shared = fleet.shared.clone();
        let opened = tokio::task::spawn_blocking(move || {
            open_repository(&shared, repository_options(&shared.options, directory), None)
        })
        .await;
        return match opened {
            Ok(Ok((id, repo))) => {
                fleet
                    .repositories
                    .write()
                    .unwrap_or_else(|e| e.into_inner())
                    .entry(id.clone())
                    .or_insert(repo);
                json_response(StatusCode::OK, json!({"id":id,"name":name,"added":true}), gzip, None).await
            }
            Ok(Err(e)) => error(StatusCode::BAD_REQUEST, &format!("{e:#}"), gzip).await,
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Opening the repository failed", gzip).await,
        };
    }
    if path == "/api/repositories" && request.method() == Method::GET {
        let mut repos: Vec<Value> = fleet.all().iter().map(|(id, repo)| json!({
            "id": id, "name": repo.options.directory.file_name().unwrap_or_default().to_string_lossy(),
            "path": repo.options.directory, "default": Arc::ptr_eq(repo, &fleet.primary)
        })).collect();
        repos.sort_by_key(|r| r["path"].as_str().unwrap_or("").to_string());
        return json_response(
            StatusCode::OK,
            json!({"repositories": repos, "role": role}),
            gzip,
            None,
        )
        .await;
    }
    // The former header name still works for pages loaded before the rename.
    let selected = match header(request.headers(), "x-peekumi-repository") {
        "" => header(request.headers(), "x-strata-repository"),
        name => name,
    };
    let app = if selected.is_empty() {
        app
    } else {
        match fleet.get(selected) {
            Some(repo) => repo,
            None => {
                return error(StatusCode::NOT_FOUND, "Repository is not registered", gzip).await;
            }
        }
    };
    if path == "/api/ask"
        || path == "/api/ask/history"
        || path == "/api/workflow"
        || path == "/api/prs"
        || path.starts_with("/api/prs/")
        || path.starts_with("/api/comments")
        || path.starts_with("/api/runs")
    {
        let method = request.method().to_string();
        // Ask conversations are kept per branch; the query names the branch viewed.
        let branch = url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .find(|(key, _)| key == "branch")
            .map(|(_, value)| value.into_owned());
        if method != "GET" {
            let origin = header(request.headers(), "origin");
            let valid_origin = origin.is_empty()
                || url::Url::parse(origin).ok().is_some_and(|url| {
                    let authority = match url.port() {
                        Some(p) => format!("{}:{p}", url.host_str().unwrap_or("")),
                        None => url.host_str().unwrap_or("").into(),
                    };
                    authority == header(request.headers(), "host")
                });
            if !valid_origin
                || header(request.headers(), "sec-fetch-site") == "cross-site"
                || !header(request.headers(), "content-type").starts_with("application/json")
            {
                return error(StatusCode::FORBIDDEN, "Same-origin JSON required", gzip).await;
            }
        }
        let bytes = match to_bytes(request.into_body(), 131072).await {
            Ok(b) => b,
            Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "Request too large", gzip).await,
        };
        let body = if bytes.is_empty() {
            json!({})
        } else {
            match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid JSON", gzip).await,
            }
        };
        if path.starts_with("/api/prs") {
            let directory = app.options.directory.clone();
            let github = app.options.github.clone();
            let route = path.clone();
            return match tokio::task::spawn_blocking(move || {
                pull_requests::route(&directory, &github, &method, &route, body)
            })
            .await
            {
                Ok(Ok(value)) => json_response(StatusCode::OK, value, gzip, None).await,
                Ok(Err(e)) => error(StatusCode::BAD_REQUEST, &e.to_string(), gzip).await,
                Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "PR lookup failed", gzip).await,
            };
        }
        if path == "/api/ask/history" {
            let Some(file) = ask_history_file(&app, branch.as_deref()) else {
                return error(StatusCode::BAD_REQUEST, "Invalid branch", gzip).await;
            };
            return match method.as_str() {
                "GET" => {
                    let read = |file: &std::path::Path| {
                        std::fs::read(file)
                            .ok()
                            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                            .filter(|v| v["messages"].is_array())
                    };
                    // The watched branch keeps the single conversation saved before conversations
                    // were kept per branch.
                    let watched = branch.as_deref().is_none_or(|b| b == app.workflow.watched);
                    let saved = read(&file)
                        .or_else(|| {
                            watched
                                .then(|| read(&app.options.state_dir.join("ask-history.json")))
                                .flatten()
                        })
                        .unwrap_or_else(|| json!({"messages": []}));
                    json_response(StatusCode::OK, json!({"messages": saved["messages"]}), gzip, None).await
                }
                "PUT" => match save_ask_history(&file, &body) {
                    Ok(()) => json_response(StatusCode::OK, json!({"ok": true}), gzip, None).await,
                    Err(e) => error(StatusCode::BAD_REQUEST, &e.to_string(), gzip).await,
                },
                _ => error(StatusCode::METHOD_NOT_ALLOWED, "Use GET or PUT", gzip).await,
            };
        }
        if path == "/api/ask" {
            if method != "POST" {
                return error(StatusCode::METHOD_NOT_ALLOWED, "Use POST for Ask", gzip).await;
            }
            let Ok(ask_guard) = app.ask_lock.clone().try_lock_owned() else {
                return error(
                    StatusCode::CONFLICT,
                    "An Ask answer is already in progress",
                    gzip,
                )
                .await;
            };
            if body["stream"] == true {
                // Newline-delimited JSON events while Claude writes; the guard lives with the task.
                let (events, received) = mpsc::channel::<Value>(64);
                let app = app.clone();
                tokio::spawn(async move {
                    let _guard = ask_guard;
                    ask::answer_stream(app, body, events).await;
                });
                let lines = tokio_stream::wrappers::ReceiverStream::new(received).map(|event| {
                    Ok::<_, std::convert::Infallible>(format!("{event}\n"))
                });
                return Response::builder()
                    .header("content-type", "application/x-ndjson")
                    .header("cache-control", "no-store")
                    .header("x-content-type-options", "nosniff")
                    .header("referrer-policy", "no-referrer")
                    .header("x-frame-options", "DENY")
                    .body(Body::from_stream(lines))
                    .unwrap();
            }
            let _ask_guard = ask_guard;
            return match ask::answer(&app, body).await {
                Ok(value) => json_response(StatusCode::OK, value, gzip, None).await,
                Err(e) => error(StatusCode::BAD_REQUEST, &e.to_string(), gzip).await,
            };
        }
        let store = app.workflow.clone();
        return match tokio::task::spawn_blocking(move || store.route(&method, &path, body)).await {
            Ok(Ok(v)) => json_response(StatusCode::OK, v, gzip, None).await,
            Ok(Err(e)) => error(StatusCode::BAD_REQUEST, &e.to_string(), gzip).await,
            Err(_) => {
                error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Workflow worker failed",
                    gzip,
                )
                .await
            }
        };
    }
    if request.method() != Method::GET {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Unsupported method", gzip).await;
    }
    let query: HashMap<_, _> =
        url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let base = query
        .get("base")
        .filter(|v| !v.is_empty())
        .unwrap_or(&app.options.base);
    let head = query
        .get("head")
        .filter(|v| !v.is_empty())
        .unwrap_or(&app.options.head);
    let result = match path.as_str() {
        "/api/repo" => app.engine.call("metadata", json!([base, head])).await,
        "/api/compare" => {
            app.engine
                .call("compare", json!([base,head,{"view":query.get("view")}]))
                .await
        }
        "/api/relationships" => {
            app.engine
                .call(
                    "relationships",
                    json!([base, head, query.get("path"), query.get("view")]),
                )
                .await
        }
        "/api/directories" => app.engine.call("directories", json!([base, head])).await,
        "/api/source" => {
            app.engine
                .call("source", json!([base, head, query.get("path")]))
                .await
        }
        _ => return error(StatusCode::NOT_FOUND, "Not found", gzip).await,
    };
    match result {
        Ok(value) => json_response(StatusCode::OK, value, gzip, None).await,
        Err(message) => error(StatusCode::BAD_REQUEST, &message, gzip).await,
    }
}
/// Loads an explicit token or reuses the token stored in the private state directory.
/// Creates a new owner-readable token file when absent; empty tokens and filesystem failures are errors.
fn token(options: &Options) -> Result<String> {
    if let Some(token) = &options.token {
        anyhow::ensure!(!token.is_empty(), "Empty token");
        return Ok(token.clone());
    }
    std::fs::create_dir_all(&options.state_dir)?;
    let path = options.state_dir.join("access-token");
    match std::fs::read_to_string(&path) {
        Ok(value) => {
            anyhow::ensure!(!value.trim().is_empty(), "Empty access token");
            Ok(value.trim().into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let value = random_token();
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(path)?.write_all(value.as_bytes())?;
            Ok(value)
        }
        Err(e) => Err(e.into()),
    }
}
/// Copies each former `STRATA_*` setting to its `PEEKUMI_*` name when that is unset, so
/// configurations from before the rename keep working.
fn adopt_former_settings() {
    for (key, value) in std::env::vars_os() {
        let Some(rest) = key.to_str().and_then(|k| k.strip_prefix("STRATA_")) else {
            continue;
        };
        let current = format!("PEEKUMI_{rest}");
        if std::env::var_os(&current).is_none() {
            // SAFETY: runs first in main, before the runtime or any other thread starts.
            unsafe { std::env::set_var(current, value) };
        }
    }
}
fn main() -> Result<()> {
    adopt_former_settings();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(serve())
}
/// Starts the configured repository service or the internal line-oriented test protocol.
/// Validates HEAD before serving, binds the listener and prints the local pairing link.
/// Returns startup, configuration, repository or listener errors.
async fn serve() -> Result<()> {
    let mut options = Options::parse();
    // Before the rename the default state directory was `.strata`; keep using it if present.
    if options.state_dir == std::path::Path::new(".peekumi")
        && !options.state_dir.exists()
        && std::path::Path::new(".strata").is_dir()
    {
        options.state_dir = ".strata".into();
    }
    options.directory = options.directory.canonicalize().context("Cannot open repository directory")?;
    if let Some(id) = &options.report_run {
        let store = workflow::Workflow::new(
            &options.directory,
            &options.state_dir,
            &options.head,
            &options.codex,
            &options.claude,
        )?;
        return runner::mcp(store, id);
    }
    let mut repo = Repository::new(
        options.directory.clone(),
        &options.state_dir,
        options.parser_root.clone(),
        options.python.clone(),
        options.node.clone(),
    )?;
    repo.resolve("HEAD")?;
    if options.stdio {
        for line in std::io::stdin().lock().lines() {
            let line = line?;
            let response = (|| -> Result<Value> {
                let request: Value = serde_json::from_str(&line)?;
                let result = dispatch(
                    &mut repo,
                    request["method"].as_str().context("Missing method")?,
                    &request["args"],
                );
                Ok(match result {
                    Ok(value) => json!({"id":request["id"],"result":value}),
                    Err(error) => json!({"id":request["id"],"error":error.to_string()}),
                })
            })();
            println!(
                "{}",
                response.unwrap_or_else(|e| json!({"error":e.to_string()}))
            );
        }
        return Ok(());
    }
    let access_token = token(&options)?;
    let server_lock = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(options.state_dir.join("server.lock"))?;
    server_lock.try_lock().context("Another Peekumi server is using this state directory")?;
    let mut reader_options = options.clone();
    reader_options.token = None;
    reader_options.state_dir = options.state_dir.join("read-only");
    let reader_token = token(&reader_options)?;
    // A stable identity names the session cookie and binds saved sessions, so moving the
    // repository or state folder does not sign devices out. It is derived once from the path
    // the cookie used before, then kept in the state folder.
    let identity_path = options.state_dir.join("instance-id");
    let identity = match std::fs::read_to_string(&identity_path) {
        Ok(saved) if saved.trim().len() == 12 => saved.trim().to_string(),
        _ => {
            let binding = if options.isolate_primary {
                options.state_dir.canonicalize()?
            } else {
                repo.directory.clone()
            };
            let derived = engine::hash(binding.to_string_lossy().as_bytes())[..12].to_string();
            std::fs::write(&identity_path, &derived)?;
            derived
        }
    };
    let cookie_name = format!("peekumi_session_{identity}");
    let shared_sessions = Arc::new(Mutex::new(sessions::Sessions::load(
        options.state_dir.join("sessions.json"),
        &access_token,
        &cookie_name,
    )?));
    let mut primary_options = options.clone();
    if options.isolate_primary {
        primary_options.state_dir = options
            .state_dir
            .join("repositories")
            .join(&engine::hash(repo.directory.to_string_lossy().as_bytes())[..16]);
        repo = Repository::new(
            options.directory.clone(),
            &primary_options.state_dir,
            options.parser_root.clone(),
            options.python.clone(),
            options.node.clone(),
        )?;
    }
    let shared = Shared {
        options: options.clone(),
        cookie_name: cookie_name.clone(),
        access_token: access_token.clone(),
        reader_token: reader_token.clone(),
        sessions: shared_sessions.clone(),
    };
    let (primary_id, primary) = open_repository(&shared, primary_options, Some(repo))?;
    let mut repositories = HashMap::from([(primary_id, primary.clone())]);
    for directory in &options.repositories {
        let directory = directory
            .canonicalize()
            .context("Cannot open registered repository")?;
        if repositories.contains_key(&repository_id(&directory)) {
            continue;
        }
        let (id, app) = open_repository(&shared, repository_options(&options, directory), None)?;
        repositories.insert(id, app);
    }
    let listener = tokio::net::TcpListener::bind((options.host.as_str(), options.port)).await?;
    let address = listener.local_addr()?;
    let _ = LOCAL_ORIGIN.set(loopback_origin(address));
    println!(
        "Peekumi · Rust\nOpen: http://{address}/#token={access_token}\nPEEKUMI_READY {}",
        json!({"port":address.port()})
    );
    let fleet = Arc::new(Fleet {
        primary,
        repositories: std::sync::RwLock::new(repositories),
        shared,
        _lock: server_lock,
    });
    axum::serve(listener, Router::new().fallback(handle).with_state(fleet))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lookup_origin_uses_loopback_for_unspecified_binds() {
        assert_eq!(loopback_origin("0.0.0.0:4319".parse().unwrap()), "http://127.0.0.1:4319");
        assert_eq!(loopback_origin("[::]:4319".parse().unwrap()), "http://[::1]:4319");
        assert_eq!(loopback_origin("100.64.0.2:80".parse().unwrap()), "http://100.64.0.2:80");
    }
    #[test]
    fn compression_respects_explicit_opt_out() {
        for (value, expected) in [
            ("gzip", true),
            ("br, gzip;q=0", false),
            ("gzip;q=0.5", true),
            ("identity", false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("accept-encoding", HeaderValue::from_str(value).unwrap());
            assert_eq!(gzip_accepted(&headers), expected);
        }
    }
    #[test]
    fn token_comparison_handles_different_byte_lengths() {
        assert!(equal("token", "token"));
        assert!(!equal("é", "aa"));
        assert!(!equal("", "token"));
    }
}
