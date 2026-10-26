param([string]$Binary = 'src-tauri/target/release/filedesk.exe')
$ErrorActionPreference = 'Stop'
# Refuse to touch a user's existing client. Cleanup only the process started here.
if (Get-Process -ErrorAction SilentlyContinue | Where-Object ProcessName -Like 'FileDesk*') {
    throw 'Exit existing FileDesk instances before running this process smoke test.'
}
$path = (Resolve-Path -LiteralPath $Binary).Path
$primary = $null
$secondaryProcesses = @()
try {
    $primary = Start-Process -FilePath $path -PassThru -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
        Start-Sleep -Milliseconds 200
        $primary.Refresh()
        if ($primary.HasExited) { throw 'Primary FileDesk process exited during startup.' }
    } while ($primary.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($primary.MainWindowHandle -eq 0) { throw 'Primary FileDesk did not create its main window.' }
    for ($i = 0; $i -lt 4; $i++) {
        $secondary = Start-Process -FilePath $path -PassThru -WindowStyle Hidden
        $secondaryProcesses += $secondary
        if (-not $secondary.WaitForExit(15000)) { throw 'Duplicate process stayed alive.' }
        if ($secondary.ExitCode -ne 0) { throw "Duplicate process failed: $($secondary.ExitCode)" }
    }
    $primary.Refresh()
    if ($primary.HasExited) { throw 'Primary process exited after a duplicate launch.' }
    $active = @(Get-Process | Where-Object Path -EQ $path)
    if ($active.Count -ne 1 -or $active[0].Id -ne $primary.Id) { throw 'Expected only the original process to remain.' }
    Write-Output 'PASS: four repeated launches exited successfully; only the original FileDesk process remains.'
}
finally {
    foreach ($process in $secondaryProcesses) {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
    }
    if ($primary -and -not $primary.HasExited) { Stop-Process -Id $primary.Id -ErrorAction SilentlyContinue }
}
