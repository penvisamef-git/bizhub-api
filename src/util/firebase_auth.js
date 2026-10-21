// Phone numbers and emails checked by Google (Firebase Authentication).
// The web app signs in with Firebase (Google button, email link, or SMS code), then gives us Firebase's ID token.
// We check that token ourselves with Google's public keys — no service account / extra package:
//   signed by Google (RS256), for our project (FIREBASE_PROJECT_ID), not expired, signed in by phone
//   a short time ago (so an old token can't be reused).
// Tests: NODE_ENV=test + FIREBASE_TEST_TOKENS=1 accepts "test:+85512345678" and "test-email:a@b.co" (never in production).
const jwt = require("jsonwebtoken");

const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const MAX_AGE_SEC = 15 * 60; // the SMS sign-in must be this fresh

class PhoneTokenError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // not_configured | bad_token | expired | no_phone
  }
}

let certs = null;
let certsUntil = 0;
async function googleCerts(force) {
  if (!force && certs && Date.now() < certsUntil) return certs;
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw new Error(`Google keys: HTTP ${r.status}`);
  const age = Number((r.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1] || 3600);
  certs = await r.json();
  certsUntil = Date.now() + age * 1000;
  return certs;
}

const testMode = () => process.env.NODE_ENV === "test" && process.env.FIREBASE_TEST_TOKENS === "1";

// any Firebase sign-in → { uid, phone, email, email_verified, provider }   (throws PhoneTokenError)
async function verifyFirebaseToken(idToken) {
  const token = String(idToken || "");
  if (testMode() && token.startsWith("test:")) {
    const phone = token.slice(5);
    if (!/^\+\d{8,15}$/.test(phone)) throw new PhoneTokenError("no_phone");
    return { uid: `test-${phone}`, phone, email: "", email_verified: false, provider: "phone" };
  }
  if (testMode() && token.startsWith("test-email:")) {
    const email = token.slice(11).toLowerCase();
    return { uid: `test-${email}`, phone: "", email, email_verified: true, provider: "google.com" };
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new PhoneTokenError("not_configured");
  const head = jwt.decode(token, { complete: true });
  if (!head?.header?.kid || head.header.alg !== "RS256") throw new PhoneTokenError("bad_token");
  let cert = (await googleCerts())[head.header.kid];
  if (!cert) cert = (await googleCerts(true))[head.header.kid]; // Google rotated its keys
  if (!cert) throw new PhoneTokenError("bad_token");
  let p;
  try {
    p = jwt.verify(token, cert, { algorithms: ["RS256"], audience: projectId, issuer: `https://securetoken.google.com/${projectId}` });
  } catch (err) {
    throw new PhoneTokenError(err.name === "TokenExpiredError" ? "expired" : "bad_token");
  }
  if (!p.sub) throw new PhoneTokenError("bad_token");
  if (!p.auth_time || p.auth_time * 1000 < Date.now() - MAX_AGE_SEC * 1000) throw new PhoneTokenError("expired");
  return { uid: p.sub, phone: p.phone_number || "", email: String(p.email || "").toLowerCase(), email_verified: p.email_verified === true, provider: p.firebase?.sign_in_provider || "" };
}

// SMS sign-in → { phone, uid }
async function verifyPhoneToken(idToken) {
  const r = await verifyFirebaseToken(idToken);
  if (!r.phone) throw new PhoneTokenError("no_phone");
  return { phone: r.phone, uid: r.uid };
}

// "012 345 678", "+855 12 345 678", "85512345678", "0085512345678" → "+85512345678"
// (no country code = Cambodia). Returns "" when it can't be a phone number.
function normalizePhone(input, country = "855") {
  let s = String(input || "").replace(/[\s\-().]/g, "");
  if (!s) return "";
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (s.startsWith("+")) s = `+${s.slice(1).replace(/\D/g, "")}`;
  else if (/^\d+$/.test(s)) s = s.startsWith(country) && s.length > 10 ? `+${s}` : `+${country}${s.replace(/^0+/, "")}`;
  else return "";
  return /^\+\d{8,15}$/.test(s) ? s : "";
}

module.exports = { verifyFirebaseToken, verifyPhoneToken, normalizePhone, PhoneTokenError };
