"""Read public official metadata; never download/execute an application or relax gates."""
import json
import re
import sys
import urllib.request
from pathlib import Path

URL = "https://work-download.accio-ai.com/package/beta-mac.yml"
LIMIT = 65536


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def version_from_manifest(data):
    if len(data) > LIMIT:
        raise ValueError("manifest_too_large")
    text = data.decode("utf-8", errors="strict")
    matches = [line[len("version:"):].strip() for line in text.splitlines()
               if line.startswith("version:")]
    if len(matches) != 1 or not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", matches[0]) or len(matches[0]) > 40:
        raise ValueError("invalid_version")
    return matches[0]


def supported_versions(source):
    match = re.search(r"const SUPPORTED_VERSIONS: &\[&str\] = &\[([^\]]+)\];", source)
    if not match:
        raise ValueError("version_gate_not_found")
    versions = re.findall(r'"([0-9]+\.[0-9]+\.[0-9]+)"', match[1])
    if not versions or re.sub(r'"[0-9]+\.[0-9]+\.[0-9]+"|[\s,]', '', match[1]):
        raise ValueError("version_gate_invalid")
    return versions


def inspect(data, source):
    version = version_from_manifest(data)
    supported = supported_versions(source)
    return {"officialVersion": version, "verifiedVersions": supported,
            "requiresCompatibilityReview": version not in supported,
            "applicationDownloaded": False, "gateChanged": False}


def main():
    root = Path(__file__).resolve().parent.parent
    source = (root / "src-tauri/src/accio_work/installation.rs").read_text()
    try:
        request = urllib.request.Request(URL, headers={"User-Agent": "YuanHeng-Compatibility-Check"})
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            if response.status != 200 or response.url != URL:
                raise ValueError("unexpected_response")
            report = inspect(response.read(LIMIT + 1), source)
    except Exception:
        # Do not expose proxy credentials, request headers or server bodies.
        print(json.dumps({"status": "check_failed", "message": "Official metadata unavailable or invalid"}))
        return 2
    print(json.dumps(report, ensure_ascii=False))
    if report["requiresCompatibilityReview"]:
        print("Official version needs signature, protocol and native regression review before enabling.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
