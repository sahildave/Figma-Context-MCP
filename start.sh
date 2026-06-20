#!/usr/bin/env bash
# Runs both processes in one container:
#   1. The Figma MCP server (built from this repo) on 127.0.0.1:3333 (internal)
#   2. The OAuth shim, which proxies to it, on Railway's $PORT (public)
#
# Railway exposes one public port; the shim is what Hyperagent talks to.
# The real MCP server stays internal on 127.0.0.1.
#
# Invoked via `bash start.sh` (package.json -> start:deploy), so bash builtins
# like `wait -n` are available regardless of what /bin/sh points to.

set -e

# --- Fatal preflight: the MCP server REQUIRES a Figma credential. -----------
# figma-developer-mcp throws "Either FIGMA_API_KEY or FIGMA_OAUTH_TOKEN is
# required" and exits BEFORE opening any HTTP listener if neither is set. That
# early exit is what produced the "no MCP startup logs, every request hangs"
# symptom. Fail loudly and early instead of looping silently.
if [ -z "$FIGMA_API_KEY" ] && [ -z "$FIGMA_OAUTH_TOKEN" ]; then
  echo "FATAL: neither FIGMA_API_KEY nor FIGMA_OAUTH_TOKEN is set."
  echo "Set FIGMA_API_KEY in Railway -> your service -> Variables, then redeploy."
  exit 1
fi
echo "Credential check OK (FIGMA_API_KEY length: ${#FIGMA_API_KEY})."

# Pin the internal port/host explicitly. The server resolves its port as:
#   --port flag  >  FRAMELINK_PORT  >  PORT  >  3333 (default)
# If FRAMELINK_PORT were unset, it would fall back to Railway's $PORT and try to
# bind the SAME public port as the shim -> collision. Pinning 3333 avoids that.
export FRAMELINK_PORT=3333
export FRAMELINK_HOST=127.0.0.1

echo "Starting Figma MCP server on ${FRAMELINK_HOST}:${FRAMELINK_PORT} (internal)..."
# FIGMA_API_KEY is read from the environment by the server; no CLI flag needed.
node dist/bin.js &
MCP_PID=$!

# Give the MCP server a moment to bind before the shim starts proxying.
sleep 3

echo "Starting OAuth shim on port ${PORT:-3334} (public)..."
SHIM_PORT="${PORT:-3334}" MCP_TARGET="http://127.0.0.1:3333" node oauth-shim/server.js &
SHIM_PID=$!

# If EITHER process exits, stop the container so Railway restarts it cleanly.
wait -n "$MCP_PID" "$SHIM_PID"
echo "A child process exited; shutting down so Railway can restart."
exit 1