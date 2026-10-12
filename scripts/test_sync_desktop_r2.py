#!/usr/bin/env python3
"""Release gating, immutable writes and resume tests, without cloud credentials."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("delivery", Path(__file__).with_name("sync-desktop-r2.py"))
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class Missing(Exception):
    response = {"Error": {"Code": "404"}}


class Forbidden(Exception):
    response = {"Error": {"Code": "AccessDenied"}}


class Storage:
    def __init__(self):
        self.objects = {}
        self.writes = []
        self.fail = False

    def head_object(self, Bucket, Key):
        if self.fail:
            raise Forbidden()
        if Key not in self.objects:
            raise Missing()
        obj = self.objects[Key]
        return {"ContentLength": len(obj["Body"]), "ETag": '"etag"',
                "Metadata": obj.get("Metadata", {}), "CacheControl": obj.get("CacheControl")}

    def get_object(self, Bucket, Key, IfMatch):
        return {"Body": io.BytesIO(self.objects[Key]["Body"])}

    def put_object(self, **args):
        assert ("IfNoneMatch" in args) != ("IfMatch" in args), "Unconditional immutable write"
        if args["Key"] not in self.objects:
            assert args["IfNoneMatch"] == "*"
        else:
            assert args["IfMatch"] == '"etag"'
        self.writes.append(args["Key"])
        self.objects[args["Key"]] = args


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.version = "0.1.78"
        self.files = {name: ("fixture-" + name).encode()
                      for name in delivery.expected_names(self.version)}
        self.manifest = {"version": self.version, "platforms": {}}
        for platform, suffix in delivery.UPDATERS.items():
            name = f"YuanHeng.Desktop_{self.version}_{suffix}"
            self.manifest["platforms"][platform] = {
                "url": f"https://github.com/{delivery.REPOSITORY}/releases/download/v{self.version}/{name}",
                "signature": self.files[name + ".sig"].decode(),
            }
        self.storage = Storage()
        self.checked = []
        self.prepare()

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self):
        self.files["latest.json"] = json.dumps(self.manifest).encode()
        self.release = {"tag_name": "v" + self.version, "draft": False, "prerelease": False,
                        "assets": [{"name": name, "size": len(data),
                                    "digest": "sha256:" + hashlib.sha256(data).hexdigest()}
                                   for name, data in self.files.items()]}
        for name, data in self.files.items():
            (self.root / name).write_bytes(data)

    def sync(self, verify=None):
        assets = delivery.validate_release(self.release, self.version)
        delivery.sync_release(self.storage, "bucket", self.root, assets, self.version,
                              verify or (lambda version, name, asset, root: self.checked.append(name)))

    def test_complete_release_and_resume_never_upload_latest(self):
        self.sync()
        self.assertEqual(len(self.storage.writes), 8)
        self.assertEqual(len(self.checked), 8)
        self.assertFalse(any(key.endswith("latest.json") for key in self.storage.writes))
        self.sync()
        self.assertEqual(len(self.storage.writes), 8)
        self.assertEqual(len(self.checked), 16)

    def test_partial_run_resumes_and_verifies_public_bytes_again(self):
        def fail(*args):
            raise delivery.DeliveryError("Public verification failed")
        with self.assertRaises(delivery.DeliveryError):
            self.sync(fail)
        self.assertEqual(len(self.storage.writes), 1)
        self.sync()
        self.assertEqual(len(self.storage.writes), 8)
        self.assertEqual(len(self.checked), 8)

    def test_one_corrupt_file_prevents_all_writes(self):
        (self.root / f"YuanHeng.Desktop_{self.version}_x64.dmg").write_bytes(b"corrupt")
        with self.assertRaises(delivery.DeliveryError):
            self.sync()
        self.assertEqual(self.storage.writes, [])

    def test_signed_manifest_must_match_asset_signature(self):
        self.manifest["platforms"]["darwin-aarch64"]["signature"] = "wrong"
        self.prepare()
        with self.assertRaises(delivery.DeliveryError):
            self.sync()
        self.assertEqual(self.storage.writes, [])

    def test_missing_platform_or_untrusted_url_prevents_writes(self):
        original = dict(self.manifest["platforms"])
        del self.manifest["platforms"]["windows-x86_64"]
        self.prepare()
        with self.assertRaises(delivery.DeliveryError):
            self.sync()
        self.manifest["platforms"] = original
        original["windows-x86_64"]["url"] = "https://example.test/installer.exe"
        self.prepare()
        with self.assertRaises(delivery.DeliveryError):
            self.sync()
        self.assertEqual(self.storage.writes, [])

    def test_missing_digest_asset_or_unpublished_release_is_rejected(self):
        for change in [lambda r: r.update(draft=True), lambda r: r.update(prerelease=True),
                       lambda r: r["assets"].pop(), lambda r: r["assets"][0].update(digest=None)]:
            with self.subTest(change=change):
                self.prepare()
                change(self.release)
                with self.assertRaises(delivery.DeliveryError):
                    self.sync()
        self.assertEqual(self.storage.writes, [])

    def test_existing_same_size_wrong_bytes_are_never_overwritten(self):
        name = sorted(set(self.files) - {"latest.json"})[0]
        key = f"desktop/update/releases/{self.version}/{name}"
        self.storage.objects[key] = {"Body": b"x" * len(self.files[name])}
        with self.assertRaises(delivery.DeliveryError):
            self.sync()
        self.assertEqual(self.storage.writes, [])

    def test_identical_ui_object_receives_cache_metadata_conditionally(self):
        name = sorted(set(self.files) - {"latest.json"})[0]
        key = f"desktop/update/releases/{self.version}/{name}"
        self.storage.objects[key] = {"Body": self.files[name]}
        self.sync()
        self.assertEqual(self.storage.objects[key]["CacheControl"], delivery.CACHE_CONTROL)
        self.assertEqual(self.storage.objects[key]["IfMatch"], '"etag"')

    def test_permission_error_is_not_treated_as_absent_object(self):
        self.storage.fail = True
        with self.assertRaises(delivery.DeliveryError):
            self.sync()
        self.assertEqual(self.storage.writes, [])

    def test_rejects_unsafe_and_prerelease_version(self):
        for version in ["../0.1.78", "01.1.78", "0.1.78-beta", "0.1.78;exit 0"]:
            with self.assertRaises(delivery.DeliveryError):
                delivery.version_number(version)


if __name__ == "__main__":
    unittest.main()
