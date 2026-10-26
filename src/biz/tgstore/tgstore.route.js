// Telegram Store (v2.0, yearly 45 coins): a small shop that opens inside Telegram (the BizHub bot's button) or any browser
// (/t/<slug>). Customers pick products, choose delivery / pickup / table, pay with KHQR (the exact amount, checked with
// Bakong when the server has BAKONG_TOKEN; else a screenshot) or cash. Every order lands in the dashboard and in the shop's
// Telegram group with Accept · 15 min · Reject · Ready · On the way · Done · Paid buttons; the customer gets the updates
// from the bot when they allowed it.
//
// Owner base: /api/user/businesses/:id/tgstore
//   GET  ""                         everything the dashboard needs (store, license, counts, links, Telegram)
//   PUT  /settings                  name, phone, address, about, colour, currency, open, delivery, pickup, dine_in, pay
//   POST /logo  DELETE /logo
//   GET  /categories  POST /categories  PUT /categories/:cid  DELETE /categories/:cid  PUT /categories-order { ids }
//   GET  /products  POST /products  PUT /products/:pid  DELETE /products/:pid  POST /products/:pid/photo  DELETE /products/:pid/photo
//   GET  /orders?status=open|done|cancelled|all&page      GET /orders/:oid
//   POST /orders/:oid/status { status, eta, reason }       POST /orders/:oid/paid
//   GET  /customers?q&page
//   POST /telegram/link  POST /telegram/test  DELETE /telegram
// Public (customers; header x-tg-init-data inside Telegram):
//   GET  /api/public/tgstore/:slug                  the store: look, categories, products, how to get it, how to pay
//   GET  /api/public/tgstore/:slug/me               (Telegram) my saved phone / address + my last orders
//   POST /api/public/tgstore/:slug/orders           { items:[{ product_id, qty, options:[{ group, choice }], note }], mode, table, address, name, phone, note, pay }
//   GET  /api/public/tgstore/order/:token           follow one order (KHQR is checked here)
//   POST /api/public/tgstore/order/:token/proof     (multipart "photo") a screenshot of the payment
//   PUT  /api/public/tgstore/:slug/cart             (Telegram, add-on ts_remind) what is in the cart, for the reminder
//   POST /api/public/tgstore/:slug/fee              (add-on ts_zones) { pin } → the delivery fee for that place
// Telegram: /start st_<slug> → the "Open the store" button · /start ts_<code> → this chat gets the orders ·
//           buttons "tgo:<orderId>:<action>" in that chat · /start tr_<code> → the riders' group (add-on ts_riders),
//           buttons "tgr:<orderId>:take|picked|done|back" there
// Scheduler: tick() (called from /api/cron/daily-report) sends the cart reminders (add-on ts_remind)
const mongoose = require("mongoose");
const crypto = require("crypto");
const multer = require("multer");
const M = require("./tgstore.models");
const Business = require("../business.model");
const { bizOwner } = require("../team/team.access"); // team members (Admin / View only) open it too
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const { statusOf, buy, LicenseError, DAY } = require("../../license/license.service");
const { PRODUCTS } = require("../../license/license.products");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");
const { rate_limit } = require("../../util/rate_limit");
const cloud = require("../../util/cloudinary");
const khqr = require("../../util/khqr");
const telegram = require("../../telegram");

const PRODUCT = "tg_store";
const GRACE_DAYS = 7;
const TZ = 7;
const DEFAULT_SITE = "https://bizhub-cambodia.web.app";
const LIMITS = { products: 500, categories: 40, items: 40, qty: 99, options: 6, choices: 12, promos: 50, broadcastsPerDay: 3, broadcastReach: 500 };
// add-ons, paid with coins (license products); yearly ones end, the others are forever
const ADDONS = ["ts_promos", "ts_broadcast", "ts_reports", "ts_hours", "ts_nobrand", "ts_history", "ts_pay", "ts_link", "ts_remind", "ts_zones", "ts_riders"];
const HISTORY_DAYS = 60; // orders older than this need ts_history
const FREE_PAY = 3; // KHQR + Cash + 1 of the owner's own; more (and pictures) = ts_pay
const THEMES = require("./tgstore.themes");
const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ! / Server problem, please try again later.",
  badId: "មិនមាន ID ត្រឹមត្រូវ! / Wrong ID.",
  notFound: "រកមិនឃើញអាជីវកម្ម! / Business not found.",
  notStore: "អាជីវកម្មនេះមិនមែនជាហាង Telegram ទេ! / This business is not a Telegram Store.",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! / This business is suspended.",
  locked: "ហាង Telegram ផុតកំណត់ហើយ! សូមបន្ត។ / The Telegram Store year has ended. Please renew.",
  saved: "បានរក្សាទុក! / Saved.",
  deleted: "បានលុប! / Deleted.",
  badValue: "តម្លៃមិនត្រឹមត្រូវ! / Wrong value.",
  needName: "សូមបញ្ចូលឈ្មោះ! / Please type a name.",
  badPrice: "តម្លៃមិនត្រឹមត្រូវ! / Wrong price.",
  badImage: "សូមដាក់រូបភាព JPG / PNG / WEBP (តិចជាង 5MB)! / A JPG, PNG or WEBP picture under 5 MB, please.",
  noFile: "សូមជ្រើសរើសរូបភាព! / Choose a picture.",
  rowNotFound: "រកមិនឃើញ! / Not found.",
  tooMany: "ច្រើនពេក! / Too many.",
  badBakong: "Bakong ID មិនត្រឹមត្រូវ (ឧ. name@aba)! / Wrong Bakong ID (like name@aba).",
  closed: "ហាងបិទនៅពេលនេះ។ / The shop is closed right now.",
  storeOff: "ហាងនេះមិនដំណើរការទេ។ / This store is not open.",
  emptyCart: "កន្ត្រកទទេ! / The cart is empty.",
  soldOut: "{name} អស់ហើយ! / {name} is sold out.",
  notEnough: "{name} នៅសល់តែ {n}! / Only {n} {name} left.",
  needChoice: "សូមជ្រើស {group} សម្រាប់ {name}! / Choose {group} for {name}.",
  badMode: "ហាងនេះមិនមានជម្រើសនេះទេ! / The shop doesn't offer this.",
  needAddress: "សូមបញ្ចូលអាសយដ្ឋាន! / Please type the address.",
  needPhone: "សូមបញ្ចូលលេខទូរស័ព្ទ! / Please type your phone number.",
  needTable: "សូមជ្រើសលេខតុ! / Choose your table.",
  minOrder: "ការកម្ម៉ង់អប្បបរមា {amount}! / The smallest order is {amount}.",
  badPay: "វិធីបង់ប្រាក់នេះមិនមានទេ! / This way to pay isn't offered.",
  badStep: "មិនអាចប្តូរស្ថានភាពនេះបានទេ! / The order can't move to that step.",
  tgNotConfigured: "Telegram មិនទាន់រៀបចំនៅលើម៉ាសុីនមេ។ / Telegram isn't set up on the server.",
  tgBlocked: "Telegram៖ បុតត្រូវបានបិទ ឬដកចេញ។ សូមភ្ជាប់ម្តងទៀត។ / The bot was removed or blocked. Connect again.",
  tgUnreachable: "មិនអាចទាក់ទង Telegram បាន។ / Can't reach Telegram.",
  tgNotConnected: "មិនទាន់ភ្ជាប់ Telegram ទេ។ / Telegram isn't connected yet.",
  tgSent: "បានផ្ញើសារសាកល្បង! / Test message sent.",
  slow: "សូមរង់ចាំបន្តិច រួចព្យាយាមម្តងទៀត។ / Please wait a moment and try again.",
  orderGone: "រកមិនឃើញការកម្ម៉ង់! / Order not found.",
  needAddon: "សូមបើកមុខងារបន្ថែមនេះជាមុនសិន។ / Unlock this add-on first.",
  badPromo: "កូដបញ្ចុះតម្លៃមិនត្រឹមត្រូវ ឬផុតកំណត់! / This promo code doesn't work.",
  promoMin: "កូដនេះប្រើបានចាប់ពី {amount}! / This code works from {amount}.",
  promoTaken: "កូដនេះមានរួចហើយ! / You already have this code.",
  badCode: "កូដ៖ អក្សរ A–Z និងលេខ 3–20 ខ្ទង់! / Code: 3–20 letters A–Z and numbers.",
  badHours: "ម៉ោងមិនត្រឹមត្រូវ (ឧ. 07:00)! / Wrong time (like 07:00).",
  needText: "សូមសរសេរសារ! / Please write the message.",
  broadcastLimit: "អ្នកផ្ញើបាន {n} ដងក្នុងមួយថ្ងៃ។ សូមព្យាយាមថ្ងៃស្អែក។ / You can send {n} times a day. Try again tomorrow.",
  noReach: "មិនទាន់មានអតិថិជនដែលអនុញ្ញាតឲ្យផ្ញើសារទេ។ / No customers allowed messages yet.",
  broadcastSent: "បានផ្ញើទៅ {n} នាក់! / Sent to {n} people.",
  badTheme: "រចនានេះមិនមានទេ! / This design doesn't exist.",
  needTheme: "សូមទិញរចនានេះជាមុនសិន។ / Buy this design first.",
  payLimit: "បើក “វិធីបង់ប្រាក់បន្ថែម” ដើម្បីបន្ថែមទៀត។ / Unlock “More ways to pay” to add more.",
  payImage: "បើក “វិធីបង់ប្រាក់បន្ថែម” ដើម្បីដាក់រូប QR។ / Unlock “More ways to pay” to add a QR picture.",
  badSlug: "តំណ៖ អក្សរ a–z លេខ និង - (3–30)! / Link: 3–30 letters a–z, numbers and -.",
  slugTaken: "តំណនេះមានអ្នកប្រើហើយ! / This link is taken.",
  needArea: "សូមជ្រើសតំបន់ដឹកជញ្ជូន! / Choose your delivery area.",
  needPin: "សូមចែករំលែកទីតាំងរបស់អ្នក! / Please share your location.",
  badPin: "ទីតាំងមិនត្រឹមត្រូវ! / This location doesn't work.",
  tooFar: "ឆ្ងាយពេក — ហាងដឹកបានដល់ {km} គម។ / Too far — the shop delivers up to {km} km.",
  needShopPin: "សូមដាក់ទីតាំងហាងជាមុនសិន! / Set the shop's location first.",
  needSteps: "សូមបញ្ចូលតម្លៃដឹកយ៉ាងតិចមួយ! / Add at least one delivery price.",
  needAreas: "សូមបញ្ចូលតំបន់យ៉ាងតិចមួយ! / Add at least one area.",
  ridersSent: "បានផ្ញើទៅក្រុមអ្នកដឹក! / Sent to the riders.",
  ridersNotConnected: "មិនទាន់ភ្ជាប់ក្រុមអ្នកដឹកទេ។ / The riders' group isn't connected yet.",
  notDelivery: "មានតែការកម្ម៉ង់ដឹកជញ្ជូនប៉ុណ្ណោះ។ / Only delivery orders.",
};
class Bad extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
const validId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && String(v).length === 24;
const str = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
const int = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const token = (n = 20) => crypto.randomBytes(n * 2).toString("base64url").replace(/[-_]/g, "").slice(0, n);
const hexColor = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? String(v) : "");
const localDay = (d = new Date()) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 10);
const dayStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - TZ * 3600000);
// money: dollars with cents, riel whole
const money = (v, cur) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return cur === "KHR" ? Math.round(n) : Math.round(n * 100) / 100;
};
const fmtMoney = (v, cur) => (cur === "KHR" ? `${Math.round(v).toLocaleString("en-US")}៛` : `$${Number(v).toFixed(2)}`);
function phoneOf(v) {
  let d = String(v ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("855")) d = `0${d.slice(3)}`;
  if (!d.startsWith("0")) d = `0${d}`;
  return d.length >= 9 && d.length <= 11 ? d : null;
}
const slugBase = (name) =>
  String(name || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
const esc = telegram.escape;
// ---------- places (add-on ts_zones) ----------
// a pin from { lat, lng }, "11.55, 104.92" or a Google Maps link
function pinOf(v) {
  let lat;
  let lng;
  if (v && typeof v === "object") {
    lat = Number(v.lat);
    lng = Number(v.lng);
  } else {
    let t = String(v || "").slice(0, 600);
    try {
      t = decodeURIComponent(t);
    } catch {
      /* keep it as it is */
    }
    const m = /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/.exec(t) || /[?&](?:q|query|ll|destination)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/.exec(t) || /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/.exec(t);
    if (!m) return null;
    lat = Number(m[1]);
    lng = Number(m[2]);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}
// straight-line distance in km
function kmBetween(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return Math.round(12742 * Math.asin(Math.sqrt(h)) * 10) / 10;
}
const mapLink = (p) => `https://maps.google.com/?q=${p.lat},${p.lng}`;
const zonesOn = (s, addons) => !!(addons?.ts_zones?.active && s.zones?.on);
// the delivery fee for an area or a pin (before "free from"); throws when it can't be delivered
function zoneFee(s, { area, pin }) {
  const z = s.zones;
  if (z.kind === "area") {
    const a = validId(area) ? z.areas.find((x) => String(x._id) === String(area) && x.on) : null;
    if (!a) throw new Bad(MSG.needArea, 400, { code: "need_area" });
    return { fee: a.fee || 0, min_order: a.min_order || 0, zone: { name: a.name, km: null, ...(pin || {}) } };
  }
  if (!pin) throw new Bad(MSG.needPin, 400, { code: "need_pin" });
  if (z.lat === null || z.lng === null || z.lat === undefined) throw new Bad(MSG.badPin, 400, { code: "no_shop_pin" });
  const km = kmBetween({ lat: z.lat, lng: z.lng }, pin);
  const steps = [...(z.steps || [])].sort((a, b) => a.upto - b.upto);
  const step = steps.find((x) => km <= x.upto);
  if (!step) throw new Bad(fill(MSG.tooFar, { km: steps[steps.length - 1]?.upto || 0 }), 400, { code: "too_far", km, max_km: steps[steps.length - 1]?.upto || 0 });
  return { fee: step.fee || 0, min_order: 0, zone: { name: `${km} km`, km, ...pin } };
}
// what the customer sees about the zones
const zonesOut = (s, addons) =>
  zonesOn(s, addons)
    ? {
        kind: s.zones.kind,
        areas: s.zones.kind === "area" ? s.zones.areas.filter((a) => a.on).map((a) => ({ _id: a._id, name: a.name, fee: a.fee, min_order: a.min_order })) : [],
        steps: s.zones.kind === "distance" ? [...s.zones.steps].sort((a, b) => a.upto - b.upto).map((x) => ({ upto: x.upto, fee: x.fee })) : [],
      }
    : null;
const siteOf = (s) => String(s?.web || process.env.WEB_URL || DEFAULT_SITE).replace(/\/+$/, "");

// ---------- Telegram Mini App: check who opened the store (the init data Telegram signs with the bot token) ----------
function tgUser(initData) {
  const raw = String(initData || "");
  const bot = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!raw || !bot || raw.length > 4096) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(bot).digest();
  const mine = crypto.createHmac("sha256", secret).update(check).digest("hex");
  if (mine.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(hash))) return null;
  const age = Date.now() / 1000 - Number(params.get("auth_date") || 0);
  if (!(age >= -300 && age < 86400)) return null; // signed more than a day ago
  try {
    const u = JSON.parse(params.get("user") || "{}");
    if (!u?.id) return null;
    return {
      tg_id: String(u.id),
      name: [u.first_name, u.last_name].filter(Boolean).join(" ").slice(0, 80),
      username: String(u.username || "").slice(0, 40),
      can_message: !!u.allows_write_to_pm,
    };
  } catch {
    return null;
  }
}

async function licenseState(businessId) {
  const main = await License.findOne({ business_id: businessId, product: PRODUCT, item: { $in: ["", null] } }).lean();
  const license = statusOf(main);
  const endedAt = license.expires_at ? new Date(license.expires_at).getTime() : null;
  license.grace_until = endedAt ? new Date(endedAt + GRACE_DAYS * DAY) : null;
  license.locked = !main || (!license.active && endedAt !== null && Date.now() > endedAt + GRACE_DAYS * DAY);
  license.read_only = !license.active; // after the year: look only; the store stays open to customers for the grace days
  return license;
}
async function addonsOf(businessId) {
  const rows = await License.find({ business_id: businessId, product: { $in: ADDONS }, item: { $in: ["", null] } }).lean();
  const out = {};
  for (const key of ADDONS) out[key] = statusOf(rows.find((r) => r.product === key));
  return out;
}
async function themesOf(businessId) {
  const rows = await License.find({ business_id: businessId, product: "ts_theme", item: { $nin: ["", null] } }).lean();
  return [...THEMES.FREE, ...rows.filter((r) => statusOf(r).active).map((r) => r.item)];
}
const needAddon = (ctx, key) => {
  if (!ctx.addons?.[key]?.active) throw new Bad(MSG.needAddon, 402, { product: key, code: "addon" });
};

// ---------- opening hours (add-on ts_hours), Cambodia time ----------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
function hoursNow(hours, at = new Date()) {
  const local = new Date(at.getTime() + TZ * 3600000);
  const day = local.getUTCDay();
  const now = local.getUTCHours() * 60 + local.getUTCMinutes();
  const days = hours?.days?.length === 7 ? hours.days : [];
  const inDay = (d, m) => {
    if (!d || d.closed) return false;
    const o = minOf(d.open);
    const c = minOf(d.close);
    return c > o ? m >= o && m < c : m >= o; // closes past midnight: the part before midnight
  };
  const lateFromYesterday = (m) => {
    const y = days[(day + 6) % 7];
    return !!y && !y.closed && minOf(y.close) <= minOf(y.open) && m < minOf(y.close);
  };
  const open = inDay(days[day], now) || lateFromYesterday(now);
  let next = null; // when it opens next
  if (!open)
    for (let i = 0; i < 8 && !next; i += 1) {
      const d = days[(day + i) % 7];
      if (d && !d.closed && (i > 0 || minOf(d.open) > now)) next = { in_days: i, day: (day + i) % 7, time: d.open };
    }
  return { open, next };
}
// open for orders right now: the switch, the year, and the hours (when the add-on is on)
function openNow(s, license, addons) {
  if (!s.open || license.read_only) return { open: false, next: null };
  if (!(addons?.ts_hours?.active && s.hours?.on)) return { open: true, next: null };
  return hoursNow(s.hours);
}
const hoursOut = (s, addons) => (addons?.ts_hours?.active && s.hours?.on ? { days: (s.hours.days || []).map((d) => ({ open: d.open, close: d.close, closed: !!d.closed })) } : null);

// ---------- promo codes (add-on ts_promos) ----------
const codeOf = (v) =>
  String(v || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
const promoOut = (p) => ({ _id: p._id, code: p.code, kind: p.kind, value: p.value, min_order: p.min_order, ends_at: p.ends_at, max_uses: p.max_uses, used: p.used, on: p.on });
// how much a code takes off this subtotal (throws when it can't be used)
async function promoFor(s, code, subtotal) {
  const p = await M.TgPromo.findOne({ business_id: s.business_id, code: codeOf(code), deleted: false }).lean();
  if (!p || !p.on || (p.ends_at && new Date(p.ends_at) < new Date()) || (p.max_uses && p.used >= p.max_uses)) throw new Bad(MSG.badPromo, 400, { code: "bad_promo" });
  if (p.min_order && subtotal < p.min_order) throw new Bad(fill(MSG.promoMin, { amount: fmtMoney(p.min_order, s.currency) }), 400, { code: "promo_min" });
  const off = p.kind === "percent" ? money((subtotal * Math.min(100, p.value)) / 100, s.currency) : money(Math.min(p.value, subtotal), s.currency);
  return { promo: p, off: Math.min(off, subtotal) };
}

async function freeSlug(name) {
  const base = slugBase(name) || "shop";
  for (let i = 0; i < 20; i += 1) {
    const s = i === 0 ? base : `${base}-${token(4).toLowerCase()}`;
    if (!(await M.TgStore.exists({ slug: s }))) return s;
  }
  return `${base}-${Date.now().toString(36)}`;
}
async function storeOf(business) {
  const found = await M.TgStore.findOne({ business_id: business._id });
  if (found) return found;
  try {
    return await M.TgStore.create({ business_id: business._id, shop_name: business.name || "", phone: business.phone || "", address: business.address || "", slug: await freeSlug(business.name) });
  } catch (err) {
    if (err.code === 11000) return M.TgStore.findOne({ business_id: business._id });
    throw err;
  }
}

// ---------- what goes out ----------
const storeOut = (s) => {
  const o = s.toObject ? s.toObject() : { ...s };
  const tg = { connected: !!o.tg?.chat_id, chat_name: o.tg?.chat_name || "" };
  delete o.tg;
  o.riders = { connected: !!o.riders?.chat_id, chat_name: o.riders?.chat_name || "", send_on: o.riders?.send_on || "accepted" };
  delete o.seq;
  const pay = { ...o.pay, custom: (o.pay?.custom || []).map((m) => ({ _id: m._id, name: m.name, info: m.info, image: m.image?.url || "", on: m.on })) };
  return { ...o, pay, logo: o.logo?.url || "", tg };
};
const categoryOut = (c) => ({ _id: c._id, name: c.name, name_km: c.name_km, sort: c.sort });
const productOut = (p) => ({
  _id: p._id,
  category_id: p.category_id,
  name: p.name,
  name_km: p.name_km,
  about: p.about,
  price: p.price,
  photo: p.photo?.url || "",
  options: (p.options || []).map((g) => ({ name: g.name, multi: !!g.multi, required: !!g.required, choices: (g.choices || []).map((c) => ({ name: c.name, price: c.price || 0 })) })),
  stock: p.stock ?? null,
  sold_out: !!p.sold_out || p.stock === 0,
  hidden: !!p.hidden,
  sort: p.sort || 0,
});
const orderOut = (o, full = false) => ({
  _id: o._id,
  no: o.no,
  mode: o.mode,
  table: o.table,
  address: o.address,
  note: o.note,
  customer: o.customer,
  items: o.items,
  subtotal: o.subtotal,
  discount: o.discount || 0,
  promo: o.promo || "",
  fee: o.fee,
  total: o.total,
  currency: o.currency,
  pay: { method: o.pay?.method, status: o.pay?.status, proof: o.pay?.proof?.url || "", paid_at: o.pay?.paid_at || null, custom: o.pay?.method === "custom" ? { name: o.pay.custom?.name || "", info: o.pay.custom?.info || "", image: o.pay.custom?.image || "" } : null },
  status: o.status,
  eta_min: o.eta_min,
  reason: o.reason,
  timeline: o.timeline,
  via: o.via,
  zone: o.zone?.name || o.zone?.lat ? { name: o.zone.name || "", km: o.zone.km ?? null, lat: o.zone.lat ?? null, lng: o.zone.lng ?? null } : null,
  rider: o.rider?.tg_id ? { name: o.rider.name || "", username: o.rider.username || "", taken_at: o.rider.taken_at || null, picked_at: o.rider.picked_at || null, delivered_at: o.rider.delivered_at || null } : null,
  riders_sent: !!o.rider_msg?.message_id,
  from_remind: !!o.from_remind,
  created_date: o.created_date,
  ...(full ? { token: o.token } : {}),
});
// what the customer sees about the shop
const lookOut = (s) => ({
  slug: s.slug,
  name: s.shop_name,
  phone: s.phone,
  address: s.address,
  about: s.about,
  logo: s.logo?.url || "",
  color: hexColor(s.color) || "",
  currency: s.currency,
  open: !!s.open,
  delivery: s.delivery?.on ? { fee: s.delivery.fee || 0, free_from: s.delivery.free_from || 0, min_order: s.delivery.min_order || 0, note: s.delivery.note || "" } : null,
  pickup: s.pickup?.on ? { note: s.pickup.note || "" } : null,
  dine_in: s.dine_in?.on ? { tables: s.dine_in.tables || 10 } : null,
  pay: {
    khqr: !!(s.pay?.khqr?.on && khqr.isBakongId(s.pay.khqr.bakong_id)),
    cash: !!s.pay?.cash?.on,
    custom: (s.pay?.custom || []).filter((m) => m.on).map((m) => ({ _id: m._id, name: m.name, info: m.info, image: m.image?.url || "" })),
  },
  theme: THEMES.KEYS.includes(s.theme) ? s.theme : THEMES.DEFAULT,
});

// ---------- Telegram messages ----------
const STEP = {
  new: { en: "New", km: "ថ្មី", icon: "🆕" },
  accepted: { en: "Accepted", km: "បានទទួល", icon: "✅" },
  ready: { en: "Ready", km: "រួចរាល់", icon: "🍽" },
  on_way: { en: "On the way", km: "កំពុងដឹក", icon: "🛵" },
  done: { en: "Done", km: "រួចរាល់", icon: "🎉" },
  cancelled: { en: "Cancelled", km: "បានបោះបង់", icon: "❌" },
};
const MODE = { delivery: "🛵 Delivery · ដឹកជញ្ជូន", pickup: "🛍 Pickup · មកយក", dine_in: "🍽 Table · តុ" };
const PAY = { unpaid: "⏳ not paid yet · មិនទាន់បង់", proof: "🧾 screenshot sent · បានផ្ញើរូបថត", paid: "💰 PAID · បានបង់" };
function groupText(s, o) {
  const cur = o.currency;
  const lines = [
    `${STEP[o.status].icon} <b>#${o.no}</b> · ${MODE[o.mode]}${o.mode === "dine_in" && o.table ? ` ${esc(o.table)}` : ""} · <b>${STEP[o.status].en} · ${STEP[o.status].km}</b>${o.eta_min && ["accepted"].includes(o.status) ? ` · ~${o.eta_min} min` : ""}`,
    "",
    ...o.items.map((l) => `${l.qty} × ${esc(l.name)}${l.options?.length ? ` (${esc(l.options.map((x) => x.choice).join(", "))})` : ""}${l.note ? ` — <i>${esc(l.note)}</i>` : ""}  ${fmtMoney(l.total, cur)}`),
  ];
  if (o.discount) lines.push(`🏷 ${esc(o.promo)} −${fmtMoney(o.discount, cur)}`);
  if (o.fee) lines.push(`Delivery · ដឹក ${fmtMoney(o.fee, cur)}`);
  lines.push(`<b>Total · សរុប ${fmtMoney(o.total, cur)}</b> · ${o.pay.method === "khqr" ? "KHQR" : o.pay.method === "custom" ? esc(o.pay.custom?.name || "") : "Cash · សាច់ប្រាក់"} · ${PAY[o.pay.status]}`, "");
  const who = [o.customer?.name && `<b>${esc(o.customer.name)}</b>`, o.customer?.phone && esc(o.customer.phone), o.customer?.username && `@${esc(o.customer.username)}`].filter(Boolean).join(" · ");
  if (who) lines.push(`👤 ${who}`);
  if (o.mode === "delivery" && o.address) lines.push(`📍 ${esc(o.address)}`);
  if (o.mode === "delivery") lines.push(...placeLines(o));
  if (o.rider?.tg_id) lines.push(`🛵 ${esc(o.rider.name || "Rider")}${o.rider.username ? ` @${esc(o.rider.username)}` : ""} · ${o.rider.delivered_at ? "delivered · ដឹករួច" : o.rider.picked_at ? "on the way · កំពុងដឹក" : "took it · បានយក"}`);
  if (o.note) lines.push(`📝 ${esc(o.note)}`);
  if (o.status === "cancelled" && o.reason) lines.push(`❌ ${esc(o.reason)}`);
  const last = o.timeline?.[o.timeline.length - 1];
  if (last?.by && o.status !== "new") lines.push(`<i>${esc(last.by)}</i>`);
  lines.push(`<i>${esc(s.shop_name)}</i>`);
  return lines.join("\n");
}
// the delivery area / distance + the map pin
function placeLines(o) {
  const out = [];
  const z = o.zone || {};
  const where = [z.name && !/ km$/.test(z.name) ? esc(z.name) : "", z.km !== null && z.km !== undefined ? `${z.km} km` : ""].filter(Boolean).join(" · ");
  if (where || z.lat) out.push(`🗺 ${where}${z.lat !== null && z.lat !== undefined ? `${where ? " · " : ""}<a href="${mapLink(z)}">Map · ផែនទី</a>` : ""}`);
  return out;
}
function groupKeys(o, { riders } = {}) {
  const b = (text, act) => ({ text, callback_data: `tgo:${o._id}:${act}` });
  const rows = [];
  if (riders && o.mode === "delivery" && ["accepted", "ready"].includes(o.status) && !o.rider_msg?.message_id) rows.push([b("🛵 Send to riders · ផ្ញើទៅអ្នកដឹក", "riders")]);
  if (o.status === "new") rows.push([b("✅ Accept · ទទួល", "accept"), b("⏱ 15 min", "eta15"), b("⏱ 30 min", "eta30")], [b("❌ Reject · បដិសេធ", "reject")]);
  else if (o.status === "accepted") rows.push(o.mode === "delivery" ? [b("🛵 On the way · ដឹក", "on_way"), b("🎉 Done", "done")] : [b("🍽 Ready · រួចរាល់", "ready"), b("🎉 Done", "done")]);
  else if (o.status === "ready") rows.push([b("🎉 Done · រួចរាល់", "done")]);
  else if (o.status === "on_way") rows.push([b("🎉 Delivered · ដឹករួច", "done")]);
  if (!["done", "cancelled"].includes(o.status) && o.pay.status !== "paid") rows.push([b("💰 Paid · បានបង់", "paid")]);
  return rows.length ? telegram.keyboard(rows) : { reply_markup: { inline_keyboard: [] } };
}
// put the order in the staff group, or change the message already there
async function postToGroup(s, o) {
  const chat = s.tg?.chat_id;
  if (!chat || !telegram.ready()) return;
  const keys = groupKeys(o, { riders: !!s.riders?.chat_id && (await addonsOf(s.business_id)).ts_riders.active });
  try {
    if (o.tg_msg?.message_id && o.tg_msg.chat_id === chat) {
      await telegram.editText(chat, o.tg_msg.message_id, groupText(s, o), keys).catch((err) => {
        if (!/not modified/i.test(err.message)) throw err;
      });
    } else {
      const m = await telegram.send(chat, groupText(s, o), keys);
      o.tg_msg = { chat_id: chat, message_id: m.message_id };
      await M.TgOrder.updateOne({ _id: o._id }, { $set: { tg_msg: o.tg_msg } });
    }
  } catch (err) {
    if (err instanceof telegram.TelegramError && err.message === "blocked") await M.TgStore.updateOne({ _id: s._id }, { $set: { "tg.chat_id": "", "tg.chat_name": "" } });
  }
}
// ---------- the riders' group (add-on ts_riders) ----------
const RIDER_STEP = {
  wait: "🙋 Waiting for a rider · រង់ចាំអ្នកដឹក",
  taken: "✋ Taken · បានយក",
  picked: "🛵 On the way · កំពុងដឹក",
  done: "🎉 Delivered · ដឹករួច",
  cancelled: "❌ Cancelled · បានបោះបង់",
};
function riderStep(o) {
  if (o.status === "cancelled") return "cancelled";
  if (o.rider?.delivered_at || o.status === "done") return "done";
  if (o.rider?.picked_at) return "picked";
  if (o.rider?.tg_id) return "taken";
  return "wait";
}
function riderText(s, o) {
  const cur = o.currency;
  const step = riderStep(o);
  const lines = [`🛵 <b>#${o.no}</b> · ${esc(s.shop_name)} · <b>${RIDER_STEP[step]}</b>`, ""];
  if (o.address) lines.push(`📍 ${esc(o.address)}`);
  lines.push(...placeLines(o));
  const who = [o.customer?.name && `<b>${esc(o.customer.name)}</b>`, o.customer?.phone && esc(o.customer.phone), o.customer?.username && `@${esc(o.customer.username)}`].filter(Boolean).join(" · ");
  if (who) lines.push(`👤 ${who}`);
  lines.push(`🧾 ${o.items.reduce((a, l) => a + l.qty, 0)} items · ទំនិញ · Total · សរុប ${fmtMoney(o.total, cur)}`);
  lines.push(o.pay?.status === "paid" ? "✅ Paid already · បានបង់រួច" : `💵 Collect · ប្រមូល <b>${fmtMoney(o.total, cur)}</b>`);
  if (o.fee) lines.push(`🛵 Delivery fee · ថ្លៃដឹក ${fmtMoney(o.fee, cur)}`);
  if (o.note) lines.push(`📝 ${esc(o.note)}`);
  if (o.rider?.tg_id) lines.push("", `<i>${esc(o.rider.name || "Rider")}${o.rider.username ? ` @${esc(o.rider.username)}` : ""}</i>`);
  return lines.join("\n");
}
function riderKeys(o) {
  const b = (text, act) => ({ text, callback_data: `tgr:${o._id}:${act}` });
  const step = riderStep(o);
  if (step === "wait") return telegram.keyboard([[b("🙋 Take it · យក", "take")]]);
  if (step === "taken") return telegram.keyboard([[b("📦 Picked up · បានយក", "picked")], [b("↩️ Give back · ប្រគល់វិញ", "back")]]);
  if (step === "picked") return telegram.keyboard([[b("🎉 Delivered · ដឹករួច", "done")]]);
  return { reply_markup: { inline_keyboard: [] } };
}
// put the order in the riders' group (send = a new message when there is none yet), or change the one there
async function postToRiders(s, o, send = false) {
  const chat = s.riders?.chat_id;
  if (!chat || !telegram.ready() || o.mode !== "delivery") return false;
  try {
    if (o.rider_msg?.message_id && o.rider_msg.chat_id === chat) {
      await telegram.editText(chat, o.rider_msg.message_id, riderText(s, o), riderKeys(o)).catch((err) => {
        if (!/not modified/i.test(err.message)) throw err;
      });
      return true;
    }
    if (!send) return false;
    const m = await telegram.send(chat, riderText(s, o), riderKeys(o));
    o.rider_msg = { chat_id: chat, message_id: m.message_id };
    await M.TgOrder.updateOne({ _id: o._id }, { $set: { rider_msg: o.rider_msg } });
    return true;
  } catch (err) {
    if (err instanceof telegram.TelegramError && err.message === "blocked") await M.TgStore.updateOne({ _id: s._id }, { $set: { "riders.chat_id": "", "riders.chat_name": "" } });
    return false;
  }
}

// the customer's own chat with the bot (only when they allowed messages)
async function tellCustomer(s, o, text, more = []) {
  if (!o.customer?.tg_id || !telegram.ready() || !o.customer_id) return;
  const c = await M.TgCustomer.findById(o.customer_id).select("can_message").lean();
  if (!c?.can_message) return;
  const link = `${siteOf(s)}/t/o/${o.token}`;
  await telegram
    .send(o.customer.tg_id, `<b>${esc(s.shop_name)}</b> · #${o.no}\n${text}`, telegram.keyboard([[{ text: "🧾 Order · ការកម្ម៉ង់", web_app: { url: link } }], ...more]))
    .catch(async (err) => {
      if (err instanceof telegram.TelegramError && err.message === "blocked") await M.TgCustomer.updateOne({ _id: o.customer_id }, { $set: { can_message: false } });
    });
}
const CUSTOMER_TEXT = {
  accepted: (o) => `✅ The shop accepted your order${o.eta_min ? ` · about ${o.eta_min} min` : ""}.\nហាងបានទទួលការកម្ម៉ង់របស់អ្នក${o.eta_min ? ` · ប្រហែល ${o.eta_min} នាទី` : ""}។`,
  ready: () => "🍽 Your order is ready.\nការកម្ម៉ង់របស់អ្នករួចរាល់ហើយ។",
  on_way: (o) => (o.rider?.name ? `🛵 ${o.rider.name} is bringing your order.\n${o.rider.name} កំពុងដឹកការកម្ម៉ង់របស់អ្នកមក។` : "🛵 Your order is on the way.\nការកម្ម៉ង់របស់អ្នកកំពុងដឹកមក។"),
  taken: (o) => `🙋 ${o.rider?.name || "A rider"} will bring your order.\n${o.rider?.name || "អ្នកដឹក"} នឹងដឹកការកម្ម៉ង់របស់អ្នក។`,
  done: () => "🎉 Done — thank you!\nរួចរាល់ — សូមអរគុណ!",
  cancelled: (o) => `❌ The shop cancelled your order${o.reason ? `: ${o.reason}` : ""}.\nហាងបានបោះបង់ការកម្ម៉ង់របស់អ្នក។`,
  paid: () => "💰 Payment received.\nបានទទួលការបង់ប្រាក់។",
};

// ---------- order steps (dashboard + group buttons) ----------
const NEXT = { new: ["accepted", "cancelled"], accepted: ["ready", "on_way", "done", "cancelled"], ready: ["on_way", "done", "cancelled"], on_way: ["done", "cancelled"], done: [], cancelled: [] };
async function giveBackStock(o) {
  for (const l of o.items) if (l.product_id) await M.TgProduct.updateOne({ _id: l.product_id, stock: { $ne: null } }, { $inc: { stock: l.qty } });
}
async function moveOrder(s, o, status, by, { eta, reason } = {}) {
  if (!NEXT[o.status]?.includes(status)) throw new Bad(MSG.badStep, 409, { code: "bad_step" });
  const set = { status };
  if (eta !== undefined) set.eta_min = int(eta, 0, 600, 0);
  if (status === "cancelled") set.reason = str(reason, 160);
  const after = await M.TgOrder.findOneAndUpdate({ _id: o._id, status: o.status }, { $set: set, $push: { timeline: { status, at: new Date(), by: str(by, 60) } } }, { returnDocument: "after" });
  if (!after) throw new Bad(MSG.badStep, 409, { code: "changed" });
  if (status === "cancelled") await giveBackStock(after);
  if (status === "done" && after.customer_id) await M.TgCustomer.updateOne({ _id: after.customer_id }, { $inc: { orders: 1, spent: after.total }, $set: { last_order_at: after.created_date } });
  const addons = await addonsOf(s.business_id);
  // the riders' group: send it when the shop says so (accepted / ready), and keep the message there up to date
  if (addons.ts_riders.active && after.mode === "delivery") {
    const sendNow = s.riders?.send_on === status && !after.rider_msg?.message_id;
    await postToRiders(s, after, sendNow);
  } else if (after.rider_msg?.message_id) await postToRiders(s, after);
  await postToGroup(s, after);
  // done: "Order again" under the message (add-on ts_remind)
  const again = status === "done" && addons.ts_remind.active ? [[{ text: "🔁 Order again · កម្ម៉ង់ម្តងទៀត", web_app: { url: `${siteOf(s)}/t/${s.slug}?again=${after.token}` } }]] : [];
  await tellCustomer(s, after, CUSTOMER_TEXT[status](after), again);
  return after;
}
async function markPaid(s, o, by) {
  if (o.pay?.status === "paid") return o;
  const after = await M.TgOrder.findOneAndUpdate(
    { _id: o._id, "pay.status": { $ne: "paid" } },
    { $set: { "pay.status": "paid", "pay.paid_at": new Date() }, $push: { timeline: { status: "paid", at: new Date(), by: str(by, 60) } } },
    { returnDocument: "after" },
  );
  if (!after) return M.TgOrder.findById(o._id);
  await postToGroup(s, after);
  if (after.rider_msg?.message_id) await postToRiders(s, after);
  await tellCustomer(s, after, CUSTOMER_TEXT.paid());
  return after;
}

// ---------- cart reminders (add-on ts_remind), from the scheduler ----------
const REMIND_TEXT = "🛒 <b>{shop}</b>\nYou left {n} in your cart. Tap to finish your order.\nអ្នកនៅមានទំនិញ {n} ក្នុងកន្ត្រក។ ចុចដើម្បីបញ្ចប់ការកម្ម៉ង់។";
async function tick() {
  if (!telegram.ready()) return { carts: 0, sent: 0 };
  const now = Date.now();
  const rows = await M.TgCart.find({ reminded_at: null, "items.0": { $exists: true }, at: { $lte: new Date(now - 15 * 60000), $gte: new Date(now - 24 * 3600000) } })
    .sort({ at: 1 })
    .limit(300);
  const shops = new Map(); // business → { s, ok } (checked once per run)
  let sent = 0;
  for (const c of rows) {
    const key = String(c.business_id);
    if (!shops.has(key)) {
      const s = await M.TgStore.findOne({ business_id: c.business_id });
      const [license, addons, business] = s ? await Promise.all([licenseState(c.business_id), addonsOf(c.business_id), Business.findOne({ _id: c.business_id, deleted: false }).select("status").lean()]) : [];
      shops.set(key, { s, ok: !!(s && business?.status && !license.locked && addons.ts_remind.active && s.remind?.on), open: !!s && openNow(s, license, addons).open });
    }
    const { s, ok, open } = shops.get(key);
    if (!ok) {
      c.reminded_at = new Date(); // the add-on is off: never remind this cart
      await c.save();
      continue;
    }
    if (now - c.at.getTime() < (s.remind.after_min || 60) * 60000 || !open) continue; // not yet / the shop is closed: later
    const cust = await M.TgCustomer.findOne({ business_id: c.business_id, tg_id: c.tg_id }).select("can_message").lean();
    c.reminded_at = new Date();
    if (c.can_message || cust?.can_message) {
      const n = c.items.reduce((a, l) => a + (l.qty || 1), 0);
      const what = `${n} ${n === 1 ? "item" : "items"}`;
      const text = s.remind.text ? `🛒 <b>${esc(s.shop_name)}</b>\n${esc(fill(s.remind.text, { name: c.name || "", shop: s.shop_name, n }))}` : fill(REMIND_TEXT, { shop: esc(s.shop_name), n: what });
      const ok2 = await telegram
        .send(c.tg_id, text, telegram.keyboard([[{ text: "🛒 Finish my order · បញ្ចប់ការកម្ម៉ង់", web_app: { url: `${siteOf(s)}/t/${s.slug}` } }]]))
        .then(() => true)
        .catch(async (err) => {
          if (err instanceof telegram.TelegramError && err.message === "blocked") await M.TgCustomer.updateOne({ business_id: c.business_id, tg_id: c.tg_id }, { $set: { can_message: false } });
          return false;
        });
      if (ok2) {
        c.reminded = true;
        sent += 1;
        await M.TgStore.updateOne({ _id: s._id }, { $inc: { "remind.sent": 1 } });
      }
    }
    await c.save();
  }
  return { carts: rows.length, sent };
}

// ---------- uploads ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});
const oneImage = (field) => (req, res, next) =>
  upload.single(field)(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: MSG.badImage });
    next();
  });

// clean what the owner sends for a product
function readProduct(b, cur, isNew) {
  const set = {};
  if (isNew || b.name !== undefined) {
    const name = str(b.name, 80);
    if (!name) throw new Bad(MSG.needName);
    set.name = name;
  }
  if (b.name_km !== undefined) set.name_km = str(b.name_km, 120);
  if (b.about !== undefined) set.about = str(b.about, 300);
  if (isNew || b.price !== undefined) {
    const p = money(b.price, cur);
    if (p === null) throw new Bad(MSG.badPrice);
    set.price = p;
  }
  if (b.category_id !== undefined) set.category_id = validId(b.category_id) ? b.category_id : null;
  if (b.stock !== undefined) set.stock = b.stock === null || b.stock === "" ? null : int(b.stock, 0, 1000000, 0);
  if (b.sold_out !== undefined) set.sold_out = !!b.sold_out;
  if (b.hidden !== undefined) set.hidden = !!b.hidden;
  if (b.sort !== undefined) set.sort = int(b.sort, -100000, 100000, 0);
  if (b.options !== undefined) {
    if (!Array.isArray(b.options)) throw new Bad(MSG.badValue);
    set.options = b.options.slice(0, LIMITS.options).map((g) => {
      const name = str(g?.name, 40);
      const choices = (Array.isArray(g?.choices) ? g.choices : [])
        .slice(0, LIMITS.choices)
        .map((c) => ({ name: str(c?.name, 40), price: money(c?.price || 0, cur) ?? 0 }))
        .filter((c) => c.name);
      if (!name || !choices.length) throw new Bad(MSG.badValue, 400, { code: "bad_option" });
      return { name, multi: !!g.multi, required: !!g.required, choices };
    });
  }
  return set;
}

module.exports = (prop) => {
  const base = "/api/user/businesses/:id/tgstore";
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
      if (err instanceof LicenseError) return res.status(err.status).json({ success: false, message: err.message, code: err.message, ...err.extra });
      if (err?.name === "ValidationError" || err?.name === "CastError") return res.status(400).json({ success: false, message: MSG.badValue });
      console.error("[tgstore]", err);
      res.status(500).json({ success: false, message: MSG.server });
    }
  };

  // ---------- the owner (customer_auth) ----------
  async function ownerCtx(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    // everything in one go (one wait for the database instead of four)
    const [business, license, addons, found, themes] = await Promise.all([
      Business.findOne({ _id: req.params.id, ...bizOwner(req), deleted: false }),
      licenseState(req.params.id),
      addonsOf(req.params.id),
      M.TgStore.findOne({ business_id: req.params.id }),
      themesOf(req.params.id),
    ]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== PRODUCT) throw new Bad(MSG.notStore);
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (license.read_only) throw new Bad(MSG.locked, 402, { product: PRODUCT });
    }
    const store = found || (await storeOf(business));
    return { business, store, license, addons, themes, who: req.customer.name || "Owner" };
  }
  const door = (method, path, o, fn, mw = []) =>
    prop.app[method](
      `${base}${path}`,
      prop.api_auth,
      customer_auth,
      ...mw,
      handle(async (req, res) => fn(await ownerCtx(req, o.write), req, res)),
    );
  const orderOf = async (ctx, oid) => {
    if (!validId(oid)) throw new Bad(MSG.badId);
    const o = await M.TgOrder.findOne({ _id: oid, business_id: ctx.business._id });
    if (!o) throw new Bad(MSG.orderGone, 404);
    return o;
  };
  const tgFail = (err) => {
    if (err instanceof telegram.TelegramError) throw new Bad(err.message === "not_configured" ? MSG.tgNotConfigured : err.message === "blocked" ? MSG.tgBlocked : MSG.tgUnreachable, err.status);
    throw err;
  };
  async function linksOf(s) {
    const web = `${siteOf(s)}/t/${s.slug}`;
    const bot = telegram.ready() ? await telegram.botUsername().catch(() => "") : "";
    return { web, bot, telegram: bot ? `https://t.me/${bot}?start=st_${s.slug}` : "", table: (n) => `${web}?table=${n}` };
  }

  async function countsOf(ctx) {
    const bid = ctx.business._id;
    const today = dayStart(localDay());
    const [open, todayRows, products, customers, fresh] = await Promise.all([
      M.TgOrder.countDocuments({ business_id: bid, status: { $in: ["new", "accepted", "ready", "on_way"] } }),
      M.TgOrder.aggregate([{ $match: { business_id: bid, created_date: { $gte: today }, status: { $ne: "cancelled" } } }, { $group: { _id: null, n: { $sum: 1 }, total: { $sum: "$total" } } }]),
      M.TgProduct.countDocuments({ business_id: bid, deleted: false }),
      M.TgCustomer.countDocuments({ business_id: bid }),
      M.TgOrder.countDocuments({ business_id: bid, status: "new" }),
    ]);
    return { open, new: fresh, today_orders: todayRows[0]?.n || 0, today_total: todayRows[0]?.total || 0, products, customers };
  }

  // ---------------------------------------- overview ----------------------------------------
  door("get", "", {}, async (ctx, req, res) => {
    const origin = String(req.get("origin") || "");
    if (/^https:\/\/[^/]+$/.test(origin) && ctx.store.web !== origin) {
      ctx.store.web = origin.slice(0, 200);
      M.TgStore.updateOne({ _id: ctx.store._id }, { $set: { web: ctx.store.web } }).catch(() => {});
    }
    const [counts, price, links, prices, themePrice] = await Promise.all([countsOf(ctx), priceOf(PRODUCT), linksOf(ctx.store), Promise.all(ADDONS.map((k) => priceOf(k))), priceOf("ts_theme")]);
    const addons = Object.fromEntries(ADDONS.map((k, i) => [k, { ...ctx.addons[k], price: prices[i], days: PRODUCTS[k].days }]));
    res.json({
      success: true,
      data: {
        business: { _id: ctx.business._id, name: ctx.business.name, status: ctx.business.status },
        store: storeOut(ctx.store),
        license: { ...ctx.license, price },
        counts,
        links: { web: links.web, telegram: links.telegram, bot: links.bot },
        telegram: { configured: telegram.ready(), connected: !!ctx.store.tg?.chat_id, chat_name: ctx.store.tg?.chat_name || "" },
        riders: { connected: !!ctx.store.riders?.chat_id, chat_name: ctx.store.riders?.chat_name || "", send_on: ctx.store.riders?.send_on || "accepted" },
        khqr_auto: khqr.configured(),
        addons,
        open_now: openNow(ctx.store, ctx.license, ctx.addons),
        themes: { owned: ctx.themes, free: THEMES.FREE, price: themePrice, count: THEMES.KEYS.length },
        history: { days: HISTORY_DAYS, all: !!ctx.addons.ts_history.active },
        pay_free: FREE_PAY,
      },
    });
  });

  door("put", "/settings", { write: true }, async (ctx, req, res) => {
    const b = req.body || {};
    const s = ctx.store;
    if (b.shop_name !== undefined) s.shop_name = str(b.shop_name, 80) || ctx.business.name;
    if (b.phone !== undefined) s.phone = str(b.phone, 40);
    if (b.address !== undefined) s.address = str(b.address, 200);
    if (b.about !== undefined) s.about = str(b.about, 300);
    if (b.color !== undefined) s.color = b.color === "" ? "" : hexColor(b.color) || s.color; // "" = the design's own colour
    if (b.channel_text !== undefined) s.channel_text = str(b.channel_text, 600);
    if (b.qr) {
      needAddon(ctx, "ts_link");
      if (b.qr.fg !== undefined) s.qr.fg = hexColor(b.qr.fg) || "#1F1A16";
      if (b.qr.bg !== undefined) s.qr.bg = hexColor(b.qr.bg) || "#FFFFFF";
      if (b.qr.logo !== undefined) s.qr.logo = !!b.qr.logo;
    }
    if (b.currency !== undefined) s.currency = b.currency === "KHR" ? "KHR" : "USD";
    if (b.open !== undefined) s.open = !!b.open;
    const cur = s.currency;
    if (b.delivery) {
      const d = b.delivery;
      if (d.on !== undefined) s.delivery.on = !!d.on;
      for (const k of ["fee", "free_from", "min_order"]) if (d[k] !== undefined) s.delivery[k] = money(d[k], cur) ?? 0;
      if (d.note !== undefined) s.delivery.note = str(d.note, 160);
    }
    if (b.pickup) {
      if (b.pickup.on !== undefined) s.pickup.on = !!b.pickup.on;
      if (b.pickup.note !== undefined) s.pickup.note = str(b.pickup.note, 160);
    }
    if (b.dine_in) {
      if (b.dine_in.on !== undefined) s.dine_in.on = !!b.dine_in.on;
      if (b.dine_in.tables !== undefined) s.dine_in.tables = int(b.dine_in.tables, 1, 300, 10);
    }
    if (b.pay?.khqr) {
      const k = b.pay.khqr;
      if (k.bakong_id !== undefined) {
        const id = str(k.bakong_id, 60).toLowerCase();
        if (id && !khqr.isBakongId(id)) throw new Bad(MSG.badBakong, 400, { code: "bad_bakong" });
        s.pay.khqr.bakong_id = id;
      }
      if (k.account_name !== undefined) s.pay.khqr.account_name = str(k.account_name, 40);
      if (k.on !== undefined) {
        if (k.on && !khqr.isBakongId(s.pay.khqr.bakong_id)) throw new Bad(MSG.badBakong, 400, { code: "bad_bakong" });
        s.pay.khqr.on = !!k.on;
      }
    }
    if (b.pay?.cash?.on !== undefined) s.pay.cash.on = !!b.pay.cash.on;
    if (b.hours) {
      if (b.hours.on && !ctx.addons.ts_hours.active) needAddon(ctx, "ts_hours");
      if (Array.isArray(b.hours.days)) {
        if (b.hours.days.length !== 7) throw new Bad(MSG.badHours);
        s.hours.days = b.hours.days.map((d) => {
          if (!d?.closed && (!HHMM.test(String(d?.open)) || !HHMM.test(String(d?.close)) || d.open === d.close)) throw new Bad(MSG.badHours, 400, { code: "bad_hours" });
          return { open: HHMM.test(String(d?.open)) ? d.open : "07:00", close: HHMM.test(String(d?.close)) ? d.close : "21:00", closed: !!d?.closed };
        });
      }
      if (b.hours.on !== undefined) s.hours.on = !!b.hours.on;
    }
    // cart reminder (add-on ts_remind)
    if (b.remind) {
      if (b.remind.on !== undefined) s.remind.on = !!b.remind.on;
      if (b.remind.after_min !== undefined) s.remind.after_min = int(b.remind.after_min, 15, 1440, 60);
      if (b.remind.text !== undefined) s.remind.text = str(b.remind.text, 300);
    }
    // delivery zones (add-on ts_zones)
    if (b.zones) {
      const z = b.zones;
      if (z.on) needAddon(ctx, "ts_zones");
      if (z.kind !== undefined) s.zones.kind = z.kind === "distance" ? "distance" : "area";
      if (z.areas !== undefined) {
        if (!Array.isArray(z.areas) || z.areas.length > 40) throw new Bad(MSG.tooMany);
        s.zones.areas = z.areas.map((a) => {
          const name = str(a?.name, 60);
          if (!name) throw new Bad(MSG.needName, 400, { code: "need_area_name" });
          return { ...(validId(a?._id) ? { _id: a._id } : {}), name, fee: money(a?.fee || 0, cur) ?? 0, min_order: money(a?.min_order || 0, cur) ?? 0, on: a?.on !== false };
        });
      }
      if (z.steps !== undefined) {
        if (!Array.isArray(z.steps) || z.steps.length > 12) throw new Bad(MSG.tooMany);
        s.zones.steps = z.steps
          .map((x) => ({ upto: Math.round(Number(x?.upto) * 10) / 10, fee: money(x?.fee || 0, cur) ?? 0 }))
          .filter((x) => Number.isFinite(x.upto) && x.upto >= 0.1 && x.upto <= 200)
          .sort((a, b2) => a.upto - b2.upto);
      }
      if (z.pin !== undefined) {
        const pin = z.pin ? pinOf(z.pin) : null;
        if (z.pin && !pin) throw new Bad(MSG.badPin, 400, { code: "bad_pin" });
        s.zones.lat = pin ? pin.lat : null;
        s.zones.lng = pin ? pin.lng : null;
      }
      if (z.on !== undefined) s.zones.on = !!z.on;
      if (s.zones.on && s.zones.kind === "area" && !s.zones.areas.some((a) => a.on)) throw new Bad(MSG.needAreas, 400, { code: "need_areas" });
      if (s.zones.on && s.zones.kind === "distance") {
        if (s.zones.lat === null || s.zones.lat === undefined) throw new Bad(MSG.needShopPin, 400, { code: "need_shop_pin" });
        if (!s.zones.steps.length) throw new Bad(MSG.needSteps, 400, { code: "need_steps" });
      }
    }
    if (b.riders?.send_on !== undefined) s.riders.send_on = ["accepted", "ready", "manual"].includes(b.riders.send_on) ? b.riders.send_on : "accepted";
    if (!s.delivery.on && !s.pickup.on && !s.dine_in.on) throw new Bad(MSG.badMode, 400, { code: "need_mode" });
    if (!s.pay.cash.on && !s.pay.khqr.on) throw new Bad(MSG.badPay, 400, { code: "need_pay" });
    await s.save();
    res.json({ success: true, data: { store: storeOut(s), open_now: openNow(s, ctx.license, ctx.addons) }, message: MSG.saved });
  });

  door(
    "post",
    "/logo",
    { write: true },
    async (ctx, req, res) => {
      if (!req.file) throw new Bad(MSG.noFile);
      const up = await cloud.uploadBuffer(req.file, "tgstore");
      const old = ctx.store.logo?.public_id;
      ctx.store.logo = { url: up.url, public_id: up.public_id };
      await ctx.store.save();
      if (old) cloud.deleteFile(old).catch(() => {});
      res.json({ success: true, data: { logo: up.url }, message: MSG.saved });
    },
    [oneImage("logo")],
  );
  door("delete", "/logo", { write: true }, async (ctx, req, res) => {
    const old = ctx.store.logo?.public_id;
    ctx.store.logo = { url: "", public_id: "" };
    await ctx.store.save();
    if (old) cloud.deleteFile(old).catch(() => {});
    res.json({ success: true, data: { logo: "" }, message: MSG.saved });
  });

  // ---------------------------------------- categories ----------------------------------------
  door("get", "/categories", {}, async (ctx, req, res) => {
    const rows = await M.TgCategory.find({ business_id: ctx.business._id, deleted: false }).sort({ sort: 1, created_date: 1 }).lean();
    res.json({ success: true, data: rows.map(categoryOut) });
  });
  door("post", "/categories", { write: true }, async (ctx, req, res) => {
    const name = str(req.body?.name, 60);
    if (!name) throw new Bad(MSG.needName);
    const n = await M.TgCategory.countDocuments({ business_id: ctx.business._id, deleted: false });
    if (n >= LIMITS.categories) throw new Bad(MSG.tooMany);
    const c = await M.TgCategory.create({ business_id: ctx.business._id, name, name_km: str(req.body?.name_km, 80), sort: n });
    res.status(201).json({ success: true, data: categoryOut(c), message: MSG.saved });
  });
  door("put", "/categories/:cid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.cid)) throw new Bad(MSG.badId);
    const set = {};
    if (req.body?.name !== undefined) set.name = str(req.body.name, 60) || undefined;
    if (req.body?.name_km !== undefined) set.name_km = str(req.body.name_km, 80);
    const c = await M.TgCategory.findOneAndUpdate({ _id: req.params.cid, business_id: ctx.business._id, deleted: false }, { $set: set }, { returnDocument: "after" });
    if (!c) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, data: categoryOut(c), message: MSG.saved });
  });
  door("delete", "/categories/:cid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.cid)) throw new Bad(MSG.badId);
    const c = await M.TgCategory.findOneAndUpdate({ _id: req.params.cid, business_id: ctx.business._id }, { $set: { deleted: true } });
    if (!c) throw new Bad(MSG.rowNotFound, 404);
    await M.TgProduct.updateMany({ business_id: ctx.business._id, category_id: c._id }, { $set: { category_id: null } }); // products stay
    res.json({ success: true, message: MSG.deleted });
  });
  door("put", "/categories-order", { write: true }, async (ctx, req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(validId).slice(0, LIMITS.categories);
    await Promise.all(ids.map((cid, i) => M.TgCategory.updateOne({ _id: cid, business_id: ctx.business._id }, { $set: { sort: i } })));
    res.json({ success: true, message: MSG.saved });
  });

  // ---------------------------------------- products ----------------------------------------
  door("get", "/products", {}, async (ctx, req, res) => {
    const rows = await M.TgProduct.find({ business_id: ctx.business._id, deleted: false }).sort({ sort: 1, created_date: 1 }).lean();
    res.json({ success: true, data: rows.map(productOut) });
  });
  door("post", "/products", { write: true }, async (ctx, req, res) => {
    const n = await M.TgProduct.countDocuments({ business_id: ctx.business._id, deleted: false });
    if (n >= LIMITS.products) throw new Bad(MSG.tooMany);
    const set = readProduct(req.body || {}, ctx.store.currency, true);
    const p = await M.TgProduct.create({ business_id: ctx.business._id, sort: n, ...set });
    res.status(201).json({ success: true, data: productOut(p), message: MSG.saved });
  });
  door("put", "/products/:pid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.pid)) throw new Bad(MSG.badId);
    const set = readProduct(req.body || {}, ctx.store.currency, false);
    const p = await M.TgProduct.findOneAndUpdate({ _id: req.params.pid, business_id: ctx.business._id, deleted: false }, { $set: set }, { returnDocument: "after", runValidators: true });
    if (!p) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, data: productOut(p), message: MSG.saved });
  });
  door("delete", "/products/:pid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.pid)) throw new Bad(MSG.badId);
    const p = await M.TgProduct.findOneAndUpdate({ _id: req.params.pid, business_id: ctx.business._id, deleted: false }, { $set: { deleted: true } });
    if (!p) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, message: MSG.deleted });
  });
  door(
    "post",
    "/products/:pid/photo",
    { write: true },
    async (ctx, req, res) => {
      if (!validId(req.params.pid)) throw new Bad(MSG.badId);
      if (!req.file) throw new Bad(MSG.noFile);
      const p = await M.TgProduct.findOne({ _id: req.params.pid, business_id: ctx.business._id, deleted: false });
      if (!p) throw new Bad(MSG.rowNotFound, 404);
      const up = await cloud.uploadBuffer(req.file, "tgstore");
      const old = p.photo?.public_id;
      p.photo = { url: up.url, public_id: up.public_id };
      await p.save();
      if (old) cloud.deleteFile(old).catch(() => {});
      res.json({ success: true, data: productOut(p), message: MSG.saved });
    },
    [oneImage("photo")],
  );
  door("delete", "/products/:pid/photo", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.pid)) throw new Bad(MSG.badId);
    const p = await M.TgProduct.findOne({ _id: req.params.pid, business_id: ctx.business._id, deleted: false });
    if (!p) throw new Bad(MSG.rowNotFound, 404);
    const old = p.photo?.public_id;
    p.photo = { url: "", public_id: "" };
    await p.save();
    if (old) cloud.deleteFile(old).catch(() => {});
    res.json({ success: true, data: productOut(p), message: MSG.saved });
  });

  // ---------------------------------------- orders ----------------------------------------
  const OPEN = ["new", "accepted", "ready", "on_way"];
  // the orders: open ones (oldest first), or the history with filters. Without ts_history only the last 60 days.
  const historyFrom = (ctx) => (ctx.addons.ts_history.active ? null : dayStart(localDay(new Date(Date.now() - (HISTORY_DAYS - 1) * DAY))));
  door("get", "/orders", {}, async (ctx, req, res) => {
    const st = String(req.query.status || "open");
    const q = { business_id: ctx.business._id };
    if (st === "open") q.status = { $in: OPEN };
    else if (M.STATUSES.includes(st)) q.status = st;
    const text = str(req.query.q, 60);
    if (text) {
      const re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const no = Number(text.replace(/^#/, ""));
      q.$or = [{ "customer.name": re }, { "customer.phone": re }, { "customer.username": re }, ...(Number.isInteger(no) && no > 0 ? [{ no }] : [])];
    }
    if (["delivery", "pickup", "dine_in"].includes(req.query.mode)) q.mode = req.query.mode;
    if (["khqr", "cash", "custom"].includes(req.query.pay)) q["pay.method"] = req.query.pay;
    if (req.query.paid === "yes") q["pay.status"] = "paid";
    if (req.query.paid === "no") q["pay.status"] = { $ne: "paid" };
    if (validId(req.query.customer)) q.customer_id = req.query.customer;
    const min = historyFrom(ctx);
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? dayStart(String(v)) : null);
    let from = day(req.query.from);
    const to = day(req.query.to);
    if (min && (!from || from < min)) from = min;
    if (from || to) q.created_date = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: new Date(to.getTime() + DAY) } : {}) };
    const page = int(req.query.page, 1, 1000, 1);
    const limit = st === "open" ? 60 : int(req.query.limit, 10, 100, 30);
    const [rows, total, sum, older, counts] = await Promise.all([
      M.TgOrder.find(q)
        .sort({ created_date: st === "open" ? 1 : -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.TgOrder.countDocuments(q),
      M.TgOrder.aggregate([{ $match: { ...q, status: q.status || { $ne: "cancelled" } } }, { $group: { _id: null, total: { $sum: "$total" } } }]),
      min ? M.TgOrder.countDocuments({ business_id: ctx.business._id, created_date: { $lt: min } }) : 0,
      countsOf(ctx),
    ]);
    res.json({
      success: true,
      data: rows.map((o) => orderOut(o)),
      pagination: { page, limit, total },
      sum: sum[0]?.total || 0,
      history: { days: HISTORY_DAYS, all: !min, from: min, hidden: older },
      counts,
    });
  });
  door("get", "/orders/:oid", {}, async (ctx, req, res) => {
    const o = await orderOf(ctx, req.params.oid);
    res.json({ success: true, data: orderOut(o, true), link: `${siteOf(ctx.store)}/t/o/${o.token}` });
  });
  door("post", "/orders/:oid/status", { write: true }, async (ctx, req, res) => {
    const o = await orderOf(ctx, req.params.oid);
    const status = String(req.body?.status || "");
    if (!M.STATUSES.includes(status)) throw new Bad(MSG.badValue);
    const after = await moveOrder(ctx.store, o, status, ctx.who, { eta: req.body?.eta, reason: req.body?.reason });
    res.json({ success: true, data: orderOut(after), message: MSG.saved });
  });
  door("post", "/orders/:oid/paid", { write: true }, async (ctx, req, res) => {
    const o = await orderOf(ctx, req.params.oid);
    const after = await markPaid(ctx.store, o, ctx.who);
    res.json({ success: true, data: orderOut(after), message: MSG.saved });
  });

  const customerOut = (c) => ({ _id: c._id, name: c.name, phone: c.phone, username: c.username, address: c.address, telegram: !!c.tg_id, can_message: !!c.can_message, orders: c.orders, placed: Math.max(c.placed || 0, c.orders || 0), spent: c.spent, last_order_at: c.last_order_at, note: c.note || "", created_date: c.created_date });
  const SORTS = { recent: { last_order_at: -1, created_date: -1 }, spent: { spent: -1, orders: -1 }, orders: { orders: -1, spent: -1 }, new: { created_date: -1 }, name: { name: 1 } };
  door("get", "/customers", {}, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const q = { business_id: bid };
    const text = str(req.query.q, 60);
    if (text) {
      const re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ name: re }, { phone: re }, { username: re }, { note: re }];
    }
    if (req.query.kind === "telegram") q.tg_id = { $gt: "" };
    if (req.query.kind === "web") q.tg_id = "";
    if (req.query.kind === "repeat") q.orders = { $gte: 2 };
    if (req.query.kind === "message") q.can_message = true;
    const page = int(req.query.page, 1, 1000, 1);
    const limit = 30;
    const monthStart = dayStart(`${localDay().slice(0, 8)}01`);
    const [rows, total, all, tg, repeat, fresh, spent] = await Promise.all([
      M.TgCustomer.find(q)
        .sort(SORTS[req.query.sort] || SORTS.recent)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.TgCustomer.countDocuments(q),
      M.TgCustomer.countDocuments({ business_id: bid }),
      M.TgCustomer.countDocuments({ business_id: bid, tg_id: { $gt: "" } }),
      M.TgCustomer.countDocuments({ business_id: bid, orders: { $gte: 2 } }),
      M.TgCustomer.countDocuments({ business_id: bid, created_date: { $gte: monthStart } }),
      M.TgCustomer.aggregate([{ $match: { business_id: bid } }, { $group: { _id: null, total: { $sum: "$spent" } } }]),
    ]);
    res.json({ success: true, data: rows.map(customerOut), pagination: { page, limit, total }, stats: { all, telegram: tg, repeat, new_month: fresh, spent: spent[0]?.total || 0 } });
  });
  door("get", "/customers/:cid", {}, async (ctx, req, res) => {
    if (!validId(req.params.cid)) throw new Bad(MSG.badId);
    const c = await M.TgCustomer.findOne({ _id: req.params.cid, business_id: ctx.business._id }).lean();
    if (!c) throw new Bad(MSG.rowNotFound, 404);
    const min = historyFrom(ctx);
    const orders = await M.TgOrder.find({ business_id: ctx.business._id, customer_id: c._id, ...(min ? { created_date: { $gte: min } } : {}) })
      .sort({ created_date: -1 })
      .limit(50)
      .lean();
    const fav = {};
    for (const o of orders) if (o.status !== "cancelled") for (const l of o.items) fav[l.name] = (fav[l.name] || 0) + l.qty;
    res.json({
      success: true,
      data: {
        customer: customerOut(c),
        orders: orders.map((o) => orderOut(o)),
        favourites: Object.entries(fav)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, qty]) => ({ name, qty })),
      },
    });
  });
  door("put", "/customers/:cid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.cid)) throw new Bad(MSG.badId);
    const c = await M.TgCustomer.findOneAndUpdate({ _id: req.params.cid, business_id: ctx.business._id }, { $set: { note: str(req.body?.note, 300) } }, { returnDocument: "after" }).lean();
    if (!c) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, data: customerOut(c), message: MSG.saved });
  });

  // ---------------------------------------- ways to pay (3 free; more + pictures = ts_pay) ----------------------------------------
  const payCount = (s) => (s.pay.khqr.on ? 1 : 0) + (s.pay.cash.on ? 1 : 0) + s.pay.custom.length;
  const payOut = (s) => s.pay.custom.map((m) => ({ _id: m._id, name: m.name, info: m.info, image: m.image?.url || "", on: m.on }));
  door("post", "/pay-methods", { write: true }, async (ctx, req, res) => {
    const s = ctx.store;
    if (!ctx.addons.ts_pay.active && (s.pay.custom.length >= 1 || payCount(s) >= FREE_PAY)) throw new Bad(MSG.payLimit, 402, { product: "ts_pay", code: "addon" });
    if (s.pay.custom.length >= 20) throw new Bad(MSG.tooMany);
    const name = str(req.body?.name, 40);
    if (!name) throw new Bad(MSG.needName);
    s.pay.custom.push({ name, info: str(req.body?.info, 300), on: true });
    await s.save();
    res.status(201).json({ success: true, data: payOut(s), message: MSG.saved });
  });
  const methodOf = (ctx, mid) => {
    const m = validId(mid) && ctx.store.pay.custom.id(mid);
    if (!m) throw new Bad(MSG.rowNotFound, 404);
    return m;
  };
  door("put", "/pay-methods/:mid", { write: true }, async (ctx, req, res) => {
    const m = methodOf(ctx, req.params.mid);
    if (req.body?.name !== undefined) {
      const name = str(req.body.name, 40);
      if (!name) throw new Bad(MSG.needName);
      m.name = name;
    }
    if (req.body?.info !== undefined) m.info = str(req.body.info, 300);
    if (req.body?.on !== undefined) m.on = !!req.body.on;
    await ctx.store.save();
    res.json({ success: true, data: payOut(ctx.store), message: MSG.saved });
  });
  door("delete", "/pay-methods/:mid", { write: true }, async (ctx, req, res) => {
    const m = methodOf(ctx, req.params.mid);
    const old = m.image?.public_id;
    m.deleteOne();
    await ctx.store.save();
    if (old) cloud.deleteFile(old).catch(() => {});
    res.json({ success: true, data: payOut(ctx.store), message: MSG.deleted });
  });
  door(
    "post",
    "/pay-methods/:mid/image",
    { write: true },
    async (ctx, req, res) => {
      needAddon(ctx, "ts_pay");
      const m = methodOf(ctx, req.params.mid);
      if (!req.file) throw new Bad(MSG.noFile);
      const up = await cloud.uploadBuffer(req.file, "tgstore-pay");
      const old = m.image?.public_id;
      m.image = { url: up.url, public_id: up.public_id };
      await ctx.store.save();
      if (old) cloud.deleteFile(old).catch(() => {});
      res.json({ success: true, data: payOut(ctx.store), message: MSG.saved });
    },
    [oneImage("image")],
  );
  door("delete", "/pay-methods/:mid/image", { write: true }, async (ctx, req, res) => {
    const m = methodOf(ctx, req.params.mid);
    const old = m.image?.public_id;
    m.image = { url: "", public_id: "" };
    await ctx.store.save();
    if (old) cloud.deleteFile(old).catch(() => {});
    res.json({ success: true, data: payOut(ctx.store), message: MSG.saved });
  });

  // ---------------------------------------- designs: 3 free, the others bought one by one ----------------------------------------
  door("post", "/themes/:key", { write: true }, async (ctx, req, res) => {
    const key = String(req.params.key);
    if (!THEMES.KEYS.includes(key)) throw new Bad(MSG.badTheme);
    const r = ctx.themes.includes(key) ? null : await buy({ customer: req.customer, business: ctx.business, product: "ts_theme", item: key });
    ctx.store.theme = key;
    await ctx.store.save();
    res.json({ success: true, data: { theme: key, owned: r ? [...ctx.themes, key] : ctx.themes, charged: r?.charged || 0 }, balance: r?.balance, charged: r?.charged || 0, message: MSG.saved });
  });

  // ---------------------------------------- own link name (ts_link); the old link keeps working ----------------------------------------
  door("put", "/link", { write: true }, async (ctx, req, res) => {
    needAddon(ctx, "ts_link");
    const slug = String(req.body?.slug || "")
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/.test(slug) || slug === "order" || slug.includes("--")) throw new Bad(MSG.badSlug, 400, { code: "bad_slug" });
    const s = ctx.store;
    if (slug !== s.slug) {
      if (await M.TgStore.exists({ _id: { $ne: s._id }, $or: [{ slug }, { old_slugs: slug }] })) throw new Bad(MSG.slugTaken, 409, { code: "taken" });
      s.old_slugs = [...new Set([s.slug, ...(s.old_slugs || [])])].filter((x) => x !== slug).slice(0, 10);
      s.slug = slug;
      await s.save();
    }
    const links = await linksOf(s);
    res.json({ success: true, data: { slug: s.slug, links: { web: links.web, telegram: links.telegram, bot: links.bot } }, message: MSG.saved });
  });

  // ---------------------------------------- add-on: promo codes ----------------------------------------
  door("get", "/promos", {}, async (ctx, req, res) => {
    const rows = await M.TgPromo.find({ business_id: ctx.business._id, deleted: false }).sort({ created_date: -1 }).lean();
    res.json({ success: true, data: rows.map(promoOut) });
  });
  const readPromo = (b, cur, isNew) => {
    const set = {};
    if (isNew || b.code !== undefined) {
      const code = codeOf(b.code);
      if (!/^[A-Z0-9]{3,20}$/.test(code)) throw new Bad(MSG.badCode, 400, { code: "bad_code" });
      set.code = code;
    }
    if (isNew || b.kind !== undefined) set.kind = b.kind === "amount" ? "amount" : "percent";
    if (isNew || b.value !== undefined) {
      const kind = set.kind || b.kind;
      const v = Number(b.value);
      if (!(v > 0) || (kind === "percent" && v > 100)) throw new Bad(MSG.badValue, 400, { code: "bad_value" });
      set.value = kind === "percent" ? Math.round(v) : money(v, cur);
    }
    if (b.min_order !== undefined) set.min_order = money(b.min_order || 0, cur) ?? 0;
    if (b.max_uses !== undefined) set.max_uses = int(b.max_uses, 0, 1000000, 0);
    if (b.ends_at !== undefined) set.ends_at = b.ends_at && !Number.isNaN(Date.parse(b.ends_at)) ? new Date(b.ends_at) : null;
    if (b.on !== undefined) set.on = !!b.on;
    return set;
  };
  door("post", "/promos", { write: true }, async (ctx, req, res) => {
    needAddon(ctx, "ts_promos");
    if ((await M.TgPromo.countDocuments({ business_id: ctx.business._id, deleted: false })) >= LIMITS.promos) throw new Bad(MSG.tooMany);
    const set = readPromo(req.body || {}, ctx.store.currency, true);
    if (await M.TgPromo.exists({ business_id: ctx.business._id, code: set.code, deleted: false })) throw new Bad(MSG.promoTaken, 409, { code: "taken" });
    const p = await M.TgPromo.create({ business_id: ctx.business._id, ...set });
    res.status(201).json({ success: true, data: promoOut(p), message: MSG.saved });
  });
  door("put", "/promos/:pid", { write: true }, async (ctx, req, res) => {
    needAddon(ctx, "ts_promos");
    if (!validId(req.params.pid)) throw new Bad(MSG.badId);
    const p = await M.TgPromo.findOne({ _id: req.params.pid, business_id: ctx.business._id, deleted: false });
    if (!p) throw new Bad(MSG.rowNotFound, 404);
    const set = readPromo({ kind: p.kind, ...req.body }, ctx.store.currency, false);
    if (set.code && set.code !== p.code && (await M.TgPromo.exists({ business_id: ctx.business._id, code: set.code, deleted: false }))) throw new Bad(MSG.promoTaken, 409, { code: "taken" });
    Object.assign(p, set);
    await p.save();
    res.json({ success: true, data: promoOut(p), message: MSG.saved });
  });
  door("delete", "/promos/:pid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.pid)) throw new Bad(MSG.badId);
    await M.TgPromo.updateOne({ _id: req.params.pid, business_id: ctx.business._id }, { $set: { deleted: true, on: false } });
    res.json({ success: true, message: MSG.deleted });
  });

  // ---------------------------------------- add-on: message the customers ----------------------------------------
  const reachOf = (bid) => ({ business_id: bid, tg_id: { $gt: "" }, can_message: true });
  door("get", "/broadcasts", {}, async (ctx, req, res) => {
    const today = dayStart(localDay());
    const [rows, reach, sentToday] = await Promise.all([
      M.TgBroadcast.find({ business_id: ctx.business._id }).sort({ created_date: -1 }).limit(20).lean(),
      M.TgCustomer.countDocuments(reachOf(ctx.business._id)),
      M.TgBroadcast.countDocuments({ business_id: ctx.business._id, created_date: { $gte: today } }),
    ]);
    const out = rows.map((r) => ({ _id: r._id, text: r.text, total: r.total, sent: r.sent, failed: r.failed, by: r.by, created_date: r.created_date }));
    res.json({ success: true, data: { rows: out, reach: Math.min(reach, LIMITS.broadcastReach), reach_all: reach, today: sentToday, per_day: LIMITS.broadcastsPerDay, telegram: telegram.ready() } });
  });
  door("post", "/broadcasts", { write: true }, async (ctx, req, res) => {
    needAddon(ctx, "ts_broadcast");
    if (!telegram.ready()) throw new Bad(MSG.tgNotConfigured, 503);
    const text = str(req.body?.text, 1000);
    if (!text) throw new Bad(MSG.needText);
    const today = dayStart(localDay());
    if ((await M.TgBroadcast.countDocuments({ business_id: ctx.business._id, created_date: { $gte: today } })) >= LIMITS.broadcastsPerDay) throw new Bad(fill(MSG.broadcastLimit, { n: LIMITS.broadcastsPerDay }), 429, { code: "limit" });
    const people = await M.TgCustomer.find(reachOf(ctx.business._id)).sort({ last_order_at: -1, created_date: -1 }).limit(LIMITS.broadcastReach).select("tg_id").lean();
    if (!people.length) throw new Bad(MSG.noReach, 400, { code: "no_reach" });
    const s = ctx.store;
    const button = telegram.keyboard([[{ text: `🛍 ${s.shop_name}`.slice(0, 60), web_app: { url: `${siteOf(s)}/t/${s.slug}` } }]]);
    const body = `<b>${esc(s.shop_name)}</b>\n${esc(text)}`;
    let sent = 0;
    let failed = 0;
    const blocked = [];
    for (let i = 0; i < people.length; i += 15) {
      await Promise.all(
        people.slice(i, i + 15).map((c) =>
          telegram
            .send(c.tg_id, body, button)
            .then(() => (sent += 1))
            .catch((err) => {
              failed += 1;
              if (err instanceof telegram.TelegramError && err.message === "blocked") blocked.push(c._id);
            }),
        ),
      );
    }
    if (blocked.length) await M.TgCustomer.updateMany({ _id: { $in: blocked } }, { $set: { can_message: false } });
    const row = await M.TgBroadcast.create({ business_id: ctx.business._id, text, total: people.length, sent, failed, by: ctx.who });
    res.status(201).json({ success: true, data: { _id: row._id, text, total: people.length, sent, failed, by: ctx.who, created_date: row.created_date }, message: fill(MSG.broadcastSent, { n: sent }) });
  });

  // ---------------------------------------- add-on: sales report ----------------------------------------
  const rangeOf = (q) => {
    const days = [7, 30, 90].includes(Number(q.days)) ? Number(q.days) : 30;
    const from = dayStart(localDay(new Date(Date.now() - (days - 1) * DAY)));
    return { days, from };
  };
  door("get", "/report", {}, async (ctx, req, res) => {
    needAddon(ctx, "ts_reports");
    const { days, from } = rangeOf(req.query);
    const rows = await M.TgOrder.find({ business_id: ctx.business._id, created_date: { $gte: from } })
      .select("created_date status total discount items mode pay.method")
      .limit(20000)
      .lean();
    const ok = rows.filter((o) => o.status !== "cancelled");
    const byDay = {};
    for (let i = 0; i < days; i += 1) byDay[localDay(new Date(from.getTime() + i * DAY + 12 * 3600000))] = { orders: 0, sales: 0 };
    const best = {};
    const hours = Array(24).fill(0);
    const modes = { delivery: 0, pickup: 0, dine_in: 0 };
    const pay = { khqr: 0, cash: 0 };
    let sales = 0;
    let discount = 0;
    for (const o of ok) {
      const d = localDay(o.created_date);
      if (byDay[d]) {
        byDay[d].orders += 1;
        byDay[d].sales += o.total;
      }
      sales += o.total;
      discount += o.discount || 0;
      hours[new Date(new Date(o.created_date).getTime() + TZ * 3600000).getUTCHours()] += 1;
      modes[o.mode] = (modes[o.mode] || 0) + 1;
      pay[o.pay?.method] = (pay[o.pay?.method] || 0) + 1;
      for (const l of o.items || []) {
        best[l.name] = best[l.name] || { name: l.name, qty: 0, sales: 0 };
        best[l.name].qty += l.qty;
        best[l.name].sales += l.total;
      }
    }
    const cur = ctx.store.currency;
    const r2 = (v) => money(v, cur) ?? 0;
    res.json({
      success: true,
      data: {
        days,
        currency: cur,
        totals: { orders: ok.length, sales: r2(sales), avg: ok.length ? r2(sales / ok.length) : 0, cancelled: rows.length - ok.length, discount: r2(discount) },
        by_day: Object.entries(byDay).map(([day, v]) => ({ day, orders: v.orders, sales: r2(v.sales) })),
        best: Object.values(best)
          .sort((a, b) => b.qty - a.qty)
          .slice(0, 10)
          .map((b) => ({ ...b, sales: r2(b.sales) })),
        hours,
        modes,
        pay,
      },
    });
  });
  // every order of the period, for the Excel file the page makes
  door("get", "/report/orders", {}, async (ctx, req, res) => {
    needAddon(ctx, "ts_reports");
    const { from } = rangeOf(req.query);
    const rows = await M.TgOrder.find({ business_id: ctx.business._id, created_date: { $gte: from } })
      .sort({ created_date: 1 })
      .limit(20000)
      .lean();
    const line = (l) => `${l.qty} × ${l.name}${l.options?.length ? ` (${l.options.map((x) => x.choice).join(", ")})` : ""}`;
    res.json({
      success: true,
      data: rows.map((o) => ({
        no: o.no,
        date: o.created_date,
        status: o.status,
        mode: o.mode,
        table: o.table,
        customer: o.customer?.name || "",
        phone: o.customer?.phone || "",
        items: o.items.map(line).join("; "),
        subtotal: o.subtotal,
        discount: o.discount || 0,
        promo: o.promo || "",
        fee: o.fee,
        total: o.total,
        pay: o.pay?.method,
        paid: o.pay?.status === "paid",
      })),
    });
  });

  // ---------------------------------------- Telegram: the staff group ----------------------------------------
  door("post", "/telegram/link", { write: true }, async (ctx, req, res) => {
    if (!telegram.ready()) throw new Bad(MSG.tgNotConfigured, 503);
    const bot = await telegram.botUsername().catch(tgFail);
    const code = `ts_${token(24)}`;
    ctx.store.tg.link_code = code;
    ctx.store.tg.link_expires = new Date(Date.now() + 15 * 60000);
    await ctx.store.save();
    res.json({ success: true, data: { url: `https://t.me/${bot}?start=${code}`, group_url: `https://t.me/${bot}?startgroup=${code}`, bot, expires_at: ctx.store.tg.link_expires } });
  });
  door("post", "/telegram/test", { write: true }, async (ctx, req, res) => {
    const chat = ctx.store.tg?.chat_id;
    if (!chat) throw new Bad(MSG.tgNotConnected);
    await telegram.send(chat, `🔔 <b>${esc(ctx.store.shop_name)}</b>\nTest from BizHub — new Telegram Store orders will come here.\nសារសាកល្បងពី BizHub — ការកម្ម៉ង់ថ្មីនឹងមកទីនេះ។`).catch(tgFail);
    res.json({ success: true, message: MSG.tgSent });
  });
  door("delete", "/telegram", { write: true }, async (ctx, req, res) => {
    const chat = ctx.store.tg?.chat_id;
    ctx.store.tg.chat_id = "";
    ctx.store.tg.chat_name = "";
    ctx.store.tg.connected_at = null;
    await ctx.store.save();
    if (chat) telegram.send(chat, "🔌 BizHub Telegram Store disconnected from this chat.\nបានផ្តាច់ពី BizHub ហើយ។").catch(() => {});
    res.json({ success: true, data: { connected: false, chat_name: "" }, message: MSG.saved });
  });

  // ---------------------------------------- the riders' group (add-on ts_riders) ----------------------------------------
  // who delivered what in the last 30 days
  door("get", "/riders", {}, async (ctx, req, res) => {
    const since = new Date(Date.now() - 30 * DAY);
    const rows = await M.TgOrder.aggregate([
      { $match: { business_id: ctx.business._id, "rider.tg_id": { $gt: "" }, created_date: { $gte: since } } },
      {
        $group: {
          _id: "$rider.tg_id",
          name: { $last: "$rider.name" },
          username: { $last: "$rider.username" },
          taken: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $eq: ["$status", "done"] }, 1, 0] } },
          fees: { $sum: { $cond: [{ $eq: ["$status", "done"] }, "$fee", 0] } },
          minutes: { $avg: { $cond: [{ $and: ["$rider.picked_at", "$rider.delivered_at"] }, { $divide: [{ $subtract: ["$rider.delivered_at", "$rider.picked_at"] }, 60000] }, null] } },
          last: { $max: "$rider.taken_at" },
        },
      },
      { $sort: { delivered: -1, taken: -1 } },
      { $limit: 50 },
    ]);
    const waiting = await M.TgOrder.countDocuments({ business_id: ctx.business._id, mode: "delivery", status: { $in: ["accepted", "ready"] }, "rider_msg.message_id": { $gt: 0 }, "rider.tg_id": { $in: [null, ""] } });
    res.json({
      success: true,
      data: {
        connected: !!ctx.store.riders?.chat_id,
        chat_name: ctx.store.riders?.chat_name || "",
        send_on: ctx.store.riders?.send_on || "accepted",
        waiting,
        riders: rows.map((r) => ({ tg_id: r._id, name: r.name || "", username: r.username || "", taken: r.taken, delivered: r.delivered, fees: money(r.fees || 0, ctx.store.currency), minutes: r.minutes === null ? null : Math.round(r.minutes), last: r.last })),
      },
    });
  });
  door("post", "/riders/link", { write: true }, async (ctx, req, res) => {
    needAddon(ctx, "ts_riders");
    if (!telegram.ready()) throw new Bad(MSG.tgNotConfigured, 503);
    const bot = await telegram.botUsername().catch(tgFail);
    const code = `tr_${token(24)}`;
    ctx.store.riders.link_code = code;
    ctx.store.riders.link_expires = new Date(Date.now() + 15 * 60000);
    await ctx.store.save();
    res.json({ success: true, data: { group_url: `https://t.me/${bot}?startgroup=${code}`, url: `https://t.me/${bot}?start=${code}`, bot, expires_at: ctx.store.riders.link_expires } });
  });
  door("post", "/riders/test", { write: true }, async (ctx, req, res) => {
    needAddon(ctx, "ts_riders");
    const chat = ctx.store.riders?.chat_id;
    if (!chat) throw new Bad(MSG.ridersNotConnected);
    await telegram.send(chat, `🛵 <b>${esc(ctx.store.shop_name)}</b>\nTest from BizHub — delivery orders will come here. Tap “Take it” to deliver one.\nសារសាកល្បង — ការកម្ម៉ង់ដឹកជញ្ជូននឹងមកទីនេះ។ ចុច “យក” ដើម្បីដឹក។`).catch(tgFail);
    res.json({ success: true, message: MSG.tgSent });
  });
  door("delete", "/riders", { write: true }, async (ctx, req, res) => {
    const chat = ctx.store.riders?.chat_id;
    ctx.store.riders.chat_id = "";
    ctx.store.riders.chat_name = "";
    ctx.store.riders.connected_at = null;
    await ctx.store.save();
    if (chat) telegram.send(chat, "🔌 BizHub riders' group disconnected.\nបានផ្តាច់ក្រុមអ្នកដឹកហើយ។").catch(() => {});
    res.json({ success: true, data: { connected: false, chat_name: "" }, message: MSG.saved });
  });
  // send one delivery order to the riders now
  door("post", "/orders/:oid/riders", { write: true }, async (ctx, req, res) => {
    needAddon(ctx, "ts_riders");
    const o = await orderOf(ctx, req.params.oid);
    if (o.mode !== "delivery") throw new Bad(MSG.notDelivery, 400, { code: "not_delivery" });
    if (!ctx.store.riders?.chat_id) throw new Bad(MSG.ridersNotConnected, 400, { code: "riders_off" });
    if (["done", "cancelled"].includes(o.status)) throw new Bad(MSG.badStep, 409, { code: "bad_step" });
    if (!(await postToRiders(ctx.store, o, true))) throw new Bad(MSG.tgUnreachable, 502);
    await postToGroup(ctx.store, o);
    res.json({ success: true, data: orderOut(o), message: MSG.ridersSent });
  });

  // ---------------------------------------- carts left in Telegram (add-on ts_remind) ----------------------------------------
  door("get", "/carts", {}, async (ctx, req, res) => {
    const since = new Date(Date.now() - 7 * DAY);
    const rows = await M.TgCart.find({ business_id: ctx.business._id, "items.0": { $exists: true }, at: { $gte: since } })
      .sort({ at: -1 })
      .limit(100)
      .lean();
    const r = ctx.store.remind || {};
    res.json({
      success: true,
      data: {
        settings: { on: r.on !== false, after_min: r.after_min || 60, text: r.text || "" },
        stats: { sent: r.sent || 0, back: r.back || 0, back_total: r.back_total || 0 },
        default_text: REMIND_TEXT,
        rows: rows.map((c) => ({ _id: c._id, name: c.name, username: c.username, n: c.items.reduce((a, l) => a + (l.qty || 1), 0), total: c.total || 0, at: c.at, reminded: !!c.reminded, can_message: !!c.can_message })),
      },
    });
  });

  telegram.onStart(async (code, chat) => {
    // the owner sends the orders to this chat (a group: t.me/<bot>?startgroup=ts_…)
    if (/^ts_[A-Za-z0-9]{10,40}$/.test(code)) {
      const s = await M.TgStore.findOne({ "tg.link_code": code });
      if (!s || !s.tg.link_expires || s.tg.link_expires < new Date()) return "This link has expired. Make a new one in BizHub.\nតំណនេះផុតកំណត់ហើយ។ សូមបង្កើតថ្មីក្នុង BizHub។";
      s.tg.chat_id = String(chat.id);
      s.tg.chat_name = (chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "")).slice(0, 80);
      s.tg.connected_at = new Date();
      s.tg.link_code = "";
      s.tg.link_expires = null;
      await s.save();
      return `✅ <b>${esc(s.shop_name)}</b>\nConnected! New Telegram Store orders will come here, with buttons to accept them.\nបានភ្ជាប់! ការកម្ម៉ង់ថ្មីនឹងមកទីនេះ ជាមួយប៊ូតុងទទួល។`;
    }
    // the riders' group (add-on ts_riders): t.me/<bot>?startgroup=tr_…
    if (/^tr_[A-Za-z0-9]{10,40}$/.test(code)) {
      const s = await M.TgStore.findOne({ "riders.link_code": code });
      if (!s || !s.riders.link_expires || s.riders.link_expires < new Date()) return "This link has expired. Make a new one in BizHub.\nតំណនេះផុតកំណត់ហើយ។ សូមបង្កើតថ្មីក្នុង BizHub។";
      s.riders.chat_id = String(chat.id);
      s.riders.chat_name = (chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "")).slice(0, 80);
      s.riders.connected_at = new Date();
      s.riders.link_code = "";
      s.riders.link_expires = null;
      await s.save();
      return `🛵 <b>${esc(s.shop_name)}</b>\nRiders' group connected! Delivery orders will come here. The first rider to tap “Take it” delivers it.\nបានភ្ជាប់ក្រុមអ្នកដឹក! អ្នកដឹកដែលចុច “យក” មុនគេ ជាអ្នកដឹក។`;
    }
    // a customer opened the shop's bot link: answer with the button that opens the store inside Telegram
    if (/^st_[a-z0-9-]{2,40}$/.test(code)) {
      const s = (await M.TgStore.findOne({ slug: code.slice(3) }).lean()) || (await M.TgStore.findOne({ old_slugs: code.slice(3) }).lean());
      if (!s) return "This shop link doesn't work any more.\nតំណហាងនេះមិនដំណើរការទៀតទេ។";
      const url = `${siteOf(s)}/t/${s.slug}`;
      // a web_app button opens the store inside Telegram (signed, so we know who orders); works in a private chat
      const button = chat.type === "private" ? { text: `🛍 ${s.shop_name}`.slice(0, 60), web_app: { url } } : { text: `🛍 ${s.shop_name}`.slice(0, 60), url };
      return { text: `🛍 <b>${esc(s.shop_name)}</b>\n${s.about ? `${esc(s.about)}\n` : ""}Tap the button to order · ចុចប៊ូតុង ដើម្បីកម្ម៉ង់`, extra: telegram.keyboard([[button]]) };
    }
    return null;
  });
  // the staff press a button under an order in their group
  telegram.onCallback(async (data, q) => {
    const r = /^tgr:([a-f0-9]{24}):(take|picked|done|back)$/.exec(data);
    if (r) return riderPress(r[1], r[2], q);
    const m = /^tgo:([a-f0-9]{24}):(accept|eta15|eta30|reject|ready|on_way|done|paid|riders)$/.exec(data);
    if (!m) return null;
    const o = await M.TgOrder.findById(m[1]);
    if (!o) return { toast: "Order not found · រកមិនឃើញ", alert: true };
    const s = await M.TgStore.findOne({ business_id: o.business_id });
    if (!s || String(q.message?.chat?.id) !== s.tg?.chat_id) return { toast: "Not this shop's chat · មិនមែនក្រុមហាងនេះ", alert: true };
    const by = [q.from?.first_name, q.from?.last_name].filter(Boolean).join(" ") || (q.from?.username ? `@${q.from.username}` : "Staff");
    try {
      const act = m[2];
      if (act === "riders") {
        const addons = await addonsOf(s.business_id);
        if (!addons.ts_riders.active || !s.riders?.chat_id) return { toast: "Riders' group not connected · មិនទាន់ភ្ជាប់ក្រុមអ្នកដឹក", alert: true };
        if (o.rider_msg?.message_id) return { toast: "Already sent · បានផ្ញើរួច" };
        await postToRiders(s, o, true);
        await postToGroup(s, o);
        return { toast: "🛵 Sent · បានផ្ញើ" };
      }
      if (act === "paid") await markPaid(s, o, by);
      else if (act === "accept") await moveOrder(s, o, "accepted", by);
      else if (act === "eta15" || act === "eta30") await moveOrder(s, o, "accepted", by, { eta: act === "eta15" ? 15 : 30 });
      else if (act === "reject") await moveOrder(s, o, "cancelled", by, { reason: "Rejected by the shop" });
      else await moveOrder(s, o, act, by);
    } catch (err) {
      if (err instanceof Bad) {
        await postToGroup(s, await M.TgOrder.findById(o._id)); // show where it really is
        return { toast: "Already changed · បានប្តូររួចហើយ" };
      }
      throw err;
    }
    return { toast: "✅" };
  });

  // a rider presses a button under an order in the riders' group
  async function riderPress(oid, act, q) {
    const o = await M.TgOrder.findById(oid);
    if (!o) return { toast: "Order not found · រកមិនឃើញ", alert: true };
    const s = await M.TgStore.findOne({ business_id: o.business_id });
    if (!s || String(q.message?.chat?.id) !== s.riders?.chat_id) return { toast: "Not this shop's riders · មិនមែនក្រុមអ្នកដឹកហាងនេះ", alert: true };
    const me = { tg_id: String(q.from?.id || ""), name: ([q.from?.first_name, q.from?.last_name].filter(Boolean).join(" ") || (q.from?.username ? `@${q.from.username}` : "Rider")).slice(0, 60), username: String(q.from?.username || "").slice(0, 40) };
    if (!me.tg_id) return { toast: "?" };
    const mine = o.rider?.tg_id && o.rider.tg_id === me.tg_id;
    const refresh = async () => postToRiders(s, await M.TgOrder.findById(o._id));
    if (["done", "cancelled"].includes(o.status)) {
      await refresh();
      return { toast: o.status === "done" ? "Already delivered · ដឹករួចហើយ" : "Cancelled · បានបោះបង់", alert: true };
    }
    if (act === "take") {
      if (o.status === "new") return { toast: "The shop hasn't accepted it yet · ហាងមិនទាន់ទទួល", alert: true };
      const after = await M.TgOrder.findOneAndUpdate(
        { _id: o._id, "rider.tg_id": { $in: [null, ""] }, status: { $in: ["accepted", "ready", "on_way"] } },
        { $set: { rider: { ...me, taken_at: new Date(), picked_at: null, delivered_at: null } }, $push: { timeline: { status: "rider", at: new Date(), by: me.name } } },
        { returnDocument: "after" },
      );
      if (!after) {
        await refresh();
        return { toast: `Taken by ${o.rider?.name || "another rider"} · មានអ្នកយករួច`, alert: true };
      }
      await postToRiders(s, after);
      await postToGroup(s, after);
      await tellCustomer(s, after, CUSTOMER_TEXT.taken(after));
      return { toast: "✋ It's yours · ជារបស់អ្នក" };
    }
    if (!mine) return { toast: o.rider?.tg_id ? `Taken by ${o.rider.name} · ${o.rider.name} បានយក` : "Tap “Take it” first · ចុច “យក” ជាមុន", alert: true };
    if (act === "back") {
      if (o.rider.picked_at) return { toast: "Already picked up · បានយករួច", alert: true };
      const after = await M.TgOrder.findOneAndUpdate({ _id: o._id, "rider.tg_id": me.tg_id, "rider.picked_at": null }, { $set: { rider: { tg_id: "", name: "", username: "" } } }, { returnDocument: "after" });
      if (after) {
        await postToRiders(s, after);
        await postToGroup(s, after);
      }
      return { toast: "↩️" };
    }
    try {
      if (act === "picked") {
        const after = await M.TgOrder.findOneAndUpdate({ _id: o._id, "rider.tg_id": me.tg_id }, { $set: { "rider.picked_at": o.rider.picked_at || new Date() } }, { returnDocument: "after" });
        if (after.status === "on_way") await postToRiders(s, after);
        else await moveOrder(s, after, "on_way", me.name);
        return { toast: "📦 ✅" };
      }
      // delivered
      const after = await M.TgOrder.findOneAndUpdate({ _id: o._id, "rider.tg_id": me.tg_id }, { $set: { "rider.delivered_at": new Date(), "rider.picked_at": o.rider.picked_at || new Date() } }, { returnDocument: "after" });
      await moveOrder(s, after, "done", me.name);
      return { toast: "🎉" };
    } catch (err) {
      if (err instanceof Bad) {
        await refresh();
        return { toast: "Already changed · បានប្តូររួចហើយ" };
      }
      throw err;
    }
  }

  // ---------------------------------------- public: the store ----------------------------------------
  async function openStore(slug) {
    const sl = str(slug, 60).toLowerCase();
    const s = sl ? (await M.TgStore.findOne({ slug: sl })) || (await M.TgStore.findOne({ old_slugs: sl })) : null;
    if (!s) throw new Bad(MSG.storeOff, 404, { code: "not_found" });
    const [business, license] = await Promise.all([Business.findOne({ _id: s.business_id, deleted: false }), licenseState(s.business_id)]);
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || !owner?.status || license.locked) throw new Bad(MSG.storeOff, 404, { code: "off" });
    return { store: s, business, license, addons: await addonsOf(s.business_id) };
  }
  const pub = (path) => `/api/public/tgstore${path}`;
  const orderLimiter = rate_limit({ windowMs: 10 * 60 * 1000, max: 20, message: MSG.slow });
  const proofLimiter = rate_limit({ windowMs: 10 * 60 * 1000, max: 10, message: MSG.slow });
  const who = (req) => tgUser(req.get("x-tg-init-data"));

  prop.app.get(
    pub("/:slug"),
    handle(async (req, res) => {
      if (req.params.slug === "order") throw new Bad(MSG.storeOff, 404);
      const { store, license, addons } = await openStore(req.params.slug);
      const now = openNow(store, license, addons);
      const [cats, products, links] = await Promise.all([
        M.TgCategory.find({ business_id: store.business_id, deleted: false }).sort({ sort: 1, created_date: 1 }).lean(),
        M.TgProduct.find({ business_id: store.business_id, deleted: false, hidden: false }).sort({ sort: 1, created_date: 1 }).lean(),
        linksOf(store),
      ]);
      res.set("Cache-Control", "no-store");
      res.json({
        success: true,
        data: {
          store: { ...lookOut(store), ...(THEMES.KEYS.includes(String(req.query.theme || "")) ? { theme: String(req.query.theme), preview: true } : {}), open: now.open, opens: now.next, hours: hoursOut(store, addons), promo: !!addons.ts_promos.active, brand: !addons.ts_nobrand.active, again: !!addons.ts_remind.active, zones: store.delivery?.on ? zonesOut(store, addons) : null, pin: !!(store.delivery?.on && (zonesOn(store, addons) || (addons.ts_riders.active && store.riders?.chat_id))) },
          categories: cats.map(categoryOut),
          products: products.map(productOut).map(({ hidden, sort, ...p }) => p), // eslint-disable-line no-unused-vars
          telegram: links.telegram,
        },
      });
    }),
  );
  prop.app.get(
    pub("/:slug/me"),
    handle(async (req, res) => {
      const { store, addons } = await openStore(req.params.slug);
      const u = who(req);
      if (!u) return res.json({ success: true, data: { telegram: false, orders: [] } });
      const [c, cart] = await Promise.all([M.TgCustomer.findOne({ business_id: store.business_id, tg_id: u.tg_id }).lean(), addons.ts_remind.active ? M.TgCart.findOne({ business_id: store.business_id, tg_id: u.tg_id }).lean() : null]);
      const orders = c
        ? await M.TgOrder.find({ business_id: store.business_id, customer_id: c._id })
            .sort({ created_date: -1 })
            .limit(10)
            .lean()
        : [];
      res.json({
        success: true,
        data: {
          telegram: true,
          name: c?.name || u.name,
          phone: c?.phone || "",
          address: c?.address || "",
          can_message: !!(c?.can_message || u.can_message),
          pin: c?.pin?.lat !== null && c?.pin?.lat !== undefined ? { lat: c.pin.lat, lng: c.pin.lng } : null,
          orders: orders.map((o) => ({ token: o.token, no: o.no, total: o.total, currency: o.currency, status: o.status, created_date: o.created_date, items: o.items.length })),
          // add-on ts_remind: the cart they left (to put it back) + the last order (for "Order again")
          cart: cart?.items?.length ? cart.items.map((l) => ({ product_id: l.product_id, qty: l.qty, options: l.options || [], note: l.note || "" })) : [],
          last: addons.ts_remind.active && orders[0] ? { token: orders[0].token, no: orders[0].no, total: orders[0].total, created_date: orders[0].created_date, items: orders[0].items.map((l) => ({ product_id: l.product_id, name: l.name, qty: l.qty, options: (l.options || []).map((x) => ({ group: x.group, choice: x.choice })), note: l.note || "" })) } : null,
        },
      });
    }),
  );

  // what a Telegram customer has in the cart (add-on ts_remind): kept for the reminder, cleared by the order
  const cartLimiter = rate_limit({ windowMs: 10 * 60 * 1000, max: 120, message: MSG.slow });
  prop.app.put(
    pub("/:slug/cart"),
    cartLimiter,
    handle(async (req, res) => {
      const { store: s, addons } = await openStore(req.params.slug);
      const u = who(req);
      if (!u || !addons.ts_remind.active) return res.json({ success: true, data: { saved: false } });
      const lines = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, LIMITS.items).filter((l) => validId(l?.product_id));
      if (!lines.length) {
        await M.TgCart.deleteOne({ business_id: s.business_id, tg_id: u.tg_id });
        return res.json({ success: true, data: { saved: true, n: 0 } });
      }
      const products = await M.TgProduct.find({ _id: { $in: lines.map((l) => l.product_id) }, business_id: s.business_id, deleted: false }).select("price").lean();
      const price = new Map(products.map((p) => [String(p._id), p.price]));
      const items = lines
        .filter((l) => price.has(String(l.product_id)))
        .map((l) => ({
          product_id: l.product_id,
          qty: int(l.qty, 1, LIMITS.qty, 1),
          options: (Array.isArray(l.options) ? l.options : []).slice(0, 20).map((x) => ({ group: str(x?.group, 40), choice: str(x?.choice, 40) })),
          note: str(l.note, 120),
        }));
      const total = money(
        items.reduce((a, l) => a + price.get(String(l.product_id)) * l.qty, 0),
        s.currency,
      );
      // the same cart again (they opened the store): leave its time and reminder alone
      const same = (l) => JSON.stringify((l || []).map((x) => [String(x.product_id), x.qty, (x.options || []).map((o) => [o.group, o.choice]), x.note || ""]));
      const was = await M.TgCart.findOne({ business_id: s.business_id, tg_id: u.tg_id }).select("items").lean();
      if (was && same(was.items) === same(items)) return res.json({ success: true, data: { saved: true, n: items.length, same: true } });
      await M.TgCart.findOneAndUpdate(
        { business_id: s.business_id, tg_id: u.tg_id },
        { $set: { name: u.name, username: u.username, items, total, at: new Date(), reminded_at: null, reminded: false, ...(u.can_message ? { can_message: true } : {}) }, $setOnInsert: { business_id: s.business_id, tg_id: u.tg_id } },
        { upsert: true },
      );
      res.json({ success: true, data: { saved: true, n: items.length } });
    }),
  );

  // the delivery fee for a place (add-on ts_zones): { pin } or { area }
  prop.app.post(
    pub("/:slug/fee"),
    cartLimiter,
    handle(async (req, res) => {
      const { store: s, addons } = await openStore(req.params.slug);
      if (!s.delivery.on || !zonesOn(s, addons)) throw new Bad(MSG.badMode, 400, { code: "no_zones" });
      const pin = req.body?.pin ? pinOf(req.body.pin) : null;
      if (req.body?.pin && !pin) throw new Bad(MSG.badPin, 400, { code: "bad_pin" });
      const z = zoneFee(s, { area: req.body?.area, pin });
      res.json({ success: true, data: { fee: money(z.fee, s.currency), km: z.zone.km, name: z.zone.name, min_order: z.min_order, pin } });
    }),
  );

  // check a promo code in the cart (the order works it out again)
  prop.app.post(
    pub("/:slug/promo"),
    orderLimiter,
    handle(async (req, res) => {
      const { store: s, addons } = await openStore(req.params.slug);
      if (!addons.ts_promos.active) throw new Bad(MSG.badPromo, 400, { code: "bad_promo" });
      const subtotal = money(req.body?.subtotal || 0, s.currency) ?? 0;
      const { promo, off } = await promoFor(s, req.body?.code, subtotal);
      res.json({ success: true, data: { code: promo.code, kind: promo.kind, value: promo.value, min_order: promo.min_order, off } });
    }),
  );

  // place an order: prices, choices and stock are worked out here, never trusted from the phone
  prop.app.post(
    pub("/:slug/orders"),
    orderLimiter,
    handle(async (req, res) => {
      const { store: s, license, addons } = await openStore(req.params.slug);
      if (!openNow(s, license, addons).open) throw new Bad(MSG.closed, 409, { code: "closed" });
      const b = req.body || {};
      const u = who(req);
      const cur = s.currency;
      const mode = ["delivery", "pickup", "dine_in"].includes(b.mode) ? b.mode : "";
      if (!mode || !s[mode]?.on) throw new Bad(MSG.badMode, 400, { code: "bad_mode" });
      const lines = Array.isArray(b.items) ? b.items.slice(0, LIMITS.items) : [];
      if (!lines.length) throw new Bad(MSG.emptyCart, 400, { code: "empty" });
      const ids = [...new Set(lines.map((l) => String(l?.product_id || "")).filter(validId))];
      const products = await M.TgProduct.find({ _id: { $in: ids }, business_id: s.business_id, deleted: false, hidden: false }).lean();
      const byId = new Map(products.map((p) => [String(p._id), p]));
      const items = [];
      const want = new Map(); // product → qty, for the stock
      for (const l of lines) {
        const p = byId.get(String(l?.product_id || ""));
        if (!p) throw new Bad(fill(MSG.soldOut, { name: "?" }), 409, { code: "gone" });
        if (p.sold_out || p.stock === 0) throw new Bad(fill(MSG.soldOut, { name: p.name }), 409, { code: "sold_out", product_id: p._id });
        const qty = int(l.qty, 1, LIMITS.qty, 1);
        const picked = Array.isArray(l.options) ? l.options : [];
        const opts = [];
        for (const g of p.options || []) {
          const mine = picked.filter((x) => x?.group === g.name);
          const choices = mine.map((x) => g.choices.find((c) => c.name === x?.choice)).filter(Boolean);
          if (g.required && !choices.length) throw new Bad(fill(MSG.needChoice, { group: g.name, name: p.name }), 400, { code: "need_choice", product_id: p._id });
          for (const c of g.multi ? choices : choices.slice(0, 1)) opts.push({ group: g.name, choice: c.name, price: c.price || 0 });
        }
        const one = money(p.price + opts.reduce((a, x) => a + x.price, 0), cur);
        items.push({ product_id: p._id, name: p.name, price: one, qty, options: opts, note: str(l.note, 120), total: money(one * qty, cur) });
        want.set(String(p._id), (want.get(String(p._id)) || 0) + qty);
      }
      const subtotal = money(items.reduce((a, l) => a + l.total, 0), cur);
      let fee = 0;
      let zone = null;
      const pin = mode === "delivery" && b.pin ? pinOf(b.pin) : null;
      if (mode === "delivery" && b.pin && !pin) throw new Bad(MSG.badPin, 400, { code: "bad_pin" });
      if (mode === "delivery") {
        if (s.delivery.min_order && subtotal < s.delivery.min_order) throw new Bad(fill(MSG.minOrder, { amount: fmtMoney(s.delivery.min_order, cur) }), 400, { code: "min_order" });
        // delivery zones (add-on ts_zones): the fee of the area / the distance
        const z = zonesOn(s, addons) ? zoneFee(s, { area: b.area, pin }) : null;
        if (z?.min_order && subtotal < z.min_order) throw new Bad(fill(MSG.minOrder, { amount: fmtMoney(z.min_order, cur) }), 400, { code: "min_order" });
        zone = z ? z.zone : pin ? { name: "", km: null, ...pin } : null;
        fee = s.delivery.free_from && subtotal >= s.delivery.free_from ? 0 : money(z ? z.fee : s.delivery.fee || 0, cur);
      }
      // a promo code (add-on ts_promos): worked out here from the real subtotal
      let promo = null;
      if (b.promo && String(b.promo).trim()) {
        if (!addons.ts_promos.active) throw new Bad(MSG.badPromo, 400, { code: "bad_promo" });
        promo = await promoFor(s, b.promo, subtotal);
      }
      const discount = promo?.off || 0;
      const total = money(Math.max(0, subtotal - discount) + fee, cur);
      const own = /^custom:[a-f0-9]{24}$/.test(String(b.pay || "")) ? s.pay.custom.id(String(b.pay).slice(7)) : null;
      const method = b.pay === "khqr" ? "khqr" : own ? "custom" : "cash";
      if (method === "khqr" && !(s.pay.khqr.on && khqr.isBakongId(s.pay.khqr.bakong_id))) throw new Bad(MSG.badPay, 400, { code: "bad_pay" });
      if (method === "cash" && !s.pay.cash.on) throw new Bad(MSG.badPay, 400, { code: "bad_pay" });
      if (method === "custom" && !own.on) throw new Bad(MSG.badPay, 400, { code: "bad_pay" });
      const name = str(b.name, 80) || u?.name || "";
      const phone = phoneOf(b.phone);
      if (phone === null) throw new Bad(MSG.needPhone, 400, { code: "bad_phone" });
      if (mode !== "dine_in" && !phone) throw new Bad(MSG.needPhone, 400, { code: "need_phone" });
      if (!name && !u) throw new Bad(MSG.needName, 400, { code: "need_name" });
      const address = str(b.address, 200);
      if (mode === "delivery" && address.length < 3) throw new Bad(MSG.needAddress, 400, { code: "need_address" });
      const table = mode === "dine_in" ? str(b.table, 10) : "";
      if (mode === "dine_in" && !table) throw new Bad(MSG.needTable, 400, { code: "need_table" });

      // take the stock (all or nothing)
      const taken = [];
      for (const [pid, qty] of want) {
        const p = byId.get(pid);
        if (p.stock === null || p.stock === undefined) continue;
        const r = await M.TgProduct.updateOne({ _id: pid, stock: { $gte: qty } }, { $inc: { stock: -qty } });
        if (!r.modifiedCount) {
          for (const [tid, tq] of taken) await M.TgProduct.updateOne({ _id: tid }, { $inc: { stock: tq } });
          const now = await M.TgProduct.findById(pid).select("stock").lean();
          throw new Bad(now?.stock ? fill(MSG.notEnough, { name: p.name, n: now.stock }) : fill(MSG.soldOut, { name: p.name }), 409, { code: "stock", product_id: p._id, left: now?.stock || 0 });
        }
        taken.push([pid, qty]);
      }

      // use the code once (all or nothing, like the stock)
      if (promo) {
        const used = await M.TgPromo.updateOne({ _id: promo.promo._id, on: true, ...(promo.promo.max_uses ? { used: { $lt: promo.promo.max_uses } } : {}) }, { $inc: { used: 1 } });
        if (!used.modifiedCount) {
          for (const [tid, tq] of taken) await M.TgProduct.updateOne({ _id: tid }, { $inc: { stock: tq } });
          throw new Bad(MSG.badPromo, 400, { code: "bad_promo" });
        }
      }

      // who is ordering
      let customer = null;
      const custSet = { name: name.slice(0, 80), ...(phone ? { phone } : {}), ...(mode === "delivery" ? { address } : {}), ...(pin ? { pin } : {}) };
      if (u) {
        customer = await M.TgCustomer.findOneAndUpdate(
          { business_id: s.business_id, tg_id: u.tg_id },
          { $set: { ...custSet, username: u.username, last_order_at: new Date(), ...(u.can_message || b.can_message === true ? { can_message: true } : {}) }, $inc: { placed: 1 }, $setOnInsert: { business_id: s.business_id, tg_id: u.tg_id } },
          { upsert: true, returnDocument: "after" },
        );
      } else if (phone) {
        customer = await M.TgCustomer.findOneAndUpdate({ business_id: s.business_id, phone, tg_id: "" }, { $set: { ...custSet, last_order_at: new Date() }, $inc: { placed: 1 }, $setOnInsert: { business_id: s.business_id, tg_id: "" } }, { upsert: true, returnDocument: "after" });
      }

      const seq = await M.TgStore.findOneAndUpdate({ _id: s._id }, { $inc: { seq: 1 } }, { returnDocument: "after" })
        .select("seq")
        .lean();
      const o = new M.TgOrder({
        business_id: s.business_id,
        no: seq.seq,
        token: token(24),
        mode,
        table,
        address: mode === "delivery" ? address : "",
        note: str(b.note, 300),
        customer_id: customer?._id || null,
        customer: { tg_id: u?.tg_id || "", username: u?.username || "", name, phone: phone || "" },
        items,
        subtotal,
        discount,
        promo: promo ? promo.promo.code : "",
        fee,
        total,
        currency: cur,
        pay: { method, status: "unpaid", ...(own ? { custom: { id: String(own._id), name: own.name, info: own.info, image: addons.ts_pay.active ? own.image?.url || "" : "" } } : {}) },
        timeline: [{ status: "new", at: new Date(), by: name || "Customer" }],
        via: u ? "telegram" : "web",
        ...(zone ? { zone } : {}),
      });
      // the cart is now an order (add-on ts_remind): after a reminder, count it as won back
      const cart = u ? await M.TgCart.findOneAndDelete({ business_id: s.business_id, tg_id: u.tg_id }).lean() : null;
      if (cart?.reminded) o.from_remind = true;
      if (method === "khqr") {
        const expires = new Date(Date.now() + 60 * 60000);
        const k = khqr.build({ bakongId: s.pay.khqr.bakong_id, name: s.pay.khqr.account_name || s.shop_name, amount: total, currency: cur, bill: `TG${o.no}`, store: s.shop_name, expiresAt: expires });
        o.pay.khqr = { qr: k.qr, md5: k.md5, amount: total, expires };
      }
      try {
        await o.save();
      } catch (err) {
        for (const [tid, tq] of taken) await M.TgProduct.updateOne({ _id: tid }, { $inc: { stock: tq } });
        if (promo) await M.TgPromo.updateOne({ _id: promo.promo._id }, { $inc: { used: -1 } });
        throw err;
      }
      if (o.from_remind) await M.TgStore.updateOne({ _id: s._id }, { $inc: { "remind.back": 1, "remind.back_total": total } });
      await postToGroup(s, o);
      res.status(201).json({ success: true, data: { token: o.token, no: o.no, total, currency: cur } });
    }),
  );

  // follow one order (the customer's private link). A KHQR order is checked with Bakong at most every 10 s.
  async function publicOrder(t) {
    const tk = str(t, 40);
    const o = tk.length >= 16 ? await M.TgOrder.findOne({ token: tk }) : null;
    if (!o) throw new Bad(MSG.orderGone, 404, { code: "not_found" });
    const s = await M.TgStore.findOne({ business_id: o.business_id });
    return { o, s };
  }
  prop.app.get(
    pub("/order/:token"),
    handle(async (req, res) => {
      let { o, s } = await publicOrder(req.params.token);
      if (o.pay.method === "khqr" && o.pay.status !== "paid" && o.status !== "cancelled" && khqr.configured() && o.pay.khqr?.md5) {
        const last = o.pay.khqr.checked_at ? new Date(o.pay.khqr.checked_at).getTime() : 0;
        if (Date.now() - last > 10000) {
          await M.TgOrder.updateOne({ _id: o._id }, { $set: { "pay.khqr.checked_at": new Date() } });
          const r = await khqr.check(o.pay.khqr.md5).catch(() => null);
          if (r?.paid && Math.round(r.amount * 100) >= Math.round((o.pay.khqr.amount || 0) * 100)) o = await markPaid(s, o, "KHQR · Bakong");
        }
      }
      res.set("Cache-Control", "no-store");
      const kq = o.pay.method === "khqr" && o.pay.status !== "paid" ? { qr: o.pay.khqr?.qr || "", amount: o.pay.khqr?.amount || o.total, expires: o.pay.khqr?.expires || null, name: s.pay.khqr.account_name || s.shop_name, auto: khqr.configured() } : null;
      const addons = await addonsOf(o.business_id);
      res.json({ success: true, data: { order: orderOut(o), khqr: kq, store: { ...lookOut(s), brand: !addons.ts_nobrand.active, again: !!addons.ts_remind.active } } });
    }),
  );
  prop.app.post(
    pub("/order/:token/proof"),
    proofLimiter,
    oneImage("photo"),
    handle(async (req, res) => {
      const { o, s } = await publicOrder(req.params.token);
      if (!req.file) throw new Bad(MSG.noFile);
      if (o.pay.status === "paid" || o.status === "cancelled") return res.json({ success: true, data: { order: orderOut(o) } });
      const up = await cloud.uploadBuffer(req.file, "tgstore-proof");
      const old = o.pay.proof?.public_id;
      const after = await M.TgOrder.findOneAndUpdate({ _id: o._id }, { $set: { "pay.status": "proof", "pay.proof": { url: up.url, public_id: up.public_id } } }, { returnDocument: "after" });
      if (old) cloud.deleteFile(old).catch(() => {});
      await postToGroup(s, after);
      if (s.tg?.chat_id && telegram.ready()) telegram.sendPhoto(s.tg.chat_id, up.url, `🧾 #${after.no} · ${fmtMoney(after.total, after.currency)} — payment screenshot · រូបថតការបង់ប្រាក់`, groupKeys(after)).catch(() => {});
      res.json({ success: true, data: { order: orderOut(after) } });
    }),
  );
};

Object.assign(module.exports, { tgUser, licenseState, groupText, riderText, tick, pinOf, kmBetween });
