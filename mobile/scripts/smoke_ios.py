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
launch = subprocess.check_output(['xcrun', 'simctl', 'launch', '--terminate-running-process', udid, identifier], text=True)
print(launch.strip())
pid = int(launch.rsplit(':', 1)[1].strip())
time.sleep(8)
out = root / 'artifacts'
out.mkdir(exist_ok=True)
subprocess.run(['xcrun', 'simctl', 'io', udid, 'screenshot', str(out / 'ios-simulator-launch.png')], check=True)
# Simulator applications are host processes. launchctl's current bootstrap domain
# may omit UIKit apps, so verify the exact PID returned by simctl instead.
process = subprocess.run(['ps', '-p', str(pid), '-o', 'stat=,comm='], capture_output=True, text=True)
alive = process.returncode == 0 and executable in process.stdout and not process.stdout.strip().startswith('Z')
if not alive:
    reports = Path.home() / 'Library/Logs/DiagnosticReports'
    for report in reports.glob(f'{executable}*'):
        if report.is_file(): shutil.copy2(report, out / report.name)
    raise SystemExit(f'Application PID {pid} exited after launch; screenshot and available crash reports saved')
print(f'Native launch verified on {device["name"]}, PID {pid}; no login or paid request performed')
