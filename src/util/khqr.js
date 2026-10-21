// KHQR (Cambodia's national QR, EMVCo) + Bakong payment check.
//   build({ bakongId, name, city, amount, currency, bill, store, expiresAt }) → { qr, md5 }   a dynamic QR with the exact amount
//   check(md5) → { paid, hash, from, to, amount, currency }   asks Bakong if that QR was paid
// .env: BAKONG_TOKEN (developer token from https://api-bakong.nbc.gov.kh, renewed every 90 days) · BAKONG_API (optional, default the NBC address)
const crypto = require("crypto");

const tlv = (id, v) => {
  const s = String(v);
  return `${id}${String(s.length).padStart(2, "0")}${s}`;
};
// CRC-16/CCITT-FALSE, as the KHQR spec asks
function crc16(str) {
  let crc = 0xffff;
  for (const b of Buffer.from(str, "utf8")) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
// names in the QR must be plain letters (banks show them on the payer's screen)
const ascii = (s, max) =>
  String(s || "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const isBakongId = (v) => /^[a-z0-9._-]{2,40}@[a-z0-9_]{2,20}$/i.test(String(v || "").trim());
const configured = () => !!process.env.BAKONG_TOKEN;

function build({ bakongId, name, city = "Phnom Penh", amount, currency = "USD", bill = "", store = "", expiresAt }) {
  if (!isBakongId(bakongId)) throw new Error("bad_bakong_id");
  const usd = currency !== "KHR";
  const amt = usd ? String(Math.round(Number(amount) * 100) / 100) : String(Math.round(Number(amount)));
  const now = Date.now();
  let s = tlv("00", "01") + tlv("01", "12") + tlv("29", tlv("00", String(bakongId).trim().toLowerCase())) + tlv("52", "5999") + tlv("53", usd ? "840" : "116") + tlv("54", amt) + tlv("58", "KH") + tlv("59", ascii(name, 25) || "BizHub") + tlv("60", ascii(city, 15) || "Phnom Penh");
  const extra = (bill ? tlv("01", ascii(bill, 25)) : "") + (store ? tlv("03", ascii(store, 25)) : "");
  if (extra) s += tlv("62", extra);
  s += tlv("99", tlv("00", String(now)) + tlv("01", String(new Date(expiresAt || now + 30 * 60000).getTime())));
  s += "6304";
  s += crc16(s);
  return { qr: s, md5: crypto.createHash("md5").update(s).digest("hex") };
}

async function check(md5) {
  if (!configured()) return { paid: false, error: "not_configured" };
  const base = (process.env.BAKONG_API || "https://api-bakong.nbc.gov.kh").replace(/\/+$/, "");
  let res;
  try {
    res = await fetch(`${base}/v1/check_transaction_by_md5`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.BAKONG_TOKEN}` }, body: JSON.stringify({ md5 }), signal: AbortSignal.timeout(8000) });
  } catch {
    return { paid: false, error: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) return { paid: false, error: "bad_token" };
  const j = await res.json().catch(() => ({}));
  if (j.responseCode === 0 && j.data) return { paid: true, hash: j.data.hash || "", from: j.data.fromAccountId || "", to: j.data.toAccountId || "", amount: Number(j.data.amount) || 0, currency: j.data.currency || "" };
  return { paid: false, error: j.errorCode ? `code_${j.errorCode}` : "" };
}

module.exports = { build, check, crc16, isBakongId, configured };
