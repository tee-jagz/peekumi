"""Verify real snapshot exports, coverage and crapper against a temporary shop repository.

Run with the isolated crapper Python environment. No repository code runs in its
checkout. Only the measurement client's new private copy executes the fixture tests.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import io
import tarfile
import subprocess
import sys
import tempfile
import time
import shlex
import unittest
from concurrent.futures import ThreadPoolExecutor
from jsonschema import Draft202012Validator

import gate_test
from peekumi_hermes.measure import measure
from peekumi_hermes.peekumi_client import Client, Unavailable

ROOT = Path(__file__).resolve().parents[2]
REFUND = """\n\ndef refund(value):
    if value == 1:
        return 1
    if value == 2:
        return 2
    if value == 3:
        return 3
    if value == 4:
        return 4
    if value == 5:
        return 5
    return 0
"""


def contents(folder):
    return {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in folder.rglob("*") if p.is_file() and not p.is_symlink()}


class IntegrationTests(unittest.TestCase):
    def assert_schema(self, name, response):
        schema = json.loads((ROOT / "docs/integrations.schema.json").read_text())
        Draft202012Validator({"$ref":"#/$defs/"+name,"$defs":schema["$defs"]}).validate(response)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="peekumi-integration-e2e-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        self.repo, self.state = root / "checkout", root / "private-state"
        shutil.copytree(ROOT / "integrations/hermes/demo/fixture", self.repo, ignore=shutil.ignore_patterns("__pycache__"))
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Risk fixture")
        self.git("config", "user.email", "risk@example.invalid")
        self.git("add", ".")
        self.git("commit", "-m", "Initial shop")
        self.repo_id = hashlib.sha256(str(self.repo).encode()).hexdigest()[:16]
        installation = json.loads(Path(os.environ["PEEKUMI_TEST_CRAPPER_CONFIG"]).read_text()) if os.environ.get("PEEKUMI_TEST_CRAPPER_CONFIG") else {}
        self.measure_python = str(Path(installation["PEEKUMI_CRAPPER_PATH"]).with_name("python")) if installation else sys.executable
        env = {**os.environ, "PEEKUMI_TOKEN": "fixture-owner", "PEEKUMI_CRAPPER_PATH": str(Path(sys.executable).with_name("crapper")),
               "PEEKUMI_CRAPPER_PARSER_SHA256": "72ac8b7b168524c011204984ab4a276c9403e88188275b09fb1d755e92849885", **installation}
        self.start(env)
        self.addCleanup(self.stop)
        (self.state / "config.json").write_text(json.dumps({"version": 1, "repositories": [str(self.repo)]}))
        token = subprocess.check_output([str(ROOT / "target/release/peekumi"), "token", "--state-dir", str(self.state), "create", "--name", "fixture", "--repo", self.repo_id], text=True).strip()
        self.client = Client(self.url, token, self.repo_id, timeout=30)
        baseline = self.client.call("baseline", {"profile": "test", "session": "test", "turn": "test"})
        self.assert_schema("baselineResponse",baseline)
        self.baseline = baseline["id"]

    def start(self, env):
        self.server_env = env
        self.process = subprocess.Popen([str(ROOT / "target/release/peekumi"), str(self.repo), "--state-dir", str(self.state), "--base", "HEAD", "--port", "0"],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        while True:
            line = self.process.stdout.readline()
            if not line:
                self.fail("Fixture server failed: " + self.process.stderr.read())
            if line.startswith("PEEKUMI_READY "):
                self.url = "http://127.0.0.1:" + str(json.loads(line.split(" ", 1)[1])["port"])
                break

    def stop(self):
        self.process.terminate()
        self.process.wait(timeout=10)
        self.process.stdout.close()
        self.process.stderr.close()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.DEVNULL, text=True).strip()

    def impact(self):
        result = self.client.call("impact", baseline=self.baseline)
        self.assert_schema("impact",result)
        return result

    def measurement(self):
        before = contents(self.repo)
        result = measure(self.client, self.baseline, self.state / "client-copies",
            [self.measure_python, "-m", "coverage", "run", "-m", "pytest", "-q"],
            [self.measure_python, "-m", "coverage", "lcov", "-o", "lcov.info"])
        self.assertEqual(contents(self.repo), before)
        self.assert_schema("impact",result)
        return result

    def add_refund(self):
        cart = self.repo / "shop/ui/cart.py"
        cart.write_text(cart.read_text() + REFUND)

    def add_special_files(self):
        (self.repo / "image.png").write_bytes(b"PNG\0binary fixture")
        (self.repo / "large.ts").write_text("x" * (512 * 1024 + 1))
        (self.repo / "link.ts").symlink_to("/etc/passwd")
        (self.repo / ".env").write_text("FIXTURE=hidden\n")
        self.git("update-index", "--add", "--cacheinfo", "160000," + self.git("rev-parse", "HEAD") + ",vendor")
        self.git("commit", "-m", "Add fixture submodule")

    def test_existing_function_gets_independent_baseline_and_current_measurements(self):
        cart = self.repo / "shop/ui/cart.py"
        cart.write_text(cart.read_text().replace("return total(amount)", "return total(amount) if amount else 0"))
        result = self.measurement()
        self.assertEqual(result["status"], "passed", result["limits"])
        symbol = next(s for s in result["changed_symbols"] if s["name"] == "cart_total")
        self.assertEqual(symbol["before"]["state"], "measured")
        self.assertEqual(symbol["after"]["state"], "measured")
        previous = result["baseline_measurement"]["measurement"]
        current = result["measurement"]
        self.assertEqual(previous["snapshot"], result["baseline_sha"])
        self.assertEqual(current["snapshot"], result["snapshot_sha"])
        self.assertNotEqual(previous["snapshot"], current["snapshot"])
        self.assertNotEqual(previous["run_id"], current["run_id"])
        # A known baseline is reused, but current coverage gets a fresh run.
        repeated = self.measurement()
        self.assertNotIn("baseline_measurement", repeated)
        self.assertNotEqual(repeated["measurement"]["run_id"], current["run_id"])

    def test_failed_baseline_tests_do_not_borrow_current_coverage(self):
        cart = self.repo / "shop/ui/cart.py"
        cart.write_text(cart.read_text().replace("return total(amount)", "return total(amount) if amount else 0"))
        script = self.state / "measure-existing.py"
        script.write_text("import sys\nsys.path.insert(0, '.')\nfrom shop.ui.cart import cart_total\nassert cart_total(None) == 0\n")
        result = measure(self.client, self.baseline, self.state / "client-copies",
            [self.measure_python, "-m", "coverage", "run", str(script)],
            [self.measure_python, "-m", "coverage", "lcov", "-o", "lcov.info"])
        self.assertFalse(result["baseline_measurement"]["measurement_accepted"])
        self.assertTrue(result["measurement_accepted"])
        self.assertEqual(result["status"], "incomplete")
        symbol = next(s for s in result["changed_symbols"] if s["name"] == "cart_total")
        self.assertEqual(symbol["before"]["state"], "unknown")
        self.assertEqual(symbol["after"]["state"], "measured")

    def test_measurement_keeps_original_current_sha_during_baseline_run_and_recovery(self):
        from peekumi_hermes.measure import resume_pending
        cart = self.repo / "shop/ui/cart.py"
        cart.write_text(cart.read_text().replace("return total(amount)", "return total(amount) if amount else 0"))
        client = self.client
        class LostBaselineReply:
            def call(self, endpoint, *args, **kwargs):
                result = client.call(endpoint, *args, **kwargs)
                if endpoint == "coverage":
                    raise Unavailable("Lost baseline acknowledgement")
                return result
        folder = self.state / "client-copies"
        commands = ([self.measure_python, "-m", "coverage", "run", "-m", "pytest", "-q"],
                    [self.measure_python, "-m", "coverage", "lcov", "-o", "lcov.info"])
        with self.assertRaises(Unavailable):
            measure(LostBaselineReply(), self.baseline, folder, *commands)
        resume_pending(client, folder)
        self.assertEqual(list(folder.glob("run-*")), [])
        # This next turn starts from an unmeasured revision. Edit during its baseline run.
        turn = client.call("baseline", {"profile":"test", "session":"race", "turn":"race"})
        cart.write_text(cart.read_text().replace("else 0", "else 1"))
        original = client.call("impact", baseline=turn["id"])["snapshot_sha"]
        class ConcurrentEdit:
            def call(self, endpoint, *args, **kwargs):
                result = client.call(endpoint, *args, **kwargs)
                if endpoint == "coverage" and args[0]["snapshot"] == turn["sha"]:
                    cart.write_text(cart.read_text() + "\n# Newer checkout tree B\n")
                return result
        result = measure(ConcurrentEdit(), turn["id"], folder, *commands)
        self.assertEqual(result["measurement"]["snapshot"], original)
        self.assertNotEqual(result["snapshot_sha"], original)
        self.assertEqual(result["status"], "incomplete")

    def test_measured_42_and_coverage_only_rerun_clear_findings(self):
        self.add_refund()
        unknown = self.impact()
        self.assertEqual(unknown["status"], "incomplete")
        measured = self.measurement()
        refund = next(s for s in measured["changed_symbols"] if s["name"] == "refund")
        self.assertEqual(refund["before"]["state"], "new")
        self.assertEqual(refund["after"]["complexity"], 6)
        self.assertEqual(refund["after"]["coverage"], 0)
        self.assertEqual(refund["after"]["crap"], 42)
        self.assertEqual(measured["status"], "findings")
        # Independently run upstream's CLI on exactly the exported source and
        # accepted report. Do not use Peekumi's helper or score mapping here.
        from edn_format import Keyword, loads
        saved = json.loads((self.state / "integration-measurements.json").read_text())
        exported = self.client.call("export", baseline=self.baseline, snapshot=measured["snapshot_sha"])
        manual = self.state / "manual-crapper"
        manual.mkdir()
        from peekumi_hermes.measure import unpack
        unpack(exported["archive"], manual)
        report = manual / "target/coverage/lcov.info"
        report.parent.mkdir(parents=True)
        report.write_text(saved["coverage"][measured["snapshot_sha"]]["report"])
        check = subprocess.run([sys.executable, "-m", "crapper", "--use-existing-coverage", "--root", str(manual), "shop/ui/cart.py"], capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stderr)
        entry = next(e for e in loads((manual / ".metrics/crap.edn").read_text())[Keyword("entries")] if e[Keyword("name")] == "refund")
        for metric in ("complexity", "coverage", "crap"):
            self.assertEqual(refund["after"][metric], entry[Keyword(metric)])
        # Change only the configured measurement command, not the source tree.
        sha = measured["snapshot_sha"]
        runner = "import shop.ui.cart as c; [c.refund(i) for i in range(7)]"
        # Run a fresh configured coverage command that reaches every branch.
        script = self.state / "exercise.py"
        script.write_text("import sys\nsys.path.insert(0, '.')\n" + runner)
        result = measure(self.client, self.baseline, self.state / "client-copies",
            [sys.executable, "-m", "coverage", "run", str(script)],
            [sys.executable, "-m", "coverage", "lcov", "-o", "lcov.info"])
        self.assertEqual(result["snapshot_sha"], sha)
        self.assertEqual(result["status"], "passed", result["limits"])
        self.assertNotEqual(result["measurement"]["run_id"], measured["measurement"]["run_id"])

    def test_rule_change_uses_frozen_rules_and_exception_stays_visible(self):
        cart = self.repo / "shop/ui/cart.py"
        cart.write_text("from shop.db.orders import save\n" + cart.read_text())
        (self.repo / ".peekumi.json").write_text('{"version":1,"groups":{},"rules":[]}')
        result = self.impact()
        self.assertEqual(result["status"], "findings")
        rule = next(f for f in result["findings"] if f["kind"] == "rule")
        self.assertEqual(rule["rule"], "ui-no-db")
        self.assertEqual(rule["line"], 1)
        self.assertEqual(rule["import_line"], "from shop.db.orders import save")
        self.assertTrue(any(f["kind"] == "rule_change" for f in result["findings"]))
        for finding in result["findings"]:
            result = self.client.call("baseline", {"action":"exception", "baseline":self.baseline, "finding_id":finding["id"],"reason":"Fixture records this open for review"})
        self.assertEqual(result["status"], "exception")
        self.assertTrue(all(f.get("exception") for f in result["findings"]))

    def test_failed_measurement_is_recorded_and_stale_receipts_are_refused(self):
        self.add_refund()
        before = self.impact()
        result = measure(self.client, self.baseline, self.state / "client-copies", [sys.executable, "-c", "raise SystemExit(7)"],
                         [sys.executable, "-m", "coverage", "lcov", "-o", "lcov.info"])
        self.assertEqual(result["measurement"]["test_exit"], 7)
        self.assertEqual(result["status"], "incomplete")
        self.assertFalse(result["measurement_accepted"])
        export = self.client.call("export", baseline=self.baseline, snapshot=before["snapshot_sha"])
        with self.assertRaises(Unavailable):
            self.client.call("coverage", {"baseline":self.baseline, "snapshot":"0" * 40,"run_id":export["run_id"],"test_exit":0,"export_exit":0})

    def test_omitted_file_and_stale_coverage_remain_unknown_with_open_risk(self):
        self.add_refund()
        first = self.measurement()
        cart = self.repo / "shop/ui/cart.py"
        cart.write_text(cart.read_text() + "\n# Source changed after measurement\n")
        stale = self.impact()
        refund = next(s for s in stale["changed_symbols"] if s["name"] == "refund")
        self.assertEqual(refund["after"]["state"], "unknown")
        self.assertEqual(stale["status"], "findings")
        self.assertTrue(next(f for f in stale["findings"] if f["kind"] == "crap")["stale"])
        script = self.state / "exercise-db.py"
        script.write_text("import sys\nsys.path.insert(0, '.')\nfrom shop.db.orders import save\nsave(1)\n")
        omitted = measure(self.client, self.baseline, self.state / "client-copies",
            [sys.executable, "-m", "coverage", "run", "--source=shop.db", str(script)],
            [sys.executable, "-m", "coverage", "lcov", "-o", "lcov.info"])
        self.assertTrue(omitted["measurement_accepted"])
        refund = next(s for s in omitted["changed_symbols"] if s["name"] == "refund")
        self.assertEqual(refund["after"]["state"], "unknown")
        self.assertIn("does not mention", refund["after"]["reason"])
        graph = self.client.call("map",baseline=self.baseline)
        cart_node = next(n for n in graph["nodes"] if n["kind"]=="file" and n["path"]=="shop/ui/cart.py")
        self.assertIsNone(cart_node["crap"])
        self.assertGreater(cart_node["unknown_count"],0)
        self.assertNotEqual(first["snapshot_sha"], omitted["snapshot_sha"])

    def test_report_failure_and_absent_fresh_report_are_recorded(self):
        self.add_refund()
        for command in [[sys.executable, "-c", "raise SystemExit(9)"], [sys.executable, "-c", "pass"]]:
            result = measure(self.client, self.baseline, self.state / "client-copies",
                [sys.executable, "-m", "coverage", "run", "-m", "pytest", "-q"],command)
            self.assertFalse(result["measurement_accepted"])
            self.assertEqual(result["status"], "incomplete")

    def test_unavailable_analyzer_never_turns_valid_coverage_into_a_pass(self):
        self.stop()
        self.start({**self.server_env, "PEEKUMI_CRAPPER_PATH": str(self.state / "not-installed-crapper")})
        self.client = Client(self.url, self.client.token, self.repo_id, timeout=30)
        self.add_refund()
        cart = self.repo / "shop/ui/cart.py"
        cart.write_text(cart.read_text().replace("return total(amount)", "return total(amount) if amount else 0"))
        result = self.measurement()
        self.assertTrue(result["measurement_accepted"])
        self.assertEqual(result["status"], "unavailable")
        self.assertTrue(any("crapper is unavailable" in limit for limit in result["limits"]))
        self.assertEqual(result["baseline_coverage_sha"], result["baseline_sha"])
        repeated = self.measurement()
        self.assertNotIn("baseline_measurement", repeated)
        self.assertEqual(repeated["status"], "unavailable")

    def test_control_routes_wait_for_cold_scoring_in_the_shared_worker_queue(self):
        self.add_refund()
        result = self.measurement()
        self.stop()
        binary = self.state / "slow-analyzer"
        binary.mkdir()
        crapper = binary / "crapper"
        crapper.write_text("Fixture analyzer marker\n")
        marker = binary / "started"
        python = binary / "python"
        # The service invokes its configured analyzer interpreter. This trusted stub
        # holds that worker longer than the old 30-second control-route timeout.
        python.write_text("#!/bin/sh\nprintf started > " + shlex.quote(str(marker)) + "\nsleep 32\nprintf '[]\\n'\n")
        python.chmod(0o755)
        self.start({**self.server_env, "PEEKUMI_CRAPPER_PATH":str(crapper)})
        client = Client(self.url, self.client.token, self.repo_id)
        with ThreadPoolExecutor(max_workers=2) as workers:
            scoring = workers.submit(client.call, "map", baseline=self.baseline)
            deadline = time.monotonic() + 10
            while not marker.exists():
                self.assertLess(time.monotonic(), deadline, "Cold scorer did not start")
                time.sleep(0.05)
            started = time.monotonic()
            baseline = workers.submit(client.call, "baseline", {"profile":"queue", "session":"queue", "turn":"queue"})
            exported = client.call("export", baseline=self.baseline, snapshot=result["snapshot_sha"])
            self.assertGreater(time.monotonic() - started, 30)
            self.assertTrue(exported["run_id"])
            self.assertTrue(baseline.result()["id"])
            graph = scoring.result()
            self.assertEqual(graph["status"], "findings")
            self.assertTrue(any(finding.get("stale") for finding in graph["findings"]))

    def test_export_reads_private_objects_and_omits_restricted_files_and_links(self):
        self.add_refund()
        (self.repo / ".env").write_text("SECRET=fixture-only\n")
        (self.repo / "link.py").symlink_to("/etc/passwd")
        impact = self.impact()
        exported = self.client.call("export", baseline=self.baseline,snapshot=impact["snapshot_sha"])
        with tarfile.open(fileobj=io.BytesIO(exported["archive"])) as archive:
            names = archive.getnames()
            self.assertNotIn(".env",names)
            self.assertNotIn("link.py",names)
            self.assertIn("def refund",archive.extractfile("shop/ui/cart.py").read().decode())
        self.assertTrue(any(".env" in reason for reason in exported["limits"]))
        # A plain Git command cannot read this dirty snapshot from the checkout's store.
        result = subprocess.run(["git","-C",str(self.repo),"cat-file","-e",impact["snapshot_sha"]],capture_output=True)
        self.assertNotEqual(result.returncode,0)

    def test_many_export_omissions_fit_the_http_header_and_remain_counted(self):
        folder = self.repo / "links"
        folder.mkdir()
        for index in range(600):
            (folder / (f"link-{index:03d}-" + "x" * 100 + ".ts")).symlink_to("/etc/passwd")
        sha = self.impact()["snapshot_sha"]
        exported = self.client.call("export", baseline=self.baseline, snapshot=sha)
        self.assertTrue(any("additional export omissions" in limit for limit in exported["limits"]))
        shown = len(exported["limits"]) - 1
        omitted = int(exported["limits"][-1].split()[0])
        self.assertEqual(shown + omitted, 600)
        with tarfile.open(fileobj=io.BytesIO(exported["archive"])) as archive:
            self.assertIn("shop/ui/cart.py", archive.getnames())
            self.assertFalse(any(name.startswith("links/") for name in archive.getnames()))

    def test_map_has_real_folders_risk_evidence_rule_edges_and_unsupported_labels(self):
        self.add_refund()
        cart = self.repo / "shop/ui/cart.py"
        cart.write_text("from shop.db.orders import save\n" + cart.read_text() + "\n\ndef unresolved():\n    import missing_package\n")
        self.measurement()
        graph = self.client.call("map",baseline=self.baseline)
        self.assert_schema("map",graph)
        self.assertLessEqual(len(graph["nodes"]),300)
        self.assertTrue(any(n["kind"]=="folder" and n["path"]=="shop/ui" for n in graph["nodes"]))
        refund = next(n for n in graph["nodes"] if n["kind"]=="symbol" and n["name"]=="refund")
        self.assertEqual(refund["crap"],42)
        unsupported = next(n for n in graph["nodes"] if n["kind"]=="file" and n["path"]=="view.ts")
        self.assertIn("CRAP not available",unsupported["reason"])
        self.assertTrue(any(e["resolution"]=="unresolved" and e["target"] is None for e in graph["edges"]))
        edge = next(e for e in graph["edges"] if e.get("rule_break"))
        self.assertEqual(edge["rule_break"]["rule"],"ui-no-db")
        self.assertEqual(edge["rule_break"]["line"],1)

    def test_special_file_labels_take_priority_over_language_availability(self):
        self.add_special_files()
        graph = self.client.call("map", baseline=self.baseline)
        files = {n["path"]: n for n in graph["nodes"] if n["kind"] == "file"}
        for path, label in {"image.png":"binary · source omitted", "large.ts":"large file · source omitted",
                            "link.ts":"symlink · not followed", ".env":"restricted · source hidden",
                            "vendor":"submodule · not expanded"}.items():
            with self.subTest(path=path):
                self.assertEqual(files[path]["reason"], label)
                self.assertEqual(files[path]["analysis"], label)

    def test_large_map_aggregates_above_300_nodes(self):
        folder = self.repo / "large"
        folder.mkdir()
        for index in range(350):
            (folder / f"file-{index:03d}.txt").write_text("Fixture data\n")
        graph = self.client.call("map",baseline=self.baseline)
        self.assert_schema("map",graph)
        self.assertLessEqual(len(graph["nodes"]),300)
        self.assertGreater(graph["hidden_nodes"],0)
        self.assertTrue(graph["aggregation"])
        self.assertTrue(any("aggregated" in limit for limit in graph["limits"]))

    def test_real_hermes_plugin_hooks_tools_and_proxy_on_the_fixture(self):
        python = os.environ.get("PEEKUMI_TEST_HERMES_PYTHON")
        if not python:
            self.skipTest("Set PEEKUMI_TEST_HERMES_PYTHON to the pinned Hermes environment")
        result = subprocess.run([python,str(Path(__file__).with_name("actual_plugin_scenario.py"))],input=json.dumps({
            "repository":str(self.repo),"state":str(self.state),"repo":self.repo_id,"url":self.url,
            "token":self.client.token,"python":self.measure_python,"refund_source":REFUND}),capture_output=True,text=True,timeout=120)
        self.assertEqual(result.returncode,0,result.stderr)
        verdict = json.loads(result.stdout.splitlines()[-1])
        self.assertEqual(verdict,{"cap":"exhausted","repair":"passed","shell_only":"findings","session_finalize":"unavailable","token_in_renderer":False})

    def test_submission_outage_retains_evidence_and_exact_retry_is_idempotent(self):
        from peekumi_hermes.measure import resume_pending
        self.add_refund()
        client = self.client
        submitted = []
        class LostReply:
            def call(self,endpoint,*args,**kwargs):
                result = client.call(endpoint,*args,**kwargs)
                if endpoint=="coverage":
                    submitted.append(args[0])
                    raise Unavailable("Fixture lost the acceptance response")
                return result
        folder = self.state/"pending-client"
        with self.assertRaises(Unavailable) as failure:
            measure(LostReply(),self.baseline,folder,[self.measure_python,"-m","coverage","run","-m","pytest","-q"],
                [self.measure_python,"-m","coverage","lcov","-o","lcov.info"])
        self.assertTrue(failure.exception.pending_run)
        self.assertEqual(len(list(folder.glob("run-*"))),1)
        resume_pending(client,folder)
        self.assertEqual(list(folder.glob("run-*")),[])
        self.assertEqual(self.impact()["status"],"findings")
        with self.assertRaises(Unavailable):
            client.call("coverage", {**submitted[0], "report_hash":"0" * 64})


if __name__ == "__main__":
    unittest.main(verbosity=2)
