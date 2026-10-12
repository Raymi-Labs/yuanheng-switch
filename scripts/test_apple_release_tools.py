#!/usr/bin/env python3
"""Offline regressions for Apple service failures and swallowed Tauri errors."""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("apple_tools", ROOT / "scripts/apple-release-tools.py")
tools = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tools)


class AppleToolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="apple retry fixture ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.state.mkdir()
        self.target = "x86_64-apple-darwin"
        self.app = self.root / "src-tauri/target" / self.target / "release/bundle/macos/Fixture App.app"
        self.app.mkdir(parents=True)
        (self.root / "src-tauri/tauri.conf.json").write_text(json.dumps({"productName": "Fixture App"}))
        env = patch.dict(os.environ, {"YUANHENG_APPLE_TOOL_STATE": str(self.state)})
        env.start()
        self.addCleanup(env.stop)
        self.output = io.StringIO()
        for manager in (contextlib.redirect_stdout(self.output), contextlib.redirect_stderr(self.output)):
            manager.__enter__()
            self.addCleanup(manager.__exit__, None, None, None)

    def staple(self):
        return tools.retry_tool("xcrun", ["stapler", "staple", "-v", str(self.app)])

    def test_staple_retries_then_validates_before_success_receipt(self):
        with patch.object(tools, "execute", side_effect=[(68, "ticket not found"), (0, "stapled"), (0, "validated")]) as execute:
            with patch.object(tools.time, "sleep") as sleep:
                self.assertEqual(self.staple(), 0)
        self.assertEqual(sleep.call_args.args, (15,))
        self.assertEqual(execute.call_args.args[0], ["/usr/bin/xcrun", "stapler", "validate", str(self.app.resolve())])
        tools.report(self.root, self.target)
        self.assertIn("ticket not found", (self.state / "diagnostics.log").read_text())

    def test_staple_exit_zero_with_invalid_ticket_retries(self):
        results = [(0, "stapled"), (65, "ticket invalid"), (0, "stapled"), (0, "validated")]
        with patch.object(tools, "execute", side_effect=results), patch.object(tools.time, "sleep") as sleep:
            self.assertEqual(self.staple(), 0)
        self.assertEqual(sleep.call_count, 1)

    def test_exhausted_retries_block_report_even_if_tauri_ignores_exit(self):
        with patch.object(tools, "execute", return_value=(68, "No ticket")) as execute:
            with patch.object(tools.time, "sleep") as sleep:
                self.assertNotEqual(self.staple(), 0)
        self.assertEqual(execute.call_count, 5)
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [15, 30, 60, 120])
        self.assertFalse((self.state / "tickets.jsonl").exists())
        with self.assertRaisesRegex(RuntimeError, "refusing to collect"):
            tools.report(self.root, self.target)

    def test_missing_staple_and_receipt_from_other_build_are_rejected(self):
        for receipt in (None, {"app": "/other/build/Fixture App.app"}):
            if receipt:
                (self.state / "tickets.jsonl").write_text(json.dumps(receipt))
            with self.assertRaisesRegex(RuntimeError, "Missing successful"):
                tools.report(self.root, self.target)

    def test_invalid_target_never_calls_native_tool(self):
        self.app.rmdir()
        with patch.object(tools, "execute") as execute:
            self.assertEqual(self.staple(), 1)
        execute.assert_not_called()

    def test_codesign_retries_only_timestamp_service_errors(self):
        args = ["--force", "-s", "identity", "path with spaces.dmg"]
        with patch.object(tools, "execute", side_effect=[(1, "The timestamp service is not available."), (0, "signed")]) as execute:
            with patch.object(tools.time, "sleep") as sleep:
                self.assertEqual(tools.retry_tool("codesign", args), 0)
        self.assertEqual(execute.call_count, 2)
        self.assertEqual(sleep.call_count, 1)
        self.assertEqual(execute.call_args.args[0], ["/usr/bin/codesign", *args])
        for error in ("identity not found", "invalid entitlements", "certificate expired"):
            with patch.object(tools, "execute", return_value=(1, error)) as execute:
                with patch.object(tools.time, "sleep") as sleep:
                    self.assertEqual(tools.retry_tool("codesign", args), 1)
            self.assertEqual(execute.call_count, 1)
            sleep.assert_not_called()

    def test_codesign_timestamp_retries_are_bounded(self):
        with patch.object(tools, "execute", return_value=(1, "timestamp service is not available")) as execute:
            with patch.object(tools.time, "sleep") as sleep:
                self.assertEqual(tools.retry_tool("codesign", ["--sign", "identity", "app"]), 1)
        self.assertEqual(execute.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_other_commands_keep_arguments_and_io_without_logging_credentials(self):
        for tool, args in (
            ("xcrun", ["notarytool", "submit", "app.zip", "--password", "private-password"]),
            ("xcrun", ["--sdk", "macosx", "--show-sdk-path"]),
            ("codesign", ["--verify", "--deep", str(self.app)]),
        ):
            with patch.object(tools.os, "execv") as execv:
                self.assertEqual(tools.retry_tool(tool, args), 0)
            execv.assert_called_once_with(f"/usr/bin/{tool}", [f"/usr/bin/{tool}", *args])
        self.assertFalse((self.state / "diagnostics.log").exists())

    def test_diagnostics_redact_credentials_in_failure_output(self):
        with patch.dict(os.environ, {"APPLE_PASSWORD": "private-password", "APPLE_ID": "private@example.test"}):
            with patch.object(tools, "execute", return_value=(1, "private-password private@example.test")):
                tools.retry_tool("codesign", ["-s", "identity", "app"])
        output = self.output.getvalue() + (self.state / "diagnostics.log").read_text()
        self.assertNotIn("private-password", output)
        self.assertNotIn("private@example.test", output)
        self.assertIn("[redacted]", output)

    def test_native_timeout_is_bounded_without_printing_command_arguments(self):
        with patch.object(tools.subprocess, "run", side_effect=subprocess.TimeoutExpired(["secret"], 120)):
            code, output = tools.execute(["secret"])
        self.assertEqual(code, 124)
        self.assertNotIn("secret", output)

    def test_installed_wrappers_preserve_spaces_and_use_isolated_state(self):
        path_file, env_file = self.root / "path", self.root / "env"
        fake_python = self.root / "python fixture"
        fake_python.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\"\n")
        fake_python.chmod(0o700)
        env = {"RUNNER_TEMP": str(self.root), "GITHUB_PATH": str(path_file), "GITHUB_ENV": str(env_file)}
        with patch.dict(os.environ, env), patch.object(tools.sys, "executable", str(fake_python)):
            tools.install()
            tools.install()
        directories = path_file.read_text().splitlines()
        self.assertEqual(len(set(directories)), 2)
        for directory in directories:
            wrapper = Path(directory) / "xcrun"
            result = subprocess.run([str(wrapper), "stapler", "staple", "App With Spaces.app"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines()[1:], ["tool", "xcrun", "stapler", "staple", "App With Spaces.app"])
            self.assertIn(f"YUANHENG_APPLE_TOOL_STATE={directory}", env_file.read_text())


if __name__ == "__main__":
    unittest.main()
