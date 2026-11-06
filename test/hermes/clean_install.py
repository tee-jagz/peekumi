"""Check the documented local install in fresh Hermes and Peekumi state.

Use the pinned installed Hermes environment and the clean crapper prefix.
No external account, model call or public repository is needed.
"""
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
source = Path(os.environ["HERMES_SOURCE"])
prefix = Path(os.environ["PEEKUMI_TEST_CRAPPER_CONFIG"]).parent
with tempfile.TemporaryDirectory(prefix="peekumi-clean-install-") as temporary:
    folder = Path(temporary)
    home, state, binary = folder / "hermes", folder / "state", folder / "bin"
    binary.mkdir()
    wrapper = binary / "peekumi"
    wrapper.write_text("#!/bin/sh\nexec node " + shlex.quote(str(ROOT / "scripts/manage.mjs")) + ' "$@"\n')
    wrapper.chmod(0o700)
    plugin = home / "plugins/peekumi-risk-map"
    if os.environ.get("PEEKUMI_TEST_PLUGIN_ARCHIVE"):
        shutil.unpack_archive(os.environ["PEEKUMI_TEST_PLUGIN_ARCHIVE"], home / "plugins")
    else:
        shutil.copytree(ROOT / "integrations/hermes", plugin, ignore=shutil.ignore_patterns("__pycache__"))
    env = {k: v for k, v in os.environ.items() if not re.search(r"TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL", k)}
    env.update(HERMES_HOME=str(home), PEEKUMI_HOME=str(state), PATH=str(binary) + os.pathsep + env["PATH"])
    def run(command):
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=180)
        if result.returncode:
            # Setup output contains its ephemeral token. Do not include it in errors.
            detail = re.sub(r"pki_[0-9a-f]+", "[fixture token]", result.stdout + result.stderr)
            raise RuntimeError("Clean-install command failed: " + command[0] + "\n" + detail)
        return result.stdout + result.stderr

    output = run(["bash", str(plugin / "demo/setup.sh"), str(folder / "demo"), str(prefix)])
    token = re.search(r"PEEKUMI_TOKEN=(pki_[0-9a-f]+)", output).group(1)
    assert len(re.findall(r"PEEKUMI_TOKEN=pki_", output)) == 1
    saved = (state / "integration-tokens.json").read_text()
    assert token not in saved
    config = json.loads((state / "config.json").read_text())
    assert config["repositories"] == [str((folder / "demo").resolve())]
    hermes = str(source / ".venv/bin/hermes")
    run([hermes, "plugins", "enable", "peekumi-risk-map"])
    validation = run([hermes, "plugins", "validate", str(plugin), "--install-deps"])
    assert "Validation passed" in validation, validation
    assert "security scan" in validation and "desktop surface" in validation
    print(validation)
    print("Fresh local package, demo setup, scoped token and plugin enable: passed.")
