"""Load the real plugin in installed Hermes and exercise its hooks and tool registry.

The parent owns a temporary fixture repository and local Peekumi server. No model
or paid service is called. Only recorded cwd and output-transform seams are mocked.
"""
import importlib.util
import json
import logging
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

args = json.loads(sys.stdin.read())
repository = Path(args["repository"])
state = Path(args["state"])
assert repository.parent == state.parent and (repository/".git").is_dir()
home = state/"hermes-profile"
home.mkdir(mode=0o700)
os.environ["HERMES_HOME"] = str(home)
os.environ["PEEKUMI_TOKEN"] = args["token"]
settings = {"repository_id":args["repo"],"repository_path":str(repository),"peekumi_url":args["url"],
    "coverage_command":[args["python"],"-m","coverage","run","-m","pytest","-q"],
    "report_command":[args["python"],"-m","coverage","lcov","-o","lcov.info"]}
(home/"config.yaml").write_text(json.dumps({"plugins":{"enabled":["peekumi-risk-map"],"entries":{"peekumi-risk-map":{"settings":settings}}},"agent":{"max_verify_nudges":3}}))

from hermes_cli.plugins import PluginManager
from hermes_cli.plugins_manifest import parse_manifest_file
from tools.registry import registry
from agent.turn_context import _collect_pre_llm_call_context
from agent.turn_stop_gates import _pre_verify_nudge
from agent.turn_finalizer import _apply_output_hooks

root = Path(__file__).resolve().parents[2]
plugin = root/"integrations/hermes"
manifest = parse_manifest_file(plugin/"plugin.yaml",plugin,"user","")
manager = PluginManager(scope_key=str(home))
manager._load_plugin(manifest)
loaded = next(p for p in manager._plugins.values() if p.manifest.name=="peekumi-risk-map")
assert loaded.enabled,loaded.error

api_spec = importlib.util.spec_from_file_location("peekumi_fixture_api",plugin/"dashboard/plugin_api.py")
api = importlib.util.module_from_spec(api_spec)
sys.modules[api_spec.name] = api
api_spec.loader.exec_module(api)
agent = SimpleNamespace(session_id="actual-session",model="fixture-no-model",platform="cli",_resolved_is_coding=True,_turn_file_mutation_paths={"shop/ui/cart.py"})


def before(turn):
    _collect_pre_llm_call_context(agent,effective_task_id="fixture",turn_id=turn,original_user_message="Add refunds",messages=[],conversation_history=[])


def after(turn):
    with patch("agent.turn_finalizer.apply_llm_output_transform",return_value=("Done",False,None)):
        _apply_output_hooks(agent,"Done",logging.getLogger("fixture"),platform="cli",effective_task_id="fixture",turn_id=turn,original_user_message="Add refunds",messages=[])


def tool(name,arguments):
    raw = registry.dispatch(name,arguments,scope=manager.scope_key,session_id=agent.session_id)
    return json.loads(raw) if isinstance(raw,str) else raw


with patch("hermes_cli.plugins.get_plugin_manager",return_value=manager), patch("hermes_cli.lifecycle._observe"), patch("hermes_cli.plugin_session.context_cwd",return_value=str(repository)):
    before("turn-one")
    cart = repository/"shop/ui/cart.py"
    original = cart.read_text()
    cart.write_text("from shop.db.orders import save\n"+original+args["refund_source"])
    measured = tool("peekumi_measure",{})
    assert measured["status"]=="findings",measured
    assert next(s for s in measured["changed_symbols"] if s["name"]=="refund")["after"]["crap"]==42
    for attempt in range(3):
        nudge = _pre_verify_nudge(agent,"Done",attempt)
        assert nudge and "CRAP" in nudge and "ui-no-db" in nudge,nudge
    assert _pre_verify_nudge(agent,"Done",3) is None
    after("turn-one")
    exhausted = api.risk_map(session_id=agent.session_id,focus="")
    assert exhausted["status"]=="exhausted",exhausted
    cart.write_text(original+args["refund_source"])
    tests = repository/"test_shop.py"
    tests.write_text(tests.read_text()+"\n\ndef test_refunds():\n    from shop.ui.cart import refund\n    assert [refund(i) for i in range(7)] == [0, 1, 2, 3, 4, 5, 0]\n")
    repaired = tool("peekumi_measure",{})
    assert repaired["status"]=="passed",repaired
    after("turn-one")
    assert api.risk_map(session_id=agent.session_id,focus="")["status"]=="passed"
    before("turn-two")
    agent._turn_file_mutation_paths = set()
    cart.write_text("from shop.db.orders import save\n"+cart.read_text())
    assert _pre_verify_nudge(agent,"Done",0) is None
    after("turn-two")
    shell = api.risk_map(session_id=agent.session_id,focus="")
    assert shell["status"]=="findings",shell
    assert args["token"] not in json.dumps(shell)
    manager.invoke_hook("on_session_end",session_id=agent.session_id)
    closed = api.risk_map(session_id=agent.session_id,focus="")
    assert closed["status"]=="unavailable"
print(json.dumps({"cap":"exhausted","repair":"passed","shell_only":"findings","session_end":"unavailable","token_in_renderer":False}))
