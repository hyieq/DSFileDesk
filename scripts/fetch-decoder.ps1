$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $root '.cache'
New-Item -ItemType Directory -Force $cache | Out-Null
$base = 'https://download.videolan.org/pub/videolan/vlc/3.0.23/win64'
$zip = Join-Path $cache 'vlc.zip'
if (-not (Test-Path $zip)) {
    curl.exe --fail --location --retry 3 "$base/vlc-3.0.23-win64.zip" -o $zip
    if ($LASTEXITCODE -ne 0) { throw 'VLC download failed' }
}
$checksum = Join-Path $cache 'vlc.sha256'
curl.exe --fail --location --retry 3 "$base/vlc-3.0.23-win64.zip.sha256" -o $checksum
if ($LASTEXITCODE -ne 0) { throw 'Checksum download failed' }
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash
if ((Get-Content $checksum -Raw) -notmatch $actual) { throw 'VLC checksum mismatch; remove .cache/vlc.zip and retry' }
Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $cache 'vlc') -Force
$decoder = Join-Path $root 'src-tauri/decoder'
New-Item -ItemType Directory -Force $decoder | Out-Null
Copy-Item -Path (Join-Path $cache 'vlc/vlc-3.0.23/*') -Destination $decoder -Recurse -Force
Write-Output 'LibVLC 3.0.23 ready (official archive, SHA256 verified).'
