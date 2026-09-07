// Microsoft 365 (Entra ID) single sign-on for agent login, on top of the
// existing username+password login (kept as a fallback - see
// src/routes/auth.js). Off entirely unless MS_TENANT_ID, MS_CLIENT_ID, and
// MS_CLIENT_SECRET are all set - agents just see the plain password form,
// exactly as before, until an admin fills those in.
//
// Deliberately an "explicit allow-list" model, not auto-provisioning: a
// Microsoft account that authenticates successfully still has to match an
// existing, active row in the agents table by email (checked in
// src/routes/auth.js, not here) - the same account-creation path (the
// Agents page, or `npm run seed`) as password-based agents. Signing in with
// Microsoft never creates a new agent by itself.
//
// Uses openid-client v5.x deliberately, not the current v6 line - v6
// dropped CommonJS support (ESM-only), and this whole codebase is plain
// require()-based with no build step or ESM anywhere else.
const { Issuer, generators } = require("openid-client");

function isEnabled() {
  return Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

// Reuses the same APP_URL already used elsewhere (status-check links in
// emails, etc.) rather than a separate env var - one less thing to keep in
// sync, and it also has to be right for Entra's own redirect URI allowlist
// to match anyway.
function redirectUri() {
  const appUrl = (process.env.APP_URL || "").replace(/\/+$/, "");
  return `${appUrl}/auth/microsoft/callback`;
}

// Discovery (fetching Microsoft's own OpenID configuration document) is one
// real network call - made once and cached for the life of the process,
// not on every login attempt.
let clientPromise = null;
function getClient() {
  if (!isEnabled()) return Promise.reject(new Error("Microsoft SSO is not configured"));
  if (!clientPromise) {
    clientPromise = Issuer.discover(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/v2.0`).then(
      (issuer) =>
        new issuer.Client({
          client_id: process.env.MS_CLIENT_ID,
          client_secret: process.env.MS_CLIENT_SECRET,
          redirect_uris: [redirectUri()],
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
// cookies allow), and returns the URL to send the browser to.
async function buildAuthUrl(req) {
  const client = await getClient();
  const state = generators.state();
  const nonce = generators.nonce();
  const codeVerifier = generators.codeVerifier();

  req.session.msState = state;
  req.session.msNonce = nonce;
  req.session.msCodeVerifier = codeVerifier;

  return client.authorizationUrl({
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: generators.codeChallenge(codeVerifier),
    code_challenge_method: "S256",
  });
}

// Completes the flow: validates state/nonce/PKCE, exchanges the code, and
// returns the signed-in Microsoft account's email + display name from the
// verified ID token. This module knows nothing about the agents table -
// the caller (src/routes/auth.js) decides what an unrecognized email means.
async function handleCallback(req) {
  const client = await getClient();
  const params = client.callbackParams(req);
  const { msState, msNonce, msCodeVerifier } = req.session;
  // Cleared before the exchange (not after) so a stashed state/nonce/PKCE
  // set is single-use regardless of whether the exchange below succeeds or
  // throws - a retry always starts from a fresh buildAuthUrl() call.
  delete req.session.msState;
  delete req.session.msNonce;
  delete req.session.msCodeVerifier;

  const tokenSet = await client.callback(redirectUri(), params, {
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
