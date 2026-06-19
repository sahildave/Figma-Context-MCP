#!/bin/sh
# Runs both processes in one container:
#   1. The Figma MCP server (built from this repo) on port 3333 (internal)
#   2. The OAuth shim, which proxies to it, on Railway's $PORT (public)
#
# Railway only exposes one port publicly, so the shim is what Hyperagent
# actually talks to. The real MCP server stays internal on localhost.
#
# IMPORTANT: this server is configured via FRAMELINK_PORT env var,
# NOT a --port CLI flag (the flag was being silently ignored, causing
# the server to never actually open an HTTP listener).

set -e

export FRAMELINK_PORT=3333
export FRAMELINK_HOST=127.0.0.1

echo "Starting Figma MCP server on port $FRAMELINK_PORT (internal)..."
node dist/bin.js --figma-api-key="$FIGMA_API_KEY" &
MCP_PID=$!

sleep 3

echo "Starting OAuth shim on port ${PORT:-3334} (public)..."
SHIM_PORT="${PORT:-3334}" MCP_TARGET="http://localhost:3333" node oauth-shim/server.js &
SHIM_PID=$!

wait -n "$MCP_PID" "$SHIM_PID"
exit 1