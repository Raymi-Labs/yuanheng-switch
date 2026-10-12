#!/usr/bin/env python3
"""Offline regressions for fail-closed Apple release verification."""

import importlib.util
import json
import os
import plistlib
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("macos_release", ROOT / "scripts/verify-macos-release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class MacReleaseTests(unittest.TestCase):
    def test_ticket_validation_recovers_from_temporary_network_failure(self):
        results = [subprocess.CompletedProcess([], 68, "", "network connection lost"),
                   subprocess.CompletedProcess([], 0, "validated", "")]
        with patch.object(release.subprocess, "run", side_effect=results) as runner:
            with patch.object(release.time, "sleep") as sleep:
                self.assertEqual(release.run("/usr/bin/xcrun", "stapler", "validate", "Fixture.app"), "validated")
        self.assertEqual(runner.call_count, 2)
        sleep.assert_called_once_with(15)

    def test_ticket_validation_network_retries_still_fail_when_exhausted(self):
        failed = subprocess.CompletedProcess([], 75, "", "temporary service failure")
        with patch.object(release.subprocess, "run", return_value=failed) as runner:
            with patch.object(release.time, "sleep") as sleep:
                with self.assertRaisesRegex(RuntimeError, "exit 75"):
                    release.run("/usr/bin/xcrun", "stapler", "validate", "Fixture.app")
        self.assertEqual(runner.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [15, 30])

    def test_invalid_ticket_and_other_verifiers_do_not_retry(self):
        for code, args in ((65, ("/usr/bin/xcrun", "stapler", "validate", "Fixture.app")),
                           (68, ("/usr/bin/codesign", "--verify", "Fixture.app")),
                           (75, ("/usr/sbin/spctl", "--assess", "Fixture.app"))):
            failed = subprocess.CompletedProcess([], code, "", "rejected")
            with patch.object(release.subprocess, "run", return_value=failed) as runner:
                with patch.object(release.time, "sleep") as sleep:
                    with self.assertRaisesRegex(RuntimeError, "rejected"):
                        release.run(*args)
            self.assertEqual(runner.call_count, 1)
            sleep.assert_not_called()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.app = Path(self.temporary.name) / "Fixture.app"
        binaries = self.app / "Contents/MacOS"
        binaries.mkdir(parents=True)
        for name in ("fixture", "yuanheng-core"):
            (binaries / name).write_text("fixture")
        self.config = {"identifier": "test.fixture", "version": "0.1.66"}
        self.info = {"CFBundleIdentifier": "test.fixture", "CFBundleShortVersionString": "0.1.66",
                     "CFBundleExecutable": "fixture"}
        self.write_info()
        self.team = "TESTTEAM01"
        self.identity = f"Developer ID Application: Test Developer ({self.team})"
        self.details = (f"Authority={self.identity}\nTeamIdentifier={self.team}\n"
                        "CodeDirectory v=20500 size=512 flags=0x10000(runtime) hashes=3+7\n"
                        "Timestamp=Oct 9, 2026 at 12:00:00\n")

    def write_info(self):
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps(self.info))

    def runner(self, *args):
        if "--display" in args:
            return self.details
        if "-archs" in args:
            return "arm64\n"
        return ""

    def verify(self):
        release.verify_app(self.app, self.config, self.identity, self.team, "arm64")

    def test_accepts_signed_notarized_app_and_checks_core(self):
        with patch.object(release, "run", side_effect=self.runner) as runner:
            self.verify()
        calls = [call.args for call in runner.call_args_list]
        self.assertTrue(any("--verify" in c and c[-1].endswith("/yuanheng-core") for c in calls))
        self.assertIn(("/usr/bin/xcrun", "stapler", "validate", str(self.app)), calls)
        self.assertTrue(any(c[0] == "/usr/sbin/spctl" for c in calls))

    def test_rejects_untrusted_or_incomplete_signature_metadata(self):
        valid = self.details
        for source, replacement, error in (
            (self.identity, "Apple Development: Test", "signing identity"),
            (f"TeamIdentifier={self.team}", "TeamIdentifier=OTHERTEAM1", "signing team"),
            ("0x10000(runtime)", "0x0(none)", "runtime"),
            ("Timestamp=", "Signed Time=", "timestamp"),
        ):
            with self.subTest(error=error):
                self.details = valid.replace(source, replacement)
                with patch.object(release, "run", side_effect=self.runner):
                    with self.assertRaisesRegex(RuntimeError, error):
                        self.verify()

    def test_rejects_invalid_signature_missing_ticket_or_gatekeeper_rejection(self):
        for tool in ("/usr/bin/codesign", "/usr/bin/xcrun", "/usr/sbin/spctl"):
            with self.subTest(tool=tool):
                def fail(*args):
                    if args[0] == tool:
                        raise RuntimeError("rejected by verifier")
                    return self.runner(*args)
                with patch.object(release, "run", side_effect=fail):
                    with self.assertRaisesRegex(RuntimeError, "rejected"):
                        self.verify()

    def test_rejects_wrong_architecture(self):
        def wrong_architecture(*args):
            return "x86_64" if "-archs" in args else self.runner(*args)
        with patch.object(release, "run", side_effect=wrong_architecture):
            with self.assertRaisesRegex(RuntimeError, "architecture"):
                self.verify()

    def test_rejects_wrong_app_version_identifier_and_executable(self):
        for key, value, message in (
            ("CFBundleShortVersionString", "0.1.65", "version"),
            ("CFBundleIdentifier", "other.application", "identifier"),
            ("CFBundleExecutable", "../outside", "executable name"),
        ):
            with self.subTest(key=key):
                original = self.info[key]
                self.info[key] = value
                self.write_info()
                with self.assertRaisesRegex(RuntimeError, message):
                    self.verify()
                self.info[key] = original

    def test_rejects_missing_core(self):
        (self.app / "Contents/MacOS/yuanheng-core").unlink()
        with patch.object(release, "run", side_effect=self.runner):
            with self.assertRaisesRegex(RuntimeError, "Missing executable"):
                self.verify()

    def test_checks_all_three_app_sources_and_detaches_failed_dmg(self):
        root = Path(self.temporary.name) / "release"
        (root / "src-tauri").mkdir(parents=True)
        config = {**self.config, "productName": "Fixture"}
        (root / "src-tauri/tauri.conf.json").write_text(json.dumps(config))
        bundle = root / "src-tauri/target/aarch64-apple-darwin/release/bundle"
        (bundle / "macos").mkdir(parents=True)
        (bundle / "dmg").mkdir()
        (bundle / "macos/Fixture.app.tar.gz").write_text("archive fixture")
        (bundle / "dmg/Fixture_0.1.66_aarch64.dmg").write_text("DMG fixture")

        def package_runner(*args):
            if args[0] == "/usr/bin/tar":
                (Path(args[-1]) / "Fixture.app").mkdir()
            return ""

        env = {"APPLE_TEAM_ID": self.team, "APPLE_SIGNING_IDENTITY": self.identity}
        with patch.dict(os.environ, env), patch.object(release, "run", side_effect=package_runner):
            with patch.object(release, "verify_app") as check:
                release.verify_release(root, "aarch64-apple-darwin")
                self.assertEqual([call.args[0].parent.name for call in check.call_args_list],
                                 ["macos", "updater", "dmg"])

        def reject_dmg(app, *args):
            if app.parent.name == "dmg":
                raise RuntimeError("DMG app rejected")

        with patch.dict(os.environ, env), patch.object(release, "run", side_effect=package_runner) as runner:
            with patch.object(release, "verify_app", side_effect=reject_dmg):
                with self.assertRaisesRegex(RuntimeError, "DMG app rejected"):
                    release.verify_release(root, "aarch64-apple-darwin")
        self.assertTrue(any(c.args[:2] == ("/usr/bin/hdiutil", "detach") for c in runner.call_args_list))

    def test_workflow_rejects_each_missing_credential_without_logging_secrets(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        step = workflow.split("- name: Require Apple Developer ID signing and notarization", 1)[1]
        step = step.split("\n      - name:", 1)[0]
        script = textwrap.dedent(step.split("        run: |\n", 1)[1])
        values = {"CERTIFICATE": "private-certificate-fixture", "CERTIFICATE_PASSWORD": "private-p12-fixture",
                  "SIGNING_IDENTITY": self.identity, "NOTARIZATION_APPLE_ID": "test@example.test",
                  "NOTARIZATION_PASSWORD": "private-notarization-fixture", "NOTARIZATION_TEAM_ID": self.team}
        env_file = Path(self.temporary.name) / "github-env"
        for missing in values:
            with self.subTest(missing=missing):
                env = {"PATH": os.environ["PATH"], "GITHUB_ENV": str(env_file), **values, missing: ""}
                result = subprocess.run(["bash", "-e", "-c", script], env=env, text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(missing, result.stdout)
                for secret in ("private-certificate-fixture", "private-p12-fixture", "private-notarization-fixture"):
                    self.assertNotIn(secret, result.stdout + result.stderr)
                self.assertFalse(env_file.exists())
        result = subprocess.run(["bash", "-e", "-c", script],
                                env={"PATH": os.environ["PATH"], "GITHUB_ENV": str(env_file), **values},
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("APPLE_PASSWORD<<", env_file.read_text())
        self.assertIn("APPLE_CERTIFICATE<<", env_file.read_text())


if __name__ == "__main__":
    unittest.main()
