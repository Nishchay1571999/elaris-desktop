#!/usr/bin/env bash
# Builds Elaris Desktop as a macOS app, installs it to /Applications, then
# quits any running copy and launches the new build. The app loads the agent
# sidecar from this repo, so it only works on the machine that built it.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
app="$repo/target/release/bundle/macos/Elaris.app"
dest="/Applications/Elaris.app"
bin="$dest/Contents/MacOS/elaris-desktop"

cd "$repo"
pnpm tauri build --bundles app

# A running app keeps its files open, so the bundle can be swapped in place.
rm -rf "$dest"
ditto "$app" "$dest"
echo "Installed $dest"

# Restart detached: when this script is run by Elaris's own agent, quitting
# the app takes this process down with it, and the relaunch must still happen.
# Uses ps rather than pgrep, which can't see the app from sandboxed shells.
nohup bash -c '
  bin="$1"; dest="$2"
  running() { ps -axo pid=,command= | awk -v b="$bin" "\$2 == b { print \$1 }"; }
  if [ -n "$(running)" ]; then
    osascript -e "quit app id \"ai.elaris.desktop\"" || true
    for _ in $(seq 1 20); do [ -z "$(running)" ] && break; sleep 0.5; done
    pids="$(running)"; [ -n "$pids" ] && kill $pids || true
    sleep 0.5
  fi
  open "$dest"
' _ "$bin" "$dest" >/dev/null 2>&1 &
disown
echo "Restarting Elaris…"
