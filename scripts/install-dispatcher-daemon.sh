#!/usr/bin/env bash
#
# Meridian dispatcher daemon (macOS) — keep the laptop bridge always-on so the
# website's Console → Agents buttons work without you ever opening a terminal.
#
# When Meridian's UI is hosted remotely (Vercel), the start/stop buttons enqueue
# commands that a LOCAL dispatcher must consume — it's the bridge to the machine
# where `claude login` lives. This installs that dispatcher (plus the news +
# holdings-ingest workers it runs alongside, via `npm run agents:remote`) as a
# per-user launchd LaunchAgent: it starts at login and auto-restarts if it dies.
# After a one-time install you control the actual research loops entirely from
# the website; this process just has to be up to relay the clicks.
#
# Usage:
#   bash scripts/install-dispatcher-daemon.sh            # install + start
#   bash scripts/install-dispatcher-daemon.sh status     # is it running?
#   bash scripts/install-dispatcher-daemon.sh logs       # tail the logs
#   bash scripts/install-dispatcher-daemon.sh uninstall   # stop + remove
#
# It writes ~/Library/LaunchAgents/com.meridian.dispatcher.plist and logs to
# .dispatcher.out.log / .dispatcher.err.log in the project root (gitignored).
set -euo pipefail

LABEL="com.meridian.dispatcher"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
# Resolve the project root as this script's parent directory, so the daemon's
# WorkingDirectory is correct no matter where it's invoked from.
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_LOG="$PROJECT_DIR/.dispatcher.out.log"
ERR_LOG="$PROJECT_DIR/.dispatcher.err.log"
DOMAIN="gui/$(id -u)"

cmd="${1:-install}"

uninstall() {
  # `bootout` unloads a running agent; ignore failure if it isn't loaded.
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ dispatcher daemon removed ($LABEL). The research loops it was hosting are now stopped."
}

case "$cmd" in
  uninstall|remove)
    uninstall
    exit 0
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "✓ $LABEL is loaded. Recent state:"
      launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =|last exit code =" || true
    else
      echo "✗ $LABEL is not loaded. Run: bash scripts/install-dispatcher-daemon.sh"
    fi
    exit 0
    ;;
  logs)
    echo "── tail -f $ERR_LOG (Ctrl-C to stop) ──"
    touch "$OUT_LOG" "$ERR_LOG"
    tail -n 40 -f "$OUT_LOG" "$ERR_LOG"
    exit 0
    ;;
  install|"")
    ;;
  *)
    echo "unknown command: $cmd (use: install | status | logs | uninstall)" >&2
    exit 1
    ;;
esac

# --- resolve absolute tool paths (launchd runs with a bare PATH) --------------
NPM_BIN="$(command -v npm || true)"
NODE_BIN="$(command -v node || true)"
CLAUDE_BIN="$(command -v claude || true)"
if [[ -z "$NPM_BIN" || -z "$NODE_BIN" ]]; then
  echo "✗ could not find node/npm on PATH. Install Node, then re-run." >&2
  exit 1
fi
if [[ -z "$CLAUDE_BIN" ]]; then
  echo "⚠ 'claude' CLI not found on PATH. The agents authenticate via your"
  echo "  'claude login' session through it — install it and run 'claude login'"
  echo "  or the loops will fail once started. Continuing to install the daemon."
fi
# Build a PATH that covers node, npm, and the claude CLI plus the system dirs.
# Dedup via a substring check on the accumulated PATH so this stays compatible
# with macOS's stock Bash 3.2 (no associative arrays / `declare -A`).
DAEMON_PATH=""
add_dir() {
  local d="$1"
  [[ -z "$d" ]] && return 0
  case ":$DAEMON_PATH:" in
    *":$d:"*) return 0 ;;
  esac
  DAEMON_PATH="${DAEMON_PATH:+$DAEMON_PATH:}$d"
  return 0
}
add_dir "$(dirname "$NODE_BIN")"
add_dir "$(dirname "$NPM_BIN")"
[[ -n "$CLAUDE_BIN" ]] && add_dir "$(dirname "$CLAUDE_BIN")"
add_dir "/opt/homebrew/bin"
add_dir "/usr/local/bin"
add_dir "/usr/bin"; add_dir "/bin"; add_dir "/usr/sbin"; add_dir "/sbin"

mkdir -p "$HOME/Library/LaunchAgents"

# --- write the LaunchAgent plist ---------------------------------------------
# KeepAlive → relaunch on crash; RunAtLoad → start at login. ThrottleInterval
# stops a crash-loop from hammering the CPU. It runs `npm run agents:remote`
# (dispatch + holdings ingest + news) — the documented laptop-bridge bundle.
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NPM_BIN}</string>
    <string>run</string>
    <string>agents:remote</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${DAEMON_PATH}</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG}</string>
</dict>
</plist>
PLIST

# --- (re)load it -------------------------------------------------------------
# bootout any prior copy, then bootstrap the fresh plist and kick it now.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true

echo "✓ dispatcher daemon installed and started."
echo "  label   : $LABEL"
echo "  runs    : $NPM_BIN run agents:remote"
echo "  workdir : $PROJECT_DIR"
echo "  logs    : $ERR_LOG"
echo
echo "It now starts at login and restarts on crash. Control the research loops"
echo "from the website: Operator Console → Governance & Telemetry → Agents."
echo "Manage the daemon: bash scripts/install-dispatcher-daemon.sh {status|logs|uninstall}"
