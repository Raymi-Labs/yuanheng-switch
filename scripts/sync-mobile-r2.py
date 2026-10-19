#!/usr/bin/env python3
"""Deliver a reviewed, signed Android release without touching desktop latest."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile

spec = importlib.util.spec_from_file_location("desktop_delivery", Path(__file__).with_name("sync-desktop-r2.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
PUBLIC_BASE = "https://download.meta-api.vip/mobile/releases"
RELEASES = Path(__file__).resolve().parents[1] / "mobile/releases"


def load_metadata(version):
    core.require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-alpha\.[0-9]+)?", version), "Invalid mobile version")
    metadata = json.loads((RELEASES / (version + ".json")).read_text())
    core.require(metadata.get("version") == version, "Mobile version mismatch")
    core.require(metadata.get("filename") == f"YuanHeng-{version}-android-arm64.apk", "Unexpected APK filename")
    core.require(type(metadata.get("size")) is int and 0 < metadata["size"] <= core.MAX_BYTES, "Invalid APK size")
    for key in ("sha256", "certificate_sha256"):
        core.require(re.fullmatch(r"[0-9a-f]{64}", metadata.get(key, "")), "Invalid APK digest")
    return metadata


def validate_release(release, metadata):
    version, filename = metadata["version"], metadata["filename"]
    core.require(release.get("tag_name") == "mobile-v" + version and release.get("draft") is False,
                 "Expected a published mobile release")
    names = {filename, filename + ".sha256"}
    selected = [asset for asset in release.get("assets", []) if asset.get("name") in names]
    core.require(len(selected) == 2 and {asset["name"] for asset in selected} == names, "Missing or duplicate Android assets")
    for asset in selected:
        core.require(type(asset.get("size")) is int and 0 < asset["size"] <= core.MAX_BYTES, "Invalid Android asset size")
        core.require(re.fullmatch(r"sha256:[0-9a-f]{64}", asset.get("digest") or ""), "Missing Android asset digest")
    assets = {asset["name"]: asset for asset in selected}
    core.require(assets[filename]["size"] == metadata["size"] and assets[filename]["digest"] == "sha256:" + metadata["sha256"],
                 "APK does not match the reviewed release")
    return assets


def validate_files(directory, assets, metadata):
    for name, asset in assets.items():
        path = directory / name
        core.require(path.is_file() and not path.is_symlink(), "Missing Android file")
        data = path.read_bytes()
        core.require(len(data) == asset["size"] and "sha256:" + hashlib.sha256(data).hexdigest() == asset["digest"],
                     "Android file size or digest mismatch")
    checksum = (directory / (metadata["filename"] + ".sha256")).read_text().split()
    core.require(checksum == [metadata["sha256"], metadata["filename"]], "APK checksum file mismatch")


def verify_certificate(directory, metadata):
    tool = os.environ.get("APKSIGNER", "apksigner")
    result = core.run([tool, "verify", "--verbose", "--print-certs", str(directory / metadata["filename"])], 60).decode()
    certificates = re.findall(r"^Signer #[0-9]+ certificate SHA-256 digest: ([0-9a-fA-F]+)$", result, re.M)
    core.require([digest.lower() for digest in certificates] == [metadata["certificate_sha256"]], "Unexpected Android signing identity")


def public_verify(version, name, asset, directory):
    target = directory / "public-verify.tmp"
    core.run(["curl", "--http1.1", "--fail", "--silent", "--show-error", "--location",
              "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15",
              "--max-time", "180", "--retry", "2", "--retry-all-errors", "--output", str(target),
              f"{PUBLIC_BASE}/{version}/{name}"], 570)
    core.require(target.stat().st_size == asset["size"] and
                 "sha256:" + hashlib.sha256(target.read_bytes()).hexdigest() == asset["digest"],
                 "Public Android file mismatch")
    target.unlink()


def sync_release(s3, bucket, directory, assets, metadata, verify=public_verify, certificate_check=verify_certificate):
    validate_files(directory, assets, metadata)
    certificate_check(directory, metadata)
    for name, asset in sorted(assets.items()):
        core.store_asset(s3, bucket, f'mobile/releases/{metadata["version"]}/{name}', directory / name, asset)
        verify(metadata["version"], name, asset, directory)
        print("Android public download verified: " + name, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    args = parser.parse_args()
    metadata = load_metadata(args.version)
    core.require(os.environ.get("GITHUB_REPOSITORY", core.REPOSITORY) == core.REPOSITORY, "Unexpected repository")
    release = json.loads(core.run(["gh", "api", f"repos/{core.REPOSITORY}/releases/tags/mobile-v{args.version}"], 60))
    assets = validate_release(release, metadata)
    with tempfile.TemporaryDirectory(prefix="yuanheng-android-delivery-") as root:
        directory = Path(root)
        core.run(["gh", "release", "download", "mobile-v" + args.version, "--repo", core.REPOSITORY,
                  "--pattern", metadata["filename"], "--pattern", metadata["filename"] + ".sha256", "--dir", root], 600)
        s3, bucket = core.client_from_environment()
        sync_release(s3, bucket, directory, assets, metadata)
    print("Android delivery complete; desktop latest unchanged")


if __name__ == "__main__":
    try:
        main()
    except core.DeliveryError as error:
        print("Android delivery failed: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print("Android delivery failed: " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
