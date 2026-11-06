//! Scoped integration transport. Inspection stays on the repository worker.
use super::*;

/// Authorizes one registered repository and rejects routes outside the allowlist.
/// POSTs change private analysis state only. Checkout files remain read-only.
pub(super) async fn integration_request(
    fleet: Arc<Fleet>,
    request: Request,
    gzip: bool,
) -> Response {
    let bearer = header(request.headers(), "authorization")
        .strip_prefix("Bearer ")
        .unwrap_or("");
    let grant = match integration_tokens::authenticate(&fleet.shared.options.state_dir, bearer) {
        Ok(Some(grant)) => grant,
        Ok(None) => {
            return error(
                StatusCode::UNAUTHORIZED,
                "Integration token not recognised",
                gzip,
            )
            .await;
        }
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Integration credentials unavailable",
                gzip,
            )
            .await;
        }
    };
    let path = request.uri().path().to_string();
    let method = request.method().to_string();
    if !integration_tokens::allows(&method, &path) {
        return error(
            StatusCode::FORBIDDEN,
            "Token is limited to integration analysis",
            gzip,
        )
        .await;
    }
    if !header(request.headers(), "origin").is_empty()
        || header(request.headers(), "sec-fetch-site") == "cross-site"
    {
        return error(
            StatusCode::FORBIDDEN,
            "Use the server-side integration client",
            gzip,
        )
        .await;
    }
    let query: HashMap<String, String> =
        url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let selected = header(request.headers(), "x-peekumi-repository").to_string();
    let body: Value = if method == "POST" {
        if !header(request.headers(), "content-type").starts_with("application/json") {
            return error(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Use application/json",
                gzip,
            )
            .await;
        }
        let bytes = match to_bytes(request.into_body(), 8 * 1024 * 1024).await {
            Ok(bytes) => bytes,
            Err(_) => {
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Integration request exceeds 8 MiB",
                    gzip,
                )
                .await;
            }
        };
        match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid JSON", gzip).await,
        }
    } else {
        json!({})
    };
    let repo = body["repo"]
        .as_str()
        .or_else(|| query.get("repo").map(String::as_str))
        .unwrap_or("");
    if repo != grant.repository
        || (!selected.is_empty() && selected != repo)
        || query.get("repo").is_some_and(|v| v != repo)
    {
        return error(
            StatusCode::FORBIDDEN,
            "Token is scoped to another repository",
            gzip,
        )
        .await;
    }
    let Some(app) = fleet.get(repo) else {
        return error(StatusCode::NOT_FOUND, "Repository is not registered", gzip).await;
    };
    let result = match path.as_str() {
        "/api/integrations/baseline" if body["action"] == "release" => app.engine.call("integration_release", json!([body["profile"],body["session"]])).await,
        "/api/integrations/baseline" => app.engine.call("integration_baseline", json!([{
            "profile":body["profile"], "session":body["session"], "turn":body["turn"], "repository":repo
        }])).await,
        _ => return json_response(StatusCode::SERVICE_UNAVAILABLE, json!({"status":"unavailable","limits":["This integration operation is not installed yet"]}), gzip, None).await,
    };
    match result {
        Ok(mut value) => {
            value["status"] = json!("incomplete");
            value["limits"] = json!(["Baseline captured; analysis has not run"]);
            json_response(StatusCode::OK, value, gzip, None).await
        }
        Err(message) => error(StatusCode::BAD_REQUEST, &message, gzip).await,
    }
}
