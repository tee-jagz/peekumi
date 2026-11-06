"""Profile-scoped Desktop proxy. The Peekumi credential never enters the renderer."""
import importlib.util
import os
from pathlib import Path
import sys

from fastapi import APIRouter, Query
from agent.secret_scope import get_secret
from hermes_cli.config import load_config_readonly
from hermes_constants import get_hermes_home

package_root = Path(__file__).resolve().parents[1]
package_name = __name__ + "_package"
spec = importlib.util.spec_from_file_location(package_name, package_root / "__init__.py", submodule_search_locations=[str(package_root)])
package = importlib.util.module_from_spec(spec)
sys.modules[package_name] = package
spec.loader.exec_module(package)

router = APIRouter()


def context():
    """Resolve current profile settings and secret at request time, never from credential files."""
    home = get_hermes_home().resolve()
    entry = (load_config_readonly() or {}).get("plugins", {}).get("entries", {}).get("peekumi-risk-map", {})
    settings = entry.get("settings", entry.get("config", {}))
    url = os.environ.get("PEEKUMI_URL") or settings.get("peekumi_url", "http://127.0.0.1:4317")
    def client():
        return package.Client(url, get_secret("PEEKUMI_TOKEN"), settings.get("repository_id", ""))
    gate = package.Gate(client, package.Store(home / "plugin-data/peekumi-risk-map"), str(home), settings.get("crap_threshold", 30), settings.get("gate_mode", "nudge"))
    return gate, url


@router.get("/map")
def risk_map(session_id: str = Query(min_length=1, max_length=256), focus: str = Query(default="", max_length=256)):
    """Fetch the focused session's baseline map through the scoped server-side client."""
    gate, url = context()
    state = gate.current(session_id)
    if not state or not state.get("baseline", {}).get("id"):
        return gate.unavailable("No pre-edit baseline for this session in the registered repository")
    if state.get("pending_measurement"):
        return gate.unavailable("Measurement evidence is waiting for submission; call peekumi_measure to resume")
    try:
        result = gate.client().call("map", baseline=state["baseline"]["id"], focus=focus, threshold=gate.threshold)
        if result["status"] == "findings" and state.get("result", {}).get("status") == "exhausted":
            result = {**result, "status": "exhausted", "stopped": "the agent stopped"}
        return {**result, "peekumi_url": url, "gate_mode": gate.mode}
    except package.Unavailable as exc:
        return gate.unavailable(exc)


@router.get("/state")
def latest(session_id: str = Query(min_length=1, max_length=256)):
    """Return saved gate evidence for this profile and session, without settings or secrets."""
    gate, _ = context()
    state = gate.current(session_id)
    return state.get("result", gate.unavailable("No saved turn result")) if state else gate.unavailable("No saved turn result")
