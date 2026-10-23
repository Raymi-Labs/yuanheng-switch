"""Distribution safety checks with synthetic metadata, no real credentials."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import unittest
from unittest.mock import patch
from verify_ios_store import BUNDLE, TEAM, check_metadata


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.info = {"CFBundleIdentifier": BUNDLE, "CFBundleShortVersionString": "1.0.0",
                     "CFBundleVersion": "1", "DTPlatformName": "iphoneos"}
        self.entitlements = {"application-identifier": f"{TEAM}.{BUNDLE}",
                             "com.apple.developer.team-identifier": TEAM, "get-task-allow": False}
        self.profile = {"TeamIdentifier": [TEAM], "Entitlements": self.entitlements.copy(),
                        "DeveloperCertificates": [b"test-public-certificate"],
                        "ExpirationDate": datetime.now(timezone.utc) + timedelta(days=1)}
        self.signer = patch("verify_ios_store.CERT_SHA256", hashlib.sha256(b"test-public-certificate").hexdigest())
        self.signer.start()
        self.addCleanup(self.signer.stop)

    def check(self, info=None, profile=None, entitlements=None):
        check_metadata(info or self.info, profile or self.profile,
                       entitlements or self.entitlements, "1.0.0", "1")

    def test_app_store(self):
        self.check()

    def test_rejects_non_store_exports(self):
        for change in ({"ProvisionedDevices": ["test-device"]}, {"ProvisionedDevices": []},
                       {"ProvisionsAllDevices": True}, {"TeamIdentifier": ["OTHER"]},
                       {"DeveloperCertificates": [b"wrong-cert"]},
                       {"ExpirationDate": datetime.now(timezone.utc) - timedelta(seconds=1)}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.check(profile={**self.profile, **change})

    def test_rejects_incorrect_app_metadata(self):
        for key, value in (("DTPlatformName", "iphonesimulator"), ("CFBundleIdentifier", "other"),
                           ("CFBundleShortVersionString", "0.1.0"), ("CFBundleVersion", "2")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.check(info={**self.info, key: value})

    def test_rejects_debug_entitlements_in_both_sources(self):
        for target in ("profile", "app"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                if target == "profile":
                    profile = deepcopy(self.profile)
                    profile["Entitlements"]["get-task-allow"] = True
                    self.check(profile=profile)
                else:
                    self.check(entitlements={**self.entitlements, "get-task-allow": True})


if __name__ == "__main__":
    unittest.main()
