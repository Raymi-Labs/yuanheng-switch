#!/usr/bin/env python3
"""Offline tests for release mirror resume; uses fake gh/curl and no credentials."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("mirror-desktop-update.sh").resolve()
FAKE_TOOL = r'''#!/usr/bin/env python3
import json,os,pathlib,sys,urllib.parse
state_path=pathlib.Path(os.environ['MIRROR_TEST_STATE'])
state=json.loads(state_path.read_text()); args=sys.argv[1:]
def arg(flag): return args[args.index(flag)+1]
def save(): state_path.write_text(json.dumps(state))
if pathlib.Path(sys.argv[0]).name=='gh':
 if args[0]=='api': print(json.dumps(state['release']))
 else:
  name=arg('--pattern'); target=pathlib.Path(arg('--dir'))/name
  if name=='latest.json': target.write_text(json.dumps(state['manifest']))
  else: target.write_bytes(b'x'*next(a['size'] for a in state['release']['assets'] if a['name']==name))
else:
 url=next(a for a in args if a.startswith('https://'))
 name=urllib.parse.unquote(urllib.parse.urlparse(url).path.rsplit('/',1)[-1])
 output=pathlib.Path(arg('--output'))
 if '--head' in args:
  if urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get('origin') != ['1']: sys.exit(99)
  if name not in state['mirrored']: sys.exit(22)
  output.write_text('HTTP/2 200\r\nContent-Length: '+str(state['mirrored'][name])+'\r\n\r\n')
 elif '--request' in args:
  if name==state.get('fail_upload'): sys.exit(22)
  source=pathlib.Path(arg('--data-binary')[1:])
  state['uploads'].append(name)
  if name=='latest.json': state['current']=json.loads(source.read_text())
  else: state['mirrored'][name]=source.stat().st_size
  save(); output.write_text('{}')
 else: output.write_text(json.dumps(state['current']))
'''


class MirrorResumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state_path = self.root / "state.json"
        self.files = {"arm.app.tar.gz": 17, "intel.app.tar.gz": 19, "windows.exe": 23}
        manifest = {
            "version": "0.1.51", "notes": "测试公告",
            "release_notes": [{"version": "0.1.51"}, {"version": "0.1.50"}],
            "platforms": {
                platform: {"url": "https://github.com/test/releases/download/v0.1.51/" + name,
                           "signature": "test-signature"}
                for platform, name in zip(
                    ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"], self.files
                )
            },
        }
        self.state = {
            "manifest": manifest, "current": {"version": "0.1.50"}, "uploads": [],
            "mirrored": self.files.copy(),
            "release": {"tag_name": "v0.1.51", "draft": False, "prerelease": False,
                        "assets": [{"name": "latest.json", "size": 100}] +
                        [{"name": name, "size": size} for name, size in self.files.items()]},
        }
        for name in ["gh", "curl"]:
            path = self.root / name
            path.write_text(FAKE_TOOL)
            path.chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    def run_mirror(self, version="0.1.51"):
        self.state_path.write_text(json.dumps(self.state))
        env = dict(os.environ)
        env.update({"PATH": str(self.root) + os.pathsep + env["PATH"],
                    "MIRROR_TEST_STATE": str(self.state_path), "GITHUB_REPOSITORY": "test/repo",
                    "DESKTOP_UPDATE_PUBLISH_URL": "https://example.test/publish",
                    "DESKTOP_UPDATE_PUBLIC_URL": "https://example.test/update",
                    "DESKTOP_UPDATE_PUBLISH_TOKEN": "fake-test-token"})
        result = subprocess.run(["bash", str(SCRIPT), version], env=env, capture_output=True, text=True)
        self.state = json.loads(self.state_path.read_text())
        self.assertNotIn("fake-test-token", result.stdout + result.stderr)
        return result

    def test_skips_all_verified_files(self):
        result = self.run_mirror()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state["uploads"], ["latest.json"])

    def test_uploads_only_missing_file_and_manifest_last(self):
        del self.state["mirrored"]["windows.exe"]
        result = self.run_mirror()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state["uploads"], ["windows.exe", "latest.json"])
        self.state["uploads"] = []
        self.assertEqual(self.run_mirror().returncode, 0)
        self.assertEqual(self.state["uploads"], ["latest.json"])

    def test_replaces_incomplete_upload(self):
        self.state["mirrored"]["intel.app.tar.gz"] = 1
        self.assertEqual(self.run_mirror().returncode, 0)
        self.assertEqual(self.state["uploads"], ["intel.app.tar.gz", "latest.json"])

    def test_upload_failure_keeps_previous_manifest(self):
        del self.state["mirrored"]["windows.exe"]
        self.state["fail_upload"] = "windows.exe"
        self.assertNotEqual(self.run_mirror().returncode, 0)
        self.assertEqual(self.state["current"]["version"], "0.1.50")
        self.assertNotIn("latest.json", self.state["uploads"])

    def test_never_downgrades_newer_manifest(self):
        self.state["current"]["version"] = "0.1.52"
        self.assertNotEqual(self.run_mirror().returncode, 0)
        self.assertEqual(self.state["current"]["version"], "0.1.52")
        self.assertNotIn("latest.json", self.state["uploads"])

    def test_rejects_non_version_input(self):
        self.assertNotEqual(self.run_mirror("0.1.51;exit 0").returncode, 0)
        self.assertEqual(self.state["uploads"], [])


if __name__ == "__main__":
    unittest.main()
