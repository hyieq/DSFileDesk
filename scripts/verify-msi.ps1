param([Parameter(Mandatory=$true)][string]$Path, [Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = 'Stop'
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase((Resolve-Path -LiteralPath $Path).Path, 0)
$view = $database.OpenView('SELECT `Property`, `Value` FROM `Property`')
$view.Execute()
$properties = @{}
while ($record = $view.Fetch()) { $properties[$record.StringData(1)] = $record.StringData(2) }
$view.Close()
if ($properties.ProductVersion -ne $Version) { throw 'MSI version mismatch' }
if ($properties.UpgradeCode -ne '{69C27FB3-E560-5EFD-AA3B-81E058BAC852}') { throw 'MSI UpgradeCode mismatch' }
$view = $database.OpenView('SELECT `FileName` FROM `File`')
$view.Execute()
$names = @()
while ($record = $view.Fetch()) { $names += ($record.StringData(1) -split '\|')[-1] }
$view.Close()
foreach ($required in @('filedesk.exe', 'libvlc.dll', 'libvlccore.dll', 'libavcodec_plugin.dll', 'THIRD-PARTY-NOTICES.txt')) {
    if ($required -notin $names) { throw "Missing MSI payload: $required" }
}
Write-Output "Verified MSI $Version, fixed UpgradeCode, and $($names.Count) payload files including decoder and notices."
