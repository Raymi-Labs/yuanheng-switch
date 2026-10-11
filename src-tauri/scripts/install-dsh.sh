#!/usr/bin/env bash
# Runs only in the supervisor-owned staging directory. No global installation.
set -eu
cd "$YUANHENG_DSH_STAGE"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) archive=node-v24.14.0-darwin-arm64; checksum=a1a54f46a750d2523d628d924aab61758a51c9dad3e0238beb14141be9615dd3 ;;
  Darwin-x86_64) archive=node-v24.14.0-darwin-x64; checksum=f2879eb810e25993a0578e5d878930266fd2eafcffe9f2839b3d8db354d4879e ;;
  Linux-x86_64) archive=node-v24.14.0-linux-x64; checksum=dbf5b8665dec15e59e6359a517fefb47b23fdb9152d8def975b9bca3dfc6d355 ;;
  Linux-aarch64) archive=node-v24.14.0-linux-arm64; checksum=f44740cd218de8127f1c44c41510a3a740fa5c9c8d1cdce1c3bedada79f3cde7 ;;
  *) echo '[DSH_PLATFORM_UNSUPPORTED]' >&2; exit 1 ;;
esac
echo download > phase
curl --fail --silent --show-error --proto '=https' --connect-timeout 20 --max-time 240 \
  "https://nodejs.org/dist/v24.14.0/$archive.tar.gz" -o runtime.tar.gz
echo checksum > phase
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 runtime.tar.gz)
else
  actual=$(sha256sum runtime.tar.gz)
fi
[ "${actual%% *}" = "$checksum" ] || { echo '[DSH_HASH_MISMATCH]' >&2; exit 1; }
echo extract > phase
mkdir runtime
tar -xzf runtime.tar.gz --strip-components=1 -C runtime
export PATH="$PWD/runtime/bin:$PATH"
export DSH_HOME="$PWD/verification-home"
export DSH_TELEMETRY_DISABLED=1
# A private npmrc prevents account-specific registry/token settings from being used.
export NPM_CONFIG_USERCONFIG="$PWD/empty.npmrc"
export NPM_CONFIG_GLOBALCONFIG="$PWD/empty-global.npmrc"
: > "$NPM_CONFIG_USERCONFIG"
: > "$NPM_CONFIG_GLOBALCONFIG"
echo package > phase
node runtime/lib/node_modules/npm/bin/npm-cli.js install --prefix "$PWD/package" \
  --cache "$PWD/npm-cache" --registry=https://registry.npmjs.org \
  --ignore-scripts --no-audit --no-fund --fetch-retries=1 @deepseek-ai/dsh@0.2.0-rc.2
echo verify > phase
[ "$(node package/node_modules/@deepseek-ai/dsh/lib/bin.js --version)" = "0.2.0-rc.2" ]
node package/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --help >/dev/null
