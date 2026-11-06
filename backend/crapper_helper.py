"""Run pinned, preinstalled crapper on a private snapshot without executing its code.

The adjacent Python environment supplies crapper, EDN parsing and the Python grammar.
Analysis runs with isolated Python imports. This adapter refuses parser downloads.
"""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys

import tree_sitter_language_pack as pack
from edn_format import Keyword, loads

if len(sys.argv)>3 and sys.argv[3]:
    pack.configure(pack.PackConfig(cache_dir=sys.argv[3]))

if importlib.metadata.version("crapper") != "0.1.0":
    raise RuntimeError("Install the pinned crapper 0.1.0 build")
if "python" not in pack.downloaded_languages():
    raise RuntimeError("Install the Python parser before analysis; runtime downloads are disabled")

expected = sys.argv[2]
parser_files = list(Path(pack.cache_dir()).glob("*python*"))
if not expected or len(parser_files) != 1 or hashlib.sha256(parser_files[0].read_bytes()).hexdigest() != expected:
    raise RuntimeError("Preinstalled Python parser checksum does not match configuration")


def preinstalled_only(names):
    """Permit upstream's cache check without permitting a network download."""
    if set(names) - set(pack.downloaded_languages()):
        raise RuntimeError("Runtime parser downloads are disabled")
    return 0


pack.download = preinstalled_only
from crapper.cli import run

root = Path(sys.argv[1])
files = json.loads(sys.stdin.read())
# Crapper's normal report goes to stderr; stdout carries only parsed evidence.
from contextlib import redirect_stdout
with redirect_stdout(sys.stderr):
    code = run(["--use-existing-coverage", "--root", str(root), *files])
if code:
    raise RuntimeError(f"Crapper failed with exit {code}")
entries = loads((root / ".metrics/crap.edn").read_text())[Keyword("entries")]
print(json.dumps([{str(key): value for key, value in entry.items()} for entry in entries]))
