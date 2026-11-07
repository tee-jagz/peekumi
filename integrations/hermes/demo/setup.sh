#!/bin/sh
# Create a local demo fixture, register it and print its scoped Hermes settings.
set -eu
demo_directory=${1:?Use: bash demo/setup.sh /new/demo/path [crapper-prefix]}
crapper_prefix=${2:-"$HOME/.local/share/peekumi-crapper"}
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "${PEEKUMI_SOURCE:-}" ]; then
    test -f "$PEEKUMI_SOURCE/scripts/manage.mjs" || { echo 'PEEKUMI_SOURCE must name the Peekumi source root' >&2; exit 1; }
    test -x "$PEEKUMI_SOURCE/target/release/peekumi" || { echo 'Build Peekumi first with npm run build:rust' >&2; exit 1; }
else
    command -v peekumi >/dev/null 2>&1 || { echo 'Install peekumi or set PEEKUMI_SOURCE to its built source root' >&2; exit 1; }
fi
test -f "$crapper_prefix/peekumi-crapper.json" || { echo 'Install the CRAP tools first with setup_crapper.py' >&2; exit 1; }
# Source archives do not install a global command. Use their management entry point.
peekumi() {
    if [ -n "${PEEKUMI_SOURCE:-}" ]; then
        node "$PEEKUMI_SOURCE/scripts/manage.mjs" "$@"
    else
        command peekumi "$@"
    fi
}
python3 - "$crapper_prefix/peekumi-crapper.json" <<'PY'
import json
from pathlib import Path
import sys
settings = json.loads(Path(sys.argv[1]).read_text())
crapper = Path(settings['PEEKUMI_CRAPPER_PATH'])
if not crapper.is_file() or not crapper.with_name('python').is_file():
    raise SystemExit('Install the configured CRAP tools before setup')
PY
python3 - "$script_directory/fixture" "$demo_directory" <<'PY'
from pathlib import Path
import shutil
import sys
source, destination = map(Path, sys.argv[1:])
if destination.exists():
    raise SystemExit("Use a new demo folder; existing files are not overwritten")
shutil.copytree(source, destination, ignore=shutil.ignore_patterns('__pycache__'))
PY
git -C "$demo_directory" init -b main
git -C "$demo_directory" config user.name 'Peekumi demo'
git -C "$demo_directory" config user.email 'demo@peekumi.invalid'
git -C "$demo_directory" add .
git -C "$demo_directory" -c core.hooksPath=/dev/null -c commit.gpgSign=false commit -m 'Initial shop fixture'
peekumi repo add "$demo_directory"
integration_token=$(peekumi token create --name hermes --repo "$demo_directory")
PEEKUMI_SETUP_TOKEN="$integration_token" python3 - "$demo_directory" "$crapper_prefix" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import shlex
import sys
repository = Path(sys.argv[1]).resolve()
prefix = Path(sys.argv[2]).expanduser().resolve()
installation = json.loads((prefix / 'peekumi-crapper.json').read_text())
python = str(Path(installation['PEEKUMI_CRAPPER_PATH']).with_name('python'))
print('\nSet this value in the active Hermes profile secrets. It is printed once:')
print('PEEKUMI_TOKEN=' + os.environ['PEEKUMI_SETUP_TOKEN'])
print('\nSet plugins.entries.peekumi-risk-map.settings to:')
print(json.dumps({'repository_id': hashlib.sha256(str(repository).encode()).hexdigest()[:16],
    'repository_path':str(repository), 'peekumi_url':'http://127.0.0.1:4317',
    'crap_threshold':30, 'gate_mode':'nudge',
    'coverage_command':[python,'-m','coverage','run','-m','pytest','-q'],
    'report_command':[python,'-m','coverage','lcov','-o','lcov.info']},indent=2))
print('\nStart Peekumi with the environment values from: ' + str(prefix/'peekumi-crapper.json'))
selected_state = os.environ.get('PEEKUMI_HOME') or os.environ.get('STRATA_HOME')
if selected_state:
    installation['PEEKUMI_HOME'] = selected_state
environment = ' '.join(key + '=' + shlex.quote(value) for key, value in installation.items())
source_root = os.environ.get('PEEKUMI_SOURCE')
command = 'node ' + shlex.quote(str(Path(source_root)/'scripts/manage.mjs')) + ' serve' if source_root else 'peekumi serve'
print('\nRun this foreground service in a separate terminal:')
print('env ' + environment + ' ' + command)
print('Start the Hermes session in: ' + str(repository))
PY
