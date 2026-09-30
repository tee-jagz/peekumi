//! Authenticated HTTP API, embedded frontend and repository worker.
mod adapters;
mod ask;
mod engine;
mod index;
mod process;
mod relationships;
mod rules;
mod runner;
mod sessions;
mod workflow;
use anyhow::{Context, Result};
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

#[derive(Parser, Clone)]
#[command(
    name = "strata",
    about = "Explore committed repository structure from your phone"
)]
/// Launch configuration for the repository, listener, private state and installed parser helpers.
struct Options {
    directory: PathBuf,
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
    #[arg(long, default_value = ".strata")]
    state_dir: PathBuf,
    #[arg(long,env="STRATA_PARSER_ROOT",default_value=env!("CARGO_MANIFEST_DIR"))]
    parser_root: PathBuf,
    #[arg(long, env = "STRATA_PYTHON", default_value = "python3")]
    python: String,
    #[arg(long, env = "STRATA_NODE", default_value = "node")]
    node: String,
    #[arg(long, env = "STRATA_TOKEN", hide_env_values = true, hide = true)]
    token: Option<String>,
    #[arg(long, hide = true)]
    stdio: bool,
    /// Installed agent executable; invoked only after an explicit run dispatch.
    #[arg(long, env = "STRATA_CODEX", default_value = "codex")]
    codex: String,
    #[arg(long, env = "STRATA_CLAUDE", default_value = "claude")]
    claude: String,
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
        "metrics" => Ok(repo.metrics()),
        _ => anyhow::bail!("Unknown repository operation"),
    }
}
/// Shared HTTP state: repository worker, access token, expiring sessions and launch options.
struct App {
    engine: Engine,
    workflow: workflow::Workflow,
    ask_lock: Mutex<()>,
    token: String,
    cookie_name: String,
    sessions: Mutex<sessions::Sessions>,
    options: Options,
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
        "/style.css" => Some(("text/css", include_bytes!("../frontend/style.css"))),
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
/// Formats an API failure as a JSON error using the supplied HTTP status.
async fn error(code: StatusCode, message: &str, gzip: bool) -> Response {
    json_response(code, json!({"error":message}), gzip, None).await
}
/// Serves assets, pairs sessions, and authenticates inspection and owner workflow requests.
/// Rejects cross-origin writes before dispatching blocking repository or workflow operations.
async fn handle(State(app): State<Arc<App>>, request: Request) -> Response {
    let gzip = gzip_accepted(request.headers());
    let path = request.uri().path().to_string();
    if request.method() == Method::GET
        && let Some((kind, bytes)) = asset(&path)
    {
        return respond(StatusCode::OK, kind, bytes.to_vec(), gzip, None).await;
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
        if !payload["token"]
            .as_str()
            .is_some_and(|token| equal(token, &app.token))
        {
            return error(
                StatusCode::UNAUTHORIZED,
                "Access token not recognised",
                gzip,
            )
            .await;
        }
        let session = random_token();
        if let Err(e) = app.sessions.lock().await.insert(&session) {
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
    let session = header(request.headers(), "cookie")
        .split(';')
        .find_map(|s| s.trim().strip_prefix(&format!("{}=", app.cookie_name)))
        .unwrap_or("");
    let authenticated = equal(bearer, &app.token) || app.sessions.lock().await.contains(session);
    if !authenticated {
        return error(
            StatusCode::UNAUTHORIZED,
            "Connect with the access link printed by Strata",
            gzip,
        )
        .await;
    }
    if path == "/api/ask"
        || path == "/api/workflow"
        || path.starts_with("/api/comments")
        || path.starts_with("/api/runs")
    {
        let method = request.method().to_string();
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
        if path == "/api/ask" {
            if method != "POST" {
                return error(StatusCode::METHOD_NOT_ALLOWED, "Use POST for Ask", gzip).await;
            }
            let Ok(_ask_guard) = app.ask_lock.try_lock() else {
                return error(
                    StatusCode::CONFLICT,
                    "An Ask answer is already in progress",
                    gzip,
                )
                .await;
            };
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
        "/api/repo" => {
            app.engine
                .call("metadata", json!([base, head]))
                .await
        }
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
#[tokio::main]
/// Starts the configured repository service or the internal line-oriented test protocol.
/// Validates HEAD before serving, binds the listener and prints the local pairing link.
/// Returns startup, configuration, repository or listener errors.
async fn main() -> Result<()> {
    let options = Options::parse();
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
    // The API owns recovery; a second service must not mark a live run interrupted.
    let service_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(options.state_dir.join("workflow-service.lock"))?;
    service_lock
        .try_lock()
        .context("Another Strata service is using this state directory")?;
    let watched = if options.head == "HEAD" {
        String::from_utf8(
            process::run(
                "git",
                &[
                    "-C",
                    repo.directory.to_str().context("Invalid directory")?,
                    "symbolic-ref",
                    "-q",
                    "HEAD",
                ],
                None,
                vec![],
            )
            .unwrap_or_default(),
        )?
        .trim()
        .to_string()
    } else {
        options.head.clone()
    };
    let workflow = workflow::Workflow::new(
        &repo.directory,
        &options.state_dir,
        if watched.is_empty() {
            &options.head
        } else {
            &watched
        },
        &options.codex,
        &options.claude,
    )?;
    runner::recover(workflow.clone())?;
    let listener = tokio::net::TcpListener::bind((options.host.as_str(), options.port)).await?;
    let address = listener.local_addr()?;
    println!(
        "Repo Strata · Rust\nOpen: http://{address}/#token={access_token}\nSTRATA_READY {}",
        json!({"port":address.port()})
    );
    let cookie_name = format!(
        "strata_session_{}",
        &engine::hash(repo.directory.to_string_lossy().as_bytes())[..12]
    );
    let sessions = sessions::Sessions::load(
        options.state_dir.join("sessions.json"),
        &access_token,
        &cookie_name,
    )?;
    let app = Arc::new(App {
        cookie_name,
        workflow,
        ask_lock: Mutex::new(()),
        engine: Engine::start(repo),
        token: access_token,
        sessions: Mutex::new(sessions),
        options,
    });
    axum::serve(listener, Router::new().fallback(handle).with_state(app))
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
