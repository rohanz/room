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

rm -rf "$WORK"; mkdir -p "$WORK"
# Seed a bare "origin" from the example repo so both clones share a base commit.
cp -R "$ROOT/examples/demo-repo" "$WORK/src"
( cd "$WORK/src" && rm -rf .git && git init -q -b main && git add -A && git -c user.email=demo@room -c user.name=demo commit -qm "demo-shop initial" )
git clone -q "$WORK/src" "$A"; git clone -q "$WORK/src" "$B"
for d in "$A" "$B"; do ( cd "$d" && git config user.email demo@room && git config user.name "$(basename "$d")" && uv sync --group dev -q ); done

echo "[demo] starting server on :$PORT"
PORT="$PORT" npx tsx "$ROOT/packages/server/src/index.ts" > "$WORK/server.log" 2>&1 &
SRV=$!
sleep 1
echo "[demo] starting daemons"
npx tsx "$ROOT/packages/roomd/src/cli.ts" --room "ws://$HOST_IP:$PORT/$ROOM" --dir "$A" --name Rohan  > "$WORK/roomd-rohan.log" 2>&1 &
D1=$!
sleep 2
npx tsx "$ROOT/packages/roomd/src/cli.ts" --room "ws://$HOST_IP:$PORT/$ROOM" --dir "$B" --name Kieran > "$WORK/roomd-kieran.log" 2>&1 &
D2=$!
trap 'echo; echo "[demo] stopping"; kill $SRV $D1 $D2 2>/dev/null; wait 2>/dev/null' EXIT

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
