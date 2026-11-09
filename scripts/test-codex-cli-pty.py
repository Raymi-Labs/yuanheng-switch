"""Bounded, isolated native TUI driver used by the opt-in Rust bridge test."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

binary, endpoint, profile, token = sys.argv[1:]
# Trust only this test-created, synthetic workspace in its isolated profile.
with open(Path(profile) / 'config.toml', 'a') as config:
    for directory in sorted({profile, os.path.realpath(profile)}):
        config.write('\n[projects.' + json.dumps(directory) + ']\ntrust_level="trusted"\n')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
env = {"HOME": profile, "CODEX_HOME": profile, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TERM": "xterm-256color", "LANG": "en_US.UTF-8"}
env['YUANHENG_CODEX_LAUNCH']=token
def controlling_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
child = subprocess.Popen([binary, "--remote", endpoint, "--remote-auth-token-env", "YUANHENG_CODEX_LAUNCH", "--no-alt-screen", "-C", profile, "Reply exactly synthetic OK. Do not use tools."],
                         stdin=slave, stdout=slave, stderr=slave, env=env, cwd=profile, preexec_fn=controlling_terminal)
os.close(slave)
output = bytearray()
deadline = time.monotonic() + 18
trust_answered = False
try:
    while child.poll() is None and time.monotonic() < deadline:
        if not select.select([master], [], [], 0.2)[0]:
            continue
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        output.extend(data)
        if b"\x1b[6n" in data:
            os.write(master, b"\x1b[1;1R")
        if b"\x1b[c" in data:
            os.write(master, b"\x1b[?1;2c")
        text = bytes(output).lower()
        if not trust_answered and (b"trust this" in text or b"trust the contents" in text):
            os.write(master, b"\r")
            trust_answered = True
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    os.close(master)
print(json.dumps({"terminal_tail": output[-10000:].decode("utf-8", errors="replace"), "returncode": child.returncode}))
