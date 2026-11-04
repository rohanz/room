#!/usr/bin/env bash
# One-machine demo: room server + a shared "origin" + two clones (Rohan, Kieran).
# Then prints how to join from each clone with plain Codex (plugin) or with roomagent.
#
# Usage (any cwd):  bash scripts/demo.sh            # or: PORT=1244 WORK=/tmp/my-room-demo bash scripts/demo.sh
# Prerequisites:    Node 22+ and npm (run `npm ci` in the repo first), git, curl, uv.
# PORT              server port (default 1234); it must be free: a listener already there is refused.
# WORK              demo directory, left in place on exit. Default: a fresh `mktemp -d` directory. A given
#                   WORK that exists and is not empty is replaced only when it holds the .room-demo marker
#                   an earlier run wrote; root, home, the repository and their ancestors are always refused.
# The server is in-memory and stops with this script (Ctrl-C). Its log is $WORK/server.log.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PORT="${PORT:-1234}"
MARKER=.room-demo

die() { echo "[demo] $*" >&2; exit 1; }
# Is $2 equal to $1 or inside it? Both are canonical absolute paths.
within() { [ "$1" = / ] || [ "$2" = "$1" ] || case "$2" in "$1"/*) true ;; *) false ;; esac; }

if [ -z "${WORK:-}" ]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/room-demo.XXXXXX")"
  WORK="$(cd "$WORK" && pwd -P)"
else
  case "/$WORK/" in */../*|*/./*) die "refusing WORK='$WORK': use a path without . or .. components" ;; esac
  while [ "${WORK%/}" != "$WORK" ]; do WORK="${WORK%/}"; done
  [ -n "$WORK" ] || die "refusing WORK=/"
  [ -L "$WORK" ] && die "refusing WORK='$WORK': it is a symbolic link"
  parent="$(dirname "$WORK")"
  [ -d "$parent" ] || die "refusing WORK='$WORK': $parent does not exist"
  parent="$(cd "$parent" && pwd -P)"
  WORK="${parent%/}/$(basename "$WORK")"
  HOME_DIR="$(cd "${HOME:-/}" && pwd -P)"
  for guarded in "$HOME_DIR" "$ROOT"; do
    within "$WORK" "$guarded" && die "refusing WORK='$WORK': it is $guarded or one of its ancestors"
  done
  if [ -e "$WORK" ]; then
    [ -d "$WORK" ] || die "refusing WORK='$WORK': it is not a directory"
    if [ -n "$(ls -A "$WORK")" ]; then
      [ -f "$WORK/$MARKER" ] || die "refusing to replace '$WORK': it is not empty and has no $MARKER marker from an earlier demo"
      rm -rf "$WORK"
    fi
  fi
  mkdir -p "$WORK"
fi
touch "$WORK/$MARKER"
A="$WORK/rohan" B="$WORK/kieran"

# Bare origin from the example repo so both clones share a base commit and an origin URL.
cp -R "$ROOT/examples/demo-repo" "$WORK/src"
( cd "$WORK/src" && rm -rf .git && git init -q -b main && git add -A && git -c user.email=demo@room -c user.name=demo commit -qm "demo-shop initial" )
git clone -q --bare "$WORK/src" "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$A"; git clone -q "$WORK/origin.git" "$B"
git -C "$A" config user.email rohan@room;  git -C "$A" config user.name Rohan
git -C "$B" config user.email kieran@room; git -C "$B" config user.name Kieran
for d in "$A" "$B"; do ( cd "$d" && uv sync --group dev -q ); done

echo "[demo] starting room server on :$PORT (fake GitHub issuer: GITHUB_CLIENT_ID=fake)"
# The fake issuer walks the real login path (POST /auth/device, /auth/poll) without GitHub: a login is
# whatever `fakeLogin` the poll carries. Never set it on a real server; NODE_ENV=production refuses it.
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/health"; then
  die "something already answers HTTP on :$PORT; stop it or pick another PORT"
fi
# The server itself, not an npx wrapper, so the recorded pid is the process to stop.
( cd "$ROOT" && GITHUB_CLIENT_ID=fake PORT="$PORT" exec node --import tsx packages/server/src/index.ts ) > "$WORK/server.log" 2>&1 &
SRV=$!
stop_server() {
  [ -n "${SRV:-}" ] || return 0
  kill "$SRV" 2>/dev/null || true
  wait "$SRV" 2>/dev/null || true
  SRV=
}
trap 'echo; echo "[demo] stopping"; stop_server' EXIT
server_failed() { echo "[demo] $1; server log follows" >&2; cat "$WORK/server.log" >&2; exit 1; }
ready=
for _ in $(seq 1 150); do
  kill -0 "$SRV" 2>/dev/null || { wait "$SRV" 2>/dev/null || true; SRV=; server_failed "the server exited during startup"; }
  if curl -sf --max-time 1 "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then ready=1; break; fi
  sleep 0.1
done
[ -n "$ready" ] || server_failed "the server did not answer /health on :$PORT within 15 s"
# Give each on-duty agent its own authenticated identity. The session values are demo-only and die
# with this in-memory server; printing them is what makes the copy/paste commands actually connect.
fake_session() {
  local login="$1" device session
  device="$(curl -sf -X POST "http://localhost:$PORT/auth/device" | sed -n 's/.*"device":"\([0-9a-f]*\)".*/\1/p')"
  session="$(curl -sf -X POST "http://localhost:$PORT/auth/poll" -H 'content-type: application/json' -d "{\"device\":\"$device\",\"fakeLogin\":\"$login\"}" | sed -n 's/.*"session":"\([0-9a-f]*\)".*/\1/p')"
  [ -n "$session" ] || { echo "[demo] fake login for $login failed on :$PORT (see $WORK/server.log)" >&2; exit 1; }
  printf '%s' "$session"
}
ROHAN_SESSION="$(fake_session Rohan)"
KIERAN_SESSION="$(fake_session Kieran)"
curl -sf -X POST "http://localhost:$PORT/rooms" -H 'content-type: application/json' -d "{\"room\":\"local/origin\",\"schema\":2,\"session\":\"$ROHAN_SESSION\"}" >/dev/null \
  || { echo "[demo] could not open the room on :$PORT" >&2; exit 1; }

cat <<MSG

Room server: ws://localhost:$PORT   (one room for local/origin across all branches)
  Rohan's clone:  $A
  Kieran's clone: $B
  The server uses the fake GitHub issuer: each agent runs room_login once and is admitted at the code it shows
  (any login name is accepted; nothing talks to GitHub).

Join with plain Codex (plugin installed via: codex plugin marketplace add $ROOT && codex plugin add room@room):
  cd $A && ROOM_SERVER=ws://localhost:$PORT codex --no-daemon     # then: \$room-join
  cd $B && ROOM_SERVER=ws://localhost:$PORT codex --no-daemon     # then: \$room-join

Or leave an agent on duty (reacts to interrupts and questions unattended):
  ROOM_SERVER=ws://localhost:$PORT ROOM_SESSION=$ROHAN_SESSION npx tsx $ROOT/packages/agent/src/cli.ts --dir $A --name Rohan
  ROOM_SERVER=ws://localhost:$PORT ROOM_SESSION=$KIERAN_SESSION npx tsx $ROOT/packages/agent/src/cli.ts --dir $B --name Kieran

Browser view:  npm run web   then open the URL room_join prints.

Ctrl-C here stops the server.
MSG
wait "$SRV"
