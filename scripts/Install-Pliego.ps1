[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\Pliego'),
    [switch]$NoShortcuts
)
$ErrorActionPreference = 'Stop'
$markerName = '.pliego-installation'
$markerValue = 'Pliego per-user installation v1'
$source = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
if (-not [IO.Path]::IsPathRooted($InstallRoot)) { throw 'InstallRoot must be an absolute path.' }
$target = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$parent = [IO.Path]::GetDirectoryName($target)
if (-not $parent -or $target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\')) { throw 'InstallRoot cannot be a drive root.' }
if ($target.Equals($source, 'OrdinalIgnoreCase') -or $target.StartsWith($source + '\', 'OrdinalIgnoreCase') -or $source.StartsWith($target + '\', 'OrdinalIgnoreCase')) { throw 'The source and destination must be separate directories.' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'Pliego.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $source 'resources\app.asar') -PathType Leaf)) { throw 'Run this installer from the extracted Pliego distribution.' }

# Refuse redirection through a junction or symbolic link in the destination path.
$part = $target
while ($part) {
    if (Test-Path -LiteralPath $part) {
        $item = Get-Item -LiteralPath $part -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse points are not allowed in the destination path: $part" }
    }
    $next = [IO.Path]::GetDirectoryName($part)
    if ($next -eq $part) { break }
    $part = $next
}
if (Test-Path -LiteralPath $target) {
    $marker = Join-Path $target $markerName
    if (-not (Test-Path -LiteralPath $target -PathType Container) -or -not (Test-Path -LiteralPath $marker -PathType Leaf) -or (Get-Content -LiteralPath $marker -Raw).Trim() -cne $markerValue) {
        throw "The destination is not a Pliego installation: $target"
    }
}
$exe = Join-Path $target 'Pliego.exe'
foreach ($process in @(Get-Process -Name Pliego -ErrorAction SilentlyContinue)) {
    try { $runningPath = $process.Path } catch { throw 'Cannot inspect a running Pliego process. Close Pliego before installing.' }
    if (-not $runningPath) { throw 'Cannot inspect a running Pliego process. Close Pliego before installing.' }
    if ($runningPath.Equals($exe, 'OrdinalIgnoreCase')) { throw 'Close the installed Pliego before installing an update.' }
}

New-Item -ItemType Directory -Path $parent -Force | Out-Null
$token = [guid]::NewGuid().ToString('N')
$stage = Join-Path $parent ('.pliego-stage-' + $token)
$backup = Join-Path $parent ('Pliego-backup-' + $token)
$movedOld = $false
try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    Copy-Item -Path (Join-Path $source '*') -Destination $stage -Recurse -Force
    Set-Content -LiteralPath (Join-Path $stage $markerName) -Value $markerValue -Encoding ASCII
    if (Test-Path -LiteralPath $target) {
        Move-Item -LiteralPath $target -Destination $backup
        $movedOld = $true
    }
    Move-Item -LiteralPath $stage -Destination $target
} catch {
    if ($movedOld -and -not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $target }
    throw
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}

if (-not $NoShortcuts) {
    try {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($directory in @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'))) {
            if (-not $directory) { continue }
            $link = Join-Path $directory 'Pliego.lnk'
            if (Test-Path -LiteralPath $link) {
                $existing = $shell.CreateShortcut($link)
                if (-not $existing.TargetPath.Equals($exe, 'OrdinalIgnoreCase')) { Write-Warning "Leaving unrelated shortcut unchanged: $link"; continue }
            }
            $shortcut = $shell.CreateShortcut($link)
            $shortcut.TargetPath = $exe
            $shortcut.WorkingDirectory = $target
            $shortcut.Save()
        }
    } catch { Write-Warning "Pliego was installed, but a shortcut could not be created: $_" }
}
Write-Host "Installed Pliego at $target"
if ($movedOld) { Write-Host "Previous installation kept at $backup" }
