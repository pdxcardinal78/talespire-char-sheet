#!/usr/bin/env bash
#
# Link the Symbiote into TaleSpire's Symbiotes directory for development.
#
# TaleSpire watches that directory and hot-reloads on file change, so a symlink
# means editing in the repo updates the running panel. Pass --copy if your
# platform refuses to follow symlinks there.
#
#   ./dev/install.sh
#   ./dev/install.sh --copy
#   ./dev/install.sh --path "/some/other/Symbiotes"
#
# --src and --name install a second build alongside the first under its own
# name, so the shipping mod stays playable while another is worked on. That
# needs the other build to carry its own interop id, or the two will receive
# each other's messages:
#
#   ./dev/install.sh --src some/other/symbiote --name "Spirekeeper next"

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/symbiote"
NAME="Spirekeeper"
MODE="link"
FORCED_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy) MODE="copy"; shift ;;
    --path) FORCED_PATH="$2"; shift 2 ;;
    --src)  SRC="$REPO_DIR/$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

# TaleSpire is a Unity game, so the Symbiotes folder sits under the platform's
# persistent data path. These are the plausible locations; we probe rather than
# guess, because the macOS build is newer than most of the documentation.
candidates=(
  "$HOME/Library/Application Support/com.bouncyrock.talespire/Symbiotes"
  "$HOME/Library/Application Support/BouncyRock Entertainment/TaleSpire/Symbiotes"
  "$HOME/Library/Application Support/com.BouncyRock.TaleSpire/Symbiotes"
  "$HOME/.config/unity3d/BouncyRock Entertainment/TaleSpire/Symbiotes"
  "$HOME/.steam/steam/steamapps/compatdata/720620/pfx/drive_c/users/steamuser/AppData/LocalLow/BouncyRock Entertainment/TaleSpire/Symbiotes"
  "${APPDATA:-}/../LocalLow/BouncyRock Entertainment/TaleSpire/Symbiotes"  # Windows (git-bash/WSL)
)

TARGET_DIR=""
if [[ -n "$FORCED_PATH" ]]; then
  TARGET_DIR="$FORCED_PATH"
else
  for dir in "${candidates[@]}"; do
    if [[ -d "$dir" ]]; then TARGET_DIR="$dir"; break; fi
  done
fi

if [[ -z "$TARGET_DIR" ]]; then
  cat >&2 <<EOF
Could not find TaleSpire's Symbiotes directory. Checked:

$(printf '  %s\n' "${candidates[@]}")

In TaleSpire, open Settings -> Modding (or the Symbiote panel) and click
"Open Symbiotes Directory", then re-run with:

  ./dev/install.sh --path "/that/path"
EOF
  exit 1
fi

if [[ ! -f "$SRC/manifest.json" ]]; then
  echo "No manifest.json in $SRC — is --src pointing at a Symbiote folder?" >&2
  exit 1
fi

DEST="$TARGET_DIR/$NAME"

if [[ -e "$DEST" || -L "$DEST" ]]; then
  echo "Removing existing $DEST"
  rm -rf "$DEST"
fi

if [[ "$MODE" == "link" ]]; then
  ln -s "$SRC" "$DEST"
  echo "Linked  $DEST -> $SRC"
  echo "Edits in symbiote/ now hot-reload in TaleSpire."
else
  cp -R "$SRC" "$DEST"
  echo "Copied  $SRC -> $DEST"
  echo "Re-run this script after each change (copy mode does not track edits)."
fi

echo
echo "In TaleSpire: enable Symbiotes in settings, then open the Symbiote panel."
echo "If '$NAME' shows a warning marker, the manifest failed validation —"
echo "check .debug/log.txt inside the Symbiote folder."
