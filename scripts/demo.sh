#!/usr/bin/env bash
# One-machine demo: server + two clones of examples/demo-repo + two sync daemons.
# Then prints the commands for the two agents and the browser tabs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-1234}"
ROOM="${ROOM:-demo}"
HOST_IP="${HOST_IP:-localhost}"
WORK="${WORK:-/tmp/room-demo}"
A="$WORK/rohan" B="$WORK/kieran"

case "$WORK" in
  /tmp/*|*room-demo*) ;;
  *) echo "[demo] refusing to remove unsafe WORK path: $WORK (must be under /tmp or contain room-demo)" >&2; exit 2 ;;
esac
rm -rf "$WORK"; mkdir -p "$WORK"
# Seed a bare "origin" from the example repo so both clones share a base commit.
cp -R "$ROOT/examples/demo-repo" "$WORK/src"
( cd "$WORK/src" && rm -rf .git && git init -q -b main && git add -A && git -c user.email=demo@room -c user.name=demo commit -qm "demo-shop initial" )
git clone -q "$WORK/src" "$A"; git clone -q "$WORK/src" "$B"
for d in "$A" "$B"; do ( cd "$d" && git config user.email demo@room && git config user.name "$(basename "$d")" && uv sync --group dev -q ); done

echo "[demo] starting server on :$PORT"
PORT="$PORT" npx tsx "$ROOT/packages/server/src/index.ts" > "$WORK/server.log" 2>&1 &
SRV=$!
D1="" D2=""
cleanup() {
  echo
  echo "[demo] stopping"
  kill "$SRV" ${D1:+"$D1"} ${D2:+"$D2"} 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

wait_for_port() {
  local attempts=100
  while (( attempts-- > 0 )); do
    if nc -z "$HOST_IP" "$PORT" 2>/dev/null; then return 0; fi
    if ! kill -0 "$SRV" 2>/dev/null; then echo "[demo] server exited; see $WORK/server.log" >&2; return 1; fi
    sleep 0.1
  done
  echo "[demo] timed out waiting for $HOST_IP:$PORT; see $WORK/server.log" >&2
  return 1
}

wait_for_sync() {
  local log_file="$1" pid="$2" attempts=150
  while (( attempts-- > 0 )); do
    if grep -q "synced .* files as" "$log_file" 2>/dev/null; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then echo "[demo] daemon exited; see $log_file" >&2; return 1; fi
    sleep 0.1
  done
  echo "[demo] timed out waiting for daemon sync; see $log_file" >&2
  return 1
}

wait_for_port
echo "[demo] starting daemons"
npx tsx "$ROOT/packages/roomd/src/cli.ts" --room "ws://$HOST_IP:$PORT/$ROOM" --dir "$A" --name Rohan  > "$WORK/roomd-rohan.log" 2>&1 &
D1=$!
wait_for_sync "$WORK/roomd-rohan.log" "$D1"
npx tsx "$ROOT/packages/roomd/src/cli.ts" --room "ws://$HOST_IP:$PORT/$ROOM" --dir "$B" --name Kieran > "$WORK/roomd-kieran.log" 2>&1 &
D2=$!
wait_for_sync "$WORK/roomd-kieran.log" "$D2"

cat <<MSG

Room is up.  ws://$HOST_IP:$PORT/$ROOM
  Rohan's clone:  $A
  Kieran's clone: $B
  logs:           $WORK/*.log

In separate terminals:
  npx tsx $ROOT/packages/agent/src/cli.ts --name Rohan  --dir $A --room ws://$HOST_IP:$PORT/$ROOM
  npx tsx $ROOT/packages/agent/src/cli.ts --name Kieran --dir $B --room ws://$HOST_IP:$PORT/$ROOM
  npm run web      # then open:
    http://localhost:5173/?room=ws://$HOST_IP:$PORT/$ROOM&name=Rohan
    http://localhost:5173/?room=ws://$HOST_IP:$PORT/$ROOM&name=Kieran

Ctrl-C here stops the server and daemons.
MSG
wait
