// Minimal auto-approving OAuth2 shim for a local MCP server.
//
// Purpose: Hyperagent's "Bring my own OAuth app" form requires a real
// authorize + token endpoint. This server provides both, auto-approving
// every request (since you're the only user and you trust the client),
// then issues a static bearer token. Your actual MCP server doesn't need
// to validate this token at all — its job is just to satisfy Hyperagent's
// OAuth flow so it stops bailing out at "Failed to start MCP OAuth".
//
// Run this on a DIFFERENT port from your MCP server (e.g. 3334),
// then tunnel THIS port instead of 3333 directly. Requests to anything
// other than /authorize and /token get proxied straight through to your
// real MCP server on 3333.
//
// Usage:
//   npm install express
//   node server.js
//
// Then in Hyperagent's "Bring my own OAuth app":
//   URL:                    https://<tunnel-url-for-3334>/mcp
//   Authorization endpoint:  https://<tunnel-url-for-3334>/authorize
//   Token endpoint:          https://<tunnel-url-for-3334>/token
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

const SHIM_PORT = process.env.SHIM_PORT || 3334;
const MCP_TARGET = process.env.MCP_TARGET || "http://localhost:3333";
const STATIC_TOKEN = process.env.STATIC_TOKEN || "local-dev-static-token";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// In-memory map of issued auth codes -> just need to exist briefly
const issuedCodes = new Set();

// Helper: figure out our own public base URL from the incoming request.
// Works whether you're behind ngrok, Pinggy, cloudflared, etc., since they
// all forward the original Host (once host-header rewrite is configured).
function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  return `${proto}://${host}`;
}

// RFC 9728: Protected Resource Metadata.
// Tells clients which authorization server protects this resource (/mcp).
// Hyperagent (and other spec-compliant clients) fetch this BEFORE trying
// any manually-configured endpoints, so without this, discovery fails
// and the manual fields you typed in may never get used.
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const base = baseUrl(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
  });
});
app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
  const base = baseUrl(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
  });
});

// RFC 8414: Authorization Server Metadata.
// Tells clients exactly where /authorize and /token live, plus which
// flows are supported. This is what makes auto-discovery succeed.
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

// Step 1: Authorization endpoint.
// Hyperagent redirects the user's browser here. We skip any login/consent
// screen and immediately redirect back with a fixed authorization code.
app.get("/authorize", (req, res) => {
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

// Step 2: Token endpoint.
// Hyperagent exchanges the code (or does PKCE) for an access token here.
// We don't bother validating PKCE/client secret — just hand back the
// static token if a code was presented.
app.post("/token", (req, res) => {
  const { code } = req.body;

  if (!code || !issuedCodes.has(code)) {
    // Be lenient: some clients retry token exchange or use refresh flows.
    // For a single-user local setup, just issue the token anyway.
  } else {
    issuedCodes.delete(code);
  }

  res.json({
    access_token: STATIC_TOKEN,
    token_type: "Bearer",
    expires_in: 31536000, // 1 year, since this never really expires
  });
});

// Everything else (including /mcp) gets proxied straight through to your
// real MCP server. We don't bother checking the Authorization header here
// — the static token's only job is to make Hyperagent's OAuth flow succeed.
app.use(
  "/",
  createProxyMiddleware({
    target: MCP_TARGET,
    changeOrigin: true,
    ws: true,
  }),
);

app.listen(SHIM_PORT, () => {
  console.log(`OAuth shim listening on http://localhost:${SHIM_PORT}`);
  console.log(`Proxying non-auth requests to ${MCP_TARGET}`);
  console.log(`Authorize endpoint: http://localhost:${SHIM_PORT}/authorize`);
  console.log(`Token endpoint:     http://localhost:${SHIM_PORT}/token`);
});
