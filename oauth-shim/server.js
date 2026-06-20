// Minimal auto-approving OAuth2 shim for a self-hosted MCP server.
//
// Purpose: Hyperagent's "Bring my own OAuth app" form requires a real
// authorize + token endpoint AND auto-discovery via .well-known. This server
// provides both, auto-approving every request (single-user, trusted client),
// then issues a static bearer token. The real MCP server doesn't validate the
// token — the shim only exists to satisfy Hyperagent's OAuth flow and to
// proxy /mcp through to the MCP server.
//
//   URL:                     https://<deploy-url>/mcp
//   Authorization endpoint:  https://<deploy-url>/authorize
//   Token endpoint:          https://<deploy-url>/token
//   Client ID:               anything, e.g. "hyperagent"
//   Client Secret:           blank   |   Scopes: blank

/* eslint-disable no-undef */
// Standalone deploy helper, run under plain Node (ESM). Requires the sibling
// oauth-shim/package.json to declare {"type":"module"} (see that file) — if it
// doesn't, Node treats this file as CommonJS and the imports below throw at
// startup.

import express from "express";
import crypto from "crypto";
import { createProxyMiddleware } from "http-proxy-middleware";

const SHIM_PORT = process.env.SHIM_PORT || process.env.PORT || 3334;

// Use 127.0.0.1, NOT "localhost". The MCP server binds 127.0.0.1 (IPv4) via
// FRAMELINK_HOST. On some hosts "localhost" resolves to ::1 (IPv6) first, which
// nothing is listening on -> ECONNREFUSED on every proxied request.
const MCP_TARGET = process.env.MCP_TARGET || "http://127.0.0.1:3333";
const STATIC_TOKEN = process.env.STATIC_TOKEN || "local-dev-static-token";

function log(...args) {
  console.log("[SHIM]", ...args);
}

const app = express();

// ---------------------------------------------------------------------------
// FIX (the hang): do NOT install body parsers globally.
//
// express.json()/urlencoded() read the entire request stream to build
// req.body. If they run before the proxy, the POST /mcp JSON-RPC body is
// drained HERE, and http-proxy-middleware then forwards a request whose body
// stream is already at EOF. The upstream MCP server keeps waiting for a body
// that never arrives -> the request hangs forever (exactly the symptom seen).
//
// Parse bodies ONLY on /token (the one route that needs req.body). Proxied
// paths (/mcp, /sse) are left untouched so their raw stream is forwarded
// intact.
// ---------------------------------------------------------------------------
const parseBody = [express.urlencoded({ extended: true }), express.json()];

// Request logger — does not touch the body, safe to run globally.
app.use((req, _res, next) => {
  log(req.method, req.url);
  next();
});

const issuedCodes = new Set();

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  return `${proto}://${host}`;
}

app.get("/ping", (_req, res) => {
  log("PING");
  res.json({ ok: true });
});

// RFC 9728 — protected resource metadata (bare + path-suffixed variants).
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const base = baseUrl(req);
  res.json({ resource: `${base}/mcp`, authorization_servers: [base] });
});
app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
  const base = baseUrl(req);
  res.json({ resource: `${base}/mcp`, authorization_servers: [base] });
});

// RFC 8414 — authorization server metadata.
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

app.get("/authorize", (req, res) => {
  log("authorize request", req.query);
  const { redirect_uri, state } = req.query;
  if (!redirect_uri) return res.status(400).send("Missing redirect_uri");
  const code = crypto.randomBytes(16).toString("hex");
  issuedCodes.add(code);
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  res.redirect(redirectUrl.toString());
});

// Body parsers applied HERE ONLY.
app.post("/token", parseBody, (req, res) => {
  log("token exchange", req.body);
  const { code } = req.body || {};
  if (code && issuedCodes.has(code)) issuedCodes.delete(code);
  res.json({
    access_token: STATIC_TOKEN,
    token_type: "Bearer",
    expires_in: 31536000,
  });
});

// ---------------------------------------------------------------------------
// Catch-all proxy: /mcp, /sse, everything else -> real MCP server.
//
// FIX (broken streams): NO proxyTimeout/timeout here. MCP Streamable HTTP
// keeps SSE responses open for a long time to push server->client messages; a
// short timeout would kill a perfectly healthy stream. A genuinely dead
// upstream still fails instantly with ECONNREFUSED, which the error handler
// below converts into a clean 502 (so debugging never silently hangs again).
// ---------------------------------------------------------------------------
app.use(
  "/",
  createProxyMiddleware({
    target: MCP_TARGET,
    changeOrigin: true,
    ws: true,
    on: {
      proxyReq: (_proxyReq, req) => {
        log("proxying ->", MCP_TARGET, req.method, req.url);
      },
      error: (err, _req, res) => {
        log("PROXY ERROR:", err.code || err.message);
        // Guard headersSent so we never throw mid-stream.
        if (res && typeof res.writeHead === "function" && !res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Upstream MCP server unreachable",
              detail: err.message,
            }),
          );
        }
      },
    },
  }),
);

log("=== SHIM STARTING ===");
log("node version:", process.version);
log("PORT env:", process.env.PORT);
log("MCP_TARGET:", MCP_TARGET);
log("cwd:", process.cwd());

app.listen(SHIM_PORT, "0.0.0.0", () => {
  log(`listening on 0.0.0.0:${SHIM_PORT}`);
  log(`proxying non-auth requests to ${MCP_TARGET}`);
});
