"""Thin Hermes hooks and tools for Peekumi's repository-scoped analysis API."""
import json
import os
from pathlib import Path

from .gate import Gate, Store
from .peekumi_client import Client, Unavailable
from .measure import measure, resume_pending


def register(ctx):
    """Register public hooks and a read-only impact tool. Credentials stay server-side."""
    from agent.secret_scope import get_secret
    from hermes_constants import get_hermes_home

    home = get_hermes_home().resolve()

    def client():
        return Client(os.environ.get("PEEKUMI_URL") or ctx.get_config("peekumi_url", "http://127.0.0.1:4317"),
                      get_secret("PEEKUMI_TOKEN"), ctx.get_config("repository_id", ""))

    gate = Gate(client, Store(home / "plugin-data/peekumi-risk-map"), str(home),
                ctx.get_config("crap_threshold", 30), ctx.get_config("gate_mode", "nudge"))

    def in_repository():
        configured = ctx.get_config("repository_path", "")
        cwd = ctx.session_cwd()
        if not configured or not cwd:
            return False
        try:
            Path(cwd).resolve().relative_to(Path(configured).resolve())
            return True
        except (ValueError, OSError):
            return False

    def before(session_id="", turn_id="", **_):
        if session_id and turn_id and in_repository():
            gate.before(session_id, turn_id)

    def verify(session_id="", attempt=0, **_):
        if gate.current(session_id) and in_repository():
            from hermes_cli.config import load_config_readonly
            cap = max(0, int((load_config_readonly() or {}).get("agent", {}).get("max_verify_nudges", 3)))
            return gate.verify(session_id, attempt, cap)

    def after(session_id="", turn_id="", **_):
        if gate.current(session_id):
            gate.after(session_id, turn_id)

    def impact(args, **kwargs):
        session = kwargs.get("session_id", "")
        state = gate.current(session)
        if not state or not state.get("baseline", {}).get("id"):
            return json.dumps(gate.unavailable("No baseline for this registered session"))
        try:
            if args.get("finding_id"):
                client().call("baseline", {"action":"exception", "baseline":state["baseline"]["id"],
                    "finding_id":args["finding_id"],"reason":args.get("reason", ""),"threshold":gate.threshold})
            return json.dumps(client().call("impact", baseline=state["baseline"]["id"],
                                            focus=args.get("path_or_symbol", ""), threshold=gate.threshold))
        except Unavailable as exc:
            return json.dumps(gate.unavailable(exc))

    def measurement(args, **kwargs):
        state = gate.current(kwargs.get("session_id", ""))
        if not state or not state.get("baseline", {}).get("id"):
            return json.dumps(gate.unavailable("No pre-edit baseline for measurement"))
        try:
            private_root = home / "plugin-data/peekumi-risk-map/measurements" / state["baseline"]["id"]
            resume_pending(client(),private_root)
            state.pop("pending_measurement",None)
            gate.save(kwargs.get("session_id", ""),state)
            result = measure(client(), state["baseline"]["id"], private_root,
                ctx.get_config("coverage_command", ["coverage", "run", "-m", "pytest"]),
                ctx.get_config("report_command", ["coverage", "lcov", "-o", "lcov.info"]), gate.threshold)
            state["result"] = result
            gate.save(kwargs.get("session_id", ""),state)
            return json.dumps(result)
        except (Unavailable, OSError, ValueError) as exc:
            if getattr(exc,"pending_run",None):
                state["pending_measurement"] = exc.pending_run
            state["result"] = gate.unavailable("Measurement unavailable; private evidence retained for recovery")
            gate.save(kwargs.get("session_id", ""),state)
            return json.dumps(state["result"])

    ctx.register_hook("pre_llm_call", before)
    ctx.register_hook("pre_verify", verify)
    ctx.register_hook("post_llm_call", after)
    # Hermes calls on_session_end after every turn. Only real teardown releases pins.
    ctx.register_hook("on_session_finalize", lambda session_id="", **_: gate.end(session_id))
    ctx.register_tool("peekumi_impact", "peekumi", {
        "name": "peekumi_impact", "description": "Inspect changed files, dependents, frozen dependency rules and measured CRAP before editing.",
        "parameters": {"type": "object", "properties": {"path_or_symbol": {"type": "string"}, "finding_id":{"type":"string"},"reason":{"type":"string"}}, "required": ["path_or_symbol"]},
    }, impact)
    ctx.register_tool("peekumi_measure", "peekumi", {
        "name":"peekumi_measure", "description":"Run configured Python coverage tests and export in a new private copy of the exact source snapshot. Record success or failure with Peekumi.",
        "parameters":{"type":"object","properties":{}}
    },measurement)
    ctx.register_skill("peekumi", Path(__file__).parent / "skills/peekumi/SKILL.md", "Check impact, measure in a private snapshot copy and record reasoned exceptions.")
