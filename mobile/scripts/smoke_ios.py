"""Boot the built application in a disposable CI iPhone simulator and save a screenshot."""
import json
from pathlib import Path
import plistlib
import subprocess
import time

root = Path(__file__).resolve().parents[1]
apps = []
for archive in (root / 'src-tauri/gen/apple').rglob('*.xcarchive'):
    for app in (archive / 'Products/Applications').glob('*.app'):
        with (app / 'Info.plist').open('rb') as handle:
            info = plistlib.load(handle)
        if info.get('DTPlatformName') == 'iphonesimulator':
            apps.append((archive.stat().st_mtime, app, info['CFBundleIdentifier']))
if not apps:
    raise SystemExit('Missing simulator application')
_, app, identifier = max(apps)
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
subprocess.run(['xcrun', 'simctl', 'launch', '--terminate-running-process', udid, identifier], check=True)
time.sleep(8)
services = subprocess.check_output(['xcrun', 'simctl', 'spawn', udid, 'launchctl', 'list'], text=True)
assert any(identifier in line and line.split()[0].isdigit() for line in services.splitlines()), 'Application exited after launch'
out = root / 'artifacts'
out.mkdir(exist_ok=True)
subprocess.run(['xcrun', 'simctl', 'io', udid, 'screenshot', str(out / 'ios-simulator-launch.png')], check=True)
print(f'Native launch verified on {device["name"]}; no login or paid request performed')
