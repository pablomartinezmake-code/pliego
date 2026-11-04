$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw -LiteralPath (Join-Path $project 'package.json') | ConvertFrom-Json).version
$release = Join-Path $project "release\v$version"
$zipFile = Join-Path $release "Pliego-$version-win32-x64.zip"
$app = Join-Path $release 'Pliego-win32-x64'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($zipFile)
try {
    foreach ($name in @('Pliego.exe', 'resources/app.asar', 'Install-Pliego.ps1', 'LICENSE', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'THIRD_PARTY_NOTICES.md')) {
        $entry = $zip.GetEntry('Pliego-win32-x64/' + $name)
        if (-not $entry) { throw "Missing ZIP entry: $name" }
        $stream = $entry.Open()
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose(); $sha.Dispose() }
        $expected = (Get-FileHash -LiteralPath (Join-Path $app $name) -Algorithm SHA256).Hash
        if ($actual -cne $expected) { throw "ZIP content differs from tested application: $name" }
    }
    Write-Output 'PASS: ZIP runtime, installer and license bytes match the tested distribution.'
} finally { $zip.Dispose() }
