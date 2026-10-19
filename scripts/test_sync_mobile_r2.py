import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_sync_desktop_r2 import Storage

spec = importlib.util.spec_from_file_location("mobile_delivery", Path(__file__).with_name("sync-mobile-r2.py"))
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class MobileDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.metadata = delivery.load_metadata("0.1.0-alpha.1")
        self.metadata.update(size=7, sha256=hashlib.sha256(b"fixture").hexdigest())
        name = self.metadata["filename"]
        self.files = {name: b"fixture", name + ".sha256": (self.metadata["sha256"] + "  " + name + "\n").encode()}
        self.release = {"tag_name": "mobile-v0.1.0-alpha.1", "draft": False, "prerelease": True,
                        "assets": [{"name": n, "size": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest()}
                                   for n, data in self.files.items()]}
        for n, data in self.files.items():
            (self.root / n).write_bytes(data)
        self.storage = Storage()
        self.verified = []

    def tearDown(self):
        self.temp.cleanup()

    def sync(self, certificate_check=lambda *_: None):
        assets = delivery.validate_release(self.release, self.metadata)
        delivery.sync_release(self.storage, "bucket", self.root, assets, self.metadata,
                              lambda *args: self.verified.append(args[1]), certificate_check)

    def test_only_android_files_and_idempotent_retry(self):
        self.release["assets"].append({"name": "ios-unsigned.zip"})
        self.sync()
        self.sync()
        self.assertEqual(len(self.storage.writes), 2)
        self.assertEqual(len(self.verified), 4)
        self.assertTrue(all(key.startswith("mobile/releases/0.1.0-alpha.1/") for key in self.storage.writes))

    def test_unpublished_missing_duplicate_or_changed_assets_rejected(self):
        original = copy.deepcopy(self.release)
        changes = [lambda r: r.update(draft=True), lambda r: r["assets"].pop(),
                   lambda r: r["assets"].append(r["assets"][0]),
                   lambda r: r["assets"][0].update(digest="sha256:" + "0" * 64)]
        for change in changes:
            self.release = copy.deepcopy(original)
            change(self.release)
            with self.assertRaises(delivery.core.DeliveryError):
                self.sync()
        self.assertEqual(self.storage.writes, [])

    def test_bad_bytes_prevent_all_writes(self):
        (self.root / self.metadata["filename"]).write_bytes(b"changed")
        with self.assertRaises(delivery.core.DeliveryError):
            self.sync()
        self.assertEqual(self.storage.writes, [])

    def test_checksum_must_name_this_apk(self):
        name = self.metadata["filename"] + ".sha256"
        data = (self.metadata["sha256"] + "  other.apk\n").encode()
        (self.root / name).write_bytes(data)
        self.release["assets"][1].update(size=len(data), digest="sha256:" + hashlib.sha256(data).hexdigest())
        with self.assertRaises(delivery.core.DeliveryError):
            self.sync()
        self.assertEqual(self.storage.writes, [])

    def test_wrong_or_multiple_signers_prevent_all_writes(self):
        for output in [b"", b"Signer #1 certificate SHA-256 digest: " + b"0" * 64,
                       ("Signer #1 certificate SHA-256 digest: " + self.metadata["certificate_sha256"] +
                        "\nSigner #2 certificate SHA-256 digest: " + "0" * 64).encode()]:
            with patch.object(delivery.core, "run", return_value=output):
                with self.assertRaises(delivery.core.DeliveryError):
                    self.sync(delivery.verify_certificate)
        self.assertEqual(self.storage.writes, [])

    def test_known_signer_is_accepted(self):
        output = ("Signer #1 certificate SHA-256 digest: " + self.metadata["certificate_sha256"] + "\n").encode()
        with patch.object(delivery.core, "run", return_value=output):
            self.sync(delivery.verify_certificate)
        self.assertEqual(len(self.storage.writes), 2)

    def test_version_path_traversal_rejected(self):
        with self.assertRaises(delivery.core.DeliveryError):
            delivery.load_metadata("../0.1.0-alpha.1")


if __name__ == "__main__":
    unittest.main()
