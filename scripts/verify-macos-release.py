#!/usr/bin/env python3
"""Verify every shipped macOS app without launching it or reading credentials."""

import argparse
import json
import os
import plistlib
import re
import subprocess
import tempfile
import time
from pathlib import Path


def run(*args):
    # stapler validate also contacts CloudKit. Retry only temporary service/host
    # failures; a missing/invalid ticket, signature or Gatekeeper rejection fails.
    validating_ticket = args[:3] == ("/usr/bin/xcrun", "stapler", "validate")
    for attempt in range(3):
        result = subprocess.run(args, text=True, capture_output=True, timeout=180)
        if result.returncode == 0:
            return result.stdout + result.stderr
        if validating_ticket and result.returncode in (68, 75) and attempt < 2:
            delay = (15, 30)[attempt]
            print(f"stapler validate returned temporary error {result.returncode}; retrying in {delay}s", flush=True)
            time.sleep(delay)
            continue
        raise RuntimeError(f"{Path(args[0]).name} failed (exit {result.returncode}): {result.stdout}{result.stderr}")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def verify_executable(path, identity, team, architecture):
    require(path.is_file(), f"Missing executable: {path}")
    run("/usr/bin/codesign", "--verify", "--strict", "--verbose=2", str(path))
    details = run("/usr/bin/codesign", "--display", "--verbose=4", str(path))
    lines = details.splitlines()
    require(f"Authority={identity}" in lines, "Wrong Developer ID signing identity")
    require(f"TeamIdentifier={team}" in lines, "Wrong Apple signing team")
    require(re.search(r"^CodeDirectory .*\(.*\bruntime\b.*\)", details, re.M),
            "Hardened runtime is missing")
    require(re.search(r"^Timestamp=.+", details, re.M), "Secure timestamp is missing")
    actual_architectures = run("/usr/bin/lipo", "-archs", str(path)).split()
    require(actual_architectures == [architecture], "Unexpected executable architecture")


def verify_app(app, config, identity, team, architecture):
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    require(info.get("CFBundleIdentifier") == config["identifier"], "Wrong app identifier")
    require(info.get("CFBundleShortVersionString") == config["version"], "Wrong app version")
    executable = info.get("CFBundleExecutable", "")
    require(executable and Path(executable).name == executable, "Invalid app executable name")
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app))
    for name in (executable, "yuanheng-core"):
        verify_executable(app / "Contents/MacOS" / name, identity, team, architecture)
    run("/usr/bin/xcrun", "stapler", "validate", str(app))
    run("/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=2", str(app))


def verify_release(root, target):
    architectures = {"aarch64-apple-darwin": "arm64", "x86_64-apple-darwin": "x86_64"}
    require(target in architectures, "Only supported macOS release targets can be verified")
    config = json.loads((root / "src-tauri/tauri.conf.json").read_text())
    identity = os.environ.get("APPLE_SIGNING_IDENTITY", "")
    team = os.environ.get("APPLE_TEAM_ID", "")
    require(re.fullmatch(r"[A-Z0-9]{10}", team), "Missing or invalid APPLE_TEAM_ID")
    require(identity.startswith("Developer ID Application: ") and identity.endswith(f"({team})"),
            "Missing or invalid APPLE_SIGNING_IDENTITY")
    bundle = root / "src-tauri/target" / target / "release/bundle"
    app_name = f"{config['productName']}.app"
    app = bundle / "macos" / app_name
    archive = bundle / "macos" / f"{app_name}.tar.gz"
    arch_suffix = "aarch64" if target.startswith("aarch64") else "x64"
    dmg = bundle / "dmg" / f"{config['productName']}_{config['version']}_{arch_suffix}.dmg"
    require(archive.is_file() and dmg.is_file(), "Missing updater archive or DMG")

    def check_app(path, source):
        verify_app(path, config, identity, team, architectures[target])
        print(f"Verified Developer ID, runtime, timestamp, notarization and Gatekeeper: {source}")

    check_app(app, "build app")
    with tempfile.TemporaryDirectory(prefix="yuanheng-macos-release-") as temporary:
        temporary = Path(temporary)
        extracted = temporary / "updater"
        extracted.mkdir()
        # This archive is produced by this trusted build, before artifact upload.
        run("/usr/bin/tar", "-xzf", str(archive), "-C", str(extracted))
        require(sorted(p.name for p in extracted.iterdir()) == [app_name],
                "Unexpected updater archive contents")
        check_app(extracted / app_name, "updater archive")
        mount = temporary / "dmg"
        mount.mkdir()
        mounted = False
        try:
            run("/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen",
                "-mountpoint", str(mount), str(dmg))
            mounted = True
            check_app(mount / app_name, "DMG")
        finally:
            if mounted:
                run("/usr/bin/hdiutil", "detach", str(mount))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=["aarch64-apple-darwin", "x86_64-apple-darwin"])
    args = parser.parse_args()
    verify_release(Path(__file__).resolve().parent.parent, args.target)
