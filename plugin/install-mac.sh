#!/usr/bin/env bash
#
# Install BepInEx and the Spirekeeper bridge into TaleSpire on macOS.
#
#   ./plugin/install-mac.sh             # install or update
#   ./plugin/install-mac.sh --uninstall # remove everything this added
#   ./plugin/install-mac.sh --path "/other/steamapps/common/TaleSpire"
#
# Nothing inside TaleSpire.app is touched. BepInEx sits beside the app and only
# runs when TaleSpire is started through run_bepinex.sh, so launching TaleSpire
# the normal way is always plain, unmodded TaleSpire.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TS_DIR="$HOME/Library/Application Support/Steam/steamapps/common/TaleSpire"
MODE="install"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) TS_DIR="$2"; shift 2 ;;
    --uninstall) MODE="uninstall"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS. On Windows, use plugin/install-windows.ps1." >&2
  exit 1
fi

if [[ ! -d "$TS_DIR/TaleSpire.app" ]]; then
  echo "TaleSpire.app not found in: $TS_DIR" >&2
  echo "Pass the folder that contains TaleSpire.app with --path." >&2
  exit 1
fi

if [[ "$MODE" == "uninstall" ]]; then
  rm -rf "$TS_DIR/BepInEx" "$TS_DIR/libdoorstop.dylib" "$TS_DIR/run_bepinex.sh" \
         "$TS_DIR/.doorstop_version" "$TS_DIR/doorstop_config.ini" "$TS_DIR/changelog.txt"
  echo "Removed BepInEx and the bridge from $TS_DIR"
  echo "Remove the Steam launch option too, if you set one."
  exit 0
fi

DLL="$HERE/dist/SpirekeeperBridge.dll"
BEPINEX="$HERE/.tools/bepinex"
if [[ ! -f "$DLL" ]]; then
  echo "Missing $DLL. Build it first with ./plugin/build.sh" >&2
  exit 1
fi
if [[ ! -f "$BEPINEX/BepInEx/core/BepInEx.dll" ]]; then
  mkdir -p "$BEPINEX"
  unzip -qo "$HERE/.tools/bepinex.zip" -d "$BEPINEX"
fi

# BepInEx itself
cp -R "$BEPINEX/BepInEx" "$TS_DIR/"
cp "$BEPINEX/libdoorstop.dylib" "$BEPINEX/.doorstop_version" "$TS_DIR/"
# Name the app in the stock launcher, so it runs with no arguments
sed 's/^executable_name=""/executable_name="TaleSpire.app"/' "$BEPINEX/run_bepinex.sh" > "$TS_DIR/run_bepinex.sh"
chmod +x "$TS_DIR/run_bepinex.sh"

# Apple Silicon: BepInEx 5's runtime detours (MonoMod) crash on arm64. Two
# changes keep BepInEx off that code path:
# 1. A preloader with HarmonyInteropFix.Apply emptied out. It is the one
#    detour BepInEx applies unconditionally. Built by plugin/tools/prepatch.
# 2. ApplyRuntimePatches = false, which skips the optional ones.
# Plugins that use Harmony still won't work on arm64; ours doesn't use it.
#
# Intel Macs run BepInEx's detours fine, so they get the stock preloader and
# runtime patches left on. hw.optional.arm64 is used rather than `uname -m`,
# because a shell running under Rosetta reports x86_64 on an Apple Silicon Mac.
if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" == "1" ]]; then
  ARM64=1; RUNTIME_PATCHES=false
  echo "Apple Silicon detected: applying the arm64 workarounds"
else
  ARM64=0; RUNTIME_PATCHES=true
  echo "Intel Mac detected: using stock BepInEx"
fi

PATCHED="$HERE/.tools/BepInEx.Preloader.patched.dll"
if [[ "$ARM64" == "1" ]]; then
  if [[ -f "$PATCHED" ]]; then
    cp "$PATCHED" "$TS_DIR/BepInEx/core/BepInEx.Preloader.dll"
  else
    echo "Warning: $PATCHED missing; BepInEx will fail on Apple Silicon." >&2
    echo "Build it with plugin/tools/prepatch (see its README)." >&2
  fi
fi
# On Intel the cp -R above has already restored the stock preloader

CFG="$TS_DIR/BepInEx/config/BepInEx.cfg"
mkdir -p "$(dirname "$CFG")"
if [[ -f "$CFG" ]] && grep -q '^ApplyRuntimePatches' "$CFG"; then
  sed -i '' "s/^ApplyRuntimePatches = .*/ApplyRuntimePatches = $RUNTIME_PATCHES/" "$CFG"
else
  printf '[Preloader]\n\nApplyRuntimePatches = %s\n' "$RUNTIME_PATCHES" >> "$CFG"
fi

# Files copied out of a download can carry the quarantine flag, which stops
# macOS loading the doorstop library. Clear it on what we just placed.
xattr -dr com.apple.quarantine "$TS_DIR/libdoorstop.dylib" "$TS_DIR/BepInEx" "$TS_DIR/run_bepinex.sh" 2>/dev/null || true

# The plugin
mkdir -p "$TS_DIR/BepInEx/plugins/SpirekeeperBridge"
cp "$DLL" "$TS_DIR/BepInEx/plugins/SpirekeeperBridge/"

# The probe panel, installed beside Spirekeeper under its own name
"$REPO/dev/install.sh" --copy --src plugin/probe-symbiote --name "Spirekeeper Bridge Probe" \
  || echo "Probe panel not installed; run dev/install.sh with --path as it describes above."

cat <<EOF

Installed into: $TS_DIR

Start TaleSpire with the bridge (Steam must be running):

  cd "$TS_DIR" && ./run_bepinex.sh

Then check the log for the bridge's "loaded" line:

  tail -f "$TS_DIR/BepInEx/LogOutput.log"
EOF
