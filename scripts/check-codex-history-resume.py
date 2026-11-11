#!/usr/bin/env python3
"""Offline resume smoke test against a locally installed Codex app-server.

Creates only synthetic history in a temporary CODEX_HOME. Never sends turn/start
or copies credentials. Rust regression tests verify these fixtures are the
production history-route projection. Requires Codex with the v2 thread protocol.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", default="codex")
    parser.add_argument(
        "--preserve-provider",
        choices=["yuanheng", "custom", "yuanheng-switch-official"],
        help="Exercise an upgraded installation retaining its existing provider ID",
    )
    args = parser.parse_args()
    fixtures = Path(__file__).resolve().parents[1] / "tests/fixtures/codex-history"
    aliases = ["yuanheng", "custom", "yuanheng-switch-official"]

    with tempfile.TemporaryDirectory(prefix="yuanheng-history-smoke-") as temp:
        root = Path(temp).resolve()

        class Server:
            def __init__(self, phase):
                config = (fixtures / f"{phase}.toml").read_text()
                if args.preserve_provider and phase != "broken":
                    config = re.sub(
                        r'^model_provider = "[^"]+"',
                        f'model_provider = "{args.preserve_provider}"',
                        config, count=1, flags=re.M,
                    )
                (root / "config.toml").write_text(
                    config + "\n[analytics]\nenabled = false\n", encoding="utf-8"
                )
                env = dict(os.environ)
                env["CODEX_HOME"] = str(root)
                for key in ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_SQLITE_HOME"]:
                    env.pop(key, None)
                self.log = open(root / f"{phase}.log", "w", encoding="utf-8")
                self.seq = 0
                self.messages = queue.Queue()
                self.process = subprocess.Popen(
                    [args.codex, "app-server", "--stdio"], stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=self.log, text=True, env=env, cwd=root,
                )
                self.reader = threading.Thread(target=self.read, daemon=True)
                self.reader.start()
                try:
                    initialized = self.call("initialize", {
                        "clientInfo": {"name": "yuanheng-history-smoke", "version": "1"},
                        "capabilities": {"experimentalApi": True},
                    })
                    assert "result" in initialized, initialized
                    self.send({"method": "initialized", "params": {}})
                except Exception:
                    self.close()
                    raise

            def read(self):
                for line in self.process.stdout:
                    self.messages.put(json.loads(line))

            def send(self, data):
                self.process.stdin.write(json.dumps(data) + "\n")
                self.process.stdin.flush()

            def call(self, method, params):
                self.seq += 1
                self.send({"id": self.seq, "method": method, "params": params})
                # Each notification also consumes the same overall timeout budget.
                import time
                deadline = time.monotonic() + 20
                while True:
                    data = self.messages.get(timeout=max(0, deadline - time.monotonic()))
                    if data.get("id") == self.seq:
                        return data

            def close(self):
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
                self.reader.join(timeout=1)
                self.log.close()

        threads = {}
        server = Server("relay")
        try:
            for alias in aliases:
                result = server.call("thread/start", {
                    "modelProvider": alias, "model": "gpt-5.4", "cwd": str(root),
                    "ephemeral": False, "approvalPolicy": "never", "sandbox": "read-only",
                })
                assert "result" in result, result
                threads[alias] = result["result"]["thread"]
        finally:
            server.close()

        # Codex does not persist an empty thread. Seed synthetic completed messages
        # without invoking a model, then exercise its real disk resume path.
        for alias, thread in threads.items():
            path = Path(thread["path"])
            assert root in path.parents, "Codex returned a path outside the isolated test home"
            path.parent.mkdir(parents=True, exist_ok=True)
            stamp = "2026-09-10T06:00:00Z"
            rows = [{"timestamp": stamp, "type": "session_meta", "payload": {
                "id": thread["id"], "timestamp": stamp, "cwd": str(root),
                "originator": "codex_cli_rs", "cli_version": thread["cliVersion"],
                "source": "cli", "model_provider": alias,
            }}]
            for role, kind, text in [
                ("user", "input_text", "Synthetic history for local resume validation."),
                ("assistant", "output_text", "Synthetic response."),
            ]:
                rows.append({"timestamp": stamp, "type": "response_item", "payload": {
                    "type": "message", "role": role, "content": [{"type": kind, "text": text}],
                }})
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

        for phase in ["broken", "official", "returned", "native"]:
            server = Server(phase)
            try:
                for alias, thread in threads.items():
                    result = server.call("thread/resume", {
                        "threadId": thread["id"], "path": thread["path"],
                        "modelProvider": alias, "approvalPolicy": "never", "sandbox": "read-only",
                    })
                    if phase == "broken" and alias != "yuanheng-switch-official":
                        expected = f"Model provider `{alias}` not found"
                        assert result.get("error", {}).get("data", {}).get("type") == "modelProviderNotConfigured", result
                        print(f"{phase}: {alias}: reproduced missing provider")
                    elif phase != "broken" and alias != (args.preserve_provider or "custom"):
                        assert result.get("error", {}).get("data", {}).get("type") == "modelProviderMismatch", result
                        print(f"{phase}: {alias}: legacy mixed bucket requires explicit migration")
                    else:
                        assert "result" in result, result
                        assert result["result"]["thread"]["id"] == thread["id"]
                        print(f"{phase}: {alias}: resume OK")
            finally:
                server.close()


if __name__ == "__main__":
    main()
