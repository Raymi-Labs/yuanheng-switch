import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("check-accio-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    source = 'pub(crate) const SUPPORTED_VERSIONS: &[&str] = &["0.35.3", "0.37.1"];'

    def test_known_and_unknown_versions_do_not_change_gate(self):
        self.assertFalse(release.inspect(b"version: 0.37.1\nfiles: []", self.source)["requiresCompatibilityReview"])
        result = release.inspect(b"version: 0.38.0", self.source)
        self.assertTrue(result["requiresCompatibilityReview"])
        self.assertFalse(result["gateChanged"])
        self.assertFalse(result["applicationDownloaded"])

    def test_rejects_duplicate_malformed_and_oversized_metadata(self):
        for data in [b"version: 0.37.1\nversion: 0.37.2", b"version: 0.37.1-beta", b"version: 0.37.1+build", b"version: 01.37.1", b"<html>error</html>", b"\xff", b"x" * (release.LIMIT + 1)]:
            with self.subTest(data=data[:50]), self.assertRaises(ValueError):
                release.inspect(data, self.source)

    def test_missing_gate_fails_closed(self):
        with self.assertRaises(ValueError):
            release.inspect(b"version: 0.37.1", "const unrelated = [];")


if __name__ == "__main__":
    unittest.main()
