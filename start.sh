#!/bin/sh
# Runs the Cloudflare Tunnel daemon alongside the Node bot. We use the
# absolute path /usr/bin/cloudflared explicitly so that a stray file named
# "cloudflared" in the working directory (which has happened during local
# testing) can't shadow the apt-installed binary and silently break the
# tunnel start.
#
# `set -e` makes any failure in either child cause the shell to exit, which
# triggers Railway's restart policy. `wait -n` means we exit as soon as
# either child dies, instead of running half a service.

set -e

# Pin the origin so the tunnel forwards to the port Railway actually exposes.
# If you need to override the port, set $PORT before invoking this script.
/usr/bin/cloudflared --config /app/config.yml tunnel run discord-bot &
TUNNEL_PID=$!

node src/index.js &
NODE_PID=$!

# On any exit signal, kill both children so the container exits cleanly.
trap "kill $TUNNEL_PID $NODE_PID 2>/dev/null" EXIT INT TERM

# Block until either process exits. If cloudflared dies first, node gets
# killed by the trap and Railway restarts the whole container.
wait -n
