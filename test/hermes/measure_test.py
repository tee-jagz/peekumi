"""Security checks for measurement archives before any inspected test can execute."""
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

import gate_test
from peekumi_hermes.measure import unpack
from peekumi_hermes.peekumi_client import Unavailable


class ArchiveTests(unittest.TestCase):
    def test_path_traversal_absolute_paths_links_and_special_files_are_refused(self):
        for name,kind in [("../escape.py",tarfile.REGTYPE),("/tmp/escape.py",tarfile.REGTYPE),("link",tarfile.SYMTYPE),("hardlink",tarfile.LNKTYPE),("pipe",tarfile.FIFOTYPE),("folder\\escape.py",tarfile.REGTYPE)]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as folder:
                data = io.BytesIO()
                with tarfile.open(fileobj=data,mode="w") as archive:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.linkname = "/etc/passwd"
                    archive.addfile(member)
                with self.assertRaises(Unavailable):
                    unpack(data.getvalue(),Path(folder))
                self.assertEqual(list(Path(folder).iterdir()),[])

    def test_oversized_entry_is_refused_before_extraction(self):
        member = tarfile.TarInfo("large.bin")
        member.size = 64*1024*1024+1
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(Unavailable):
                unpack(member.tobuf()+b"\0"*1024,Path(folder))
            self.assertEqual(list(Path(folder).iterdir()),[])


if __name__=="__main__":
    unittest.main(verbosity=2)
