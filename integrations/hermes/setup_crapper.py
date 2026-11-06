"""Install pinned crapper and a checksum-verified parser before Peekumi analysis.

This explicit setup command downloads fixed upstream artifacts. Runtime analysis
never downloads code. It creates only the requested new installation directory.
"""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import shlex
import subprocess
import sys
import tarfile
from urllib.request import urlopen
import venv

REVISION = "6fd92c4c9bcc56efb64a2f8743d5a2993bcfd42d"
SOURCE_HASH = "b132c09e2902da8e433e6b372cdfc84a6af61a79a32b52e148f3bfdef8eaa77d"
PARSER_HASHES = {
    "linux-aarch64": "eeb8ba3c285057aa43128067295b96c13d92dfb438513a37f80874f04353c5da",
    "linux-x86_64": "e7aa7f5ee7d6b0310f25b684748c3c9a6ee4272288d2cf30552dae20ef637c16",
    "macos-arm64": "724fd6958191ad0ca45fa034865350d44ed58aa65189ba3b7346db67f7f7603b",
    "macos-x86_64": "c8d9e4a78d48488fb6870134c488dca72812d8aad0ea6145827e210291b449f2",
    "windows-aarch64": "0df2e1b7bc3cef61dd25ba7680c5ca00479c44e0d2dac043d5823987471177e3",
    "windows-x86_64": "9510437d9f77c063b4784f5295528df320275a26ae0f89008d66ca06d90515fa",
}


def fetch(url, destination, checksum):
    """Download at most 64 MiB and verify the committed checksum before use."""
    with urlopen(url, timeout=60) as response:
        content = response.read(64 * 1024 * 1024 + 1)
    if len(content)>64*1024*1024 or hashlib.sha256(content).hexdigest()!=checksum:
        raise RuntimeError("Download checksum or size mismatch: " + destination.name)
    destination.write_bytes(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix",type=Path,required=True)
    args = parser.parse_args()
    if sys.version_info < (3,14):
        parser.error("Use Python 3.14 for the pinned parser archive")
    prefix = args.prefix.expanduser().resolve()
    if prefix.exists():
        parser.error("Use a new installation folder; existing installations are not overwritten")
    system = {"Darwin":"macos","Linux":"linux","Windows":"windows"}.get(platform.system(),"")
    machine = {"AMD64":"x86_64","arm64":"arm64" if system=="macos" else "aarch64"}.get(platform.machine(),platform.machine())
    target = system+"-"+machine
    if target not in PARSER_HASHES:
        parser.error("No pinned parser archive for " + target)
    prefix.mkdir(parents=True,mode=0o700)
    cache = prefix/"install-cache"
    cache.mkdir(mode=0o700)
    source = cache/"crapper.tar.gz"
    fetch(f"https://codeload.github.com/unclebob/crapper/tar.gz/{REVISION}",source,SOURCE_HASH)
    with tarfile.open(source) as archive:
        archive.extractall(cache,filter="data")
    venv.EnvBuilder(with_pip=True).create(prefix/"venv")
    binary = prefix/"venv"/("Scripts" if system=="windows" else "bin")
    python = binary/("python.exe" if system=="windows" else "python")
    subprocess.run([str(python),"-m","pip","install",str(cache/("crapper-"+REVISION)),
        "tree-sitter==0.26.0","tree-sitter-language-pack==1.23.1","coverage==7.17.2","pytest==9.2.0","edn_format==0.8.0"],check=True)
    parser_archive = cache/("parsers-"+target+".tar.zst")
    fetch(f"https://github.com/xberg-io/tree-sitter-language-pack/releases/download/v1.23.1/parsers-{target}.tar.zst",parser_archive,PARSER_HASHES[target])
    parser_cache = prefix/"parser-cache"
    code = "import sys;import tree_sitter_language_pack as p;p.configure(p.PackConfig(cache_dir=sys.argv[1]));print(p.cache_dir())"
    folder = Path(subprocess.check_output([str(python),"-I","-c",code,str(parser_cache)],text=True).strip())
    folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    with tarfile.open(parser_archive,"r:*") as archive:
        matches = [m for m in archive.getmembers() if m.isfile() and "tree_sitter_python" in Path(m.name).name]
        if len(matches)!=1:
            raise RuntimeError("Pinned archive has no unique Python parser")
        member = matches[0]
        parser_file = folder/Path(member.name).name
        parser_file.write_bytes(archive.extractfile(member).read())
    settings = {"PEEKUMI_CRAPPER_PATH":str(binary/("crapper.exe" if system=="windows" else "crapper")),
                "PEEKUMI_CRAPPER_PARSER_CACHE":str(parser_cache),
                "PEEKUMI_CRAPPER_PARSER_SHA256":hashlib.sha256(parser_file.read_bytes()).hexdigest()}
    (prefix/"peekumi-crapper.json").write_text(json.dumps(settings,indent=2)+"\n")
    print("\nSet these values in the environment that starts Peekumi:")
    for key,value in settings.items():
        print("export "+key+"="+shlex.quote(value))
    print("\nCoverage command interpreter: "+str(python))


if __name__=="__main__":
    main()
