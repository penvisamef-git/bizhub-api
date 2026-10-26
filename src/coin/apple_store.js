// App Store (StoreKit 2) signed data, checked here without calling Apple and without any Apple key:
// every transaction and every App Store Server Notification is a JWS (ES256) whose x5c header carries the
// certificate chain leaf → Apple intermediate → Apple Root CA - G3. We check the chain up to the pinned Apple root,
// Apple's marker OIDs on the leaf / intermediate, the dates, and then the JWS signature with the leaf key.
//   env APPLE_BUNDLE_ID        com.bizhubcambodia.app (default)
//   env APPLE_IAP              "off" closes buying coins on iPhone (default open)
//   env APPLE_ALLOW_SANDBOX    "false" refuses sandbox purchases (default allowed: App Review and TestFlight pay
//                              with sandbox accounts, also against the production server)
// Tests replace `trust.roots` with their own root, so no real Apple data is needed.
const crypto = require("crypto");

const bundleId = () => (process.env.APPLE_BUNDLE_ID || "com.bizhubcambodia.app").trim();
const ready = () => String(process.env.APPLE_IAP || "").toLowerCase() !== "off";
const sandboxOk = () => String(process.env.APPLE_ALLOW_SANDBOX || "").toLowerCase() !== "false";

// Apple Root CA - G3 (https://www.apple.com/certificateauthority/AppleRootCA-G3.cer), valid until 30 Apr 2039
const APPLE_ROOT_G3 = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;
const APPLE_ROOT_G3_SHA256 = "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79";

// the trusted roots (sha256 fingerprints, "AA:BB:…"). Tests put their own here.
const trust = { roots: [APPLE_ROOT_G3_SHA256], markers: true };

// Apple's marker extensions: the leaf (App Store receipt signing) and the intermediate (WWDR)
const OID_LEAF = Buffer.from("060a2a864886f76364060b01", "hex"); // 1.2.840.113635.100.6.11.1
const OID_MID = Buffer.from("060a2a864886f76364060201", "hex"); // 1.2.840.113635.100.6.2.1

class AppleError extends Error {
  constructor(message) {
    super(message);
    this.code = "apple_invalid";
  }
}
const fail = (why) => {
  throw new AppleError(`App Store data refused: ${why}`);
};

const b64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const json = (buf, what) => {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return fail(`bad ${what}`);
  }
};
const validAt = (cert, at) => at >= new Date(cert.validFrom) && at <= new Date(cert.validTo);

// a JWS from StoreKit / the App Store → its payload (throws AppleError when anything is off)
function decode(jws) {
  const text = String(jws || "").trim();
  if (text.length < 100 || text.length > 20000) fail("size");
  const parts = text.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) fail("format");
  const header = json(b64url(parts[0]), "header");
  const payload = json(b64url(parts[1]), "payload");
  if (header.alg !== "ES256") fail("alg");
  if (!Array.isArray(header.x5c) || header.x5c.length < 3) fail("x5c");

  let chain;
  try {
    chain = header.x5c.slice(0, 3).map((c) => new crypto.X509Certificate(Buffer.from(c, "base64")));
  } catch {
    return fail("certificate");
  }
  const [leaf, mid, root] = chain;
  if (!trust.roots.includes(root.fingerprint256)) fail("root");
  if (!root.verify(root.publicKey) || !mid.verify(root.publicKey) || !leaf.verify(mid.publicKey)) fail("chain");
  if (!mid.ca || leaf.ca) fail("ca");
  if (trust.markers && (!leaf.raw.includes(OID_LEAF) || !mid.raw.includes(OID_MID))) fail("marker");
  // the certificates must have been valid when Apple signed (old purchases may be checked later)
  const signed = Number(payload.signedDate) ? new Date(Number(payload.signedDate)) : new Date();
  if (signed > new Date(Date.now() + 5 * 60000)) fail("date");
  if (!chain.every((c) => validAt(c, signed))) fail("expired");

  const ok = crypto.verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: leaf.publicKey, dsaEncoding: "ieee-p1363" }, b64url(parts[2]));
  if (!ok) fail("signature");
  return payload;
}

// a signed StoreKit 2 transaction → its fields, for this app only
function transaction(jws) {
  const t = decode(jws);
  if (t.bundleId !== bundleId()) fail("bundle");
  if (!t.transactionId || !t.productId) fail("fields");
  if (!["Production", "Sandbox"].includes(t.environment)) fail("environment");
  if (t.environment === "Sandbox" && !sandboxOk()) fail("sandbox");
  return t;
}

// a signed App Store Server Notification (V2) → { notificationType, subtype, environment, transaction | null }
function notification(signedPayload) {
  const n = decode(signedPayload);
  const d = n.data || {};
  if (d.bundleId && d.bundleId !== bundleId()) fail("bundle");
  let t = null;
  if (d.signedTransactionInfo) {
    t = decode(d.signedTransactionInfo);
    if (t.bundleId !== bundleId()) fail("bundle");
  }
  return { notificationType: n.notificationType, subtype: n.subtype || "", uuid: n.notificationUUID || "", environment: d.environment || t?.environment || "", transaction: t };
}

// the app passes this as appAccountToken (StoreKit wants a UUID), so a purchase belongs to the account that paid
function accountUuid(customerId) {
  const h = crypto.createHash("sha256").update(`bizhub-apple:${customerId}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5 style
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

module.exports = { decode, transaction, notification, accountUuid, ready, sandboxOk, bundleId, trust, AppleError, APPLE_ROOT_G3, APPLE_ROOT_G3_SHA256 };
