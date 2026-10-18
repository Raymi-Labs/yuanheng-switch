"""Package development archives with explicit labels, never mislabel them as installable IPAs."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
kind = sys.argv[1]
if kind not in ('device', 'simulator'):
    raise SystemExit('Expected device or simulator')
version = json.loads((root / 'package.json').read_text())['version']
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
    # --no-sign leaves only a linker signature, without the bundle resource seal.
    # Ad-hoc signing is sufficient for the simulator and uses no Apple identity.
    for app in (archive / 'Products/Applications').glob('*.app'):
        with (app / 'Info.plist').open('rb') as handle:
            identifier = plistlib.load(handle)['CFBundleIdentifier']
        team = os.environ.get('APPLE_DEVELOPMENT_TEAM') or 'YUANHENGCI'
        application = f'{team}.{identifier}'
        # Simulator securityd still requires an application/keychain identity.
        # These ad-hoc entitlements apply only to the simulator, never the device archive.
        entitlements = {'application-identifier': application,
            'com.apple.developer.team-identifier': team,
            'keychain-access-groups': [application], 'get-task-allow': True}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'Simulator.entitlements'
            with path.open('wb') as handle:
                plistlib.dump(entitlements, handle)
            subprocess.run(['codesign', '--force', '--sign', '-', '--timestamp=none',
                '--entitlements', str(path), str(app)], check=True)
        subprocess.run(['codesign', '--verify', '--strict', '--verbose=2', str(app)], check=True)
    signing = 'adhoc'
out = root / 'artifacts'
out.mkdir(exist_ok=True)
subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(archive), str(out / f'YuanHeng-{version}-ios-{kind}-{signing}.xcarchive.zip')], check=True)
