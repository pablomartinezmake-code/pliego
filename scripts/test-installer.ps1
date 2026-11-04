param([string]$PowerShell = 'powershell.exe')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$fixture = Join-Path $root ('test-results\installer-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $fixture 'source'
$target = Join-Path $fixture 'programs\Pliego'
New-Item -ItemType Directory -Path (Join-Path $source 'resources') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-Pliego.ps1') -Destination $source
Set-Content -LiteralPath (Join-Path $source 'Pliego.exe') -Value 'version one'
Set-Content -LiteralPath (Join-Path $source 'resources\app.asar') -Value 'fixture'
$installer = Join-Path $source 'Install-Pliego.ps1'
function Install-Fixture([string]$Destination) {
    & $PowerShell -NoProfile -NonInteractive -File $installer -InstallRoot $Destination -NoShortcuts | Out-Host
    return $LASTEXITCODE
}
if ((Install-Fixture $target) -ne 0) { throw 'Initial installation failed.' }
if ((Get-Content -LiteralPath (Join-Path $target 'Pliego.exe') -Raw).Trim() -ne 'version one') { throw 'First installation was not copied.' }
Set-Content -LiteralPath (Join-Path $source 'Pliego.exe') -Value 'version two'
if ((Install-Fixture $target) -ne 0) { throw 'Update failed.' }
if ((Get-Content -LiteralPath (Join-Path $target 'Pliego.exe') -Raw).Trim() -ne 'version two') { throw 'Updated installation missing.' }
$backups = @(Get-ChildItem -LiteralPath (Split-Path $target) -Directory -Filter 'Pliego-backup-*')
if ($backups.Count -ne 1 -or (Get-Content -LiteralPath (Join-Path $backups[0].FullName 'Pliego.exe') -Raw).Trim() -ne 'version one') { throw 'Previous version was not retained.' }
# Exercise the live-process guard with a disposable executable, never the user's app.
Remove-Item -LiteralPath (Join-Path $target 'Pliego.exe')
Add-Type -TypeDefinition 'public class Fixture { public static void Main() { System.Threading.Thread.Sleep(30000); } }' -OutputAssembly (Join-Path $target 'Pliego.exe') -OutputType ConsoleApplication
$running = Start-Process -FilePath (Join-Path $target 'Pliego.exe') -PassThru -WindowStyle Hidden
try {
    if ((Install-Fixture $target) -eq 0) { throw 'Running installation was replaced.' }
    if ($running.HasExited) { throw 'Installer stopped the running process.' }
} finally {
    Stop-Process -Id $running.Id -ErrorAction SilentlyContinue
}
$foreign = Join-Path $fixture 'foreign'
New-Item -ItemType Directory -Path $foreign | Out-Null
Set-Content -LiteralPath (Join-Path $foreign 'keep.txt') -Value 'untouched'
if ((Install-Fixture $foreign) -eq 0) { throw 'Foreign directory was accepted.' }
if ((Get-Content -LiteralPath (Join-Path $foreign 'keep.txt') -Raw).Trim() -ne 'untouched') { throw 'Foreign directory changed.' }
Write-Host "Installer fixture passed with $PowerShell at $fixture"
