// Microsoft Graph, app-only access (OAuth2 client-credentials grant) - a
// separate flow from src/msSso.js's user-facing sign-in. That flow proves
// "this browser is a specific signed-in person"; this one lets the app
// itself act as a background, no-user-involved caller - looking up a
// *requester's* directory profile (not the signed-in agent's own), fetching
// anyone's photo, or pulling a SharePoint list on a schedule.
//
// Needs Application permissions (User.Read.All, Sites.Read.All) granted
// with admin consent on the same Entra app registration SSO uses - see the
// "Microsoft 365 SSO" section in README.md. Off entirely unless
// MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET are set (same flag as SSO) -
// every exported function here degrades to returning null/throwing a
// caught error rather than the caller ever surfacing a broken page.
const GRAPH_TIMEOUT_MS = 5000;

function isEnabled() {
  return Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

// Cached in memory for the life of the process - app-only tokens are good
// for about an hour, so this avoids a token request on every single Graph
// call. Refreshed a minute before actual expiry, not exactly at it.
let tokenCache = null;
async function getAppToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const res = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
    }),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Could not get a Graph app-only token: ${res.status} ${await res.text()}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function graphFetch(path, options = {}) {
  const token = await getAppToken();
  return fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
}

// null covers both "this email isn't a real account in the tenant" (a 404 -
// perfectly normal, e.g. an external requester email) and any other Graph
// error - callers treat both the same way: show no enrichment, not a
// broken page.
async function fetchUserProfile(email) {
  const res = await graphFetch(`/users/${encodeURIComponent(email)}?$select=displayName,department,jobTitle,mobilePhone,businessPhones`);
  if (!res.ok) return null;
  const data = await res.json();
  return {
    displayName: data.displayName || null,
    department: data.department || null,
    jobTitle: data.jobTitle || null,
    phone: data.mobilePhone || (data.businessPhones && data.businessPhones[0]) || null,
  };
}

// A fixed 96x96 size - plenty for a small avatar next to a name, and a
// bounded, predictable size to cache as a BLOB (see src/directory.js).
// Most tenant members have no photo set at all - that's a plain 404, not
// an error.
async function fetchUserPhoto(email) {
  const res = await graphFetch(`/users/${encodeURIComponent(email)}/photos/96x96/$value`);
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

// Resolves a SharePoint site's numeric-ish Graph ID from its hostname +
// server-relative path, then a list on that site by its display name - two
// lookups, but each is cheap and only needed once per sync run (see
// src/assetSync.js), not per item.
async function resolveSiteId(hostname, sitePath) {
  const res = await graphFetch(`/sites/${hostname}:${sitePath}`);
  if (!res.ok) throw new Error(`Could not resolve SharePoint site ${hostname}${sitePath}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.id;
}

async function resolveListId(siteId, listDisplayName) {
  const res = await graphFetch(`/sites/${siteId}/lists?$filter=${encodeURIComponent(`displayName eq '${listDisplayName}'`)}`);
  if (!res.ok) throw new Error(`Could not look up lists on site ${siteId}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const list = data.value && data.value[0];
  if (!list) throw new Error(`No list named "${listDisplayName}" found on site ${siteId}`);
  return list.id;
}

// Every item's field values, following @odata.nextLink pagination - a
// hardware inventory list is a few hundred rows at most, comfortably fine
// to pull in full each sync run rather than tracking deltas.
async function fetchListItems(siteId, listId) {
  const items = [];
  let path = `/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=200`;
  while (path) {
    const res = await graphFetch(path);
    if (!res.ok) throw new Error(`Could not read list items: ${res.status} ${await res.text()}`);
    const data = await res.json();
    items.push(...data.value.map((item) => ({ id: item.id, fields: item.fields })));
    path = data["@odata.nextLink"] ? data["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null;
  }
  return items;
}

module.exports = { isEnabled, fetchUserProfile, fetchUserPhoto, resolveSiteId, resolveListId, fetchListItems };
