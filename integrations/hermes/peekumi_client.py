"""Bounded HTTP access to the local Peekumi analysis API. No hidden retries."""
import json
import base64
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler


class Unavailable(RuntimeError):
    """Peekumi cannot provide a verified response. Messages contain no credentials."""
    def __init__(self, message, pending_run=None):
        super().__init__(message)
        self.pending_run = pending_run


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise Unavailable("Peekumi redirected the request; check PEEKUMI_URL")


class Client:
    """Use one repository-scoped credential, a timeout and explicit response limits."""
    def __init__(self, url, token, repository, timeout=None):
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise Unavailable("Invalid PEEKUMI_URL")
        if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise Unavailable("Use HTTPS for a remote Peekumi service")
        if not token or not repository:
            raise Unavailable("Configure PEEKUMI_TOKEN and repository_id")
        self.url, self.token, self.repository, self.timeout = url.rstrip("/"), token, repository, timeout
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def call(self, endpoint, body=None, **query):
        """Return JSON or tar bytes. Refuse oversized, redirected or failed responses."""
        if endpoint not in {"baseline", "coverage", "impact", "map", "export"}:
            raise ValueError("Unknown integration operation")
        query = {k: v for k, v in query.items() if v is not None}
        query["repo"] = self.repository
        url = self.url + "/api/integrations/" + endpoint + "?" + urlencode(query)
        headers = {"Authorization": "Bearer " + self.token}
        data = None
        if body is not None:
            data = json.dumps({**body, "repo": self.repository}).encode()
            headers["Content-Type"] = "application/json"
        try:
            # Every operation shares the repository worker. Allow a queued two-revision
            # check plus this request's two scorers (4 x 60 seconds), with headroom.
            timeout = self.timeout if self.timeout is not None else 300
            with self.opener.open(Request(url, data=data, headers=headers), timeout=timeout) as response:
                limit = 64 * 1024 * 1024 if endpoint == "export" else 16 * 1024 * 1024
                raw = response.read(limit + 1)
                if len(raw) > limit:
                    raise Unavailable("Peekumi response exceeds the size limit")
                if endpoint == "export":
                    return {"archive": raw, "run_id": response.headers.get("X-Peekumi-Run-Id"),
                            "snapshot": response.headers.get("X-Peekumi-Snapshot"),
                            "limits": json.loads(base64.b64decode(response.headers.get("X-Peekumi-Limits", "W10=")))}
                return json.loads(raw)
        except HTTPError as exc:
            exc.close()
            raise Unavailable(f"Peekumi returned HTTP {exc.code}") from None
        except (URLError, OSError, ValueError, HTTPException):
            raise Unavailable("Peekumi did not return valid evidence") from None
