import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("check-accio-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    source = 'pub(crate) const VERIFIED_VERSIONS: &[&str] = &["0.35.3", "0.37.1"];'

    def test_known_and_unknown_versions_never_block_configuration(self):
        self.assertTrue(release.inspect(b"version: 0.37.1\nfiles: []", self.source)["hasNativeVerification"])
        result = release.inspect(b"version: 0.38.0", self.source)
        self.assertFalse(result["hasNativeVerification"])
        self.assertFalse(result["configurationBlocked"])
        self.assertFalse(result["applicationDownloaded"])

    def test_rejects_duplicate_malformed_and_oversized_metadata(self):
        for data in [b"version: 0.37.1\nversion: 0.37.2", b"version: 0.37.1-beta", b"version: 0.37.1+build", b"version: 01.37.1", b"<html>error</html>", b"\xff", b"x" * (release.LIMIT + 1)]:
            with self.subTest(data=data[:50]), self.assertRaises(ValueError):
                release.inspect(data, self.source)

    def test_missing_history_is_not_fabricated(self):
        with self.assertRaises(ValueError):
            release.inspect(b"version: 0.37.1", "const unrelated = [];")


if __name__ == "__main__":
    unittest.main()
