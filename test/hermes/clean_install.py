"""Check the documented local install in fresh Hermes and Peekumi state.

Use the pinned installed Hermes environment and the clean crapper prefix.
No external account, model call or public repository is needed.
"""
import json
import os
from pathlib import Path
import re
import queue
import shlex
import shutil
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]
source = Path(os.environ["HERMES_SOURCE"])
prefix = Path(os.environ["PEEKUMI_TEST_CRAPPER_CONFIG"]).parent
with tempfile.TemporaryDirectory(prefix="peekumi-clean-install-") as temporary:
    folder = Path(temporary)
    home, state = folder / "hermes", folder / "state"
    plugin = home / "plugins/peekumi-risk-map"
    if os.environ.get("PEEKUMI_TEST_PLUGIN_ARCHIVE"):
        shutil.unpack_archive(os.environ["PEEKUMI_TEST_PLUGIN_ARCHIVE"], home / "plugins")
    else:
        shutil.copytree(ROOT / "integrations/hermes", plugin, ignore=shutil.ignore_patterns("__pycache__"))
    env = {k: v for k, v in os.environ.items() if not re.search(r"TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL", k)}
    env.update(HERMES_HOME=str(home), PEEKUMI_HOME=str(state), PEEKUMI_SOURCE=str(ROOT))
    def run(command):
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=180)
        if result.returncode:
            # Setup output contains its ephemeral token. Do not include it in errors.
            detail = re.sub(r"pki_[0-9a-f]+", "[fixture token]", result.stdout + result.stderr)
            raise RuntimeError("Clean-install command failed: " + command[0] + "\n" + detail)
        return result.stdout + result.stderr

    # Missing prerequisites must fail before a checkout or a token is created.
    missing = subprocess.run(["bash", str(plugin / "demo/setup.sh"), str(folder / "demo"), str(folder / "missing-analyzer")],env=env,capture_output=True,text=True)
    assert missing.returncode != 0
    assert not (folder / "demo").exists()
    assert not (state / "integration-tokens.json").exists()
    bad = folder / "bad-analyzer"
    bad.mkdir()
    (bad / "peekumi-crapper.json").write_text(json.dumps({"PEEKUMI_CRAPPER_PATH":str(bad/"absent-crapper")}))
    invalid = subprocess.run(["bash", str(plugin / "demo/setup.sh"), str(folder / "demo"), str(bad)],env=env,capture_output=True,text=True)
    assert invalid.returncode != 0
    assert not (folder / "demo").exists()
    assert not (state / "integration-tokens.json").exists()
    output = run(["bash", str(plugin / "demo/setup.sh"), str(folder / "demo"), str(prefix)])
    token = re.search(r"PEEKUMI_TOKEN=(pki_[0-9a-f]+)", output).group(1)
    assert len(re.findall(r"PEEKUMI_TOKEN=pki_", output)) == 1
    assert "Run this foreground service in a separate terminal:" in output
    assert "scripts/manage.mjs serve" in output
    saved = (state / "integration-tokens.json").read_text()
    assert token not in saved
    config = json.loads((state / "config.json").read_text())
    assert config["repositories"] == [str((folder / "demo").resolve())]
    # Start the exact printed command, with an ephemeral port in this test's registry.
    config["port"] = 0
    (state / "config.json").write_text(json.dumps(config))
    service_command = output.split("Run this foreground service in a separate terminal:\n",1)[1].splitlines()[0]
    settings = json.JSONDecoder().raw_decode(output.split("Set plugins.entries.peekumi-risk-map.settings to:\n",1)[1])[0]
    # A pasted command in another terminal must not depend on inherited registry state.
    service_env = {k:v for k,v in env.items() if k not in {"PEEKUMI_HOME","STRATA_HOME"}}
    service = subprocess.Popen(shlex.split(service_command), env=service_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    ready = queue.Queue()
    def read_ready():
        for line in service.stdout:
            if line.startswith("PEEKUMI_READY "):
                ready.put(json.loads(line.split(" ",1)[1]))
                return
    thread = threading.Thread(target=read_ready,daemon=True)
    thread.start()
    try:
        port = ready.get(timeout=30)["port"]
        import gate_test
        from peekumi_hermes.peekumi_client import Client
        from peekumi_hermes.measure import measure
        client = Client("http://127.0.0.1:"+str(port),token,settings["repository_id"],timeout=30)
        baseline = client.call("baseline",{"profile":"clean-install","session":"clean-install","turn":"first"})
        result = measure(client,baseline["id"],folder/"private-copies",settings["coverage_command"],settings["report_command"])
        assert result["measurement_accepted"]
        graph = client.call("map",baseline=baseline["id"])
        cart = next(n for n in graph["nodes"] if n["kind"]=="symbol" and n["name"]=="cart_total")
        assert cart["after"]["state"]=="measured" and cart["after"]["crap"]==1
    finally:
        service.terminate()
        service.wait(timeout=10)
        thread.join(timeout=1)
        service.stdout.close()
    hermes = str(source / ".venv/bin/hermes")
    run([hermes, "plugins", "enable", "peekumi-risk-map"])
    validation = run([hermes, "plugins", "validate", str(plugin), "--install-deps"])
    assert "Validation passed" in validation, validation
    assert "security scan" in validation and "desktop surface" in validation
    print(validation)
    print("Source setup without a global command, printed service command, real coverage/CRAP, token and plugin enable: passed.")
