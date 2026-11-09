"""Exercise the shipped login script with a fake launchctl; never change this Mac."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "src-tauri/src/loopback_proxy/login.sh"

class LoginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / "environment.json"
        self.state.write_text(json.dumps({"NO_PROXY": "upper.test", "no_proxy": "lower.test"}))
        fake = self.root / "launchctl"
        fake.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p = Path(os.environ["FAKE_ENV"])
s = json.loads(p.read_text())
a = sys.argv[1:]
if a[0] == "getenv": print(s.get(a[1], ""))
elif a[0] == "setenv":
    if os.environ.get("FAIL_LOWER") and a[1] == "no_proxy": sys.exit(1)
    s[a[1]] = a[2]
elif a[0] == "unsetenv": s.pop(a[1], None)
p.write_text(json.dumps(s))
''')
        fake.chmod(0o700)
        self.script = self.root / "login.sh"
        self.script.write_text(SCRIPT.read_text().replace("/bin/launchctl", str(fake)))
        (self.root / "baseline").write_text("upper.test,lower.test")

    def run_script(self, action="apply", fail=False):
        env = dict(os.environ, FAKE_ENV=str(self.state))
        if fail: env["FAIL_LOWER"] = "1"
        return subprocess.run(["/bin/sh", str(self.script), str(self.root), action], env=env, capture_output=True).returncode

    def values(self): return json.loads(self.state.read_text())

    def test_merge_idempotence_and_restore_both_original_values(self):
        self.assertEqual(self.run_script(), 0)
        first = self.values()
        self.assertEqual(first["NO_PROXY"], first["no_proxy"])
        for host in ["upper.test", "lower.test", "localhost", "127.0.0.1", "::1"]:
            self.assertIn(host, first["NO_PROXY"].split(","))
        self.assertEqual(self.run_script(), 0)
        self.assertEqual(self.values(), first)
        self.assertEqual(self.run_script("restore"), 0)
        self.assertEqual(self.values(), {"NO_PROXY": "upper.test", "no_proxy": "lower.test"})

    def test_relogin_merges_new_entries_and_restores_session_before_values(self):
        self.assertEqual(self.run_script(), 0)
        self.state.write_text(json.dumps({"no_proxy": "new-login.test"}))
        self.assertEqual(self.run_script(), 0)
        self.assertIn("new-login.test", self.values()["NO_PROXY"])
        self.assertIn("upper.test", self.values()["NO_PROXY"])
        self.assertEqual(self.run_script("restore"), 0)
        self.assertEqual(self.values(), {"no_proxy": "new-login.test"})

    def test_external_edits_are_not_overwritten_on_undo(self):
        self.run_script()
        changed = self.values()
        changed["NO_PROXY"] += ",later.test"
        self.state.write_text(json.dumps(changed))
        self.assertEqual(self.run_script("restore"), 2)
        self.assertEqual(self.values(), changed)

    def test_partial_apply_rolls_back_upper(self):
        self.assertNotEqual(self.run_script(fail=True), 0)
        self.assertEqual(self.values(), {"NO_PROXY": "upper.test", "no_proxy": "lower.test"})

    def test_partial_restore_rolls_back_upper(self):
        self.run_script()
        before = self.values()
        self.assertNotEqual(self.run_script("restore", fail=True), 0)
        self.assertEqual(self.values(), before)

    def test_empty_environment_and_shell_metacharacters(self):
        self.state.write_text(json.dumps({"no_proxy": "$(touch SHOULD_NOT_EXIST),*.internal"}))
        self.assertEqual(self.run_script(), 0)
        self.assertIn("$(touch SHOULD_NOT_EXIST)", self.values()["NO_PROXY"])
        self.assertFalse((Path.cwd() / "SHOULD_NOT_EXIST").exists())
        self.assertEqual(self.run_script("restore"), 0)
        self.assertEqual(self.values(), {"no_proxy": "$(touch SHOULD_NOT_EXIST),*.internal"})

if __name__ == "__main__": unittest.main()
