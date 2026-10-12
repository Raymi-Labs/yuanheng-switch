#!/usr/bin/env bash
# Resume an immutable tagged release. Publish latest.json only after every asset
# is available on the public mirror. Never print publishing credentials.
set -euo pipefail

version="${1:?usage: mirror-desktop-update.sh VERSION}"
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Invalid release version" >&2
  exit 1
fi
: "${GITHUB_REPOSITORY:?missing repository}"
: "${DESKTOP_UPDATE_PUBLISH_URL:?missing publishing URL}"
: "${DESKTOP_UPDATE_PUBLISH_TOKEN:?missing publishing token}"
public_url="${DESKTOP_UPDATE_PUBLIC_URL:-https://meta-api.vip/desktop/update}"
tag="v${version}"
asset_dir="$(mktemp -d)"
trap 'rm -rf "$asset_dir"' EXIT

# Validate the release before uploading anything.
gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${tag}" > "$asset_dir/release.json"
python3 - "$asset_dir/release.json" "$tag" "$asset_dir/assets.tsv" <<'PY'
import json,sys
release=json.load(open(sys.argv[1]))
assert release['tag_name']==sys.argv[2] and not release['draft'] and not release['prerelease'], 'Expected a published stable release'
assets=release['assets']
assert any(a['name']=='latest.json' for a in assets), 'Missing updater manifest'
with open(sys.argv[3],'w') as output:
 for asset in assets:
  name=asset['name']
  assert name not in ('.','..') and not any(c in name for c in '/\\\t\r\n'), 'Unsafe asset name'
  assert isinstance(asset['size'],int) and asset['size']>0, 'Empty release asset'
  if name!='latest.json': output.write(f"{name}\t{asset['size']}\n")
PY

gh release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern latest.json --dir "$asset_dir"
python3 - "$asset_dir/latest.json" "$version" "$asset_dir/release.json" <<'PY'
import json,sys,urllib.parse
manifest=json.load(open(sys.argv[1])); release=json.load(open(sys.argv[3]))
assert manifest['version']==sys.argv[2], 'Updater version mismatch'
assert {'darwin-aarch64','darwin-x86_64','windows-x86_64'} <= manifest['platforms'].keys(), 'Incomplete platforms'
assets={asset['name'] for asset in release['assets']}
for platform in manifest['platforms'].values():
 assert platform.get('signature'), 'Missing updater signature'
 assert urllib.parse.urlparse(platform['url']).scheme=='https', 'Invalid download URL'
 assert urllib.parse.unquote(urllib.parse.urlparse(platform['url']).path.rsplit('/',1)[-1]) in assets, 'Missing updater asset'
PY

mirror_has_asset() {
  local url="$1" expected="$2"
  if ! curl --fail --silent --show-error --head \
    --header 'Cache-Control: no-cache' --connect-timeout 15 --max-time 30 \
    --output "$asset_dir/headers.txt" "$url" 2>/dev/null; then
    return 1
  fi
  python3 - "$asset_dir/headers.txt" "$expected" <<'PY'
import re,sys
headers=open(sys.argv[1]).read()
lengths=re.findall(r'^content-length:\s*(\d+)\s*$',headers,re.I|re.M)
sys.exit(0 if lengths and int(lengths[-1])==int(sys.argv[2]) else 1)
PY
}

upload() {
  local file="$1" destination="$2" content_type="$3"
  curl --fail --silent --show-error \
    --retry 3 --retry-all-errors --retry-max-time 3600 \
    --connect-timeout 20 --max-time 1800 --speed-time 90 --speed-limit 1024 \
    --request PUT --header "Authorization: Bearer $DESKTOP_UPDATE_PUBLISH_TOKEN" \
    --header "Content-Type: $content_type" --data-binary "@$file" \
    --output "$asset_dir/upload-response" \
    --write-out 'Upload finished: HTTP %{http_code}, %{time_total}s\n' "$destination"
}

while IFS=$'\t' read -r filename expected_size; do
  encoded="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1],safe=""))' "$filename")"
  # A public download may redirect to R2. Inspect the platform's local copy so
  # a successful CDN response cannot hide a missing origin publication asset.
  public_asset="${public_url%/}/releases/${version}/${encoded}?origin=1"
  if mirror_has_asset "$public_asset" "$expected_size"; then
    echo "Already mirrored: $filename ($expected_size bytes)"
    continue
  fi
  echo "Uploading: $filename ($expected_size bytes)"
  gh release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern "$filename" --dir "$asset_dir"
  upload "$asset_dir/$filename" "${DESKTOP_UPDATE_PUBLISH_URL%/}/${version}/${encoded}" application/octet-stream
  if ! mirror_has_asset "$public_asset" "$expected_size"; then
    echo "Mirror asset verification failed: $filename; latest.json was not changed" >&2
    exit 1
  fi
  rm -f "$asset_dir/$filename"
done < "$asset_dir/assets.tsv"

# A delayed retry must not downgrade a newer release already on the mirror.
curl --fail --silent --show-error --retry 3 --connect-timeout 15 --max-time 30 \
  "${public_url%/}/latest.json" --output "$asset_dir/current.json"
python3 - "$asset_dir/current.json" "$version" <<'PY'
import json,re,sys
current=json.load(open(sys.argv[1]))['version']
assert re.fullmatch(r'\d+\.\d+\.\d+',current), 'Invalid current mirror version'
assert tuple(map(int,current.split('.'))) <= tuple(map(int,sys.argv[2].split('.'))), 'Refusing to downgrade the mirror'
PY
upload "$asset_dir/latest.json" "${DESKTOP_UPDATE_PUBLISH_URL%/}/latest.json" application/json
curl --fail --silent --show-error --retry 3 --connect-timeout 15 --max-time 30 \
  "${public_url%/}/latest.json" --output "$asset_dir/published.json"
python3 - "$asset_dir/published.json" "$asset_dir/latest.json" <<'PY'
import json,sys
published=json.load(open(sys.argv[1])); expected=json.load(open(sys.argv[2]))
assert published['version']==expected['version'], 'Mirror version was not updated'
assert published.get('notes')==expected.get('notes'), 'Release notes mismatch'
assert published.get('release_notes')==expected.get('release_notes'), 'Announcement feed mismatch'
for name,platform in expected['platforms'].items():
 assert published['platforms'][name]['signature']==platform['signature'], 'Signature mismatch'
print(f"Mirror verified: v{published['version']}")
PY
