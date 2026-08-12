#!/bin/bash
# Runs the Cloudflare Tunnel daemon alongside the Node bot. We use bash
# (not /bin/sh) so `wait -n` is available — exit as soon as either child
# dies. docker.io/library/node:22-bookworm-slim ships bash, so no extra
# install step needed.
#
# `set -e` makes any failure in the launch checks fail this script
# immediately, before either background process is started.

set -e

# Resolve binary locations relative to this script so we don't depend on
# nixpacks using /app as the working directory.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLOUDFLARED_BIN="$(command -v cloudflared || echo /usr/bin/cloudflared)"
CLOUDFLARED_CFG="$SCRIPT_DIR/config.yml"

if [ ! -x "$CLOUDFLARED_BIN" ]; then
  echo "start.sh: cloudflared not found at $CLOUDFLARED_BIN (is it installed?)" >&2
  exit 1
fi
if [ ! -r "$CLOUDFLARED_CFG" ]; then
  echo "start.sh: config.yml not readable at $CLOUDFLARED_CFG" >&2
  exit 1
fi

# Pin the origin so the tunnel forwards to the port Railway actually exposes.
# If you need to override the port, set $PORT before invoking this script.
echo "start.sh: cloudflared=$CLOUDFLARED_BIN config=$CLOUDFLARED_CFG port=$PORT"
"$CLOUDFLARED_BIN" --config "$CLOUDFLARED_CFG" tunnel run discord-bot &
TUNNEL_PID=$!

node src/index.js &
NODE_PID=$!

# On any exit signal, kill both children so the container exits cleanly.
trap "kill $TUNNEL_PID $NODE_PID 2>/dev/null" EXIT INT TERM

# Block until either child exits; the trap above kills the other one, and
# this script then exits (per `set -e`). Railway's ON_FAILURE restart policy
# restarts the whole container.
wait -n
