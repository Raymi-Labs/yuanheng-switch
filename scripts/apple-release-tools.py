#!/usr/bin/env python3
"""Bounded retries around Tauri's Apple tools, scoped to one release job.

Tauri 2.8.1 discards stapler's exit status/output. Keep a separate receipt and
failure marker so even a successful Tauri action cannot hide a failed staple.
All unrelated commands exec the native tool with their original arguments/IO.
"""

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

STAPLE_DELAYS = (15, 30, 60, 120)
SIGN_DELAYS = (15, 30)
SECRET_NAMES = (
    "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_PASSWORD",
    "APPLE_ID", "APPLE_SIGNING_IDENTITY", "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
)


def state_dir():
    return Path(os.environ["YUANHENG_APPLE_TOOL_STATE"])


def redact(message):
    for name in SECRET_NAMES:
        value = os.environ.get(name)
        if value:
            message = message.replace(value, "[redacted]")
    return message


def record(message):
    # Do not log command arguments: notarytool arguments can contain credentials.
    with (state_dir() / "diagnostics.log").open("a") as stream:
        stream.write(redact(message) + "\n")


def execute(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                errors="replace", timeout=120)
        return result.returncode, result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        return 124, "Apple tool exceeded the 120 second timeout"


def retry_tool(tool, args):
    stapling = tool == "xcrun" and args[:2] == ["stapler", "staple"]
    signing = tool == "codesign" and ("-s" in args or "--sign" in args)
    executable = f"/usr/bin/{tool}"
    if not stapling and not signing:
        os.execv(executable, [executable, *args])
        return 0

    # Fail before invoking a retryable command if the isolated state is missing.
    record(f"Starting {'staple' if stapling else 'codesign'}")
    app = Path(args[-1]).resolve() if stapling else None
    if stapling and (not app.is_dir() or app.suffix != ".app"):
        record("Refusing stapling: expected an existing .app bundle")
        (state_dir() / "failed").write_text("Invalid stapling target\n")
        return 1

    delays = STAPLE_DELAYS if stapling else SIGN_DELAYS
    for attempt in range(len(delays) + 1):
        code, output = execute([executable, *args])
        if stapling and code == 0:
            code, validation = execute(["/usr/bin/xcrun", "stapler", "validate", str(app)])
            output += validation
        if code == 0:
            if stapling:
                with (state_dir() / "tickets.jsonl").open("a") as stream:
                    stream.write(json.dumps({"app": str(app)}) + "\n")
            record(f"{'Staple and validation' if stapling else 'Codesign'} passed on attempt {attempt + 1}")
            print(redact(output), end="", flush=True)
            return 0

        record(f"Attempt {attempt + 1} failed (exit {code}):\n{output}")
        # Never retry certificate, identity, entitlement or other signing errors.
        transient = stapling or "timestamp service is not available" in output.lower()
        if not transient or attempt == len(delays):
            (state_dir() / "failed").write_text(f"{tool} failed after {attempt + 1} attempt(s)\n")
            print(redact(output), file=sys.stderr, flush=True)
            return code if code > 0 else 1
        record(f"Retrying in {delays[attempt]} seconds")
        time.sleep(delays[attempt])
    raise AssertionError("unreachable")


def install():
    directory = Path(tempfile.mkdtemp(prefix="yuanheng-apple-tools-", dir=os.environ["RUNNER_TEMP"]))
    script = Path(__file__).resolve()
    for tool in ("xcrun", "codesign"):
        wrapper = directory / tool
        wrapper.write_text(f"#!/bin/sh\nexec {shlex.quote(sys.executable)} "
                           f"{shlex.quote(str(script))} tool {tool} \"$@\"\n")
        wrapper.chmod(0o700)
    with Path(os.environ["GITHUB_PATH"]).open("a") as stream:
        stream.write(str(directory) + "\n")
    with Path(os.environ["GITHUB_ENV"]).open("a") as stream:
        stream.write(f"YUANHENG_APPLE_TOOL_STATE={directory}\n")


def report(root, target):
    directory = state_dir()
    log = directory / "diagnostics.log"
    if log.exists():
        print(redact(log.read_text()), flush=True)
    if (directory / "failed").exists():
        raise RuntimeError("Apple tool retries failed; refusing to collect or publish artifacts")
    config = json.loads((root / "src-tauri/tauri.conf.json").read_text())
    app = (root / "src-tauri/target" / target / "release/bundle/macos" /
           f"{config['productName']}.app").resolve()
    receipts = directory / "tickets.jsonl"
    verified = {json.loads(line)["app"] for line in receipts.read_text().splitlines()} if receipts.exists() else set()
    if str(app) not in verified:
        raise RuntimeError("Missing successful stapler validation receipt for this build")
    print("Apple tool retries and pre-packaging stapler validation passed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("install")
    tool_parser = sub.add_parser("tool")
    tool_parser.add_argument("tool", choices=("xcrun", "codesign"))
    tool_parser.add_argument("args", nargs=argparse.REMAINDER)
    report_parser = sub.add_parser("report")
    report_parser.add_argument("target", choices=("aarch64-apple-darwin", "x86_64-apple-darwin"))
    options = parser.parse_args()
    if options.command == "install":
        install()
    elif options.command == "tool":
        sys.exit(retry_tool(options.tool, options.args))
    else:
        report(Path(__file__).resolve().parent.parent, options.target)
