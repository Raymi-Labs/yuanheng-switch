"""Verify an official Mac package and run bounded, offline protocol checks.

Never launches Accio, reads an account or changes product compatibility policy.
Only a structured summary is retained; downloaded vendor files are temporary.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import unicodedata
import zipfile

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = "https://work-download.accio-ai.com"
URL = ORIGIN + "/package/beta-mac.yml"
MAX_PACKAGE = 600 * 1024 * 1024
MAX_EXPANDED = 2 * 1024 * 1024 * 1024
IDENTITY = '=anchor apple generic and identifier "com.accio.desktop" and certificate leaf[subject.OU] = "P75YXKHHMH"'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def read_metadata(response):
    chunks, total, start = [], 0, time.monotonic()
    while chunk := response.read1(8192):
        total += len(chunk)
        if total > 65536 or time.monotonic() - start > 30:
            raise ValueError("metadata_limit")
        chunks.append(chunk)
    return b"".join(chunks)


def arm_package(data):
    """Accept only the small, observed official manifest subset; no YAML tags."""
    spec = importlib.util.spec_from_file_location("release", ROOT / "scripts/check-accio-release.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    version = module.version_from_manifest(data)
    blocks = re.findall(r"^  - url: ([^\n]+)\n    sha512: ([^\n]+)\n    size: ([0-9]+)\n    arch: ([a-z0-9]+)$", data.decode(), re.M)
    arms = [b for b in blocks if b[3] == "arm64"]
    if len(arms) != 1:
        raise ValueError("manifest_arm64_ambiguous")
    relative, digest, size, _ = arms[0]
    if not re.fullmatch(r"v" + re.escape(version) + r"/Accio-" + re.escape(version) + r"-[0-9-]+-arm64\.zip", relative):
        raise ValueError("untrusted_package_path")
    expected = base64.b64decode(digest, validate=True)
    if len(expected) != 64 or not 0 < int(size) <= MAX_PACKAGE:
        raise ValueError("invalid_package_metadata")
    return version, ORIGIN + "/package/" + relative, expected, int(size)


def download(url, target, size, digest):
    if urllib.parse.urlsplit(url).netloc != "work-download.accio-ai.com" or not url.startswith(ORIGIN + "/package/"):
        raise ValueError("untrusted_download_origin")
    actual, count, started = hashlib.sha512(), 0, time.monotonic()
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(url, timeout=20) as response, target.open("xb") as output:
        if response.status != 200 or response.url != url:
            raise ValueError("download_status")
        while chunk := response.read1(1024 * 1024):
            count += len(chunk)
            if count > size or time.monotonic() - started > 180:
                raise ValueError("download_limit")
            output.write(chunk)
            actual.update(chunk)
    if count != size or actual.digest() != digest:
        raise ValueError("package_integrity")


def check_archive(path):
    total, seen, links = 0, set(), set()
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 60000:
            raise ValueError("archive_count")
        for entry in entries:
            raw = unicodedata.normalize("NFC", entry.filename.rstrip("/"))
            name = PurePosixPath(raw)
            if (not raw or "\\" in raw or "\x00" in raw or name.is_absolute() or
                    any(p in ("", ".", "..") for p in raw.split("/")) or
                    name.parts[0] != "Accio.app" or raw.casefold() in seen or entry.flag_bits & 1):
                raise ValueError("archive_path")
            seen.add(raw.casefold())
            total += entry.file_size
            if total > MAX_EXPANDED or entry.file_size > MAX_PACKAGE:
                raise ValueError("archive_size")
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode):
                if entry.file_size > 4096:
                    raise ValueError("archive_link_size")
                target = archive.read(entry).decode("utf8")
                if target.startswith("/") or "\\" in target or "\x00" in target or ".." in target.split("/"):
                    raise ValueError("archive_link")
                parts = list(name.parent.parts)
                for part in target.split("/"):
                    if part == "..":
                        if len(parts) <= 1:
                            raise ValueError("archive_link_escape")
                        parts.pop()
                    elif part not in ("", "."):
                        parts.append(part)
                links.add(raw.casefold())
            elif stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError("archive_special_file")
        # A later archive entry may never write through a previously created link.
        for raw in seen:
            if any(str(p).casefold() in links for p in PurePosixPath(raw).parents):
                raise ValueError("archive_link_parent")
    return total


def bounded(command, timeout, env=None):
    # Temp file bounds memory; report never returns raw process output.
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(command, stdout=log, stderr=log, env=env, start_new_session=True)
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if time.monotonic() > deadline or os.fstat(log.fileno()).st_size > 2 * 1024 * 1024:
                    raise TimeoutError("subprocess_limit")
                time.sleep(0.1)
            log.seek(0)
            return process.returncode, log.read(2 * 1024 * 1024).decode("utf8", errors="replace")
        finally:
            # Reap the group even after a parent exits; no background children survive.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def extract_worker(asar, target):
    with asar.open("rb") as stream:
        header = stream.read(16)
        if len(header) != 16:
            raise ValueError("asar_header")
        _, header_size, _, json_size = struct.unpack("<4I", header)
        if not 0 < json_size <= 16 * 1024 * 1024 or not json_size + 8 <= header_size <= json_size + 16:
            raise ValueError("asar_header_size")
        tree = json.loads(stream.read(json_size))
        entry = tree["files"]["out"]["files"]["main"]["files"]["gateway-worker.js"]
        size, offset = entry["size"], int(entry["offset"])
        if entry.get("link") or entry.get("unpacked") or not 0 < size <= 64 * 1024 * 1024 or offset < 0:
            raise ValueError("asar_worker")
        if 8 + header_size + offset + size > asar.stat().st_size:
            raise ValueError("asar_bounds")
        stream.seek(8 + header_size + offset)
        data = stream.read(size)
        if len(data) != size:
            raise ValueError("asar_truncated")
        target.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def run(expected_version=None):
    report = {"schemaVersion": 1, "status": "check_failed", "configurationBlocked": False,
              "nativeGuiTested": False, "paidModelRequests": 0, "officialAppLaunched": False,
              "testProcessesRemaining": 0}
    stage = "metadata"
    try:
        with urllib.request.build_opener(NoRedirect).open(URL, timeout=20) as response:
            if response.status != 200 or response.url != URL:
                raise ValueError("manifest_status")
            version, url, digest, size = arm_package(read_metadata(response))
        report["version"] = version
        if expected_version and version != expected_version:
            report.update(status="review_required", reason="official_version_changed")
            return report
        if sys.platform != "darwin":
            report.update(status="review_required", reason="macos_signature_check_required")
            return report
        with tempfile.TemporaryDirectory(prefix="yh-accio-package-") as folder:
            root = Path(folder)
            package = root / "Accio.zip"
            stage = "download_integrity"
            download(url, package, size, digest)
            report["archiveSha512"] = digest.hex()
            stage = "archive_validation"
            check_archive(package)
            code, _ = bounded(["/usr/bin/ditto", "-x", "-k", str(package), str(root / "unpacked")], 60)
            if code:
                raise ValueError("extract_failed")
            app = root / "unpacked/Accio.app"
            stage = "official_identity"
            code, _ = bounded(["/usr/bin/codesign", "--verify", "--deep", "--strict", "-R", IDENTITY, str(app)], 60)
            if code:
                raise ValueError("signature_failed")
            with (app / "Contents/Info.plist").open("rb") as stream:
                info = plistlib.load(stream)
            if info.get("CFBundleShortVersionString") != version or info.get("CFBundleIdentifier") != "com.accio.desktop":
                raise ValueError("bundle_metadata_mismatch")
            report["officialIdentityVerified"] = True
            stage = "protocol"
            worker = root / "gateway-worker.js"
            report["workerSha256"] = extract_worker(app / "Contents/Resources/app.asar", worker)
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "ACCIO_CANDIDATE_VERSION": version}
            code, text = bounded(["node", str(ROOT / "scripts/test-accio-work-upgrade.cjs"), str(worker), "--match-baseline"], 60, env)
            lines = [line for line in text.splitlines() if line.startswith("{")]
            result = json.loads(lines[-1]) if lines else {}
            if code == 3 and result.get("status") == "review_required":
                report.update(status="review_required", reason="protocol_structure_changed",
                              mismatchCount=len(result.get("mismatches", [])))
            elif code == 0 and result.get("passed") == 16 and result.get("timersRemaining") == 0 and result.get("externalRequests") == 0:
                report.update(status="protocol_passed", protocolChecks=16, timersRemaining=0, externalProtocolRequests=0)
            else:
                report.update(status="check_failed", reason="protocol_regression_failed")
        return report
    except Exception:
        report.update(status="check_failed", failedStage=stage)
        return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-version")
    args = parser.parse_args()
    result = run(args.expected_version)
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(1 if result["status"] == "check_failed" else 0)
