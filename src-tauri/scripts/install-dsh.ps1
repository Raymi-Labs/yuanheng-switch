$ErrorActionPreference = 'Stop'
# The supervisor releases this gate only after attaching the Windows Job.
if ([Console]::ReadLine() -ne 'YUANHENG_GO') { exit 1 }
try {
    Set-Location -LiteralPath $env:YUANHENG_DSH_STAGE
    $targetVersion = $env:YUANHENG_DSH_VERSION
    if (!$targetVersion -or $targetVersion.Length -gt 80 -or $targetVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') { throw 'Invalid version' }
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    switch ($arch) {
        'X64' { $archive = 'node-v24.14.0-win-x64'; $checksum = '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66' }
        'Arm64' { $archive = 'node-v24.14.0-win-arm64'; $checksum = '88d36e8109736a2fa9bdc596f2cf507a3c52c69cdf96e54f8acd473ec14be853' }
        default { throw 'Unsupported architecture' }
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Set-Content -LiteralPath phase -Value download -Encoding ASCII
    . (Join-Path $PWD 'dsh-download.ps1')
    Save-DshRuntime "https://nodejs.org/dist/v24.14.0/$archive.zip"
    Set-Content -LiteralPath phase -Value checksum -Encoding ASCII
    if ((Get-FileHash -LiteralPath runtime.zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $checksum) {
        throw 'Runtime hash mismatch'
    }
    Set-Content -LiteralPath phase -Value extract -Encoding ASCII
    Expand-Archive -LiteralPath runtime.zip -DestinationPath unpack
    Move-Item -LiteralPath (Join-Path unpack $archive) -Destination runtime
    $node = Join-Path $PWD 'runtime\node.exe'
    $env:PATH = (Join-Path $PWD 'runtime') + ';' + $env:PATH
    $env:DSH_HOME = Join-Path $PWD 'verification-home'
    $env:DSH_TELEMETRY_DISABLED = '1'
    $env:NPM_CONFIG_USERCONFIG = Join-Path $PWD 'empty.npmrc'
    $env:NPM_CONFIG_GLOBALCONFIG = Join-Path $PWD 'empty-global.npmrc'
    Set-Content -LiteralPath $env:NPM_CONFIG_USERCONFIG -Value '' -Encoding ASCII
    Set-Content -LiteralPath $env:NPM_CONFIG_GLOBALCONFIG -Value '' -Encoding ASCII
    Set-Content -LiteralPath phase -Value package -Encoding ASCII
    & $node --require (Join-Path $PWD 'dsh-npm-progress.cjs') runtime/node_modules/npm/bin/npm-cli.js install --prefix (Join-Path $PWD 'package') `
        --cache (Join-Path $PWD 'npm-cache') --registry=https://registry.npmjs.org `
        --ignore-scripts --engine-strict --no-audit --no-fund --fetch-retries=1 "@deepseek-ai/dsh@$targetVersion"
    if ($LASTEXITCODE -ne 0) { throw 'Package install failed' }
    Set-Content -LiteralPath phase -Value verify -Encoding ASCII
    $version = & $node package/node_modules/@deepseek-ai/dsh/lib/bin.js --version
    if ($LASTEXITCODE -ne 0 -or $version.Trim() -ne $targetVersion) { throw 'Version check failed' }
    & $node package/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --help
    if ($LASTEXITCODE -ne 0) { throw 'Web command check failed' }
} catch {
    # No raw exception: paths, proxy credentials and download bodies stay local.
    [Console]::Error.WriteLine('[DSH_INSTALL_FAILED]')
    exit 1
}
exit 0
