#!/usr/bin/env bash
#
# Launch TaleSpire through BepInEx with every log turned on, and collect what
# Claude needs to diagnose a failed load into plugin/.tools/diag/.
#
#   ./plugin/diag-mac.sh
#
# Quit TaleSpire first. Steam must be running. The script leaves TaleSpire
# running; get to the main menu, wait a few seconds, then say "done".

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS_DIR="$HOME/Library/Application Support/Steam/steamapps/common/TaleSpire"
OUT="$HERE/.tools/diag"
CFG="$TS_DIR/BepInEx/config/BepInEx.cfg"

if pgrep -x TaleSpire >/dev/null; then
  echo "TaleSpire is still running. Quit it first, then re-run this." >&2
  exit 1
fi

rm -rf "$OUT" && mkdir -p "$OUT"

# Turn on console and Unity logging so the preloader's output reaches the
# Terminal, where this script captures it
if [[ -f "$CFG" ]]; then
  cp "$CFG" "$OUT/BepInEx.cfg.before"
  awk '
    /^\[/ { section = $0 }
    section == "[Logging.Console]" && /^Enabled *=/ { print "Enabled = true"; next }
    section == "[Logging.Disk]" && /^WriteUnityLog *=/ { print "WriteUnityLog = true"; next }
    section == "[Logging.Disk]" && /^LogLevels *=/ { print "LogLevels = All"; next }
    { print }
  ' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
  cp "$CFG" "$OUT/BepInEx.cfg.after"
fi

grep -nE '^(executable_name|doorstop_name|target_assembly|enabled)=' "$TS_DIR/run_bepinex.sh" > "$OUT/launcher.txt"

# Launch in the background, capturing everything it prints
cd "$TS_DIR"
nohup ./run_bepinex.sh > "$OUT/launch.txt" 2>&1 &
echo "Launched. Waiting 45 seconds for TaleSpire to start..."
sleep 45

{
  echo "== processes"; pgrep -lf "TaleSpire.app/Contents/MacOS"
  echo "== doorstop mapped"
  pid="$(pgrep -x TaleSpire | head -1)"
  [[ -n "$pid" ]] && lsof -p "$pid" 2>/dev/null | grep -iE "doorstop|BepInEx|Spirekeeper" || echo "none"
  echo "== ping"; curl -s -m 3 http://127.0.0.1:47817/ping || echo "no answer"
  echo "== BepInEx files"; find "$TS_DIR/BepInEx" -newer "$OUT/launcher.txt" -type f
  echo "== stray logs in game folder"; ls -la "$TS_DIR" | grep -iE "log|preloader|doorstop"
} > "$OUT/state.txt" 2>&1

[[ -f "$TS_DIR/BepInEx/LogOutput.log" ]] && cp "$TS_DIR/BepInEx/LogOutput.log" "$OUT/"
find "$TS_DIR" -maxdepth 2 -name "preloader_*.log" -exec cp {} "$OUT/" \;

# Unity's own player log; the folder name has spaces, so read it null-separated
find "$HOME/Library/Logs" -ipath "*talespire*" -name "Player*.log" -print0 2>/dev/null |
  while IFS= read -r -d '' f; do cp "$f" "$OUT/$(basename "$f")"; done

ls -la "$OUT"
echo
echo "Collected into $OUT. TaleSpire is still running."
