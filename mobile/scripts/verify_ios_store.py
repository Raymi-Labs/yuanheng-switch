"""Verify an exported App Store IPA before retaining or uploading it."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import zipfile

TEAM = "GY42242ZWS"
BUNDLE = "com.nanashiwang.yuanhengmobile"
CERT_SHA256 = "94c60c1f3801aeb45f6d9a20a4e439f165ebc9c336ac792a7bbe7a0551b13d27"


def check_metadata(info, profile, entitlements, version, build):
    """Fail closed on simulator, wrong identity, development or device-limited exports."""
    expected = f"{TEAM}.{BUNDLE}"
    if (info.get("CFBundleIdentifier") != BUNDLE
            or info.get("CFBundleShortVersionString") != version
            or info.get("CFBundleVersion") != build
            or info.get("DTPlatformName") != "iphoneos"):
        raise ValueError("IPA platform, bundle ID or version mismatch")
    if profile.get("TeamIdentifier") != [TEAM]:
        raise ValueError("Incorrect signing team")
    if "ProvisionedDevices" in profile or profile.get("ProvisionsAllDevices"):
        raise ValueError("Expected App Store profile, not Ad Hoc/development/enterprise")
    if profile["ExpirationDate"].replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        raise ValueError("Expired provisioning profile")
    if not any(hashlib.sha256(cert).hexdigest() == CERT_SHA256
               for cert in profile.get("DeveloperCertificates", [])):
        raise ValueError("Unexpected profile certificate")
    for item in (profile.get("Entitlements", {}), entitlements):
        if (item.get("application-identifier") != expected
                or item.get("com.apple.developer.team-identifier") != TEAM
                or item.get("get-task-allow") is not False):
            raise ValueError("Invalid distribution entitlements")


def main():
    root = Path(__file__).resolve().parents[1]
    config = json.loads((root / "src-tauri/tauri.ios.conf.json").read_text())
    version = config["version"]
    build = os.environ.get("IOS_BUILD_NUMBER", config["bundle"]["iOS"]["bundleVersion"])
    candidates = list((root / "src-tauri/gen/apple").rglob("*.ipa"))
    if len(candidates) != 1:
        raise SystemExit(f"Expected one IPA in clean build, found {len(candidates)}")
    ipa = candidates[0]
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        with zipfile.ZipFile(ipa) as archive:
            if any(Path(name).is_absolute() or ".." in Path(name).parts for name in archive.namelist()):
                raise ValueError("Unsafe IPA archive path")
            archive.extractall(directory)
        apps = list((directory / "Payload").glob("*.app"))
        if len(apps) != 1:
            raise ValueError("Expected one app payload")
        app = apps[0]
        info = plistlib.loads((app / "Info.plist").read_bytes())
        if info.get("UIDeviceFamily") != [1] or int(info.get("DTXcode", "0")) < 2600:
            raise ValueError(
                "Expected iPhone-only app built with Xcode 26 or later; "
                f"device_families={info.get('UIDeviceFamily')}, "
                f"xcode={info.get('DTXcode')}, sdk={info.get('DTSDKName')}"
            )
        privacy = plistlib.loads((app / "PrivacyInfo.xcprivacy").read_bytes())
        if privacy.get("NSPrivacyTracking") is not False:
            raise ValueError("Unexpected tracking declaration")
        profile = plistlib.loads(subprocess.check_output([
            "security", "cms", "-D", "-i", str(app / "embedded.mobileprovision")]))
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
        entitlements = plistlib.loads(subprocess.check_output([
            "codesign", "-d", "--entitlements", ":-", str(app)], stderr=subprocess.DEVNULL))
        check_metadata(info, profile, entitlements, version, build)
        prefix = directory / "signer-"
        subprocess.run(["codesign", "-d", "--extract-certificates", str(prefix), str(app)],
                       check=True, stderr=subprocess.DEVNULL)
        if hashlib.sha256(Path(f"{prefix}0").read_bytes()).hexdigest() != CERT_SHA256:
            raise ValueError("IPA signer differs from approved distribution certificate")
        report = {
            "version": version, "build": build, "bundle_id": BUNDLE, "team": TEAM,
            "signing": "app-store-connect", "certificate_sha256": CERT_SHA256,
            "profile_uuid": profile["UUID"], "profile_expires": profile["ExpirationDate"].isoformat(),
            "sdk": info.get("DTSDKName"), "xcode": info.get("DTXcode"),
            "device_families": info.get("UIDeviceFamily"),
            "privacy_manifests": [str(p.relative_to(app)) for p in app.rglob("*.xcprivacy")],
            "source_commit": os.environ.get("GITHUB_SHA", "local"),
            "sha256": hashlib.sha256(ipa.read_bytes()).hexdigest(),
            "app_store_review": "not-submitted-by-this-script",
        }
    output = root / "artifacts"
    output.mkdir(exist_ok=True)
    target = output / f"YuanHeng-{version}-{build}-ios-appstore.ipa"
    shutil.copyfile(ipa, target)
    (output / "ios-app-store-verification.json").write_text(json.dumps(report, indent=2) + "\n")
    (output / f"{target.name}.sha256").write_text(f"{report['sha256']}  {target.name}\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
