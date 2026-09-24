#!/usr/bin/env bash
# The Room playground shop at a pinned commit, as a git clone with an origin like a real checkout.
set -euo pipefail
git clone -q -b shop https://github.com/rohanz/room-playground-2 .
git checkout -q dbc11ba7dabf140a21fa6c3661f5f49a7e10898b
