"""Exercise the thin Hermes gate against a real loopback stub Peekumi service."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PLUGIN = Path(__file__).resolve().parents[2] / "integrations/hermes"
spec = importlib.util.spec_from_file_location("peekumi_hermes", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from peekumi_hermes.gate import Gate, Store
from peekumi_hermes.peekumi_client import Client


class GateTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.requests = []
        self.result = {"status": "findings", "findings": [{"id": "risk:refund", "message": "refund CRAP 42; add tests"}], "limits": []}
        self.http_status = 200
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.requests.append(("POST", self.path, body))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"id": "base-" + body.get("turn", "released"), "sha": "a" * 40, "status": "incomplete", "limits": []}).encode())

            def do_GET(self):
                owner.requests.append(("GET", self.path, None))
                self.send_response(owner.http_status)
                self.end_headers()
                self.wfile.write(json.dumps(owner.result).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.client = lambda: Client(f"http://127.0.0.1:{self.server.server_port}", "test-token", "repo-one", timeout=0.2)
        self.gate = Gate(self.client, Store(self.folder.name), "profile-one")

    def test_baseline_survives_retry_and_plugin_restart_and_scopes_turns(self):
        first = self.gate.before("session-one", "turn-one")
        self.gate.before("session-one", "turn-one")
        restarted = Gate(self.client, Store(self.folder.name), "profile-one")
        self.assertEqual(restarted.before("session-one", "turn-one")["baseline"], first["baseline"])
        self.assertEqual(len(self.requests), 1)
        self.gate.before("session-two", "turn-one")
        self.gate.before("session-one", "turn-two")
        self.assertEqual(len(self.requests), 3)
        self.assertEqual(self.gate.current("session-two")["turn"], "turn-one")

    def test_cap_marks_only_remaining_findings_exhausted(self):
        self.gate.before("session", "turn")
        self.assertEqual(self.gate.verify("session", 0, 3)["action"], "continue")
        self.assertIn("CRAP 42", self.gate.verify("session", 2, 3)["message"])
        self.assertEqual(self.gate.after("session", "turn")["status"], "exhausted")
        for outcome in ["passed", "incomplete", "exception", "unavailable"]:
            self.result = {"status": outcome, "limits": ["coverage unknown"] if outcome == "incomplete" else [], "findings": []}
            self.assertEqual(self.gate.after("session", "turn")["status"], outcome)

    def test_shell_only_edit_refreshes_and_unknown_never_becomes_passed(self):
        self.gate.before("session", "turn")
        self.assertEqual(self.gate.after("session", "turn")["status"], "findings")
        self.result = {"status": "incomplete", "limits": ["Missing coverage"], "findings": []}
        self.assertIsNone(self.gate.verify("session", 0, 3))
        self.assertEqual(self.gate.after("session", "turn")["status"], "incomplete")
        self.result = {"status": "invented"}
        self.assertEqual(self.gate.after("session", "turn")["status"], "unavailable")

    def test_outage_fails_open_with_visible_unavailable(self):
        self.gate.before("session", "turn")
        self.http_status = 503
        self.assertIsNone(self.gate.verify("session", 0, 3))
        self.assertEqual(self.gate.after("session", "turn")["status"], "unavailable")
        self.assertEqual(self.gate.after("session", "wrong-turn")["status"], "unavailable")
        self.assertEqual(self.gate.after("no-baseline", "turn")["status"], "unavailable")

    def test_session_end_releases_pins_and_off_mode_observes_without_nudging(self):
        self.gate.before("session", "turn")
        self.gate.mode = "off"
        self.assertIsNone(self.gate.verify("session", 0, 3))
        self.assertEqual(self.gate.after("session", "turn")["status"], "findings")
        self.gate.end("session")
        self.assertEqual(self.requests[-1][2]["action"], "release")

    def test_separate_session_writers_do_not_overwrite_each_other(self):
        def write(index):
            store = Store(self.folder.name)
            store.update(self.gate.key(str(index)), {"turn":str(index)})
        with ThreadPoolExecutor(max_workers=8) as workers:
            list(workers.map(write,range(30)))
        for index in range(30):
            self.assertEqual(self.gate.current(str(index))["turn"],str(index))

    def test_pending_measurement_cannot_show_a_previous_pass_as_current(self):
        self.gate.before("session","turn")
        state = self.gate.current("session")
        state["pending_measurement"] = "waiting-run"
        self.gate.save("session",state)
        self.result = {"status":"passed","limits":[],"findings":[]}
        self.assertEqual(self.gate.after("session","turn")["status"],"unavailable")


if __name__ == "__main__":
    unittest.main(verbosity=2)
