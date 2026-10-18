"""Sign only the generated release APK, then verify before publishing an artifact."""
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text())['version']
apks = list((root / 'src-tauri/gen/android/app/build/outputs/apk').glob('**/*release-unsigned.apk'))
if len(apks) != 1:
    raise SystemExit(f'Expected one unsigned release APK, found {len(apks)}')
if not os.environ.get('ANDROID_KEYSTORE_BASE64') or not os.environ.get('ANDROID_KEYSTORE_PASSWORD'):
    raise SystemExit('Missing persistent Android release signing secrets')
build_tools = Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0'
out = root / 'artifacts'
out.mkdir(exist_ok=True)
artifact = out / f'YuanHeng-{version}-android-arm64.apk'
with tempfile.TemporaryDirectory() as folder:
    keystore = Path(folder) / 'release.p12'
    keystore.write_bytes(base64.b64decode(os.environ['ANDROID_KEYSTORE_BASE64'], validate=True))
    keystore.chmod(0o600)
    aligned = Path(folder) / 'aligned.apk'
    subprocess.run([str(build_tools / 'zipalign'), '-P', '16', '-f', '4', str(apks[0]), str(aligned)], check=True)
    subprocess.run([str(build_tools / 'apksigner'), 'sign', '--ks', str(keystore), '--ks-type', 'PKCS12', '--ks-key-alias', 'yuanheng', '--ks-pass', 'env:ANDROID_KEYSTORE_PASSWORD', '--out', str(artifact), str(aligned)], check=True)
    subprocess.run([str(build_tools / 'apksigner'), 'verify', '--verbose', '--print-certs', str(artifact)], check=True)
    subprocess.run([str(build_tools / 'zipalign'), '-c', '-P', '16', '4', str(artifact)], check=True)
metadata = subprocess.check_output([str(build_tools / 'aapt2'), 'dump', 'badging', str(artifact)], text=True)
config = json.loads((root / 'src-tauri/tauri.conf.json').read_text())
assert f"name='{config['identifier']}'" in metadata, 'Unexpected Android package ID'
assert f"versionCode='{config['bundle']['android']['versionCode']}'" in metadata, 'Unexpected version code'
assert f"versionName='{version}'" in metadata, 'Unexpected app version'
assert "sdkVersion:'29'" in metadata, 'Unexpected minimum SDK'
assert "native-code: 'arm64-v8a'" in metadata, 'Unexpected APK architecture'
manifest = subprocess.check_output([str(build_tools / 'aapt2'), 'dump', 'xmltree', str(artifact), '--file', 'AndroidManifest.xml'], text=True)
assert re.search(r'android:allowBackup[^\n]*\(type 0x12\)0x0\b', manifest), 'Session backup must be disabled'
print('Verified package ID, version, Android 10 minimum, ARM64 and disabled backup')
(out / f'{artifact.name}.sha256').write_text(f'{hashlib.sha256(artifact.read_bytes()).hexdigest()}  {artifact.name}\n')
