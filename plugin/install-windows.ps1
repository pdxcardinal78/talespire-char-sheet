<#
.SYNOPSIS
  Install BepInEx and the Spirekeeper bridge into TaleSpire on Windows.

.DESCRIPTION
  Only the GM needs this. Players run Spirekeeper as a plain symbiote.

    .\plugin\install-windows.ps1                 # install or update
    .\plugin\install-windows.ps1 -Uninstall      # remove everything this added
    .\plugin\install-windows.ps1 -Path "D:\SteamLibrary\steamapps\common\TaleSpire"
    .\plugin\install-windows.ps1 -Dll .\SpirekeeperBridge.dll   # a DLL built elsewhere

  On Windows BepInEx loads through winhttp.dll beside TaleSpire.exe, so
  TaleSpire starts with the bridge however it's launched (Steam, desktop
  shortcut). -Uninstall removes it and TaleSpire is plain again. None of the
  macOS Apple Silicon workarounds apply here: the stock BepInEx is used.

  If PowerShell refuses to run the script, allow it for this one run:
    powershell -ExecutionPolicy Bypass -File .\plugin\install-windows.ps1
#>
[CmdletBinding()]
param(
  [string]$Path,
  [string]$Dll,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$BepInExVersion = "5.4.23.5"
$BepInExUrl = "https://github.com/BepInEx/BepInEx/releases/download/v$BepInExVersion/BepInEx_win_x64_$BepInExVersion.zip"

function Find-TaleSpire {
  # Steam's default library first, then every library Steam knows about
  $candidates = @()
  foreach ($root in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
    if ($root) { $candidates += Join-Path $root "Steam\steamapps\common\TaleSpire" }
  }
  foreach ($root in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
    if (-not $root) { continue }
    $vdf = Join-Path $root "Steam\steamapps\libraryfolders.vdf"
    if (Test-Path $vdf) {
      foreach ($m in [regex]::Matches((Get-Content $vdf -Raw), '"path"\s+"([^"]+)"')) {
        $lib = $m.Groups[1].Value -replace '\\\\', '\'
        $candidates += Join-Path $lib "steamapps\common\TaleSpire"
      }
    }
  }
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c "TaleSpire.exe")) { return $c }
  }
  return $null
}

if (-not $Path) { $Path = Find-TaleSpire }
if (-not $Path -or -not (Test-Path (Join-Path $Path "TaleSpire.exe"))) {
  Write-Error "TaleSpire.exe not found. Pass the folder that contains it with -Path."
}
Write-Host "TaleSpire: $Path"

# Everything BepInEx puts beside the game, and nothing else
$ours = @("BepInEx", "winhttp.dll", "doorstop_config.ini", ".doorstop_version", "changelog.txt")

if ($Uninstall) {
  foreach ($name in $ours) {
    $p = Join-Path $Path $name
    if (Test-Path $p) { Remove-Item -Recurse -Force $p }
  }
  Write-Host "Removed BepInEx and the bridge. TaleSpire starts unmodded again."
  exit 0
}

if (-not $Dll) { $Dll = Join-Path $Here "dist\SpirekeeperBridge.dll" }
if (-not (Test-Path $Dll)) {
  Write-Error "Missing $Dll. Build it with plugin/build.sh (macOS, Linux or Git Bash), or pass a built copy with -Dll."
}

# BepInEx for Windows, downloaded once into plugin\.tools
$tools = Join-Path $Here ".tools"
$zip = Join-Path $tools "bepinex-win.zip"
$unpacked = Join-Path $tools "bepinex-win"
New-Item -ItemType Directory -Force -Path $tools | Out-Null
if (-not (Test-Path $zip)) {
  Write-Host "Downloading BepInEx $BepInExVersion for Windows..."
  Invoke-WebRequest -Uri $BepInExUrl -OutFile $zip -UseBasicParsing
}
if (-not (Test-Path (Join-Path $unpacked "BepInEx\core\BepInEx.dll"))) {
  if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
  Expand-Archive -Path $zip -DestinationPath $unpacked -Force
}

# BepInEx itself, beside TaleSpire.exe
Copy-Item -Recurse -Force (Join-Path $unpacked "BepInEx") $Path
foreach ($name in @("winhttp.dll", "doorstop_config.ini", ".doorstop_version", "changelog.txt")) {
  $src = Join-Path $unpacked $name
  if (Test-Path $src) { Copy-Item -Force $src $Path }
}

# The plugin
$pluginDir = Join-Path $Path "BepInEx\plugins\SpirekeeperBridge"
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
Copy-Item -Force $Dll $pluginDir

# Files from a download carry the mark of the web, which can stop .NET loading them
if ($env:OS -eq "Windows_NT") {
  Get-ChildItem -Recurse -File (Join-Path $Path "BepInEx") | Unblock-File
  $wh = Join-Path $Path "winhttp.dll"
  if (Test-Path $wh) { Unblock-File $wh }
}

Write-Host ""
Write-Host "Installed. Start TaleSpire as usual; BepInEx loads with it."
Write-Host "Check the log for the bridge's 'loaded' line:"
Write-Host "  Get-Content -Wait `"$(Join-Path $Path 'BepInEx\LogOutput.log')`""
Write-Host "To go back to plain TaleSpire: .\plugin\install-windows.ps1 -Uninstall"
