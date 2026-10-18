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
version = json.loads((root / 'package.json').read_text())['version']
candidates = []
for archive in (root / 'src-tauri/gen/apple').rglob('*.xcarchive'):
    for app in (archive / 'Products/Applications').glob('*.app'):
        with (app / 'Info.plist').open('rb') as handle:
            info = plistlib.load(handle)
        platform = info.get('DTPlatformName', '')
        if (kind == 'simulator' and platform == 'iphonesimulator') or (kind == 'device' and platform == 'iphoneos'):
            candidates.append((archive.stat().st_mtime, archive))
if not candidates:
    raise SystemExit(f'No verified {kind} archive found')
archive = max(candidates)[1]
signing = 'unsigned'
if kind == 'simulator':
    # --no-sign leaves only a linker signature, without the bundle resource seal.
    # Ad-hoc signing is sufficient for the simulator and uses no Apple identity.
    for app in (archive / 'Products/Applications').glob('*.app'):
        subprocess.run(['codesign', '--force', '--sign', '-', '--timestamp=none', str(app)], check=True)
        subprocess.run(['codesign', '--verify', '--strict', '--verbose=2', str(app)], check=True)
    signing = 'adhoc'
out = root / 'artifacts'
out.mkdir(exist_ok=True)
subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(archive), str(out / f'YuanHeng-{version}-ios-{kind}-{signing}.xcarchive.zip')], check=True)
