"""Measure a private fixture copy with existing LCOV and installed, pinned crapper.

Run in the isolated crapper environment. All tests and metric writes happen in new
temporary copies. The fixture checkout is checked byte for byte after each run.
"""
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from edn_format import Keyword, loads

SOURCE = """def refund(value):
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


def manifest(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob("*") if p.is_file()}


class CrapperProbe(unittest.TestCase):
    def test_existing_coverage_private_copy_and_missing_report(self):
        with tempfile.TemporaryDirectory(prefix="peekumi-crapper-") as folder:
            root = Path(folder)
            checkout = root / "checkout"
            checkout.mkdir()
            (checkout / "shop.py").write_text(SOURCE)
            (checkout / ".coveragerc").write_text("[run]\nrelative_files = true\nbranch = true\nsource = shop\n")
            (checkout / "test_shop.py").write_text("import shop\n\ndef test_import():\n    assert callable(shop.refund)\n")
            original = manifest(checkout)
            measured = root / "measured"
            shutil.copytree(checkout, measured)

            def run(*args, cwd=measured):
                result = subprocess.run([sys.executable, *args], cwd=cwd, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                return result

            run("-m", "coverage", "run", "-m", "pytest", "-q")
            run("-m", "coverage", "lcov", "-o", "target/coverage/lcov.info")
            report = measured / "target/coverage/lcov.info"
            self.assertIn("SF:shop.py", report.read_text())
            report_before = report.read_bytes()
            # A test run by crapper would fail. Existing-coverage mode must not run it.
            (measured / "test_shop.py").write_text("raise RuntimeError('crapper ran tests')\n")
            run("-m", "crapper", "--use-existing-coverage", "--root", str(measured), "shop.py")
            entries = loads((measured / ".metrics/crap.edn").read_text())[Keyword("entries")]
            entry = next(e for e in entries if e[Keyword("name")] == "refund")
            self.assertEqual(entry[Keyword("complexity")], 6)
            self.assertEqual(entry[Keyword("coverage")], 0)
            self.assertEqual(entry[Keyword("crap")], 42)
            self.assertEqual(report.read_bytes(), report_before)
            print("Measured refund: complexity=6 coverage=0% CRAP=42")

            # This upstream behavior is why P4 must validate LCOV presence itself.
            report.unlink()
            run("-m", "crapper", "--use-existing-coverage", "--root", str(measured), "shop.py")
            absent = loads((measured / ".metrics/crap.edn").read_text())[Keyword("entries")][0]
            self.assertEqual(absent[Keyword("coverage")], 0)
            self.assertEqual(manifest(checkout), original)


if __name__ == "__main__":
    unittest.main(verbosity=2)
