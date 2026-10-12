// Cloudflare Worker: public CORS proxy for TypeSafe SystemOne (Jev).
//
// Why: api.typesafe.ai rejects browser CORS preflights (HTTP 400, no
// Access-Control-Allow-Origin), so the Pages site cannot call Jev directly.
// This worker forwards the browser's POST (body + Authorization header) to
// https://api.typesafe.ai/v1/systemone and adds permissive CORS for our origins.
//
// The worker holds NO secrets: each visitor's own API key travels in their
// Authorization header and counts against their quota. Origin allowlist keeps
// random sites from borrowing the endpoint.
//
// Deploy (dashboard, ~5 min, free plan is plenty):
//   1. https://dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
//   2. Deploy the starter, then Edit code -> paste this file -> Save and Deploy
//   3. Copy the worker URL: https://<name>.<subdomain>.workers.dev
//   4. Set it as JEV_PUBLIC_PROXY in providers.js, bump ?v=, push.
//
// Test:
//   curl -X POST https://<name>.<subdomain>.workers.dev \
//     -H "Origin: https://wnoronha.github.io" \
//     -H "Authorization: Bearer $TYPESAFE_API_KEY" \
//     -H "Content-Type: application/json" \
//     -d '{"state":"hi","model":"jev-latest","questions":{"q":{"type":"noul","instructions":"Is this a greeting?"}}}'

const UPSTREAM = "https://api.typesafe.ai/v1/systemone";

// Update if the site moves; localhost entries are for local dev.
const ALLOWED_ORIGINS = [
  "https://wnoronha.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    // Preflight: answer even for unknown origins (browser enforces the rest).
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowed ? origin : ALLOWED_ORIGINS[0]) });
    }
    if (request.method !== "POST") {
      return new Response("POST only", { status: 405, headers: corsHeaders(ALLOWED_ORIGINS[0]) });
    }
    if (!allowed) {
      return new Response("origin not allowed", { status: 403, headers: corsHeaders(ALLOWED_ORIGINS[0]) });
    }
    const auth = request.headers.get("Authorization");
    if (!auth) {
      return new Response(JSON.stringify({ error: "missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
    }
    const body = await request.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > 256 * 1024) {
      return new Response(JSON.stringify({ error: "missing or oversized body" }),
        { status: 400, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
    }
    let upstream;
    try {
      upstream = await fetch(UPSTREAM, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "jev upstream unreachable: " + (e && e.message || e) }),
        { status: 502, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
    }
    const respBody = await upstream.arrayBuffer();
    return new Response(respBody, {
      status: upstream.status,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  },
};
