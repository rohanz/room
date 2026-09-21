#!/usr/bin/env bash
# One-machine demo: room server + a shared "origin" + two clones (Rohan, Kieran).
# Then prints how to join from each clone with plain Codex (plugin) or with roomagent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-1234}"
WORK="${WORK:-/tmp/room-demo}"
A="$WORK/rohan" B="$WORK/kieran"

case "$WORK" in
  /tmp/*|*room-demo*) ;;
  *) echo "[demo] refusing to rm -rf '$WORK' (must be under /tmp or contain 'room-demo')" >&2; exit 1 ;;
esac
rm -rf "$WORK"; mkdir -p "$WORK"

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
GITHUB_CLIENT_ID=fake PORT="$PORT" npx tsx "$ROOT/packages/server/src/index.ts" > "$WORK/server.log" 2>&1 &
SRV=$!
trap 'echo; echo "[demo] stopping"; kill $SRV 2>/dev/null; wait 2>/dev/null' EXIT
for _ in $(seq 1 50); do
  if (echo > "/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1; then break; fi
  sleep 0.1
done
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
curl -sf -X POST "http://localhost:$PORT/rooms" -H 'content-type: application/json' -d "{\"room\":\"local/origin/main\",\"session\":\"$ROHAN_SESSION\"}" >/dev/null \
  || { echo "[demo] could not open the room on :$PORT" >&2; exit 1; }

cat <<MSG

Room server: ws://localhost:$PORT   (room opened for local/origin; branch rooms derive from the clone, e.g. local/origin/main)
  Rohan's clone:  $A
  Kieran's clone: $B
  The server uses the fake GitHub issuer: each agent runs room_login once and is admitted at the code it shows
  (any login name is accepted; nothing talks to GitHub).

Join with plain Codex (plugin installed via: codex plugin marketplace add $ROOT && codex plugin add room@room):
  cd $A && ROOM_SERVER=ws://localhost:$PORT codex     # then: \$room-join
  cd $B && ROOM_SERVER=ws://localhost:$PORT codex     # then: \$room-join

Or leave an agent on duty (reacts to interrupts and questions unattended):
  ROOM_SERVER=ws://localhost:$PORT ROOM_SESSION=$ROHAN_SESSION npx tsx $ROOT/packages/agent/src/cli.ts --dir $A --name Rohan
  ROOM_SERVER=ws://localhost:$PORT ROOM_SESSION=$KIERAN_SESSION npx tsx $ROOT/packages/agent/src/cli.ts --dir $B --name Kieran

Browser view:  npm run web   then open the URL room_join prints.

Ctrl-C here stops the server.
MSG
wait
