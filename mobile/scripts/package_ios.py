"""Package development archives with explicit labels, never mislabel them as installable IPAs."""
import json
from pathlib import Path
import plistlib
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
kind = sys.argv[1]
if kind not in ('device', 'simulator'):
    raise SystemExit('Expected device or simulator')
version = json.loads((root / 'src-tauri/tauri.ios.conf.json').read_text())['version']
candidates = []
for archive in (root / 'src-tauri/gen/apple').rglob('*.xcarchive'):
    for app in (archive / 'Products/Applications').glob('*.app'):
        with (app / 'Info.plist').open('rb') as handle:
            info = plistlib.load(handle)
        platform = info.get('DTPlatformName', '')
        if (kind == 'simulator' and platform == 'iphonesimulator') or (kind == 'device' and platform == 'iphoneos'):
            assert info['CFBundleExecutable'].isascii(), 'iOS executable must use an ASCII filename'
            assert info.get('CFBundleDisplayName') == '元衡', 'iOS display name must remain localized'
            candidates.append((archive.stat().st_mtime, archive))
if not candidates:
    raise SystemExit(f'No verified {kind} archive found')
archive = max(candidates)[1]
signing = 'unsigned'
if kind == 'simulator':
    # Xcode supplies the simulator signature and simulated entitlements at link time.
    # Re-signing an unsigned app cannot recreate those embedded simulator entitlements.
    for app in (archive / 'Products/Applications').glob('*.app'):
        subprocess.run(['codesign', '--verify', '--strict', '--verbose=2', str(app)], check=True)
    signing = 'adhoc'
out = root / 'artifacts'
out.mkdir(exist_ok=True)
subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(archive), str(out / f'YuanHeng-{version}-ios-{kind}-{signing}.xcarchive.zip')], check=True)
