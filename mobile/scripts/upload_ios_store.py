"""Require Apple's explicit JSON success; altool can exit zero after rejection."""
import json
import os
from pathlib import Path
import subprocess
import sys


def check_response(output, action, returncode):
    result = json.loads(output)
    message = result.get("success-message", "")
    verb = {"validate": "validating", "upload": "uploading"}[action]
    if (returncode != 0 or result.get("product-errors")
            or not message.startswith(f"No errors {verb}")):
        raise ValueError(f"Apple {action} did not explicitly succeed: {result}")
    return message


def main():
    ipa = Path(sys.argv[1])
    for action in ("validate", "upload"):
        completed = subprocess.run([
            "xcrun", "altool", f"--{action}-app", "-f", str(ipa), "-t", "ios",
            "-u", os.environ["APPLE_ID"], "-p", "@env:APPLE_PASSWORD",
            "--output-format", "json"], capture_output=True, text=True)
        # Keep the provider response in CI artifacts, never the credential args.
        (ipa.parent / f"apple-{action}.json").write_text(completed.stdout)
        try:
            print(check_response(completed.stdout, action, completed.returncode), flush=True)
        except (ValueError, TypeError, AttributeError):
            print(completed.stderr, file=sys.stderr)
            raise


if __name__ == "__main__":
    main()
