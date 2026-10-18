"""Boot the built application in a disposable CI iPhone simulator and save a screenshot."""
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import time

root = Path(__file__).resolve().parents[1]
apps = []
for archive in (root / 'src-tauri/gen/apple').rglob('*.xcarchive'):
    for app in (archive / 'Products/Applications').glob('*.app'):
        with (app / 'Info.plist').open('rb') as handle:
            info = plistlib.load(handle)
        if info.get('DTPlatformName') == 'iphonesimulator':
            apps.append((archive.stat().st_mtime, app, info['CFBundleIdentifier'], info['CFBundleExecutable']))
if not apps:
    raise SystemExit('Missing simulator application')
_, app, identifier, executable = max(apps)
state = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j']))
devices = [d for group in state['devices'].values() for d in group if d.get('isAvailable') and d['name'].startswith('iPhone')]
if not devices:
    raise SystemExit('No available iPhone simulator')
device = devices[0]
udid = device['udid']
if device['state'] != 'Booted':
    subprocess.run(['xcrun', 'simctl', 'boot', udid], check=True)
subprocess.run(['xcrun', 'simctl', 'bootstatus', udid, '-b'], check=True, timeout=240)
subprocess.run(['xcrun', 'simctl', 'install', udid, str(app)], check=True, timeout=90)
out = root / 'artifacts'
out.mkdir(exist_ok=True)
started = time.time()
launch = subprocess.check_output(['xcrun', 'simctl', 'launch', '--terminate-running-process',
    f'--stdout={out / "ios-stdout.log"}', f'--stderr={out / "ios-stderr.log"}', udid, identifier], text=True)
print(launch.strip(), flush=True)
pid = int(launch.rsplit(':', 1)[1].strip())
time.sleep(8)
subprocess.run(['xcrun', 'simctl', 'io', udid, 'screenshot', str(out / 'ios-simulator-launch.png')], check=True)
# Simulator applications are host processes. launchctl's current bootstrap domain
# may omit UIKit apps, so verify the exact PID returned by simctl instead.
process = subprocess.run(['ps', '-p', str(pid), '-o', 'stat=,comm='], capture_output=True, text=True)
print(f'Process check: {process.returncode}, {process.stdout.strip()!r}', flush=True)
alive = process.returncode == 0 and executable in process.stdout and not process.stdout.strip().startswith('Z')
if not alive:
    reports = [Path.home() / 'Library/Logs/DiagnosticReports',
        Path.home() / f'Library/Developer/CoreSimulator/Devices/{udid}/data/Library/Logs']
    # Simulator crash reports may live inside the device, or arrive after exit.
    time.sleep(20)
    for directory in reports:
        for report in directory.rglob('*'):
            if report.is_file() and report.suffix in ('.ips', '.crash') and report.stat().st_mtime >= started:
                content = report.read_text(errors='replace')
                if identifier in content or executable in report.name:
                    shutil.copy2(report, out / report.name)
    with (out / 'ios-system.log').open('w') as handle:
        subprocess.run(['xcrun', 'simctl', 'spawn', udid, 'log', 'show', '--last', '3m',
            '--style', 'compact', '--predicate', f'processID == {pid} OR eventMessage CONTAINS "{identifier}"'],
            stdout=handle, stderr=subprocess.STDOUT, timeout=45)
    with (out / 'ios-host.log').open('w') as handle:
        subprocess.run(['log', 'show', '--last', '8m', '--style', 'compact', '--predicate',
            f'processID == {pid} OR eventMessage CONTAINS "{identifier}" OR eventMessage CONTAINS "{executable}"'],
            stdout=handle, stderr=subprocess.STDOUT, timeout=45)
    # Capture the first fault directly if crash reporting is unavailable in CI.
    debug = subprocess.check_output(['xcrun', 'simctl', 'launch', '--terminate-running-process',
        '--wait-for-debugger', udid, identifier], text=True, timeout=90)
    debug_pid = int(debug.rsplit(':', 1)[1].strip())
    with (out / 'ios-backtrace.log').open('w') as handle:
        try:
            subprocess.run(['xcrun', 'lldb', '--batch', '-o', f'process attach --pid {debug_pid}',
                '-o', 'continue', '-o', 'thread backtrace all', '-o', 'image list', '-o', 'quit'],
                stdout=handle, stderr=subprocess.STDOUT, timeout=90)
        except subprocess.TimeoutExpired:
            handle.write('\nDebugger timed out after 90 seconds\n')
    raise SystemExit(f'Application PID {pid} exited after launch; screenshot and available crash reports saved')
print(f'Native launch verified on {device["name"]}, PID {pid}; no login or paid request performed')
