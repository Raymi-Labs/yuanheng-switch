#!/usr/bin/env python3
"""Publish immutable GitHub release assets to R2; never publish latest.json here."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

REPOSITORY = "Raymi-Labs/yuanheng-switch"
LEGACY_REPOSITORY = "nanashiwang/yuanheng-switch"
PUBLIC_BASE = "https://download.meta-api.vip/desktop/update/releases"
CACHE_CONTROL = "public, max-age=31536000, immutable"
MAX_BYTES = 256 * 1024 * 1024
UPDATERS = {
    "darwin-aarch64": "aarch64.app.tar.gz",
    "darwin-x86_64": "x64.app.tar.gz",
    "windows-x86_64": "x64-setup.exe",
}


class DeliveryError(Exception):
    """Only controlled, non-secret diagnostics may be printed to CI logs."""


def require(condition, message):
    if not condition:
        raise DeliveryError(message)


def version_number(value):
    version = value.removeprefix("v")
    require(re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version),
            "Expected a stable numeric release version")
    return version


def expected_names(version):
    names = {f"YuanHeng.Desktop_{version}_{suffix}" for suffix in UPDATERS.values()}
    return names | {name + ".sig" for name in names} | {
        f"YuanHeng.Desktop_{version}_aarch64.dmg",
        f"YuanHeng.Desktop_{version}_x64.dmg", "latest.json",
    }


def validate_release(release, version):
    require(release.get("tag_name") == "v" + version and not release.get("draft", True)
            and not release.get("prerelease", True), "Expected a published stable release")
    assets = release.get("assets", [])
    require(len(assets) == len(expected_names(version)), "Incomplete or unexpected release assets")
    require({a.get("name") for a in assets} == expected_names(version),
            "Incomplete or unexpected release assets")
    for asset in assets:
        require(type(asset.get("size")) is int and 0 < asset["size"] <= MAX_BYTES,
                "Invalid release asset size")
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", asset.get("digest") or ""),
                "GitHub asset SHA-256 is missing")
    return {a["name"]: a for a in assets}


def validate_files(directory, assets, version):
    for name, asset in assets.items():
        path = directory / name
        require(path.is_file() and not path.is_symlink(), "Missing release file: " + name)
        require(path.stat().st_size == asset["size"], "Release size mismatch: " + name)
        require("sha256:" + hashlib.sha256(path.read_bytes()).hexdigest() == asset["digest"],
                "Release digest mismatch: " + name)
    manifest = json.loads((directory / "latest.json").read_text())
    require(manifest.get("version") == version, "Updater version mismatch")
    platforms = manifest.get("platforms", {})
    require(set(UPDATERS) <= platforms.keys(), "Incomplete updater platforms")
    # Transferred historical releases retain their original immutable manifest.
    prefixes = [f"https://github.com/{repo}/releases/download/v{version}/"
                for repo in (REPOSITORY, LEGACY_REPOSITORY)]
    for name, platform in platforms.items():
        require(isinstance(platform, dict), "Invalid updater platform")
        family = name.removesuffix("-app").removesuffix("-nsis")
        require(family in UPDATERS, "Unexpected updater platform")
        filename = f"YuanHeng.Desktop_{version}_{UPDATERS[family]}"
        require(platform.get("url") in [prefix + filename for prefix in prefixes],
                "Unexpected updater asset URL")
        signature = (directory / (filename + ".sig")).read_text().strip()
        require(bool(signature) and platform.get("signature") == signature,
                "Updater signature mismatch: " + filename)


def run(command, timeout):
    result = subprocess.run(command, capture_output=True, timeout=timeout)
    require(result.returncode == 0, f"{Path(command[0]).name} operation failed (exit {result.returncode})")
    return result.stdout


def public_verify(version, name, expected, directory):
    target = directory / "public-verify.tmp"
    run(["curl", "--http1.1", "--fail", "--silent", "--show-error", "--location",
         "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15",
         "--max-time", "180", "--retry", "2", "--retry-all-errors", "--retry-max-time", "540",
         "--output", str(target), f"{PUBLIC_BASE}/{version}/{name}"], 570)
    require(target.stat().st_size == expected["size"], "Public R2 size mismatch: " + name)
    require("sha256:" + hashlib.sha256(target.read_bytes()).hexdigest() == expected["digest"],
            "Public R2 SHA-256 mismatch: " + name)
    target.unlink()


def response_code(error):
    response = getattr(error, "response", {})
    return str(response.get("Error", {}).get("Code", ""))


def store_asset(s3, bucket, key, path, expected):
    data = path.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    require("sha256:" + sha256 == expected["digest"] and len(data) == expected["size"],
            "Local asset changed after validation")
    try:
        head = s3.head_object(Bucket=bucket, Key=key)
    except Exception as error:
        if response_code(error) not in ("404", "NoSuchKey", "NotFound"):
            raise DeliveryError("R2 object inspection failed") from None
        head = None
    if head is not None:
        # Also handles the first UI-uploaded test object, which has no SHA metadata.
        require(head.get("ContentLength") == len(data), "Refusing to replace a different immutable object")
        stored = s3.get_object(Bucket=bucket, Key=key, IfMatch=head["ETag"])["Body"]
        try:
            actual = stored.read(MAX_BYTES + 1)
        finally:
            stored.close()
        require(hashlib.sha256(actual).hexdigest() == sha256,
                "Refusing to replace a different immutable object")
        if head.get("Metadata", {}).get("sha256") == sha256 and head.get("CacheControl") == CACHE_CONTROL:
            return
    condition = {"IfMatch": head["ETag"]} if head else {"IfNoneMatch": "*"}
    s3.put_object(Bucket=bucket, Key=key, Body=data,
                  ContentLength=len(data), ContentMD5=base64.b64encode(hashlib.md5(data).digest()).decode(),
                  ContentType="application/octet-stream",
                  ContentDisposition=f'attachment; filename="{path.name}"',
                  CacheControl=CACHE_CONTROL, Metadata={"sha256": sha256}, **condition)


def sync_release(s3, bucket, directory, assets, version, verify=public_verify):
    # Validate the WHOLE release before the first write. A partial run can resume,
    # but its caller must not advance the platform manifest until this returns.
    validate_files(directory, assets, version)
    for name in sorted(assets):
        if name == "latest.json":
            continue
        store_asset(s3, bucket, f"desktop/update/releases/{version}/{name}", directory / name, assets[name])
        verify(version, name, assets[name], directory)
        print("R2 verified: " + name, flush=True)


def client_from_environment():
    account = os.environ.get("R2_ACCOUNT_ID", "")
    bucket = os.environ.get("R2_BUCKET", "")
    access = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    require(re.fullmatch(r"[0-9a-f]{32}", account), "R2_ACCOUNT_ID is missing or invalid")
    require(bucket == "yuanheng-desktop-downloads", "Unexpected R2 download bucket")
    require(access and secret, "R2 upload credentials are not configured")
    import boto3
    from botocore.config import Config
    return boto3.client("s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
                        region_name="auto", aws_access_key_id=access, aws_secret_access_key=secret,
                        config=Config(signature_version="s3v4", connect_timeout=15, read_timeout=120,
                                      retries={"max_attempts": 3, "mode": "standard"},
                                      request_checksum_calculation="when_required",
                                      response_checksum_validation="when_required")), bucket


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    args = parser.parse_args()
    version = version_number(args.version)
    require(os.environ.get("GITHUB_REPOSITORY", REPOSITORY) == REPOSITORY,
            "Unexpected release repository")
    s3, bucket = client_from_environment()
    release = json.loads(run(["gh", "api", f"repos/{REPOSITORY}/releases/tags/v{version}"], 60))
    assets = validate_release(release, version)
    with tempfile.TemporaryDirectory(prefix="yuanheng-r2-release-") as root:
        directory = Path(root)
        run(["gh", "release", "download", "v" + version, "--repo", REPOSITORY, "--dir", root], 600)
        sync_release(s3, bucket, directory, assets, version)
    print(f"R2 release complete: v{version}; all eight assets verified; latest.json was not modified")


if __name__ == "__main__":
    try:
        main()
    except DeliveryError as error:
        print("R2 delivery failed: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # SDK / subprocess errors may contain authenticated request details.
        print("R2 delivery failed: " + type(error).__name__ + "; previous manifest retained", file=sys.stderr)
        sys.exit(1)
