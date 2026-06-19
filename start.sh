#!/bin/sh
# Runs both processes in one Railway container:
# Runs both processes in one container:
#   1. The Figma MCP server (built from this repo) on port 3333 (internal)
#   2. The OAuth shim, which proxies to it, on Railway's $PORT (public)
#
# Railway only exposes one port publicly, so the shim is what Hyperagent
# actually talks to. The real MCP server stays internal on localhost.

set -e

echo "Starting Figma MCP server on port 3333 (internal)..."
node dist/bin.js --figma-api-key="$FIGMA_API_KEY" --port=3333 &
MCP_PID=$!

# Give it a moment to boot before the shim starts proxying to it
sleep 3

echo "Starting OAuth shim on port ${PORT:-3334} (public)..."
SHIM_PORT="${PORT:-3334}" MCP_TARGET="http://localhost:3333" node oauth-shim/server.js &
SHIM_PID=$!

# If either process dies, kill the other and exit so Railway restarts the service
wait -n "$MCP_PID" "$SHIM_PID"
exit 1