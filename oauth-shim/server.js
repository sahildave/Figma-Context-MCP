// Minimal auto-approving OAuth2 shim for a local MCP server.
//
// Purpose: Hyperagent's "Bring my own OAuth app" form requires a real
// authorize + token endpoint. This server provides both, auto-approving
// every request (since you're the only user and you trust the client),
// then issues a static bearer token. Your actual MCP server doesn't need
// to validate this token at all — its job is just to satisfy Hyperagent's
// OAuth flow so it stops bailing out at "Failed to start MCP OAuth".
//
// Then in Hyperagent's "Bring my own OAuth app":
//   URL:                     https://<your-deploy-url>/mcp
//   Authorization endpoint:  https://<your-deploy-url>/authorize
//   Token endpoint:          https://<your-deploy-url>/token
//   Client ID:               anything, e.g. "hyperagent"
//   Client Secret:           leave blank (public client / PKCE)
//   Scopes:                  leave blank

/* eslint-disable no-undef */
// This file is a standalone deploy helper, not part of the main
// figma-developer-mcp source. It runs under plain Node (ESM), where
// process/console/URL are valid globals — eslint's no-undef rule is
// disabled here rather than fighting the parent repo's flat config.

import express from "express";
import crypto from "crypto";
import { createProxyMiddleware } from "http-proxy-middleware";

const SHIM_PORT = process.env.SHIM_PORT || process.env.PORT || 3334;
const MCP_TARGET = process.env.MCP_TARGET || "http://localhost:3333";
const STATIC_TOKEN = process.env.STATIC_TOKEN || "local-dev-static-token";

// All logs go through this so they're easy to grep/filter in Railway's
// log viewer — search "[SHIM]" to isolate this process's output from
// the Figma MCP server's own logs running alongside it.
function log(...args) {
  console.log("[SHIM]", ...args);
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  log(req.method, req.url);
  next();
});

// In-memory map of issued auth codes -> just need to exist briefly
const issuedCodes = new Set();

// Helper: figure out our own public base URL from the incoming request.
function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  return `${proto}://${host}`;
}

app.get("/ping", (_, res) => {
  log("PING");
  res.json({ ok: true });
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  log("protected resource route");
  const base = baseUrl(req);
  res.json({ resource: `${base}/mcp`, authorization_servers: [base] });
});
app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
  log("protected resource route (/mcp)");
  const base = baseUrl(req);
  res.json({ resource: `${base}/mcp`, authorization_servers: [base] });
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  log("authorization server metadata route");
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
  if (!redirect_uri) {
    return res.status(400).send("Missing redirect_uri");
  }
  const code = crypto.randomBytes(16).toString("hex");
  issuedCodes.add(code);
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  res.redirect(redirectUrl.toString());
});

app.post("/token", (req, res) => {
  log("token exchange", req.body);
  const { code } = req.body;
  if (code && issuedCodes.has(code)) {
    issuedCodes.delete(code);
  }
  res.json({
    access_token: STATIC_TOKEN,
    token_type: "Bearer",
    expires_in: 31536000,
  });
});

app.use(
  "/",
  createProxyMiddleware({
    target: MCP_TARGET,
    changeOrigin: true,
    ws: true,
    proxyTimeout: 10000,
    timeout: 10000,
    on: {
      proxyReq: (proxyReq, req) => {
        log("proxying ->", MCP_TARGET, req.method, req.url);
      },
      error: (err, req, res) => {
        log("PROXY ERROR:", err.message);
        if (res.writeHead) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "Upstream MCP server unreachable", detail: err.message }),
          );
        }
      },
    },
  }),
);

log("=== SHIM STARTING ===");
log("node version:", process.version);
log("PORT env:", process.env.PORT);
log("cwd:", process.cwd());

app.listen(SHIM_PORT, "0.0.0.0", () => {
  log(`listening on 0.0.0.0:${SHIM_PORT}`);
  log(`proxying non-auth requests to ${MCP_TARGET}`);
});
