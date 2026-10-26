param([switch]$UseRegistryMirror, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    if (-not (Test-Path src-tauri/decoder/libvlc.dll)) {
        & "$PSScriptRoot/fetch-decoder.ps1"
    }
    if (-not $SkipBuild) {
        $buildArgs = @('tauri', 'build', '--bundles', 'msi', '--ci', '--', '--locked')
        if ($UseRegistryMirror) {
            $buildArgs += @('--config', 'source.crates-io.replace-with="rsproxy"', '--config', 'source.rsproxy.registry="sparse+https://rsproxy.cn/index/"')
        }
        & npx @buildArgs
        if ($LASTEXITCODE -ne 0) { throw 'MSI build failed' }
    }
    $installer = Get-ChildItem src-tauri/target/release/bundle/msi -Filter "FileDesk_${version}_x64_*.msi"
    if (@($installer).Count -ne 1) { throw 'Expected exactly one MSI installer for this version' }
    New-Item -ItemType Directory -Force release | Out-Null
    $name = "FileDesk-${version}-windows-x64.msi"
    Copy-Item -LiteralPath $installer.FullName -Destination (Join-Path release $name) -Force
    & "$PSScriptRoot/verify-msi.ps1" -Path (Join-Path release $name) -Version $version
    $hash = (Get-FileHash (Join-Path release $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $root 'release/SHA256SUMS.txt'), "$hash  $name`n", [Text.UTF8Encoding]::new($false))
    Write-Output "Release asset ready: release/$name"
}
finally { Pop-Location }
