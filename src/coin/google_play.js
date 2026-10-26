// Google Play Developer API (androidpublisher v3) for in-app coin packs — no extra package: a service-account
// JWT (RS256, jsonwebtoken) → an OAuth token → plain fetch.
//   env GOOGLE_PLAY_SERVICE_ACCOUNT   the service account key JSON (the whole file, as one value)
//   env GOOGLE_PLAY_PACKAGE           com.bizhubcambodia.app (default)
// Tests replace `api` (module.exports.api = {...}) so nothing calls Google.
const jwt = require("jsonwebtoken");

const BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const pkg = () => process.env.GOOGLE_PLAY_PACKAGE || "com.bizhubcambodia.app";

function account() {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT || "";
  if (!raw.trim()) return null;
  try {
    const j = JSON.parse(raw);
    if (!j.client_email || !j.private_key) return null;
    return { email: j.client_email, key: String(j.private_key).replace(/\\n/g, "\n"), tokenUri: j.token_uri || "https://oauth2.googleapis.com/token" };
  } catch {
    return null;
  }
}
const ready = () => !!account();

let cached = null; // { token, until }
async function accessToken() {
  if (cached && cached.until > Date.now() + 60000) return cached.token;
  const a = account();
  if (!a) throw Object.assign(new Error("Google Play is not set up"), { code: "not_setup" });
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({ iss: a.email, scope: SCOPE, aud: a.tokenUri, iat: now, exp: now + 3600 }, a.key, { algorithm: "RS256" });
  const r = await fetch(a.tokenUri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error(`Google token: ${j.error_description || j.error || r.status}`), { code: "google_auth" });
  cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return cached.token;
}

async function call(method, path, query) {
  const url = `${BASE}/${encodeURIComponent(pkg())}${path}${query ? `?${new URLSearchParams(query)}` : ""}`;
  const r = await fetch(url, { method, headers: { authorization: `Bearer ${await accessToken()}` } });
  const text = await r.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = {};
  }
  if (!r.ok) throw Object.assign(new Error(`Google Play ${r.status}: ${j.error?.message || text.slice(0, 200)}`), { status: r.status, code: r.status === 404 || r.status === 400 ? "google_invalid" : "google_error" });
  return j;
}

const tokenPath = (productId, token) => `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;

// the swappable part (tests put fakes here)
const api = {
  // → { purchaseState 0 bought | 1 cancelled | 2 pending, consumptionState, acknowledgementState, orderId, purchaseTimeMillis, regionCode, obfuscatedExternalAccountId, quantity }
  getProduct: (productId, token) => call("GET", tokenPath(productId, token)),
  consume: (productId, token) => call("POST", `${tokenPath(productId, token)}:consume`),
  // refunds / chargebacks since startTime (ms). One page; returns { voidedPurchases: [...], tokenPagination: { nextPageToken } }
  voided: (startTime, pageToken) => call("GET", "/purchases/voidedpurchases", { startTime: String(startTime), type: "0", maxResults: "1000", ...(pageToken ? { token: pageToken } : {}) }),
};

module.exports = { api, ready, pkg };
