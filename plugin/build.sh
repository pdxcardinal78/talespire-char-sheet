#!/usr/bin/env bash
#
# Build the Spirekeeper bridge plugin.
#
# Compiles straight against TaleSpire's own assemblies in plugin/refs, using
# the C# compiler that ships with the .NET SDK. No NuGet packages are needed.
#
#   ./plugin/build.sh            # writes plugin/dist/SpirekeeperBridge.dll
#
# Needs: .NET SDK 8 or newer (brew install dotnet), plugin/refs populated
# (see plugin/README.md), and the BepInEx zip in plugin/.tools.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REFS="$HERE/refs"
TOOLS="$HERE/.tools"
OUT="$HERE/dist"
BEPINEX_ZIP="$TOOLS/bepinex.zip"
BEPINEX_URL="https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.5/BepInEx_macos_universal_5.4.23.5.zip"

if [[ ! -f "$REFS/Bouncyrock.TaleSpire.Runtime.dll" ]]; then
  echo "plugin/refs is missing TaleSpire's assemblies. See plugin/README.md, step 1." >&2
  exit 1
fi

# Fetch and unpack BepInEx once
mkdir -p "$TOOLS"
if [[ ! -f "$BEPINEX_ZIP" ]]; then
  curl -fsSL -o "$BEPINEX_ZIP" "$BEPINEX_URL"
fi
if [[ ! -f "$TOOLS/bepinex/BepInEx/core/BepInEx.dll" ]]; then
  rm -rf "$TOOLS/bepinex" && mkdir -p "$TOOLS/bepinex"
  unzip -q "$BEPINEX_ZIP" -d "$TOOLS/bepinex"
fi

# Find Roslyn inside the newest installed SDK
SDK_DIR="$(dotnet --list-sdks | tail -1 | sed -E 's/^([^ ]+) \[(.*)\]$/\2\/\1/')"
CSC="$SDK_DIR/Roslyn/bincore/csc.dll"
if [[ ! -f "$CSC" ]]; then
  echo "Could not find csc.dll under $SDK_DIR" >&2
  exit 1
fi

# Reference every TaleSpire assembly plus BepInEx. -nostdlib makes TaleSpire's
# own mscorlib the base library, so the plugin targets exactly the runtime the
# game ships rather than whatever this machine has.
args=()
for dll in "$REFS"/*.dll; do args+=("-r:$dll"); done
args+=("-r:$TOOLS/bepinex/BepInEx/core/BepInEx.dll")
args+=("-r:$TOOLS/bepinex/BepInEx/core/0Harmony.dll")

mkdir -p "$OUT"
dotnet "$CSC" -nologo -nostdlib -noconfig -target:library -optimize+ -langversion:9 \
  -nowarn:CS1701,CS1702 \
  -out:"$OUT/SpirekeeperBridge.dll" \
  "${args[@]}" \
  "$HERE"/src/*.cs

echo "Built $OUT/SpirekeeperBridge.dll"

# The Apple Silicon preloader (see tools/prepatch/README.md). An empty
# packageSources list keeps restore offline; the tool needs no packages.
PATCHED="$TOOLS/BepInEx.Preloader.patched.dll"
if [[ ! -f "$PATCHED" || "$TOOLS/bepinex/BepInEx/core/BepInEx.Preloader.dll" -nt "$PATCHED" ]]; then
  dotnet run --project "$HERE/tools/prepatch" -c Release -- \
    "$TOOLS/bepinex/BepInEx/core/BepInEx.Preloader.dll" "$PATCHED" "$REFS"
fi
echo "Built $PATCHED"
