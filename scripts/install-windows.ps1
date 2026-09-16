[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepoRoot = '',
    [switch]$SkipNpmCi,
    [switch]$ValidateOnly,
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$traySource = Join-Path $repo 'tools\PlayroomNearby.Tray\PlayroomNearby.Tray.ps1'
$package = Join-Path $repo 'package.json'

if (-not (Test-Path -LiteralPath $traySource -PathType Leaf)) { throw "Tray script not found: $traySource" }
if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { throw "package.json not found: $package" }

$node = Get-Command node.exe -ErrorAction Stop
$npm = Get-Command npm.cmd -ErrorAction Stop
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
    throw "Windows PowerShell not found: $windowsPowerShell"
}
$nodeVersion = (& $node.Source --version).Trim()
if ($nodeVersion -notmatch '^v(?<major>\d+)\.' -or [int]$Matches.major -lt 22) {
    throw "Node.js 22 or newer is required; found $nodeVersion"
}

$installRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PlayroomNearbySEO\tray'
$installedTray = Join-Path $installRoot 'PlayroomNearby.Tray.ps1'
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$shortcutPath = Join-Path $desktop 'Playroom SEO Bot.lnk'

Write-Host "Repository: $repo"
Write-Host "Node: $nodeVersion"
Write-Host "Tray target: $installedTray"
Write-Host "Shortcut: $shortcutPath"
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
$utf8WithBom = New-Object System.Text.UTF8Encoding($true)
$validationScript = Join-Path ([IO.Path]::GetTempPath()) ("PlayroomNearby.Tray.validate.{0}.ps1" -f [guid]::NewGuid())
try {
    $sourceText = [IO.File]::ReadAllText($traySource, $utf8WithoutBom)
    [IO.File]::WriteAllText($validationScript, $sourceText, $utf8WithBom)
    & $windowsPowerShell -NoProfile -STA -ExecutionPolicy Bypass -File $validationScript -RepoRoot $repo -ValidateOnly
    if ($LASTEXITCODE -ne 0) { throw "Tray runtime validation failed with exit code $LASTEXITCODE" }
} finally {
    Remove-Item -LiteralPath $validationScript -Force -ErrorAction SilentlyContinue
}
if ($ValidateOnly) {
    Write-Host 'Validation passed; no files or processes were changed.'
    return
}

if (-not $SkipNpmCi -and $PSCmdlet.ShouldProcess($repo, 'Install exact Node dependencies')) {
    & $npm.Source ci --prefix $repo
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
}

if ($PSCmdlet.ShouldProcess($repo, 'Build Node service')) {
    & $npm.Source run build --prefix $repo
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
}

if ($PSCmdlet.ShouldProcess($installRoot, 'Install Windows tray controller')) {
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    [IO.File]::WriteAllText($installedTray, $sourceText, $utf8WithBom)
}

if ($PSCmdlet.ShouldProcess($shortcutPath, 'Create desktop shortcut')) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $windowsPowerShell
    $shortcut.Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $installedTray + '" -RepoRoot "' + $repo + '"'
    $shortcut.WorkingDirectory = $repo
    $shortcut.IconLocation = "$windowsPowerShell,0"
    $shortcut.Description = 'Playroom Nearby SEO bot controller'
    $shortcut.Save()
}

if ($Launch -and $PSCmdlet.ShouldProcess($installedTray, 'Launch tray controller')) {
    $arguments = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $installedTray + '" -RepoRoot "' + $repo + '"'
    Start-Process -FilePath $windowsPowerShell -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden
}

Write-Host 'Installation complete. The shortcut starts the tray and then the bot.'
