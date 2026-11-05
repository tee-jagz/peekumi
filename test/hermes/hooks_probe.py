"""Probe installed Hermes lifecycle code with a loaded stub plugin and no model call.

Run with the Python interpreter from the pinned Hermes environment. Only a temporary
Hermes home is used. Internal seams are deliberate: they verify the actual turn
prologue, stop gate and finalizer, rather than simulating their dispatch behavior.
"""
import logging
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class HooksProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory(prefix="peekumi-hermes-probe-")
        cls.env = patch.dict(os.environ, {"HERMES_HOME": cls.home.name})
        cls.env.start()
        from hermes_cli.plugins import PluginManager
        from hermes_cli.plugins_manifest import parse_manifest_file

        stub = Path(__file__).parent / "stub"
        manifest = parse_manifest_file(stub / "plugin.yaml", stub, "user", "")
        assert manifest is not None
        cls.manager = PluginManager(scope_key=cls.home.name)
        cls.manager._load_plugin(manifest)
        loaded = cls.manager._plugins[manifest.name]
        assert loaded.enabled, loaded.error
        cls.events = loaded.module.events

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.home.cleanup()

    def setUp(self):
        self.events.clear()
        self.enterContext(patch("hermes_cli.plugins.get_plugin_manager", return_value=self.manager))
        self.enterContext(patch("hermes_cli.lifecycle._observe"))
        self.agent = SimpleNamespace(
            session_id="probe-session", model="no-model", platform="cli",
            _resolved_is_coding=True, _turn_file_mutation_paths={"shop/refund.py"},
        )

    def before(self):
        from agent.turn_context import _collect_pre_llm_call_context
        return _collect_pre_llm_call_context(
            self.agent, effective_task_id="probe-task", turn_id="probe-turn",
            original_user_message="Add refunds", messages=[], conversation_history=[],
        )

    def after(self):
        from agent.turn_finalizer import _apply_output_hooks
        with patch("agent.turn_finalizer.apply_llm_output_transform", return_value=("Done", False, None)):
            _apply_output_hooks(
                self.agent, "Done", logging.getLogger("probe"), platform="cli",
                effective_task_id="probe-task", turn_id="probe-turn",
                original_user_message="Add refunds", messages=[],
            )

    def test_turn_payloads_and_nudge_cap(self):
        from agent.turn_stop_gates import _pre_verify_nudge
        self.assertEqual(self.before(), "Peekumi baseline probe")
        with patch("agent.verify_hooks.max_verify_nudges", return_value=3):
            for attempt in range(3):
                self.assertEqual(_pre_verify_nudge(self.agent, "Done", attempt), "Probe finding still open")
            self.assertIsNone(_pre_verify_nudge(self.agent, "Done", 3))
        self.after()
        self.assertEqual([name for name, _ in self.events],
                         ["pre_llm_call", "pre_verify", "pre_verify", "pre_verify", "post_llm_call"])
        self.assertEqual(self.events[0][1]["turn_id"], "probe-turn")
        self.assertEqual([payload["attempt"] for name, payload in self.events if name == "pre_verify"], [0, 1, 2])
        self.assertNotIn("turn_id", self.events[1][1])
        self.assertEqual(self.events[-1][1]["turn_id"], "probe-turn")

    def test_shell_only_edit_skips_gate_but_finalizer_observes(self):
        from agent.tool_result_classification import FILE_MUTATING_TOOL_NAMES
        from agent.turn_stop_gates import _pre_verify_nudge
        self.assertNotIn("terminal", FILE_MUTATING_TOOL_NAMES)
        self.agent._turn_file_mutation_paths = set()
        self.before()
        self.assertIsNone(_pre_verify_nudge(self.agent, "Done", 0))
        self.after()
        self.assertEqual([name for name, _ in self.events], ["pre_llm_call", "post_llm_call"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
