//! Scoped integration transport. Inspection stays on the repository worker.
use super::*;
use base64::Engine as _;

/// Keeps omission details below common HTTP header limits and counts the rest.
fn limits_header(limits: &Value) -> String {
    const MAX_HEADER: usize = 4096;
    let encode =
        |value: &Value| base64::engine::general_purpose::STANDARD.encode(value.to_string());
    let full = encode(limits);
    if full.len() <= MAX_HEADER {
        return full;
    }
    let all = limits.as_array().map(Vec::as_slice).unwrap_or_default();
    let summary = |count| {
        json!(format!(
            "{count} additional export omissions not listed in the header"
        ))
    };
    let mut shown = vec![];
    for item in all {
        let mut candidate = shown.clone();
        candidate.push(item.clone());
        candidate.push(summary(all.len() - candidate.len()));
        if encode(&json!(candidate)).len() > MAX_HEADER {
            break;
        }
        shown.push(item.clone());
    }
    shown.push(summary(all.len() - shown.len()));
    encode(&json!(shown))
}

async fn error(code: StatusCode, message: &str, gzip: bool) -> Response {
    json_response(
        code,
        json!({"status":"unavailable","limits":[message],"error":message}),
        gzip,
        None,
    )
    .await
}

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
    let baseline = body["baseline"]
        .as_str()
        .or_else(|| query.get("baseline").map(String::as_str))
        .unwrap_or("");
    let threshold = body["threshold"]
        .as_f64()
        .or_else(|| query.get("threshold").and_then(|v| v.parse::<f64>().ok()))
        .unwrap_or(30.0);
    let result = match path.as_str() {
        "/api/integrations/map" => app.engine.call("integration_map",json!([baseline,threshold,query.get("focus")])).await,
        "/api/integrations/baseline" if body["action"] == "exception" => app.engine.call("integration_exception", json!([baseline,threshold,body["finding_id"],body["reason"]])).await,
        "/api/integrations/baseline" if body["action"] == "release" => app.engine.call("integration_release", json!([body["profile"],body["session"]])).await,
        "/api/integrations/baseline" => app.engine.call("integration_baseline", json!([{
            "profile":body["profile"], "session":body["session"], "turn":body["turn"], "repository":repo
        }])).await,
        "/api/integrations/impact" => app.engine.call("integration_impact", json!([baseline,threshold,query.get("focus")])).await,
        "/api/integrations/coverage" => app.engine.call("integration_coverage", json!([baseline,body])).await,
        "/api/integrations/export" => app.engine.call("integration_export", json!([baseline,query.get("snapshot")])).await,
        _ => return json_response(StatusCode::SERVICE_UNAVAILABLE, json!({"status":"unavailable","limits":["This integration operation is not installed yet"]}), gzip, None).await,
    };
    match result {
        Ok(mut value) => {
            if path == "/api/integrations/export" {
                let bytes = match base64::engine::general_purpose::STANDARD
                    .decode(value["archive"].as_str().unwrap_or(""))
                {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        return error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "Snapshot export encoding failed",
                            gzip,
                        )
                        .await;
                    }
                };
                let mut response =
                    respond(StatusCode::OK, "application/x-tar", bytes, false, None).await;
                for (name, field) in [
                    ("x-peekumi-run-id", "run_id"),
                    ("x-peekumi-snapshot", "snapshot"),
                    ("x-peekumi-status", "status"),
                ] {
                    if let Ok(header) = HeaderValue::from_str(value[field].as_str().unwrap_or("")) {
                        response.headers_mut().insert(name, header);
                    }
                }
                let encoded = limits_header(&value["limits"]);
                response
                    .headers_mut()
                    .insert("x-peekumi-limits", HeaderValue::from_str(&encoded).unwrap());
                return response;
            }
            if value.get("status").is_none() {
                value["status"] = json!("incomplete");
                value["limits"] = json!(["Baseline state saved; analysis has not run"]);
            }
            json_response(StatusCode::OK, value, gzip, None).await
        }
        Err(message) => error(StatusCode::BAD_REQUEST, &message, gzip).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_limits_are_bounded_without_silent_omissions() {
        for count in [1, 600, 5000] {
            let limits: Vec<_> = (0..count)
                .map(|i| format!("Export omitted {i}/{}: symlink", "長".repeat(2000)))
                .collect();
            let encoded = limits_header(&json!(limits));
            assert!(encoded.len() <= 4096);
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap();
            let value: Value = serde_json::from_slice(&decoded).unwrap();
            assert_eq!(
                value,
                json!([format!(
                    "{count} additional export omissions not listed in the header"
                )])
            );
        }
        let limits = json!(["Export omitted link.py: symlink"]);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(limits_header(&limits))
            .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), limits);
        let limits: Vec<_> = (0..600)
            .map(|i| format!("Export omitted {i}: symlink"))
            .collect();
        let encoded = limits_header(&json!(limits));
        assert!(encoded.len() <= 4096);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let shown: Vec<String> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(shown[0], limits[0]);
        assert_eq!(
            shown.last().unwrap(),
            &format!(
                "{} additional export omissions not listed in the header",
                limits.len() - shown.len() + 1
            )
        );
    }
}
