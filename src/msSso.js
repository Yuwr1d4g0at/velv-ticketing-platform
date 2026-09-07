// Microsoft 365 (Entra ID) single sign-on - shared by two separate flows on
// top of the same one app registration:
//   - Agent login (src/routes/auth.js), alongside the existing password
//     login kept as a fallback. Explicit allow-list: only logs in if the
//     email already matches an existing, active agent.
//   - Requester identification on the public request form
//     (src/routes/public.js), so a ticket's contact info is a verified
//     Velv identity instead of freely-typed text. Any successfully
//     authenticated velv.pt account is accepted here - there's no
//     allow-list for "who's allowed to submit a ticket".
// Both are off entirely unless MS_TENANT_ID, MS_CLIENT_ID, and
// MS_CLIENT_SECRET are all set.
//
// Uses openid-client v5.x deliberately, not the current v6 line - v6
// dropped CommonJS support (ESM-only), and this whole codebase is plain
// require()-based with no build step or ESM anywhere else.
const { Issuer, generators } = require("openid-client");

const CALLBACK_PATHS = {
  agent: "/auth/microsoft/callback",
  requester: "/auth/microsoft/requester/callback",
};

function isEnabled() {
  return Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

// Reuses the same APP_URL already used elsewhere (status-check links in
// emails, etc.) rather than a separate env var - one less thing to keep in
// sync, and it also has to be right for Entra's own redirect URI allowlist
// to match anyway. `kind` picks which of the two flows above this call is
// for - each needs its own redirect URI registered on the Entra app (see
// README) so Microsoft sends the browser back to the right callback route.
function redirectUri(kind) {
  const appUrl = (process.env.APP_URL || "").replace(/\/+$/, "");
  return `${appUrl}${CALLBACK_PATHS[kind]}`;
}

// Discovery (fetching Microsoft's own OpenID configuration document) is one
// real network call - made once and cached for the life of the process,
// not on every login attempt. One client, shared by both flows - the
// specific redirect_uri is passed per-call (to authorizationUrl/callback
// below), not fixed on the client itself, so a single client can drive
// either flow.
let clientPromise = null;
function getClient() {
  if (!isEnabled()) return Promise.reject(new Error("Microsoft SSO is not configured"));
  if (!clientPromise) {
    clientPromise = Issuer.discover(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/v2.0`).then(
      (issuer) =>
        new issuer.Client({
          client_id: process.env.MS_CLIENT_ID,
          client_secret: process.env.MS_CLIENT_SECRET,
          redirect_uris: [redirectUri("agent"), redirectUri("requester")],
          response_types: ["code"],
        })
    );
    // Don't leave a *rejected* promise cached - a transient discovery
    // failure (Microsoft hiccup, a typo'd tenant ID caught late) shouldn't
    // permanently wedge SSO for the rest of the process's lifetime; the
    // next attempt gets to try discovery again.
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

// Starts the flow: generates state/nonce/PKCE, stashes them on the session
// (round-trips via the session cookie while the browser is away at
// Microsoft - a plain top-level GET redirect back, which SameSite=Lax
// cookies allow), and returns the URL to send the browser to. `kind` is
// "agent" or "requester" - picks which redirect URI Microsoft sends the
// browser back to.
async function buildAuthUrl(req, kind) {
  const client = await getClient();
  const state = generators.state();
  const nonce = generators.nonce();
  const codeVerifier = generators.codeVerifier();

  req.session.msState = state;
  req.session.msNonce = nonce;
  req.session.msCodeVerifier = codeVerifier;

  return client.authorizationUrl({
    scope: "openid profile email",
    redirect_uri: redirectUri(kind),
    state,
    nonce,
    code_challenge: generators.codeChallenge(codeVerifier),
    code_challenge_method: "S256",
  });
}

// Completes the flow: validates state/nonce/PKCE, exchanges the code, and
// returns the signed-in Microsoft account's email + display name from the
// verified ID token. This module knows nothing about agents or requesters -
// the caller decides what an email means (an allow-list lookup for agent
// login, or just "this is who's filing the ticket" for the requester flow).
async function handleCallback(req, kind) {
  const client = await getClient();
  const params = client.callbackParams(req);
  const { msState, msNonce, msCodeVerifier } = req.session;
  // Cleared before the exchange (not after) so a stashed state/nonce/PKCE
  // set is single-use regardless of whether the exchange below succeeds or
  // throws - a retry always starts from a fresh buildAuthUrl() call.
  delete req.session.msState;
  delete req.session.msNonce;
  delete req.session.msCodeVerifier;

  const tokenSet = await client.callback(redirectUri(kind), params, {
    state: msState,
    nonce: msNonce,
    code_verifier: msCodeVerifier,
  });

  const claims = tokenSet.claims();
  const email = (claims.email || claims.preferred_username || "").toLowerCase();
  if (!email) throw new Error("Microsoft did not return an email address for this account");
  return { email, name: claims.name || email };
}

module.exports = { isEnabled, buildAuthUrl, handleCallback };
