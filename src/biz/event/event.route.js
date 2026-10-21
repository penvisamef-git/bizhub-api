// Event Tickets (75 coins / year): concerts, shows, workshops… The organiser makes events with ticket types
// (Standard / Gold / Premium: price + quantity) or free registration. Buyers open the event page, pick tickets,
// pay with the organiser's own KHQR / pay link and send the screenshot; the organiser approves → each person
// gets a ticket QR (used once at the door). Free events: tickets at once.
// Add-ons: ev_doors (more door phones, yearly) · ev_team (more than 3 team members) · ev_cashier (sell at the gate)
//          · ev_invites (free / VIP tickets) · ev_export (guest list CSV) · ev_nobrand (no "Made with BizHub") — forever
//
// Owner base: /api/user/businesses/:id/events
//   GET  ""                     settings, license, add-ons, events (with counts), what waits
//   PUT  /settings              organiser, payment (bank, account, link), hold minutes
//   POST/DELETE /pay-qr (multipart "file")   POST/DELETE /logo (multipart "file")
//   GET  /events   POST /events   GET/PUT/DELETE /events/:eid   POST/DELETE /events/:eid/poster
//   GET  /orders?event&status&q&page   POST /orders/:oid/approve | /reject { reason } | /cancel { reason }
//   GET  /events/:eid/tickets?q&status&page   POST /tickets/:tid/checkin | /undo | /cancel
//   POST /events/:eid/invites { name, phone, key, qty }  (ev_invites)   GET /events/:eid/export (ev_export, CSV)
//   GET  /events/:eid/report
//   GET  /team   POST /team { name, role, pin }   PUT/DELETE /team/:mid   POST /pair-code   DELETE /devices/:did
//   POST /themes/:key { event_id }   buy a ticket design (ev_theme, 15 coins, forever) and use it on that event
//   POST /page-themes/:key { event_id }   buy an event page theme (ev_page_theme, 25 coins, forever) and use it on that event
// Public: /api/public/ev
//   GET  /e/:slug               the event page
//   POST /e/:slug/order { lines: [{ key, qty }], name, phone, note }  → { token }  (free event: tickets at once)
//   GET  /o/:token              the buyer's order: pay info while waiting, tickets once paid
//   POST /o/:token/proof (multipart "file", reference)
//   GET  /t/:code               one ticket
// Door phones: see event.door.js (/api/evdoor/*)
const mongoose = require("mongoose");
const crypto = require("crypto");
const multer = require("multer");
const M = require("./event.models");
const Business = require("../business.model");
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const { statusOf, buy, LicenseError, DAY } = require("../../license/license.service");
const { THEMES, FREE_THEMES, PAGE_THEMES, FREE_PAGE_THEMES, CERT_THEMES, FREE_CERT_THEMES } = require("./event.themes");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");
const { rate_limit } = require("../../util/rate_limit");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");

const PRODUCT = "event";
const ADDONS = ["ev_doors", "ev_team", "ev_cashier", "ev_invites", "ev_export", "ev_nobrand", "ev_telegram", "ev_guest_tg", "ev_seats", "ev_shows", "ev_promos", "ev_questions", "ev_autopay", "ev_certs", "ev_waitlist", "ev_pricing", "ev_referrals", "ev_bundles", "ev_feedback", "ev_sponsors"];
const YEARLY_ADDONS = ["ev_doors", "ev_telegram", "ev_guest_tg", "ev_autopay", "ev_referrals"];
const LIMITS = { devices: 1, devices_more: 20, team: 3, team_more: 50, events: 500 };
const GRACE_DAYS = 7;
const TZ = 7;
const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ! / Server problem, please try again later.",
  badId: "មិនមាន ID ត្រឹមត្រូវ! / Wrong ID.",
  notFound: "រកមិនឃើញអាជីវកម្ម! / Business not found.",
  notEvent: "អាជីវកម្មនេះមិនមែនជាសំបុត្រកម្មវិធីទេ! / This business is not Event Tickets.",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។ / This business is suspended.",
  locked: "សំបុត្រកម្មវិធីផុតកំណត់ហើយ! សូមបន្តដើម្បីប្រើប្រាស់។ / Event Tickets ended — please renew.",
  rowNotFound: "រកមិនឃើញ! / Not found.",
  saved: "បានរក្សាទុក! / Saved.",
  deleted: "បានលុប! / Deleted.",
  badValue: "តម្លៃមិនត្រឹមត្រូវ! / Wrong value.",
  badTheme: "រកមិនឃើញរចនានេះ! / This design doesn't exist.",
  themeLocked: "សូមទិញរចនានេះជាមុនសិន! / Buy this design first.",
  needTitle: "សូមបញ្ចូលឈ្មោះកម្មវិធី! / Please type the event name.",
  needDate: "សូមបញ្ចូលថ្ងៃ និងម៉ោងកម្មវិធី! / Please set the date and time.",
  needType: "សូមបន្ថែមប្រភេទសំបុត្រយ៉ាងហោចណាស់មួយ! / Add at least one ticket type.",
  needName: "សូមបញ្ចូលឈ្មោះ! / Please type your name.",
  badPhone: "សូមបញ្ចូលលេខទូរស័ព្ទត្រឹមត្រូវ! / Please type a correct phone number.",
  badImage: "សូមដាក់រូបភាព JPG / PNG / WEBP (តិចជាង 5MB)! / JPG, PNG or WEBP under 5 MB please.",
  noFile: "សូមជ្រើសរើសរូបភាព! / Please choose a picture.",
  noPay: "អ្នករៀបចំមិនទាន់ដាក់ QR បង់ប្រាក់ទេ។ / The organiser hasn't added a payment QR yet.",
  needPayQr: "សូមដាក់ QR បង់ប្រាក់ (ការកំណត់) មុនពេលបើកលក់សំបុត្រ! / Add your payment QR (Settings) before selling paid tickets.",
  closed: "កម្មវិធីនេះឈប់លក់សំបុត្រហើយ។ / Ticket sales for this event are closed.",
  cancelledEv: "កម្មវិធីនេះត្រូវបានលុបចោល។ / This event was cancelled.",
  soldOut: "សំបុត្រប្រភេទនេះលក់អស់ហើយ ឬនៅសល់មិនគ្រប់។ / Not enough tickets left of this type.",
  tooMany: "សំបុត្រច្រើនពេកក្នុងមួយការកម្ម៉ង់! / Too many tickets in one order.",
  emptyOrder: "សូមជ្រើសរើសសំបុត្រ! / Please choose tickets.",
  notWaiting: "ការកម្ម៉ង់នេះមិនកំពុងរង់ចាំទេ។ / This order is not waiting any more.",
  expired: "ពេលវេលាបង់ប្រាក់ផុតហើយ។ សូមកម្ម៉ង់ម្តងទៀត។ / Time to pay is over — please order again.",
  hasPaid: "កម្មវិធីនេះមានសំបុត្របានលក់ហើយ — សូមលុបចោលកម្មវិធីជំនួសវិញ។ / Tickets were sold — cancel the event instead.",
  typeSold: "មិនអាចលុបប្រភេទដែលបានលក់ហើយ — បិទវាជំនួសវិញ។ / A type with sold tickets can't be removed — turn it off instead.",
  qtyLow: "ចំនួនតិចជាងសំបុត្រដែលបានលក់ហើយ! / Quantity is lower than tickets already sold.",
  pinBad: "PIN ត្រូវមាន 4 ខ្ទង់! / The PIN must have 4 digits.",
  pinTaken: "PIN នេះមានគេប្រើហើយ! / Another team member uses this PIN.",
  teamLimit: "ក្រុមការងារឥតគិតថ្លៃមានតែ 3 នាក់។ សូមដោះសោ “ក្រុមការងារច្រើន”។ / 3 team members are free — unlock “More team members”.",
  teamMax: "ក្រុមការងារច្រើនពេក! / Too many team members.",
  needCashier: "សូមដោះសោ “អ្នកលក់នៅច្រកចូល” ជាមុនសិន! / Unlock “Gate cashier” first.",
  needInvites: "សូមដោះសោ “សំបុត្រអញ្ជើញ” ជាមុនសិន! / Unlock “Free / VIP invites” first.",
  needExport: "សូមដោះសោ “នាំចេញបញ្ជីភ្ញៀវ” ជាមុនសិន! / Unlock “Guest list export” first.",
  eventLimit: "កម្មវិធីច្រើនពេក! / Too many events.",
  ticketOff: "សំបុត្រនេះមិនដំណើរការទេ។ / This ticket doesn't work.",
  slow: "សូមរង់ចាំបន្តិច រួចព្យាយាមម្តងទៀត។ / Please wait a moment and try again.",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។ / Not enough coins.",
  busy: "កំពុងដំណើរការ សូមព្យាយាមម្តងទៀត! / Busy, try again.",
  pickShow: "សូមជ្រើសរើសថ្ងៃ និងម៉ោង! / Please choose a date and time.",
  showClosed: "ម៉ោងនេះឈប់លក់ហើយ។ / This show is no longer on sale.",
  showSold: "មិនអាចលុបម៉ោងដែលមានសំបុត្របានលក់ហើយ — បិទវាជំនួសវិញ។ / A show with tickets can't be removed — turn it off instead.",
  showsAfterSales: "កម្មវិធីនេះលក់សំបុត្របាត់ហើយ — សូមបង្កើតកម្មវិធីថ្មីដែលមានម៉ោងច្រើន។ / Tickets are already sold — make a new event with showtimes.",
  pickSeats: "សូមជ្រើសរើសកៅអីឲ្យគ្រប់! / Please choose your seats.",
  badSeat: "កៅអីនេះមិនមានទេ! / This seat doesn't exist.",
  seatTaken: "កៅអីខ្លះទើបតែមានគេយក — សូមជ្រើសម្តងទៀត។ / Some seats were just taken — please choose again.",
  seatsSold: "កៅអីដែលបានលក់ហើយត្រូវតែនៅដដែល! / Seats already sold must stay on the map.",
  promoBad: "លេខកូដបញ្ចុះតម្លៃមិនត្រឹមត្រូវ! / This promo code doesn't work.",
  promoEnded: "លេខកូដបញ្ចុះតម្លៃផុតកំណត់ហើយ! / This promo code has ended.",
  promoUsed: "លេខកូដបញ្ចុះតម្លៃត្រូវបានប្រើអស់ហើយ! / This promo code is used up.",
  promoMin: "ត្រូវទិញយ៉ាងហោចណាស់ {n} សំបុត្រ! / Buy at least {n} tickets for this code.",
  promoTaken: "លេខកូដនេះមានហើយ! / This code already exists.",
  needAnswer: "សូមឆ្លើយ៖ {q} / Please answer: {q}",
  badAnswer: "ចម្លើយមិនត្រឹមត្រូវ៖ {q} / Please check: {q}",
  needShows: "សូមដោះសោ “ម៉ោងច្រើន” ជាមុនសិន! / Unlock “Showtimes” first.",
  needSeats: "សូមដោះសោ “ផែនទីកៅអី” ជាមុនសិន! / Unlock “Seat map” first.",
  needPromos: "សូមដោះសោ “លេខកូដបញ្ចុះតម្លៃ” ជាមុនសិន! / Unlock “Promo codes” first.",
  needQuestions: "សូមដោះសោ “សំណួរចុះឈ្មោះ” ជាមុនសិន! / Unlock “Registration questions” first.",
  needGuestTg: "សូមដោះសោ “តេឡេក្រាមសម្រាប់ភ្ញៀវ” ជាមុនសិន! / Unlock “Telegram for guests” first.",
  needOrgTg: "សូមដោះសោ “តេឡេក្រាមសម្រាប់អ្នករៀបចំ” ជាមុនសិន! / Unlock “Telegram for organisers” first.",
  needAddon: "សូមដោះសោសេវាបន្ថែមនេះជាមុនសិន! / Unlock this add-on first.",
  needAutopay: "សូមដោះសោ “បង់ប្រាក់ KHQR ស្វ័យប្រវត្តិ” ជាមុនសិន! / Unlock “Automatic KHQR payment” first.",
  needCerts: "សូមដោះសោ “វិញ្ញាបនបត្រ” ជាមុនសិន! / Unlock “Certificates” first.",
  badBakong: "Bakong ID មិនត្រឹមត្រូវ (ឧ. name@aba)! / Wrong Bakong ID (e.g. name@aba).",
  badDoc: "សូមដាក់ PDF / JPG / PNG (តិចជាង 10MB)! / PDF, JPG or PNG under 10 MB please.",
};
class Bad extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const validId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && String(v).length === 24;
const str = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
const int = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const randCode = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHA[b % ALPHA.length]).join("");
const token = (n = 24) => crypto.randomBytes(n * 2).toString("base64url").replace(/[-_]/g, "").slice(0, n);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const pinKey = (bid, pin) => sha(`ev:${bid}:${pin}`);
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hexColor = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? String(v) : "");
function phoneOf(v) {
  let d = String(v ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("855")) d = `0${d.slice(3)}`;
  if (!d.startsWith("0")) d = `0${d}`;
  return d.length >= 9 && d.length <= 11 ? d : null;
}
// a pay link / map link: https only, "" clears it
const httpsLink = (v) => {
  const s = String(v ?? "").trim().slice(0, 300);
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol === "https:") return u.toString();
  } catch {
    /* not a link */
  }
  throw new Bad(MSG.badValue, 400, { code: "bad_link" });
};
const slugBase = (s) =>
  String(s || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
const dateOf = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const localDay = (d = new Date()) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 10);
const X = require("./event.extras")({ Bad, MSG, str, int, r2, randCode });
const khqr = require("../../util/khqr");
// Telegram (event.telegram.js fills these in): an order waits for review / is paid / was rejected
const hooks = { freed: async () => {}, sendCerts: async () => 0, review: async () => {}, paid: async () => {}, rejected: async () => {}, view: async () => ({}), broadcast: async () => 0, sendDoc: async () => 0 };
const fire = (name, ...args) => hooks[name](...args).catch((err) => console.error("[event tg]", err.message));

// ---------- license ----------
async function licenseState(businessId) {
  const rows = await License.find({ business_id: businessId, product: { $in: [PRODUCT, ...ADDONS, "ev_theme", "ev_page_theme", "ev_cert_theme"] } }).lean();
  const main = rows.find((r) => r.product === PRODUCT && !r.item);
  const license = statusOf(main);
  const endedAt = license.expires_at ? new Date(license.expires_at).getTime() : null;
  license.grace_until = endedAt ? new Date(endedAt + GRACE_DAYS * DAY) : null;
  license.locked = !main || (!license.active && endedAt !== null && Date.now() > endedAt + GRACE_DAYS * DAY);
  license.in_grace = !!main && !license.active && !license.locked;
  license.read_only = !license.active;
  const addons = {};
  for (const key of ADDONS) addons[key] = statusOf(rows.find((r) => r.product === key && !r.item));
  const themes = [...FREE_THEMES, ...rows.filter((r) => r.product === "ev_theme" && r.item && THEMES[r.item] && statusOf(r).active).map((r) => r.item)];
  const pageThemes = [...FREE_PAGE_THEMES, ...rows.filter((r) => r.product === "ev_page_theme" && r.item && PAGE_THEMES[r.item] && statusOf(r).active).map((r) => r.item)];
  const certThemes = [...FREE_CERT_THEMES, ...rows.filter((r) => r.product === "ev_cert_theme" && r.item && CERT_THEMES[r.item] && statusOf(r).active).map((r) => r.item)];
  return {
    license,
    addons,
    themes,
    pageThemes,
    certThemes,
    limits: { devices: addons.ev_doors.active ? LIMITS.devices_more : LIMITS.devices, team: addons.ev_team.active ? LIMITS.team_more : LIMITS.team },
  };
}

async function settingsOf(business) {
  const found = await M.EvSettings.findOne({ business_id: business._id });
  // the one payment of before becomes the first payment method
  if (found && !found.pay_methods?.length && (found.pay?.qr?.url || found.pay?.link || found.pay?.account_no)) {
    oldToFirst(found);
    await found.save();
  }
  if (found) return found;
  try {
    return await M.EvSettings.create({ business_id: business._id, org_name: business.name || "", phone: business.phone || "" });
  } catch (err) {
    if (err.code === 11000) return M.EvSettings.findOne({ business_id: business._id });
    throw err;
  }
}
async function freeSlug(title, not) {
  const base = slugBase(title) || "event";
  for (let i = 0; i < 20; i += 1) {
    const s = i === 0 ? base : `${base}-${randCode(4).toLowerCase()}`;
    if (!(await M.EvEvent.exists({ slug: s, ...(not ? { _id: { $ne: not } } : {}) }))) return s;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// ---------- tickets: hold, release, make ----------
// orders that waited too long for their screenshot: give their tickets back
async function releaseExpired(filter = {}) {
  const old = await M.EvOrder.find({ ...filter, status: "pending", hold_until: { $lt: new Date() } })
    .select("_id business_id event_id lines show seats promo")
    .limit(300)
    .lean();
  for (const o of old) {
    const r = await M.EvOrder.updateOne({ _id: o._id, status: "pending" }, { $set: { status: "expired" } });
    if (r.modifiedCount) await giveBack(o);
  }
}
// lines: what to give back (default: all the order's lines). With an _id the order's seats + promo code are freed too.
async function giveBack(order, { lines, keepPromo } = {}) {
  if (order._id) {
    await X.freeSeats(order._id);
    if (!keepPromo && order.promo?.code) await X.promoRelease(order.business_id, order.promo.code);
  }
  if (order.show) return X.giveShow(order.event_id, order.show, lines || order.lines);
  for (const l of lines || order.lines || []) {
    if (!l.qty) continue;
    await M.EvEvent.updateOne({ _id: order.event_id }, { $inc: { "types.$[t].taken": -l.qty } }, { arrayFilters: [{ "t.key": l.key }] });
  }
  // never below 0
  await M.EvEvent.updateOne({ _id: order.event_id }, [{ $set: { types: { $map: { input: "$types", as: "t", in: { $mergeObjects: ["$$t", { taken: { $max: [0, "$$t.taken"] } }] } } } } }], { updatePipeline: true });
  fire("freed", order.event_id); // ev_waitlist: tell the people waiting
}
// hold tickets for an order (all lines or none). gate: the organiser's own sales / invites / late approvals
// may use a type that is turned off for online sale
async function take(ev, want, { gate = false, show = "" } = {}) {
  if (show) return X.takeShow(ev, show, want, gate);
  const done = [];
  for (const l of want) {
    const t = ev?.types.find((x) => x.key === l.key);
    const r = t ? await M.EvEvent.updateOne({ _id: ev._id, types: { $elemMatch: { key: l.key, ...(gate ? {} : { active: true }), taken: { $lte: t.qty - l.qty } } } }, { $inc: { "types.$.taken": l.qty } }) : { modifiedCount: 0 };
    if (!r.modifiedCount) {
      if (done.length) await giveBack({ event_id: ev._id, lines: done });
      throw new Bad(MSG.soldOut, 409, { code: "sold_out", key: l.key });
    }
    done.push(l);
  }
}
// ev_pricing: the price right now (the first early-bird / timed price whose date hasn't passed, else the normal price)
function tierNow(t, now = new Date()) {
  const list = [...(t.tiers || [])].filter((x) => x.until && new Date(x.until) > now).sort((a, b) => new Date(a.until) - new Date(b.until));
  return list[0] || null;
}
const priceNow = (t, ev, now) => (ev.kind === "free" ? 0 : r2(ev.pricing === false ? t.price : (tierNow(t, now)?.price ?? t.price)));
// ev_bundles: the best price for qty tickets of one type ("4 for $30", "10 for $70"…)
function bundleCost(unit, qty, bundles) {
  const deals = (bundles || []).filter((b) => b.qty >= 2 && b.qty <= qty && b.price < unit * b.qty);
  // small: try every mix (qty ≤ 50)
  const best = Array(qty + 1).fill(Infinity);
  best[0] = 0;
  for (let n = 1; n <= qty; n += 1) {
    best[n] = best[n - 1] + unit;
    for (const d of deals) if (d.qty <= n) best[n] = Math.min(best[n], best[n - d.qty] + d.price);
  }
  return r2(best[qty]);
}
// the order lines from what the buyer picked
function linesOf(ev, raw, { gate = false } = {}) {
  const lines = [];
  for (const x of Array.isArray(raw) ? raw.slice(0, 20) : []) {
    const qty = int(x?.qty, 0, 50, 0);
    const t = ev.types.find((y) => y.key === String(x?.key || ""));
    if (!qty || !t || (!t.active && !gate)) continue;
    const same = lines.find((l) => l.key === t.key);
    if (same) same.qty += qty;
    else lines.push({ key: t.key, name: t.name, price: priceNow(t, ev), qty });
  }
  if (!lines.length) throw new Bad(MSG.emptyOrder, 400, { code: "empty" });
  const qty = lines.reduce((a, l) => a + l.qty, 0);
  if (qty > (ev.max_per_order || 10) && !gate) throw new Bad(MSG.tooMany, 400, { code: "too_many", max: ev.max_per_order });
  return { lines, qty, total: r2(lines.reduce((a, l) => a + l.price * l.qty, 0)) };
}
async function nextNo(settings) {
  const s = await M.EvSettings.findOneAndUpdate({ _id: settings._id }, { $inc: { seq: 1 } }, { returnDocument: "after" })
    .select("seq")
    .lean();
  return String(s?.seq || 1).padStart(4, "0");
}
// paid → one ticket per person
async function makeTickets(order) {
  if (await M.EvTicket.exists({ order_id: order._id })) return M.EvTicket.find({ order_id: order._id }).sort({ no: 1 }).lean();
  const ev = await M.EvEvent.findById(order.event_id).lean();
  const show = order.show ? X.showOf(ev, order.show) : null;
  // seats of each type, in the order the buyer picked them
  const seats = {};
  for (const id of order.seats || []) {
    const sInfo = X.seatInfo(ev, id);
    if (sInfo) (seats[sInfo.sec.type_key] = seats[sInfo.sec.type_key] || []).push(sInfo);
  }
  const rows = [];
  let no = 0;
  for (const l of order.lines)
    for (let i = 0; i < l.qty; i += 1) {
      const seat = seats[l.key]?.shift();
      const name = order.names?.[no] || "";
      rows.push({ business_id: order.business_id, event_id: order.event_id, order_id: order._id, no: (no += 1), type_key: l.key, type_name: l.name, price: l.price, holder: name || order.buyer?.name || "", code: randCode(10), show: order.show || "", show_at: show?.starts_at || null, seat: seat?.id || "", seat_label: seat?.label || "" });
    }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return (await M.EvTicket.insertMany(rows, { ordered: true })).map((t) => t.toObject());
    } catch (err) {
      if (err.code !== 11000) throw err;
      await M.EvTicket.deleteMany({ order_id: order._id });
      for (const r of rows) r.code = randCode(10);
    }
  }
  throw new Bad(MSG.busy, 409);
}

// ---------- outputs ----------
const typeOut = (t, ev) => {
  const tier = ev.kind === "free" ? null : tierNow(t);
  return {
    key: t.key,
    name: t.name,
    price: ev.kind === "free" ? 0 : t.price,
    now: priceNow(t, ev), // what it costs today (early-bird…)
    tier: tier ? { label: tier.label || "", price: tier.price, until: tier.until } : null,
    tiers: (t.tiers || []).map((x) => ({ label: x.label || "", price: x.price, until: x.until })),
    bundles: (t.bundles || []).map((x) => ({ qty: x.qty, price: x.price })),
    qty: t.qty,
    taken: t.taken || 0,
    left: Math.max(0, t.qty - (t.taken || 0)),
    color: t.color,
    note: t.note,
    active: t.active !== false,
  };
};
const colorsOut = (c) => ({ a: hexColor(c?.a), b: hexColor(c?.b), c: hexColor(c?.c) });
const eventOut = (e) => ({
  _id: e._id,
  slug: e.slug,
  title: e.title,
  about: e.about,
  poster: e.poster?.url || "",
  theme: THEMES[e.theme] ? e.theme : "classic",
  page_theme: PAGE_THEMES[e.page_theme] ? e.page_theme : "standard",
  theme_colors: colorsOut(e.theme_colors),
  page_colors: colorsOut(e.page_colors),
  pay_methods: e.pay_methods || [],
  kind: e.kind,
  starts_at: e.starts_at,
  ends_at: e.ends_at,
  venue: e.venue,
  map_url: e.map_url,
  types: (e.types || []).map((t) => typeOut(t, e)),
  max_per_order: e.max_per_order,
  terms: e.terms,
  status: e.status,
  sale_ends_at: e.sale_ends_at,
  shows: (e.shows || []).map((s) => ({ key: s.key, starts_at: s.starts_at, ends_at: s.ends_at, label: s.label, active: s.active !== false })),
  seating: { on: !!e.seating?.on, sections: (e.seating?.sections || []).map((s) => ({ key: s.key, name: s.name, type_key: s.type_key, rows: s.rows, cols: s.cols, blocked: s.blocked || [] })) },
  questions: (e.questions || []).map((q) => ({ key: q.key, label: q.label, kind: q.kind, options: q.options || [], required: !!q.required })),
  ask_names: !!e.ask_names,
  cert: { on: !!e.cert?.on, who: e.cert?.who || "checked_in", title: e.cert?.title || "Certificate of Attendance", body: e.cert?.body || "This is to certify that {name} attended {event} on {date}.", signer: e.cert?.signer || "", signer_title: e.cert?.signer_title || "", design: e.cert?.design || "classic", signature: e.cert?.signature?.url || "" },
  updates: [...(e.updates || [])].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 30).map((u) => ({ _id: u._id, text: u.text, at: u.at, sent: u.sent || 0 })),
  docs: (e.docs || []).map((d) => ({ key: d.key, name: d.name, url: d.url, kind: d.kind })),
  sponsors: (e.sponsors || []).map((x) => ({ key: x.key, name: x.name, link: x.link || "", tier: x.tier || "partner", logo: x.logo?.url || "" })),
  feedback: { on: !!e.feedback?.on, question: e.feedback?.question || "" },
  featured_until: e.featured_until && new Date(e.featured_until) > new Date() ? e.featured_until : null,
  category: e.category || "",
  city: e.city || "",
  created_date: e.created_date,
});
const orderOut = (o) => ({
  _id: o._id,
  event_id: o.event_id,
  no: o.no,
  token: o.token,
  buyer: o.buyer,
  lines: o.lines,
  qty: o.qty,
  subtotal: o.subtotal || o.total,
  total: o.total,
  show: o.show || "",
  seats: o.seats || [],
  promo: o.promo?.code ? { code: o.promo.code, off: o.promo.off || 0 } : null,
  bundle_off: o.bundle_off || 0,
  ref: o.ref || "",
  requests: (o.requests || []).map((q) => ({ _id: q._id, kind: q.kind, tickets: q.tickets || [], to_name: q.to_name || "", to_phone: q.to_phone || "", note: q.note || "", status: q.status, reply: q.reply || "", at: q.at, decided_at: q.decided_at, decided_by: q.decided_by || "" })),
  refunded: o.refunded || 0,
  answers: o.answers || [],
  names: o.names || [],
  tg_linked: !!o.tg?.chat_id,
  status: o.status,
  hold_until: o.hold_until,
  proof: o.proof?.url || "",
  pay_key: o.pay_key || "",
  pay_label: o.pay_label || "",
  reference: o.reference,
  note: o.note,
  reason: o.reason,
  via: o.via,
  method: o.method,
  decided_by: o.decided_by,
  decided_at: o.decided_at,
  created_date: o.created_date,
});
const ticketOut = (t) => ({ _id: t._id, code: t.code, no: t.no, order_id: t.order_id, event_id: t.event_id, type_key: t.type_key, type_name: t.type_name, price: t.price, holder: t.holder, status: t.status, used_at: t.used_at, used_by: t.used_by, show: t.show || "", show_at: t.show_at || null, seat: t.seat || "", seat_label: t.seat_label || "", transfers: (t.transfers || []).map((x) => ({ from: x.from, to: x.to, at: x.at })) });
// ---------- payment methods ----------
const methodOut = (m) => ({ key: m.key, bank: m.bank || "", account_name: m.account_name || "", account_no: m.account_no || "", link: m.link || "", note: m.note || "", qr: m.qr?.url || "", bakong_id: m.bakong_id || "", active: m.active !== false });
// auto: automatic KHQR is on (ev_autopay + BAKONG_TOKEN) → a method with only a Bakong ID can take money too
const methodReady = (m, auto) => m.active !== false && !!(m.qr?.url || m.link || (auto && m.bakong_id));
const autoOn = (ctx) => !!ctx?.addons?.ev_autopay?.active && khqr.configured();
// what an event accepts: the methods it picked (or all), that can take money
const eventMethods = (s, ev, auto = false) => {
  const all = (s?.pay_methods || []).filter((m) => methodReady(m, auto));
  const pick = ev?.pay_methods || [];
  return pick.length ? all.filter((m) => pick.includes(m.key)) : all;
};
const methodLabel = (m) => m.bank || m.account_name || "Payment";
// the old single payment (s.pay) → the first method
function oldToFirst(s) {
  if (!(s.pay?.qr?.url || s.pay?.link || s.pay?.account_no)) return;
  const v = { bank: s.pay.bank, account_name: s.pay.account_name, account_no: s.pay.account_no, link: s.pay.link, note: s.pay.note, qr: { url: s.pay.qr?.url || "", public_id: s.pay.qr?.public_id || "" } };
  const m = s.pay_methods?.[0];
  if (m) Object.assign(m, v);
  else s.pay_methods.push({ key: "m_main", active: true, ...v });
}
// the first one, in the old single-payment shape
const payOut = (s, ev) => {
  const m = eventMethods(s, ev)[0] || (s?.pay_methods || [])[0];
  return m ? methodOut(m) : { qr: "", link: "", bank: "", account_name: "", account_no: "", note: "" };
};
const orgOut = (s, business) => ({ name: s.org_name || business?.name || "", phone: s.phone || "", telegram: s.telegram || "", logo: s.logo?.url || "" });
// can people buy right now?
function saleState(ev) {
  if (ev.status === "cancelled") return "cancelled";
  if (ev.status !== "published") return "closed";
  const lastShow = (ev.shows || []).reduce((m, s) => (!m || new Date(s.starts_at) > new Date(m) ? s.starts_at : m), null);
  const end = ev.sale_ends_at || lastShow || ev.ends_at || ev.starts_at;
  if (end && new Date(end) < new Date()) return "closed";
  return "open";
}

// counts per event: orders waiting, tickets sold / checked in, money
async function countsOf(bid, eventIds) {
  const ids = eventIds.map((x) => new mongoose.Types.ObjectId(String(x)));
  const [orders, tickets] = await Promise.all([
    M.EvOrder.aggregate([{ $match: { business_id: bid, event_id: { $in: ids } } }, { $group: { _id: { e: "$event_id", s: "$status" }, n: { $sum: 1 }, total: { $sum: "$total" } } }]),
    M.EvTicket.aggregate([{ $match: { business_id: bid, event_id: { $in: ids } } }, { $group: { _id: { e: "$event_id", s: "$status" }, n: { $sum: 1 } } }]),
  ]);
  const out = {};
  for (const id of eventIds) out[String(id)] = { review: 0, pending: 0, paid_orders: 0, money: 0, tickets: 0, used: 0, cancelled: 0 };
  for (const r of orders) {
    const c = out[String(r._id.e)];
    if (!c) continue;
    if (r._id.s === "review") c.review = r.n;
    if (r._id.s === "pending") c.pending = r.n;
    if (r._id.s === "paid") {
      c.paid_orders = r.n;
      c.money = r2(r.total);
    }
  }
  for (const r of tickets) {
    const c = out[String(r._id.e)];
    if (!c) continue;
    if (r._id.s === "cancelled") c.cancelled = r.n;
    else {
      c.tickets += r.n;
      if (r._id.s === "used") c.used = r.n;
    }
  }
  return out;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});
// documents for guests (programme, map…): PDF or a picture, up to 10 MB
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});
const withDoc = (req, res, next) =>
  docUpload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: MSG.badDoc });
    next();
  });
const withFile = (field) => (req, res, next) =>
  upload.single(field)(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: MSG.badImage });
    next();
  });

module.exports = (prop) => {
  const base = "/api/user/businesses/:id/events";
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
      if (err instanceof LicenseError) return res.status(err.status).json({ success: false, message: MSG[err.message] || err.message, code: err.message, ...err.extra });
      if (err?.name === "ValidationError" || err?.name === "CastError") return res.status(400).json({ success: false, message: MSG.badValue });
      console.error("[event]", err);
      res.status(500).json({ success: false, message: MSG.server });
    }
  };

  // ======================================== the owner ========================================
  async function ownerCtx(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    const [business, state] = await Promise.all([Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false }), licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== PRODUCT) throw new Bad(MSG.notEvent);
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (state.license.read_only) throw new Bad(MSG.locked, 402, { product: PRODUCT });
    }
    const settings = await settingsOf(business);
    return { business, settings, ...state, who: req.customer.name || "Owner" };
  }
  const door = (method, path, o, fn, mw = []) =>
    prop.app[method](
      `${base}${path}`,
      prop.api_auth,
      customer_auth,
      ...mw,
      handle(async (req, res) => fn(await ownerCtx(req, o.write), req, res)),
    );
  const need = (ctx, key, msg) => {
    if (!ctx.addons[key]?.active) throw new Bad(msg, 402, { product: key });
  };
  const eventOf = async (ctx, eid) => {
    if (!validId(eid)) throw new Bad(MSG.badId);
    const ev = await M.EvEvent.findOne({ _id: eid, business_id: ctx.business._id });
    if (!ev) throw new Bad(MSG.rowNotFound, 404);
    return ev;
  };
  // the picture of the business in "My businesses": the organiser's logo, else the newest event poster
  async function syncBizLogo(ctx, { force = false } = {}) {
    let want = ctx.settings.logo?.url || "";
    if (!want) want = (await M.EvEvent.findOne({ business_id: ctx.business._id, "poster.url": { $gt: "" } }).sort({ created_date: -1 }).select("poster").lean())?.poster?.url || "";
    if ((force || !ctx.business.logo_url) && ctx.business.logo_url !== want) {
      await Business.updateOne({ _id: ctx.business._id }, { $set: { logo_url: want } });
      ctx.business.logo_url = want;
    }
  }
  const settingsBody = (s) => ({ org: { name: s.org_name, phone: s.phone, telegram: s.telegram, logo: s.logo?.url || "" }, pay: payOut(s), pay_methods: (s.pay_methods || []).map(methodOut), hold_minutes: s.hold_minutes, khqr_ready: khqr.configured(), listed: !!s.listed });

  door("get", "", {}, async (ctx, req, res) => {
    const origin = String(req.get("origin") || "");
    if (/^https?:\/\/[^/]+$/.test(origin) && ctx.settings.web !== origin) M.EvSettings.updateOne({ _id: ctx.settings._id }, { $set: { web: origin.slice(0, 200) } }).catch(() => {});
    await releaseExpired({ business_id: ctx.business._id });
    if (!ctx.business.logo_url) await syncBizLogo(ctx).catch(() => {});
    const keys = [PRODUCT, ...ADDONS, "ev_theme", "ev_page_theme", "ev_cert_theme", "ev_feature"];
    const [prices, events, review, members, devices] = await Promise.all([
      Promise.all(keys.map((k) => priceOf(k))),
      M.EvEvent.find({ business_id: ctx.business._id }).sort({ starts_at: -1 }).limit(LIMITS.events).lean(),
      M.EvOrder.countDocuments({ business_id: ctx.business._id, status: "review" }),
      M.EvMember.countDocuments({ business_id: ctx.business._id, active: true }),
      M.EvDevice.countDocuments({ business_id: ctx.business._id, revoked: false }),
    ]);
    const price = Object.fromEntries(keys.map((k, i) => [k, prices[i]]));
    const counts = await countsOf(ctx.business._id, events.map((e) => e._id));
    res.json({
      success: true,
      data: {
        business: { _id: ctx.business._id, name: ctx.business.name, status: ctx.business.status },
        ...settingsBody(ctx.settings),
        license: { ...ctx.license, price: price[PRODUCT], days: 365 },
        addons: Object.fromEntries(ADDONS.map((k) => [k, { ...ctx.addons[k], price: price[k], days: YEARLY_ADDONS.includes(k) ? 365 : null }])),
        limits: ctx.limits,
        themes: { owned: ctx.themes, price: price.ev_theme },
        page_themes: { owned: ctx.pageThemes, price: price.ev_page_theme },
        cert_themes: { owned: ctx.certThemes, price: price.ev_cert_theme },
        feature: { price: price.ev_feature, days: 7 },
        events: events.map((e) => ({ ...eventOut(e), sale: saleState(e), counts: counts[String(e._id)] })),
        waiting: review,
        team: { members, devices },
      },
    });
  });

  // ---------- settings: organiser + payment ----------
  door("put", "/settings", { write: true }, async (ctx, req, res) => {
    const b = req.body || {};
    const s = ctx.settings;
    if (b.org_name !== undefined) s.org_name = str(b.org_name, 80);
    if (b.phone !== undefined) s.phone = str(b.phone, 40);
    if (b.telegram !== undefined) s.telegram = str(b.telegram, 80);
    if (b.hold_minutes !== undefined) s.hold_minutes = int(b.hold_minutes, 10, 1440, 30);
    const p = b.pay || {};
    if (p.link !== undefined) {
      const m = String(p.link).match(/https:\/\/\S+/); // the whole ABA message can be pasted
      s.pay.link = httpsLink(m ? m[0].replace(/[),.]+$/, "") : p.link);
    }
    for (const [k, max] of [
      ["bank", 60],
      ["account_name", 80],
      ["account_no", 60],
      ["note", 200],
    ])
      if (p[k] !== undefined) s.pay[k] = str(p[k], max);
    if (b.pay !== undefined) oldToFirst(s);
    await s.save();
    res.json({ success: true, data: settingsBody(s), message: MSG.saved });
  });
  const picDoor = (path, set, get, folder) => {
    door("post", path, { write: true }, async (ctx, req, res) => {
      if (!req.file) throw new Bad(MSG.noFile);
      const up = await uploadBuffer(req.file, folder);
      const old = get(ctx)?.public_id;
      set(ctx, { url: up.url, public_id: up.public_id || "" });
      if (path === "/pay-qr") oldToFirst(ctx.settings);
      await ctx.settings.save();
      if (path === "/logo") await syncBizLogo(ctx, { force: true });
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: settingsBody(ctx.settings), message: MSG.saved });
    }, [withFile("file")]);
    door("delete", path, { write: true }, async (ctx, req, res) => {
      const old = get(ctx)?.public_id;
      set(ctx, { url: "", public_id: "" });
      await ctx.settings.save();
      if (path === "/logo") await syncBizLogo(ctx, { force: true });
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: settingsBody(ctx.settings), message: MSG.deleted });
    });
  };
  picDoor("/pay-qr", (ctx, v) => (ctx.settings.pay.qr = v), (ctx) => ctx.settings.pay?.qr, "event");
  picDoor("/logo", (ctx, v) => (ctx.settings.logo = v), (ctx) => ctx.settings.logo, "event");
  // ---------- payment methods (several: ABA, ACLEDA, Wing, KHQR…) ----------
  const methodOf = (ctx, key) => {
    const m = (ctx.settings.pay_methods || []).find((x) => x.key === key);
    if (!m) throw new Bad(MSG.rowNotFound, 404);
    return m;
  };
  function methodFields(m, b) {
    for (const [k, max] of [
      ["bank", 60],
      ["account_name", 80],
      ["account_no", 60],
      ["note", 200],
    ])
      if (b[k] !== undefined) m[k] = str(b[k], max);
    if (b.link !== undefined) {
      const found = String(b.link).match(/https:\/\/\S+/); // the whole ABA message can be pasted
      m.link = httpsLink(found ? found[0].replace(/[),.]+$/, "") : b.link);
    }
    if (b.active !== undefined) m.active = !!b.active;
    if (b.bakong_id !== undefined) {
      const id = str(b.bakong_id, 60).toLowerCase();
      if (id && !khqr.isBakongId(id)) throw new Bad(MSG.badBakong, 400, { code: "bad_bakong" });
      m.bakong_id = id;
    }
  }
  // the first method is also the old single "pay" (older screens)
  const syncOld = (s) => {
    const m = s.pay_methods?.[0];
    s.pay = m ? { qr: { url: m.qr?.url || "", public_id: m.qr?.public_id || "" }, link: m.link, bank: m.bank, account_name: m.account_name, account_no: m.account_no, note: m.note } : { qr: { url: "", public_id: "" }, link: "", bank: "", account_name: "", account_no: "", note: "" };
  };
  door("post", "/pay-methods", { write: true }, async (ctx, req, res) => {
    if ((ctx.settings.pay_methods || []).length >= 10) throw new Bad(MSG.badValue, 400, { code: "too_many" });
    const m = { key: `m_${randCode(6).toLowerCase()}`, bank: "", account_name: "", account_no: "", link: "", note: "", qr: { url: "", public_id: "" }, active: true };
    methodFields(m, req.body || {});
    ctx.settings.pay_methods.push(m);
    syncOld(ctx.settings);
    await ctx.settings.save();
    res.status(201).json({ success: true, data: settingsBody(ctx.settings), key: m.key, message: MSG.saved });
  });
  door("put", "/pay-methods/:key", { write: true }, async (ctx, req, res) => {
    methodFields(methodOf(ctx, req.params.key), req.body || {});
    syncOld(ctx.settings);
    await ctx.settings.save();
    res.json({ success: true, data: settingsBody(ctx.settings), message: MSG.saved });
  });
  door("delete", "/pay-methods/:key", { write: true }, async (ctx, req, res) => {
    const m = methodOf(ctx, req.params.key);
    const old = m.qr?.public_id;
    ctx.settings.pay_methods = ctx.settings.pay_methods.filter((x) => x.key !== m.key);
    syncOld(ctx.settings);
    await ctx.settings.save();
    await M.EvEvent.updateMany({ business_id: ctx.business._id }, { $pull: { pay_methods: m.key } });
    if (old) deleteFile(old).catch(() => {});
    res.json({ success: true, data: settingsBody(ctx.settings), message: MSG.deleted });
  });
  door(
    "post",
    "/pay-methods/:key/qr",
    { write: true },
    async (ctx, req, res) => {
      const m = methodOf(ctx, req.params.key);
      if (!req.file) throw new Bad(MSG.noFile);
      const up = await uploadBuffer(req.file, "event");
      const old = m.qr?.public_id;
      m.qr = { url: up.url, public_id: up.public_id || "" };
      syncOld(ctx.settings);
      await ctx.settings.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: settingsBody(ctx.settings), message: MSG.saved });
    },
    [withFile("file")],
  );
  door("delete", "/pay-methods/:key/qr", { write: true }, async (ctx, req, res) => {
    const m = methodOf(ctx, req.params.key);
    const old = m.qr?.public_id;
    m.qr = { url: "", public_id: "" };
    syncOld(ctx.settings);
    await ctx.settings.save();
    if (old) deleteFile(old).catch(() => {});
    res.json({ success: true, data: settingsBody(ctx.settings), message: MSG.deleted });
  });


  // ---------- events ----------
  // ticket types from the form: keeps sold counts, refuses to drop a type that has tickets
  function typesFrom(raw, ev, kind) {
    const old = ev?.types || [];
    const out = [];
    for (const x of Array.isArray(raw) ? raw.slice(0, 20) : []) {
      const name = str(x?.name, 60);
      if (!name) continue;
      const prev = old.find((t) => t.key === x?.key);
      const qty = int(x?.qty, 1, 100000, 100);
      if (prev && qty < (prev.taken || 0)) throw new Bad(MSG.qtyLow, 400, { code: "qty_low", key: prev.key });
      const tiers =
        kind === "free" || !Array.isArray(x?.tiers)
          ? []
          : x.tiers
              .slice(0, 6)
              .map((y) => ({ label: str(y?.label, 40), price: r2(Math.max(0, Number(y?.price) || 0)), until: dateOf(y?.until) }))
              .filter((y) => y.until)
              .sort((a, b) => a.until - b.until);
      const bundles =
        kind === "free" || !Array.isArray(x?.bundles)
          ? []
          : x.bundles
              .slice(0, 5)
              .map((y) => ({ qty: int(y?.qty, 2, 50, 0), price: r2(Math.max(0, Number(y?.price) || 0)) }))
              .filter((y) => y.qty >= 2 && y.price > 0);
      out.push({ key: prev?.key || `t_${randCode(6).toLowerCase()}`, name, price: kind === "free" ? 0 : r2(Math.max(0, Number(x?.price) || 0)), qty, taken: prev?.taken || 0, color: hexColor(x?.color), note: str(x?.note, 120), active: x?.active !== false, tiers, bundles });
    }
    for (const t of old) if ((t.taken || 0) > 0 && !out.some((o) => o.key === t.key)) throw new Bad(MSG.typeSold, 400, { code: "type_sold", key: t.key });
    if (!out.length) throw new Bad(MSG.needType, 400, { code: "need_type" });
    return out;
  }
  function eventFields(b, ev, owned = FREE_THEMES, ownedPages = FREE_PAGE_THEMES, payKeys = []) {
    const set = {};
    if (b.title !== undefined || !ev) {
      set.title = str(b.title, 120);
      if (!set.title) throw new Bad(MSG.needTitle, 400, { code: "need_title" });
    }
    if (b.starts_at !== undefined || !ev) {
      set.starts_at = dateOf(b.starts_at);
      if (!set.starts_at) throw new Bad(MSG.needDate, 400, { code: "need_date" });
    }
    if (b.ends_at !== undefined) set.ends_at = dateOf(b.ends_at);
    if (b.sale_ends_at !== undefined) set.sale_ends_at = dateOf(b.sale_ends_at);
    if (b.about !== undefined) set.about = str(b.about, 4000);
    if (b.venue !== undefined) set.venue = str(b.venue, 160);
    if (b.map_url !== undefined) set.map_url = httpsLink(b.map_url);
    if (b.terms !== undefined) set.terms = str(b.terms, 1000);
    if (b.max_per_order !== undefined) set.max_per_order = int(b.max_per_order, 1, 50, 10);
    if (b.kind !== undefined && ["paid", "free"].includes(b.kind)) set.kind = b.kind;
    if (b.status !== undefined && ["draft", "published", "closed", "cancelled"].includes(b.status)) set.status = b.status;
    if (b.theme !== undefined && b.theme !== ev?.theme) {
      if (!THEMES[b.theme]) throw new Bad(MSG.badTheme, 400, { code: "bad_theme" });
      if (!owned.includes(b.theme)) throw new Bad(MSG.themeLocked, 402, { product: "ev_theme", item: b.theme });
      set.theme = b.theme;
    }
    for (const k of ["theme_colors", "page_colors"]) if (b[k] !== undefined) set[k] = colorsOut(b[k] || {});
    if (b.pay_methods !== undefined) set.pay_methods = [...new Set((Array.isArray(b.pay_methods) ? b.pay_methods : []).map((k) => str(k, 20)))].filter((k) => payKeys.includes(k));
    if (b.page_theme !== undefined && b.page_theme !== ev?.page_theme) {
      if (!PAGE_THEMES[b.page_theme]) throw new Bad(MSG.badTheme, 400, { code: "bad_theme" });
      if (!ownedPages.includes(b.page_theme)) throw new Bad(MSG.themeLocked, 402, { product: "ev_page_theme", item: b.page_theme });
      set.page_theme = b.page_theme;
    }
    const kind = set.kind || ev?.kind || "paid";
    if (b.types !== undefined || !ev) set.types = typesFrom(b.types, ev, kind);
    else if (set.kind === "free") set.types = ev.types.map((t) => ({ ...(t.toObject ? t.toObject() : t), price: 0 }));
    return set;
  }
  const payReady = (ctx, ev) => eventMethods(ctx.settings, ev, autoOn(ctx)).length > 0;
  // showtimes, seat map, questions (add-ons) + quantity checks that need the database
  async function extrasFields(b, ev, ctx, set) {
    if (b.shows !== undefined) {
      const list = await X.showsFrom(b.shows, ev);
      if (list.length) need(ctx, "ev_shows", MSG.needShows);
      set.shows = list;
    }
    if (b.seating !== undefined) {
      const st = await X.seatingFrom(b.seating, ev);
      if (st.on) need(ctx, "ev_seats", MSG.needSeats);
      set.seating = st;
    }
    if (b.questions !== undefined) {
      const q = X.questionsFrom(b.questions);
      if (q.length) need(ctx, "ev_questions", MSG.needQuestions);
      set.questions = q;
    }
    if (b.cert !== undefined && b.cert && typeof b.cert === "object") {
      const c = b.cert;
      const cur = ev?.cert || {};
      const on = c.on !== undefined ? !!c.on : !!cur.on;
      if (on) need(ctx, "ev_certs", MSG.needCerts);
      const who = c.who ?? cur.who;
      set.cert = {
        on,
        who: who === "all" ? "all" : "checked_in",
        title: str(c.title ?? cur.title ?? "Certificate of Attendance", 80) || "Certificate of Attendance",
        body: str(c.body ?? cur.body ?? "", 400) || "This is to certify that {name} attended {event} on {date}.",
        signer: str(c.signer ?? cur.signer ?? "", 60),
        signer_title: str(c.signer_title ?? cur.signer_title ?? "", 60),
        design: cur.design || "classic",
        signature: { url: cur.signature?.url || "", public_id: cur.signature?.public_id || "" },
      };
      if (c.design !== undefined && c.design !== set.cert.design) {
        if (!CERT_THEMES[c.design]) throw new Bad(MSG.badTheme, 400, { code: "bad_theme" });
        if (!ctx.certThemes.includes(c.design)) throw new Bad(MSG.themeLocked, 402, { product: "ev_cert_theme", item: c.design });
        set.cert.design = c.design;
      }
    }
    if (set.types?.some((t) => t.tiers?.length)) need(ctx, "ev_pricing", MSG.needAddon);
    if (set.types?.some((t) => t.bundles?.length)) need(ctx, "ev_bundles", MSG.needAddon);
    if (b.feedback !== undefined && b.feedback && typeof b.feedback === "object") {
      if (b.feedback.on) need(ctx, "ev_feedback", MSG.needAddon);
      set.feedback = { on: !!b.feedback.on, question: str(b.feedback.question ?? ev?.feedback?.question ?? "", 160) };
    }
    if (b.category !== undefined) set.category = str(b.category, 30).toLowerCase();
    if (b.city !== undefined) set.city = str(b.city, 40);
    if (b.ask_names !== undefined) {
      if (b.ask_names) need(ctx, "ev_questions", MSG.needQuestions);
      set.ask_names = !!b.ask_names;
    }
    // with shows, a type's quantity is for each show
    if (ev && set.types && (set.shows || ev.shows || []).length) {
      const max = await X.maxTaken(ev._id);
      for (const t of set.types) if (t.qty < (max[t.key] || 0)) throw new Bad(MSG.qtyLow, 400, { code: "qty_low", key: t.key });
      for (const [k, n] of Object.entries(max)) if (n > 0 && !set.types.some((t) => t.key === k)) throw new Bad(MSG.typeSold, 400, { code: "type_sold", key: k });
    }
  }

  door("get", "/events", {}, async (ctx, req, res) => {
    const events = await M.EvEvent.find({ business_id: ctx.business._id }).sort({ starts_at: -1 }).limit(LIMITS.events).lean();
    const counts = await countsOf(ctx.business._id, events.map((e) => e._id));
    res.json({ success: true, data: events.map((e) => ({ ...eventOut(e), sale: saleState(e), counts: counts[String(e._id)] })) });
  });
  door("post", "/events", { write: true }, async (ctx, req, res) => {
    if ((await M.EvEvent.countDocuments({ business_id: ctx.business._id })) >= LIMITS.events) throw new Bad(MSG.eventLimit);
    const set = eventFields(req.body || {}, null, ctx.themes, ctx.pageThemes, (ctx.settings.pay_methods || []).map((m) => m.key));
    await extrasFields(req.body || {}, null, ctx, set);
    if (set.status === "published" && set.kind !== "free" && !payReady(ctx, set)) throw new Bad(MSG.needPayQr, 400, { code: "need_pay" });
    const ev = await M.EvEvent.create({ business_id: ctx.business._id, slug: await freeSlug(set.title), ...set });
    res.status(201).json({ success: true, data: { ...eventOut(ev), sale: saleState(ev) }, message: MSG.saved });
  });
  door("get", "/events/:eid", {}, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    await releaseExpired({ event_id: ev._id });
    const fresh = await M.EvEvent.findById(ev._id).lean();
    const counts = (await countsOf(ctx.business._id, [ev._id]))[String(ev._id)];
    res.json({ success: true, data: { ...eventOut(fresh), sale: saleState(fresh), counts } });
  });
  door("put", "/events/:eid", { write: true }, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    const set = eventFields(req.body || {}, ev, ctx.themes, ctx.pageThemes, (ctx.settings.pay_methods || []).map((m) => m.key));
    await extrasFields(req.body || {}, ev, ctx, set);
    const kind = set.kind || ev.kind;
    if ((set.status || ev.status) === "published" && kind !== "free" && !payReady(ctx, { pay_methods: set.pay_methods ?? ev.pay_methods })) throw new Bad(MSG.needPayQr, 400, { code: "need_pay" });
    if (set.title && set.title !== ev.title && req.body?.new_slug) set.slug = await freeSlug(set.title, ev._id);
    Object.assign(ev, set);
    await ev.save();
    // cancelling the event: orders still waiting are cancelled (paid tickets stay, marked by the event status)
    if (set.status === "cancelled") {
      const waiting = await M.EvOrder.find({ event_id: ev._id, status: { $in: ["pending", "review"] } }).lean();
      for (const o of waiting) if ((await M.EvOrder.updateOne({ _id: o._id, status: o.status }, { $set: { status: "cancelled", reason: "Event cancelled" } })).modifiedCount) await giveBack(o);
    }
    const counts = (await countsOf(ctx.business._id, [ev._id]))[String(ev._id)];
    res.json({ success: true, data: { ...eventOut(ev), sale: saleState(ev), counts }, message: MSG.saved });
  });
  door("delete", "/events/:eid", { write: true }, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    if (await M.EvOrder.exists({ event_id: ev._id, status: { $in: ["paid", "review"] } })) throw new Bad(MSG.hasPaid, 409, { code: "has_paid" });
    const proofs = await M.EvOrder.find({ event_id: ev._id }).select("proof").lean();
    await Promise.all([M.EvOrder.deleteMany({ event_id: ev._id }), M.EvTicket.deleteMany({ event_id: ev._id }), M.EvEvent.deleteOne({ _id: ev._id })]);
    for (const id of [ev.poster?.public_id, ...proofs.map((o) => o.proof?.public_id)]) if (id) deleteFile(id).catch(() => {});
    res.json({ success: true, message: MSG.deleted });
  });
  door("post", "/events/:eid/poster", { write: true }, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    if (!req.file) throw new Bad(MSG.noFile);
    const up = await uploadBuffer(req.file, "event");
    const old = ev.poster?.public_id;
    ev.poster = { url: up.url, public_id: up.public_id || "" };
    await ev.save();
    if (!ctx.settings.logo?.url) await syncBizLogo(ctx, { force: true }).catch(() => {});
    if (old) deleteFile(old).catch(() => {});
    res.json({ success: true, data: { ...eventOut(ev), sale: saleState(ev) }, message: MSG.saved });
  }, [withFile("file")]);
  door("delete", "/events/:eid/poster", { write: true }, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    const old = ev.poster?.public_id;
    ev.poster = { url: "", public_id: "" };
    await ev.save();
    if (old) deleteFile(old).catch(() => {});
    res.json({ success: true, data: { ...eventOut(ev), sale: saleState(ev) }, message: MSG.deleted });
  });

  // ---------- ticket designs + event page themes: buy once (forever), then use on any event ----------
  const themeDoor = (path, list, owned, product, field) =>
    door("post", path, { write: true }, async (ctx, req, res) => {
      const key = String(req.params.key);
      if (list[key] !== "premium") throw new Bad(MSG.badTheme, 400, { code: "bad_theme" });
      const ev = req.body?.event_id ? await eventOf(ctx, req.body.event_id) : null;
      const r = owned(ctx).includes(key) ? null : await buy({ customer: req.customer, business: ctx.business, product, item: key });
      if (ev) {
        ev.set(field, key);
        await ev.save();
      }
      res.json({ success: true, data: { [field]: key, event_id: ev?._id || null, charged: r?.charged || 0, balance: r?.balance }, balance: r?.balance, message: MSG.saved });
    });
  themeDoor("/themes/:key", THEMES, (ctx) => ctx.themes, "ev_theme", "theme");
  themeDoor("/page-themes/:key", PAGE_THEMES, (ctx) => ctx.pageThemes, "ev_page_theme", "page_theme");
  themeDoor("/cert-themes/:key", CERT_THEMES, (ctx) => ctx.certThemes, "ev_cert_theme", "cert.design");

  // ---------- certificate signature: an uploaded picture or one drawn on screen (PNG) ----------
  door("post", "/events/:eid/cert-signature", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_certs", MSG.needCerts);
    const ev = await eventOf(ctx, req.params.eid);
    if (!req.file) throw new Bad(MSG.noFile);
    const up = await uploadBuffer(req.file, "event");
    const old = ev.cert?.signature?.public_id;
    ev.set("cert.signature", { url: up.url, public_id: up.public_id || "" });
    await ev.save();
    if (old) deleteFile(old).catch(() => {});
    res.json({ success: true, data: { ...eventOut(ev), sale: saleState(ev) }, message: MSG.saved });
  }, [withFile("file")]);
  door("delete", "/events/:eid/cert-signature", { write: true }, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    const old = ev.cert?.signature?.public_id;
    ev.set("cert.signature", { url: "", public_id: "" });
    await ev.save();
    if (old) deleteFile(old).catch(() => {});
    res.json({ success: true, data: { ...eventOut(ev), sale: saleState(ev) }, message: MSG.deleted });
  });

  // ---------- promo codes (ev_promos) ----------
  const promoOut = (p, evs = {}) => ({ _id: p._id, code: p.code, kind: p.kind, value: p.value, max_uses: p.max_uses, used: p.used, event_id: p.event_id, event: p.event_id ? evs[String(p.event_id)] || null : null, types: p.types || [], min_qty: p.min_qty || 1, ends_at: p.ends_at, active: p.active, created_date: p.created_date });
  function promoBody(b, ctx) {
    const set = {};
    if (b.code !== undefined) {
      set.code = X.codeOf(b.code);
      if (set.code.length < 3) throw new Bad(MSG.promoBad, 400, { code: "promo_short" });
    }
    if (b.kind !== undefined) set.kind = b.kind === "amount" ? "amount" : "percent";
    if (b.value !== undefined) set.value = Math.max(0, Math.min((set.kind || b.kind) === "amount" ? 100000 : 100, r2(b.value)));
    if (b.max_uses !== undefined) set.max_uses = int(b.max_uses, 0, 100000, 0);
    if (b.min_qty !== undefined) set.min_qty = int(b.min_qty, 1, 50, 1);
    if (b.ends_at !== undefined) set.ends_at = dateOf(b.ends_at);
    if (b.active !== undefined) set.active = !!b.active;
    if (b.event_id !== undefined) set.event_id = validId(b.event_id) ? new mongoose.Types.ObjectId(String(b.event_id)) : null;
    if (b.types !== undefined) set.types = (Array.isArray(b.types) ? b.types : []).map((k) => str(k, 20)).filter(Boolean).slice(0, 20);
    return set;
  }
  const promoList = async (ctx) => {
    const rows = await M.EvPromo.find({ business_id: ctx.business._id }).sort({ created_date: -1 }).limit(300).lean();
    const evs = Object.fromEntries((await M.EvEvent.find({ _id: { $in: rows.filter((p) => p.event_id).map((p) => p.event_id) } }).select("title").lean()).map((e) => [String(e._id), e.title]));
    return rows.map((p) => promoOut(p, evs));
  };
  door("get", "/promos", {}, async (ctx, req, res) => res.json({ success: true, data: await promoList(ctx) }));
  door("post", "/promos", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_promos", MSG.needPromos);
    const set = promoBody({ kind: "percent", value: 10, ...(req.body || {}) }, ctx);
    if (!set.code) throw new Bad(MSG.promoBad, 400, { code: "promo_short" });
    if (set.event_id && !(await M.EvEvent.exists({ _id: set.event_id, business_id: ctx.business._id }))) throw new Bad(MSG.rowNotFound, 404);
    if (await M.EvPromo.exists({ business_id: ctx.business._id, code: set.code })) throw new Bad(MSG.promoTaken, 409, { code: "promo_taken" });
    try {
      await M.EvPromo.create({ business_id: ctx.business._id, ...set });
    } catch (err) {
      if (err.code === 11000) throw new Bad(MSG.promoTaken, 409, { code: "promo_taken" });
      throw err;
    }
    res.status(201).json({ success: true, data: await promoList(ctx), message: MSG.saved });
  });
  door("put", "/promos/:pid", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_promos", MSG.needPromos);
    if (!validId(req.params.pid)) throw new Bad(MSG.badId);
    const set = promoBody(req.body || {}, ctx);
    if (set.code && (await M.EvPromo.exists({ business_id: ctx.business._id, code: set.code, _id: { $ne: req.params.pid } }))) throw new Bad(MSG.promoTaken, 409, { code: "promo_taken" });
    try {
      const r = await M.EvPromo.updateOne({ _id: req.params.pid, business_id: ctx.business._id }, { $set: set });
      if (!r.matchedCount) throw new Bad(MSG.rowNotFound, 404);
    } catch (err) {
      if (err.code === 11000) throw new Bad(MSG.promoTaken, 409, { code: "promo_taken" });
      throw err;
    }
    res.json({ success: true, data: await promoList(ctx), message: MSG.saved });
  });
  door("delete", "/promos/:pid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.pid)) throw new Bad(MSG.badId);
    await M.EvPromo.deleteOne({ _id: req.params.pid, business_id: ctx.business._id });
    res.json({ success: true, data: await promoList(ctx), message: MSG.deleted });
  });

  // ---------- attendance + certificates (ev_certs) ----------
  door("get", "/events/:eid/attendance", {}, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    const [tickets, orders] = await Promise.all([M.EvTicket.find({ event_id: ev._id, status: { $ne: "cancelled" } }).sort({ holder: 1 }).limit(10000).lean(), M.EvOrder.find({ event_id: ev._id, status: "paid" }).select("no buyer tg.chat_id cert_sent").lean()]);
    const byId = Object.fromEntries(orders.map((o) => [String(o._id), o]));
    const rows = tickets
      .filter((t) => byId[String(t.order_id)])
      .map((t) => {
        const o = byId[String(t.order_id)];
        return { _id: t._id, code: t.code, holder: t.holder, type_name: t.type_name, status: t.status, used_at: t.used_at, used_by: t.used_by, seat_label: t.seat_label, show_at: t.show_at, order_no: o.no, phone: o.buyer?.phone || "", tg: !!o.tg?.chat_id, cert_sent: o.cert_sent };
      });
    res.json({ success: true, data: { rows, total: rows.length, used: rows.filter((r) => r.status === "used").length } });
  });
  door("post", "/events/:eid/certs/send", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_certs", MSG.needCerts);
    const ev = await eventOf(ctx, req.params.eid);
    if (!ev.cert?.on) throw new Bad(MSG.needCerts, 400, { code: "certs_off" });
    const sent = await hooks.sendCerts(ev, { force: true });
    res.json({ success: true, sent, message: MSG.saved });
  });

  // ---------- live updates + documents for guests (ev_guest_tg) ----------
  door("post", "/events/:eid/updates", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_guest_tg", MSG.needGuestTg);
    const ev = await eventOf(ctx, req.params.eid);
    const text = str(req.body?.text, 1000);
    if (!text) throw new Bad(MSG.badValue, 400, { code: "need_text" });
    ev.updates.push({ text, at: new Date(), sent: 0 });
    if (ev.updates.length > 60) ev.updates = ev.updates.slice(-60);
    await ev.save();
    const u = ev.updates[ev.updates.length - 1];
    const sent = req.body?.send === false ? 0 : await hooks.broadcast(ev, text).catch(() => 0);
    if (sent) await M.EvEvent.updateOne({ _id: ev._id, "updates._id": u._id }, { $set: { "updates.$.sent": sent } });
    res.status(201).json({ success: true, data: { ...eventOut(await M.EvEvent.findById(ev._id).lean()), sale: saleState(ev) }, sent, message: MSG.saved });
  });
  door("delete", "/events/:eid/updates/:uid", { write: true }, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    ev.updates = ev.updates.filter((u) => String(u._id) !== String(req.params.uid));
    await ev.save();
    res.json({ success: true, data: { ...eventOut(ev), sale: saleState(ev) }, message: MSG.deleted });
  });
  door(
    "post",
    "/events/:eid/docs",
    { write: true },
    async (ctx, req, res) => {
      need(ctx, "ev_guest_tg", MSG.needGuestTg);
      const ev = await eventOf(ctx, req.params.eid);
      if (!req.file) throw new Bad(MSG.noFile);
      if ((ev.docs || []).length >= 10) throw new Bad(MSG.badValue, 400, { code: "too_many_docs" });
      const pdf = req.file.mimetype === "application/pdf";
      const up = await uploadBuffer(req.file, "event-docs", pdf ? "raw" : "image");
      const name = str(req.body?.name, 80) || str(req.file.originalname, 80) || "Document";
      ev.docs.push({ key: `d_${randCode(6).toLowerCase()}`, name, url: up.url, public_id: up.public_id || "", kind: pdf ? "pdf" : "image", resource: pdf ? "raw" : "image" });
      await ev.save();
      res.status(201).json({ success: true, data: { ...eventOut(ev), sale: saleState(ev) }, message: MSG.saved });
    },
    [withDoc],
  );
  door("delete", "/events/:eid/docs/:key", { write: true }, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    const d = (ev.docs || []).find((x) => x.key === req.params.key);
    ev.docs = (ev.docs || []).filter((x) => x.key !== req.params.key);
    await ev.save();
    if (d?.public_id) deleteFile(d.public_id, d.resource || "image").catch(() => {});
    res.json({ success: true, data: { ...eventOut(ev), sale: saleState(ev) }, message: MSG.deleted });
  });
  door("post", "/events/:eid/docs/:key/send", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_guest_tg", MSG.needGuestTg);
    const ev = await eventOf(ctx, req.params.eid);
    const d = (ev.docs || []).find((x) => x.key === req.params.key);
    if (!d) throw new Bad(MSG.rowNotFound, 404);
    const sent = await hooks.sendDoc(ev, d);
    res.json({ success: true, sent, message: MSG.saved });
  });
  // the seats already held / sold (seat map editor)
  door("get", "/events/:eid/seats", {}, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    res.json({ success: true, data: { taken: await X.takenSeats(ev, String(req.query.show || "")) } });
  });

  // ---------- orders (shared with the manager on a door phone) ----------
  const listOrders = async (ctx, q) => {
    const where = { business_id: ctx.business._id };
    if (validId(q.event)) where.event_id = new mongoose.Types.ObjectId(String(q.event));
    if (q.show) where.show = str(q.show, 20);
    if (q.pay) where.pay_key = str(q.pay, 20);
    if (q.via && ["online", "gate", "invite"].includes(q.via)) where.via = q.via;
    const base = { ...where };
    if (["pending", "review", "paid", "rejected", "expired", "cancelled"].includes(q.status)) where.status = q.status;
    const s = str(q.q, 60);
    if (s) {
      const re = { $regex: escRe(s.replace(/^#/, "")), $options: "i" };
      where.$or = [{ "buyer.name": re }, { "buyer.phone": { $regex: escRe(s.replace(/\D/g, "") || s) } }, { no: re }, { reference: re }];
    }
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 50;
    const [rows, total] = await Promise.all([
      M.EvOrder.find(where)
        .sort({ status: 1, created_date: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.EvOrder.countDocuments(where),
    ]);
    const evs = await M.EvEvent.find({ _id: { $in: [...new Set(rows.map((o) => String(o.event_id)))] } }).select("title starts_at shows").lean();
    const byId = Object.fromEntries(evs.map((e) => [String(e._id), { _id: e._id, title: e.title, starts_at: e.starts_at, shows: (e.shows || []).map((sh) => ({ key: sh.key, starts_at: sh.starts_at, label: sh.label })) }]));
    // the numbers on top (same event / show / payment filters, every status)
    const sum = await M.EvOrder.aggregate([{ $match: base }, { $group: { _id: "$status", n: { $sum: 1 }, money: { $sum: "$total" }, tickets: { $sum: "$qty" } } }]);
    const summary = Object.fromEntries(["pending", "review", "paid", "rejected", "expired", "cancelled"].map((k) => [k, { n: 0, money: 0, tickets: 0 }]));
    for (const r of sum) summary[r._id] = { n: r.n, money: r2(r.money), tickets: r.tickets };
    return { data: rows.map((o) => ({ ...orderOut(o), event: byId[String(o.event_id)] || null })), summary, pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page } };
  };
  const orderOf = async (ctx, oid) => {
    if (!validId(oid)) throw new Bad(MSG.badId);
    const o = await M.EvOrder.findOne({ _id: oid, business_id: ctx.business._id });
    if (!o) throw new Bad(MSG.rowNotFound, 404);
    return o;
  };
  // approve: the money arrived → tickets
  async function approve(ctx, o, who) {
    if (!["pending", "review", "expired"].includes(o.status)) throw new Bad(MSG.notWaiting, 409, { code: "not_waiting" });
    if (o.status === "expired") {
      // the screenshot came late but the money is there: take the tickets again (if still there)
      const ev = await M.EvEvent.findById(o.event_id);
      await take(ev, o.lines, { gate: true, show: o.show || "" });
      try {
        await X.holdSeats(ev, o.show, o._id, o.seats);
      } catch (err) {
        await giveBack({ event_id: o.event_id, show: o.show, lines: o.lines });
        throw err;
      }
      if (o.promo?.code) await M.EvPromo.updateOne({ business_id: o.business_id, code: o.promo.code }, { $inc: { used: 1 } });
    }
    const done = await M.EvOrder.findOneAndUpdate({ _id: o._id, status: o.status }, { $set: { status: "paid", decided_by: who, decided_at: new Date(), hold_until: null } }, { returnDocument: "after" });
    if (!done) {
      if (o.status === "expired") await giveBack(o); // someone else changed it: hand back what we just took
      throw new Bad(MSG.busy, 409);
    }
    const tickets = await makeTickets(done);
    await fire("paid", done, { who });
    return { order: done, tickets };
  }
  async function reject(ctx, o, who, reason, to = "rejected") {
    if (to === "rejected" && !["pending", "review"].includes(o.status)) throw new Bad(MSG.notWaiting, 409, { code: "not_waiting" });
    if (to === "cancelled" && ["rejected", "expired", "cancelled"].includes(o.status)) throw new Bad(MSG.notWaiting, 409, { code: "not_waiting" });
    const was = o.status;
    const done = await M.EvOrder.findOneAndUpdate({ _id: o._id, status: was }, { $set: { status: to, reason: str(reason, 200), decided_by: who, decided_at: new Date() } }, { returnDocument: "after" });
    if (!done) throw new Bad(MSG.busy, 409);
    if (was === "paid" && (await M.EvTicket.exists({ order_id: o._id }))) {
      // tickets cancelled one by one were already given back: only give back the ones still live
      const live = await M.EvTicket.find({ order_id: o._id, status: { $ne: "cancelled" } }).select("type_key").lean();
      await M.EvTicket.updateMany({ order_id: o._id, status: { $ne: "cancelled" } }, { $set: { status: "cancelled" } });
      const per = {};
      for (const t of live) per[t.type_key] = (per[t.type_key] || 0) + 1;
      await giveBack(done, { lines: Object.entries(per).map(([key, qty]) => ({ key, qty })) });
    } else await giveBack(done);
    await fire("rejected", done, { who });
    return done;
  }
  door("get", "/orders", {}, async (ctx, req, res) => {
    await releaseExpired({ business_id: ctx.business._id });
    res.json({ success: true, ...(await listOrders(ctx, req.query)) });
  });
  door("post", "/orders/:oid/approve", { write: true }, async (ctx, req, res) => {
    const r = await approve(ctx, await orderOf(ctx, req.params.oid), ctx.who);
    res.json({ success: true, data: { order: orderOut(r.order), tickets: r.tickets.map(ticketOut) }, message: MSG.saved });
  });
  door("post", "/orders/:oid/reject", { write: true }, async (ctx, req, res) => {
    const o = await reject(ctx, await orderOf(ctx, req.params.oid), ctx.who, req.body?.reason);
    res.json({ success: true, data: orderOut(o), message: MSG.saved });
  });
  door("post", "/orders/:oid/cancel", { write: true }, async (ctx, req, res) => {
    const o = await reject(ctx, await orderOf(ctx, req.params.oid), ctx.who, req.body?.reason, "cancelled");
    res.json({ success: true, data: orderOut(o), message: MSG.saved });
  });

  // ---------- tickets / guest list ----------
  const listTickets = async (ctx, ev, q, withMoney) => {
    const where = { business_id: ctx.business._id, event_id: ev._id };
    if (["valid", "used", "cancelled"].includes(q.status)) where.status = q.status;
    if (q.type) where.type_key = String(q.type);
    const s = str(q.q, 60);
    const orderIds = [];
    if (s) {
      const re = { $regex: escRe(s.replace(/^#/, "")), $options: "i" };
      const os = await M.EvOrder.find({ event_id: ev._id, $or: [{ "buyer.phone": { $regex: escRe(s.replace(/\D/g, "") || s) } }, { no: re }] })
        .select("_id")
        .limit(200)
        .lean();
      orderIds.push(...os.map((o) => o._id));
      where.$or = [{ holder: re }, { code: s.toUpperCase() }, ...(orderIds.length ? [{ order_id: { $in: orderIds } }] : [])];
    }
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 100;
    const [rows, total] = await Promise.all([
      M.EvTicket.find(where)
        .sort({ status: 1, holder: 1, no: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.EvTicket.countDocuments(where),
    ]);
    const orders = await M.EvOrder.find({ _id: { $in: [...new Set(rows.map((t) => String(t.order_id)))] } }).select("no buyer via").lean();
    const byId = Object.fromEntries(orders.map((o) => [String(o._id), o]));
    return {
      data: rows.map((t) => {
        const o = byId[String(t.order_id)];
        const out = { ...ticketOut(t), order_no: o?.no || "", phone: o?.buyer?.phone || "", via: o?.via || "online" };
        if (!withMoney) delete out.price;
        return out;
      }),
      pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page },
    };
  };
  const ticketOf = async (ctx, tid) => {
    if (!validId(tid)) throw new Bad(MSG.badId);
    const t = await M.EvTicket.findOne({ _id: tid, business_id: ctx.business._id });
    if (!t) throw new Bad(MSG.rowNotFound, 404);
    return t;
  };
  door("get", "/events/:eid/tickets", {}, async (ctx, req, res) => res.json({ success: true, ...(await listTickets(ctx, await eventOf(ctx, req.params.eid), req.query, true)) }));
  door("post", "/tickets/:tid/checkin", { write: true }, async (ctx, req, res) => {
    const t = await ticketOf(ctx, req.params.tid);
    if (t.status === "cancelled") throw new Bad(MSG.ticketOff, 409, { code: "cancelled" });
    if (t.status === "valid") Object.assign(t, { status: "used", used_at: new Date(), used_by: ctx.who, used_device: "dashboard" });
    await t.save();
    res.json({ success: true, data: ticketOut(t), message: MSG.saved });
  });
  door("post", "/tickets/:tid/undo", { write: true }, async (ctx, req, res) => {
    const t = await ticketOf(ctx, req.params.tid);
    if (t.status === "used") Object.assign(t, { status: "valid", used_at: null, used_by: "", used_device: "" });
    await t.save();
    res.json({ success: true, data: ticketOut(t), message: MSG.saved });
  });
  door("post", "/tickets/:tid/cancel", { write: true }, async (ctx, req, res) => {
    const t = await ticketOf(ctx, req.params.tid);
    if (t.status !== "cancelled") {
      t.status = "cancelled";
      await t.save();
      if (t.seat) await M.EvSeat.deleteOne({ event_id: t.event_id, show: t.show || "", seat: t.seat });
      if (t.show) await X.giveShow(t.event_id, t.show, [{ key: t.type_key, qty: 1 }]);
      else await M.EvEvent.updateOne({ _id: t.event_id }, { $inc: { "types.$[t].taken": -1 } }, { arrayFilters: [{ "t.key": t.type_key }] });
    }
    res.json({ success: true, data: ticketOut(t), message: MSG.saved });
  });

  // ---------- invites (ev_invites): free tickets for guests / sponsors / VIP ----------
  door("post", "/events/:eid/invites", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_invites", MSG.needInvites);
    const ev = await eventOf(ctx, req.params.eid);
    const b = req.body || {};
    const name = str(b.name, 80);
    if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
    const phone = phoneOf(b.phone);
    if (phone === null) throw new Bad(MSG.badPhone, 400, { code: "bad_phone" });
    const { lines, qty } = linesOf(ev, [{ key: b.key, qty: int(b.qty, 1, 50, 1) }], { gate: true });
    const show = X.pickShow(ev, b.show, { gate: true });
    await take(ev, lines, { gate: true, show });
    const _id = new mongoose.Types.ObjectId();
    let seats = [];
    try {
      if (X.isSeated(ev, lines[0].key)) {
        seats = await X.autoSeats(ev, show, lines[0].key, qty);
        await X.holdSeats(ev, show, _id, seats);
      }
    } catch (err) {
      await giveBack({ event_id: ev._id, show, lines });
      throw err;
    }
    const o = await M.EvOrder.create({ _id, business_id: ctx.business._id, event_id: ev._id, no: await nextNo(ctx.settings), token: token(24), buyer: { name, phone }, lines: lines.map((l) => ({ ...l, price: 0 })), qty, total: 0, show, seats, status: "paid", via: "invite", note: str(b.note, 300), decided_by: ctx.who, decided_at: new Date() });
    const tickets = await makeTickets(o);
    res.status(201).json({ success: true, data: { order: orderOut(o), tickets: tickets.map(ticketOut) }, message: MSG.saved });
  });

  // ---------- report + export ----------
  async function reportOf(ctx, ev) {
    const bid = ctx.business._id;
    const [byType, byVia, perDay, checkins, byShow, promos] = await Promise.all([
      M.EvTicket.aggregate([{ $match: { business_id: bid, event_id: ev._id, status: { $ne: "cancelled" } } }, { $group: { _id: "$type_key", sold: { $sum: 1 }, used: { $sum: { $cond: [{ $eq: ["$status", "used"] }, 1, 0] } }, money: { $sum: "$price" } } }]),
      M.EvOrder.aggregate([{ $match: { business_id: bid, event_id: ev._id, status: "paid" } }, { $group: { _id: "$via", orders: { $sum: 1 }, tickets: { $sum: "$qty" }, money: { $sum: "$total" } } }]),
      M.EvOrder.aggregate([{ $match: { business_id: bid, event_id: ev._id, status: "paid" } }, { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$decided_at", timezone: "+07:00" } }, tickets: { $sum: "$qty" }, money: { $sum: "$total" } } }, { $sort: { _id: 1 } }]),
      M.EvTicket.aggregate([{ $match: { business_id: bid, event_id: ev._id, status: "used" } }, { $group: { _id: { $dateToString: { format: "%Y-%m-%dT%H:00", date: "$used_at", timezone: "+07:00" } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      M.EvTicket.aggregate([{ $match: { business_id: bid, event_id: ev._id, status: { $ne: "cancelled" }, show: { $gt: "" } } }, { $group: { _id: "$show", sold: { $sum: 1 }, used: { $sum: { $cond: [{ $eq: ["$status", "used"] }, 1, 0] } } } }]),
      M.EvOrder.aggregate([{ $match: { business_id: bid, event_id: ev._id, status: "paid", "promo.code": { $gt: "" } } }, { $group: { _id: "$promo.code", orders: { $sum: 1 }, off: { $sum: "$promo.off" } } }, { $sort: { orders: -1 } }]),
    ]);
    const bundled = await M.EvOrder.aggregate([{ $match: { business_id: bid, event_id: ev._id, status: "paid", bundle_off: { $gt: 0 } } }, { $group: { _id: null, off: { $sum: "$bundle_off" } } }]);
    const discount = r2(promos.reduce((a, x) => a + (x.off || 0), 0) + (bundled[0]?.off || 0));
    const types = ev.types.map((t) => {
      const r = byType.find((x) => x._id === t.key) || {};
      return { key: t.key, name: t.name, price: t.price, qty: t.qty, sold: r.sold || 0, used: r.used || 0, money: r2(r.money || 0), waiting: Math.max(0, (t.taken || 0) - (r.sold || 0)) };
    });
    const sum = (k) => types.reduce((a, t) => a + t[k], 0);
    return {
      event: { ...eventOut(ev), sale: saleState(ev) },
      totals: { qty: sum("qty") * Math.max(1, (ev.shows || []).length), sold: sum("sold"), used: sum("used"), money: r2(sum("money") - discount), discount, waiting: sum("waiting") },
      shows: (ev.shows || []).map((sh) => {
        const r = byShow.find((x) => x._id === sh.key) || {};
        return { key: sh.key, starts_at: sh.starts_at, label: sh.label, sold: r.sold || 0, used: r.used || 0, qty: sum("qty") };
      }),
      promos: promos.map((x) => ({ code: x._id, orders: x.orders, off: r2(x.off) })),
      types,
      via: byVia.map((v) => ({ via: v._id, orders: v.orders, tickets: v.tickets, money: r2(v.money) })),
      per_day: perDay.map((d) => ({ day: d._id, tickets: d.tickets, money: r2(d.money) })),
      checkins: checkins.map((c) => ({ hour: c._id, n: c.n })),
    };
  }
  door("get", "/events/:eid/report", {}, async (ctx, req, res) => res.json({ success: true, data: await reportOf(ctx, await eventOf(ctx, req.params.eid)) }));
  door("get", "/events/:eid/export", {}, async (ctx, req, res) => {
    need(ctx, "ev_export", MSG.needExport);
    const ev = await eventOf(ctx, req.params.eid);
    const [tickets, orders] = await Promise.all([M.EvTicket.find({ event_id: ev._id }).sort({ order_id: 1, no: 1 }).lean(), M.EvOrder.find({ event_id: ev._id, status: "paid" }).lean()]);
    const byId = Object.fromEntries(orders.map((o) => [String(o._id), o]));
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const fmt = (d) => (d ? new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 16).replace("T", " ") : "");
    const qs = ev.questions || [];
    const lines = [["Order", "Ticket", "Name", "Phone", "Type", "Price (USD)", "Show", "Seat", "Status", "Checked in", "By", "Sold via", "Promo", "Code", ...qs.map((q) => q.label)].map(cell).join(",")];
    for (const t of tickets) {
      const o = byId[String(t.order_id)];
      const ans = (k) => (o?.answers || []).find((a) => a.key === k)?.value || "";
      lines.push([o?.no || "", t.no, t.holder, o?.buyer?.phone || "", t.type_name, t.price, fmt(t.show_at), t.seat_label, t.status, fmt(t.used_at), t.used_by, o?.via || "", o?.promo?.code || "", t.code, ...qs.map((q) => ans(q.key))].map(cell).join(","));
    }
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${slugBase(ev.title) || "event"}-guests.csv"`);
    res.send(`﻿${lines.join("\r\n")}`);
  });

  // ---------- team + door phones ----------
  const memberOut = (m) => ({ _id: m._id, name: m.name, role: m.role, active: m.active, created_date: m.created_date });
  door("get", "/team", {}, async (ctx, req, res) => {
    const [members, devices] = await Promise.all([M.EvMember.find({ business_id: ctx.business._id }).sort({ created_date: 1 }).lean(), M.EvDevice.find({ business_id: ctx.business._id, revoked: false }).sort({ created_date: -1 }).select("name last_seen created_date").lean()]);
    res.json({ success: true, data: { members: members.map(memberOut), devices, limits: ctx.limits, cashier: !!ctx.addons.ev_cashier?.active } });
  });
  const pinOk = async (ctx, pin, not) => {
    if (!/^\d{4}$/.test(String(pin || ""))) throw new Bad(MSG.pinBad, 400, { code: "bad_pin" });
    if (await M.EvMember.exists({ business_id: ctx.business._id, pin_key: pinKey(ctx.business._id, pin), ...(not ? { _id: { $ne: not } } : {}) })) throw new Bad(MSG.pinTaken, 409, { code: "pin_taken" });
  };
  const roleOk = (ctx, role) => {
    if (!["door", "crew", "cashier", "manager"].includes(role)) throw new Bad(MSG.badValue);
    if (role === "cashier") need(ctx, "ev_cashier", MSG.needCashier);
    return role;
  };
  door("post", "/team", { write: true }, async (ctx, req, res) => {
    const b = req.body || {};
    const name = str(b.name, 60);
    if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
    const role = roleOk(ctx, String(b.role || "door"));
    const count = await M.EvMember.countDocuments({ business_id: ctx.business._id, active: true });
    if (count >= ctx.limits.team) throw new Bad(ctx.addons.ev_team?.active ? MSG.teamMax : MSG.teamLimit, 402, ctx.addons.ev_team?.active ? { code: "max" } : { product: "ev_team", code: "team_limit" });
    await pinOk(ctx, b.pin);
    const m = await M.EvMember.create({ business_id: ctx.business._id, name, role, pin_key: pinKey(ctx.business._id, b.pin) });
    res.status(201).json({ success: true, data: memberOut(m), message: MSG.saved });
  });
  door("put", "/team/:mid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.mid)) throw new Bad(MSG.badId);
    const m = await M.EvMember.findOne({ _id: req.params.mid, business_id: ctx.business._id });
    if (!m) throw new Bad(MSG.rowNotFound, 404);
    const b = req.body || {};
    if (b.name !== undefined) m.name = str(b.name, 60) || m.name;
    if (b.role !== undefined && b.role !== m.role) m.role = roleOk(ctx, String(b.role));
    if (b.pin) {
      await pinOk(ctx, b.pin, m._id);
      m.pin_key = pinKey(ctx.business._id, b.pin);
      m.pin_v = (m.pin_v || 0) + 1;
    }
    if (b.active !== undefined) {
      if (b.active && !m.active && (await M.EvMember.countDocuments({ business_id: ctx.business._id, active: true })) >= ctx.limits.team) throw new Bad(MSG.teamLimit, 402, { product: "ev_team", code: "team_limit" });
      m.active = !!b.active;
      m.pin_v = (m.pin_v || 0) + 1;
    }
    await m.save();
    res.json({ success: true, data: memberOut(m), message: MSG.saved });
  });
  door("delete", "/team/:mid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.mid)) throw new Bad(MSG.badId);
    const r = await M.EvMember.deleteOne({ _id: req.params.mid, business_id: ctx.business._id });
    if (!r.deletedCount) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, message: MSG.deleted });
  });
  door("post", "/pair-code", { write: true }, async (ctx, req, res) => {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    ctx.settings.pair_code = code;
    ctx.settings.pair_expires = new Date(Date.now() + 10 * 60000);
    await ctx.settings.save();
    res.json({ success: true, data: { code, expires: ctx.settings.pair_expires } });
  });
  door("delete", "/devices/:did", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.did)) throw new Bad(MSG.badId);
    const r = await M.EvDevice.updateOne({ _id: req.params.did, business_id: ctx.business._id }, { $set: { revoked: true } });
    if (!r.matchedCount) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, message: MSG.deleted });
  });

  // ======================================== public ========================================
  const pub = (path) => `/api/public/ev${path}`;
  const orderLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 20, message: MSG.slow });
  async function openBiz(bid) {
    const [business, state] = await Promise.all([Business.findOne({ _id: bid, deleted: false }), licenseState(bid)]);
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || !owner?.status || state.license.locked) throw new Bad(MSG.ticketOff, 404, { code: "off" });
    return { business, ...state, settings: await settingsOf(business) };
  }
  async function openEvent(slug) {
    const s = str(slug, 80).toLowerCase();
    const ev = s ? await M.EvEvent.findOne({ slug: s }) : null;
    if (!ev || ev.status === "draft") throw new Bad(MSG.rowNotFound, 404, { code: "not_found" });
    return { ev, ...(await openBiz(ev.business_id)) };
  }
  const publicEvent = async (ctx) => ({
    ...eventOut(ctx.ev),
    // showtimes still on sale + what's left of each type
    shows: await (async () => {
      if (!X.hasShows(ctx.ev)) return [];
      const left = await X.showLeft(ctx.ev);
      return ctx.ev.shows
        .filter((sh) => sh.active !== false)
        .map((sh) => ({ key: sh.key, starts_at: sh.starts_at, ends_at: sh.ends_at, label: sh.label, open: new Date(sh.starts_at) > new Date(), left: left[sh.key] || {} }));
    })(),
    questions: ctx.addons.ev_questions?.active ? eventOut(ctx.ev).questions : [],
    ask_names: !!(ctx.addons.ev_questions?.active && ctx.ev.ask_names),
    promos: !!ctx.addons.ev_promos?.active && (await M.EvPromo.exists({ business_id: ctx.ev.business_id, active: true, $or: [{ event_id: null }, { event_id: ctx.ev._id }] })) !== null,
    updates: ctx.addons.ev_guest_tg?.active ? eventOut(ctx.ev).updates : [],
    docs: ctx.addons.ev_guest_tg?.active ? eventOut(ctx.ev).docs : [],
    types: ctx.ev.types.filter((t) => t.active !== false).map((t) => {
      const o = typeOut(ctx.addons.ev_pricing?.active ? t : { ...(t.toObject ? t.toObject() : t), tiers: [] }, ctx.ev);
      if (!ctx.addons.ev_bundles?.active) o.bundles = [];
      delete o.taken;
      delete o.active;
      return o;
    }),
    sponsors: ctx.addons.ev_sponsors?.active ? eventOut(ctx.ev).sponsors : [],
    waitlist: !!ctx.addons.ev_waitlist?.active,
    referrals: !!ctx.addons.ev_referrals?.active,
    sale: saleState(ctx.ev),
    org: orgOut(ctx.settings, ctx.business),
    brand: !ctx.addons.ev_nobrand?.active,
  });

  prop.app.get(
    pub("/e/:slug"),
    handle(async (req, res) => {
      const ctx = await openEvent(req.params.slug);
      await releaseExpired({ event_id: ctx.ev._id });
      ctx.ev = await M.EvEvent.findById(ctx.ev._id);
      res.set("Cache-Control", "no-store");
      res.json({ success: true, data: await publicEvent(ctx) });
    }),
  );
  prop.app.post(
    pub("/e/:slug/order"),
    orderLimit,
    handle(async (req, res) => {
      const ctx = await openEvent(req.params.slug);
      const ev = ctx.ev;
      const sale = saleState(ev);
      if (sale !== "open") throw new Bad(sale === "cancelled" ? MSG.cancelledEv : MSG.closed, 409, { code: sale });
      if (ctx.license.read_only) throw new Bad(MSG.closed, 409, { code: "closed" });
      const b = req.body || {};
      const name = str(b.name, 80);
      if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
      const phone = phoneOf(b.phone);
      if (!phone) throw new Bad(MSG.badPhone, 400, { code: "bad_phone" });
      if (ev.kind !== "free" && !eventMethods(ctx.settings, ev, autoOn(ctx)).length) throw new Bad(MSG.noPay, 409, { code: "no_pay" });
      await releaseExpired({ event_id: ev._id });
      const show = X.pickShow(ev, b.show);
      const { lines, qty, total: subtotal } = linesOf(ev, b.lines);
      // seats: one picked seat for every ticket of a seated type
      const bySeat = X.seatedOn(ev) ? X.seatsByType(ev, b.seats) : {};
      for (const l of lines) if (X.isSeated(ev, l.key) && (bySeat[l.key] || []).length !== l.qty) throw new Bad(MSG.pickSeats, 400, { code: "pick_seats", key: l.key });
      const seats = lines.flatMap((l) => bySeat[l.key] || []);
      const answers = ctx.addons.ev_questions?.active ? X.answersOf(ev, b.answers) : [];
      const names = ctx.addons.ev_questions?.active ? X.namesOf(ev, b.names, qty) : [];
      const promo = b.promo && ctx.addons.ev_promos?.active && ev.kind !== "free" ? await X.promoFor(ev.business_id, ev, b.promo, lines) : null;
      // group deals: the best mix for each type
      let bundleOff = 0;
      if (ctx.addons.ev_bundles?.active && ev.kind !== "free")
        for (const l of lines) {
          const t = ev.types.find((y) => y.key === l.key);
          if (t?.bundles?.length) bundleOff += r2(l.price * l.qty - bundleCost(l.price, l.qty, t.bundles));
        }
      bundleOff = r2(bundleOff);
      // a promoter's link (?ref=CODE)
      const refCode = ctx.addons.ev_referrals?.active ? str(b.ref, 24).toUpperCase() : "";
      const ref = refCode ? await M.EvRef.findOne({ business_id: ev.business_id, code: refCode, active: true, $or: [{ event_id: null }, { event_id: ev._id }] }).select("code").lean() : null;
      const total = r2(Math.max(0, subtotal - bundleOff - (promo?.off || 0)));
      await take(ev, lines, { show });
      const _id = new mongoose.Types.ObjectId();
      const back = { _id, business_id: ev.business_id, event_id: ev._id, show, lines };
      try {
        await X.holdSeats(ev, show, _id, seats);
        if (promo) await X.promoUse(promo.promo);
      } catch (err) {
        await giveBack(back, { keepPromo: true });
        throw err;
      }
      if (promo) back.promo = { code: promo.promo.code };
      const free = ev.kind === "free" || total === 0;
      let o;
      try {
        o = await M.EvOrder.create({
          _id,
          subtotal,
          show,
          seats,
          promo: promo ? { code: promo.promo.code, off: promo.off } : undefined,
          bundle_off: bundleOff,
          ref: ref?.code || "",
          answers,
          names,
          business_id: ev.business_id,
          event_id: ev._id,
          no: await nextNo(ctx.settings),
          token: token(24),
          buyer: { name, phone },
          lines,
          qty,
          total,
          status: free ? "paid" : "pending",
          hold_until: free ? null : new Date(Date.now() + (ctx.settings.hold_minutes || 30) * 60000),
          note: str(b.note, 300),
          decided_by: free ? "auto" : "",
          decided_at: free ? new Date() : null,
        });
      } catch (err) {
        await giveBack(back);
        throw err;
      }
      if (free) {
        await makeTickets(o);
        await fire("paid", o, { who: "auto" });
      }
      res.status(201).json({ success: true, data: { token: o.token, status: o.status } });
    }),
  );
  async function buyerOrder(tok) {
    const t = str(tok, 60);
    const o = t ? await M.EvOrder.findOne({ token: t }) : null;
    if (!o) throw new Bad(MSG.rowNotFound, 404, { code: "not_found" });
    if (o.status === "pending" && o.hold_until && o.hold_until < new Date()) {
      if ((await M.EvOrder.updateOne({ _id: o._id, status: "pending" }, { $set: { status: "expired" } })).modifiedCount) await giveBack(o);
      o.status = "expired";
    }
    return o;
  }
  prop.app.get(
    pub("/o/:token"),
    handle(async (req, res) => {
      const o = await buyerOrder(req.params.token);
      const ev = await M.EvEvent.findById(o.event_id).lean();
      const ctx = await openBiz(o.business_id);
      const tickets = o.status === "paid" ? await M.EvTicket.find({ order_id: o._id }).sort({ no: 1 }).lean() : [];
      const auto = autoOn(ctx);
      const methods = ["pending", "review"].includes(o.status) ? eventMethods(ctx.settings, ev, auto) : [];
      // automatic KHQR: a QR with the exact amount, made once per order (again if the method or amount changed)
      let kq = null;
      const am = auto && o.status === "pending" && o.total > 0 ? methods.find((m) => m.bakong_id) : null;
      if (am) {
        if (!o.khqr?.md5 || o.khqr.key !== am.key || o.khqr.amount !== o.total) {
          const k = khqr.build({ bakongId: am.bakong_id, name: am.account_name || ctx.settings.org_name || ctx.business.name, amount: o.total, bill: o.no, store: ctx.settings.org_name || ctx.business.name, expiresAt: o.hold_until });
          o.khqr = { key: am.key, qr: k.qr, md5: k.md5, amount: o.total, expires: o.hold_until, checked_at: null };
          await M.EvOrder.updateOne({ _id: o._id }, { $set: { khqr: o.khqr } });
        }
        kq = { key: am.key, qr: o.khqr.qr, amount: o.total, currency: "USD", expires: o.hold_until, bank: methodLabel(am), name: am.account_name || ctx.settings.org_name || ctx.business.name, bakong_id: am.bakong_id };
      }
      const out = orderOut(o);
      delete out.decided_by;
      res.set("Cache-Control", "no-store");
      res.json({
        success: true,
        data: {
          order: out,
          event: { ...eventOut(ev), types: undefined, sale: saleState(ev), sponsors: ctx.addons.ev_sponsors?.active ? eventOut(ev).sponsors : [] },
          org: orgOut(ctx.settings, ctx.business),
          feedback: ctx.addons.ev_feedback?.active && ev.feedback?.on && o.status === "paid" ? { open: new Date(ev.starts_at) <= new Date(), done: !!(await M.EvFeedback.exists({ order_id: o._id })) } : null,
          pay: ["pending", "review"].includes(o.status) ? payOut(ctx.settings, ev) : null,
          pays: methods.map((m) => ({ ...methodOut(m), auto: !!(auto && m.bakong_id) })),
          khqr: kq,
          cert: ctx.addons.ev_certs?.active && ev.cert?.on ? { on: true, who: ev.cert.who } : null,
          tickets: tickets.map((t) => {
            const x = ticketOut(t);
            delete x.used_by;
            return x;
          }),
          brand: !ctx.addons.ev_nobrand?.active,
          ...(await hooks.view(o, ctx).catch(() => ({}))),
        },
      });
    }),
  );
  prop.app.post(
    pub("/o/:token/proof"),
    orderLimit,
    withFile("file"),
    handle(async (req, res) => {
      const o = await buyerOrder(req.params.token);
      if (o.status === "expired") throw new Bad(MSG.expired, 409, { code: "expired" });
      if (!["pending", "review"].includes(o.status)) throw new Bad(MSG.notWaiting, 409, { code: "not_waiting" });
      if (!req.file) throw new Bad(MSG.noFile);
      const up = await uploadBuffer(req.file, "event-proofs");
      const old = o.proof?.public_id;
      const st = await M.EvSettings.findOne({ business_id: o.business_id }).lean();
      const used = (st?.pay_methods || []).find((m) => m.key === str(req.body?.pay_key, 20));
      const done = await M.EvOrder.findOneAndUpdate(
        { _id: o._id, status: { $in: ["pending", "review"] } },
        { $set: { status: "review", proof: { url: up.url, public_id: up.public_id || "" }, reference: str(req.body?.reference, 80), hold_until: null, pay_key: used?.key || "", pay_label: used ? methodLabel(used) : "" } },
        { returnDocument: "after" },
      );
      if (!done) throw new Bad(MSG.notWaiting, 409, { code: "not_waiting" });
      if (old) deleteFile(old).catch(() => {});
      await fire("review", done);
      res.json({ success: true, data: { status: done.status } });
    }),
  );
  prop.app.get(
    pub("/t/:code"),
    handle(async (req, res) => {
      const code = str(req.params.code, 20).toUpperCase();
      const t = /^[A-Z0-9]{8,14}$/.test(code) ? await M.EvTicket.findOne({ code }).lean() : null;
      if (!t) throw new Bad(MSG.rowNotFound, 404, { code: "not_found" });
      const [ev, o] = await Promise.all([M.EvEvent.findById(t.event_id).lean(), M.EvOrder.findById(t.order_id).select("no token buyer").lean()]);
      const ctx = await openBiz(t.business_id);
      const x = ticketOut(t);
      delete x.used_by;
      res.set("Cache-Control", "no-store");
      res.json({ success: true, data: { ticket: x, order_no: o?.no || "", event: { ...eventOut(ev), types: undefined, sale: saleState(ev) }, org: orgOut(ctx.settings, ctx.business), brand: !ctx.addons.ev_nobrand?.active } });
    }),
  );

  // ---------- automatic KHQR payment (ev_autopay): the order page asks, Bakong answers ----------
  const checkLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 240, message: MSG.slow });
  // paid on Bakong (right amount, right account) → approve by itself. Also for an order that just expired.
  async function autoCheck(o) {
    if (!["pending", "expired"].includes(o.status) || !o.khqr?.md5) return o.status;
    const r = await khqr.check(o.khqr.md5);
    await M.EvOrder.updateOne({ _id: o._id }, { $set: { "khqr.checked_at": new Date() } });
    if (!r.paid) return o.status;
    if (Math.round(r.amount * 100) < Math.round((o.khqr.amount || 0) * 100) || (r.currency && r.currency !== "USD")) return o.status;
    const st = await M.EvSettings.findOne({ business_id: o.business_id }).lean();
    const m = (st?.pay_methods || []).find((x) => x.key === o.khqr.key);
    if (m?.bakong_id && r.to && r.to.toLowerCase() !== m.bakong_id.toLowerCase()) return o.status;
    await M.EvOrder.updateOne({ _id: o._id }, { $set: { reference: String(r.hash || "").slice(0, 80), pay_key: o.khqr.key, pay_label: `${m ? methodLabel(m) : "Bakong"} · KHQR` } });
    const fresh = await M.EvOrder.findById(o._id);
    try {
      await approve({}, fresh, "KHQR (auto)");
    } catch (err) {
      if (!(err instanceof Bad)) throw err;
    }
    return (await M.EvOrder.findById(o._id).select("status").lean())?.status || o.status;
  }
  prop.app.post(
    pub("/o/:token/check"),
    checkLimit,
    handle(async (req, res) => {
      const o = await buyerOrder(req.params.token);
      res.json({ success: true, data: { status: await autoCheck(o) } });
    }),
  );
  // the scheduler: orders whose buyer closed the page before Bakong confirmed
  module.exports.autopayTick = async () => {
    if (!khqr.configured()) return { checked: 0 };
    const since = new Date(Date.now() - 3 * 3600000);
    const list = await M.EvOrder.find({ "khqr.md5": { $gt: "" }, status: { $in: ["pending", "expired"] }, created_date: { $gte: since }, $or: [{ "khqr.checked_at": null }, { "khqr.checked_at": { $lt: new Date(Date.now() - 60000) } }] }).limit(60);
    let paid = 0;
    for (const o of list) if ((await autoCheck(o).catch(() => o.status)) === "paid") paid += 1;
    return { checked: list.length, paid };
  };

  // ---------- certificates (ev_certs) ----------
  const certOk = (ev, t, o) => !!ev?.cert?.on && t.status !== "cancelled" && o?.status === "paid" && (ev.cert.who === "all" || t.status === "used");
  prop.app.get(
    pub("/c/:code"),
    handle(async (req, res) => {
      const code = str(req.params.code, 20).toUpperCase();
      const t = /^[A-Z0-9]{8,14}$/.test(code) ? await M.EvTicket.findOne({ code }).lean() : null;
      if (!t) throw new Bad(MSG.rowNotFound, 404, { code: "not_found" });
      const [ev, o] = await Promise.all([M.EvEvent.findById(t.event_id).lean(), M.EvOrder.findById(t.order_id).select("status").lean()]);
      const ctx = await openBiz(t.business_id);
      if (!ctx.addons.ev_certs?.active || !ev?.cert?.on) throw new Bad(MSG.rowNotFound, 404, { code: "not_found" });
      res.set("Cache-Control", "no-store");
      res.json({
        success: true,
        data: {
          valid: certOk(ev, t, o),
          waiting: t.status === "valid" && ev.cert.who === "checked_in",
          ticket: { code: t.code, holder: t.holder, type_name: t.type_name, used_at: t.used_at, show_at: t.show_at },
          event: { title: ev.title, starts_at: ev.starts_at, ends_at: ev.ends_at, venue: ev.venue, slug: ev.slug },
          cert: { ...ev.cert, signature: ev.cert.signature?.url || "" },
          sponsors: ctx.addons.ev_sponsors?.active ? (ev.sponsors || []).map((x) => ({ name: x.name, tier: x.tier, logo: x.logo?.url || "" })) : [],
          org: orgOut(ctx.settings, ctx.business),
          brand: !ctx.addons.ev_nobrand?.active,
        },
      });
    }),
  );

  // promo code check before ordering (shows the discount)
  prop.app.post(
    pub("/e/:slug/promo"),
    orderLimit,
    handle(async (req, res) => {
      const ctx = await openEvent(req.params.slug);
      if (!ctx.addons.ev_promos?.active || ctx.ev.kind === "free") throw new Bad(MSG.promoBad, 400, { code: "promo_bad" });
      const { lines, total } = linesOf(ctx.ev, req.body?.lines);
      const r = await X.promoFor(ctx.ev.business_id, ctx.ev, req.body?.code, lines);
      res.json({ success: true, data: { code: r.promo.code, off: r.off, subtotal: total, total: r2(Math.max(0, total - r.off)) } });
    }),
  );
  // seats already taken (seat map)
  prop.app.get(
    pub("/e/:slug/seats"),
    handle(async (req, res) => {
      const ctx = await openEvent(req.params.slug);
      res.set("Cache-Control", "no-store");
      res.json({ success: true, data: { taken: await X.takenSeats(ctx.ev, X.hasShows(ctx.ev) ? str(req.query.show, 20) : "") } });
    }),
  );

  // Telegram for organisers + guests
  require("./event.more")(prop, { M, X, Bad, MSG, handle, door, need, hooks, fire, licenseState, settingsOf, openBiz, openEvent, publicEvent, buyerOrder, eventOf, ticketOf, eventOut, orderOut, ticketOut, saleState, countsOf, freeSlug, giveBack, uploadBuffer, deleteFile, withFile, phoneOf, httpsLink, str, int, r2, randCode, token, dateOf, validId, escRe, priceNow, LIMITS, TZ, Business, License, statusOf });
  require("./event.telegram")(prop, { M, X, Bad, MSG, handle, door, need, hooks, licenseState, settingsOf, approve, reject, orderOut, eventOut, str, r2, randCode, localDay, TZ });

  // the door phones (pairing + PIN) share the same helpers
  require("./event.door")(prop, { M, Bad, MSG, handle, licenseState, settingsOf, validId, str, int, r2, sha, pinKey, token, linesOf, take, giveBack, nextNo, makeTickets, releaseExpired, approve, reject, listOrders, listTickets, reportOf, eventOut, orderOut, ticketOut, saleState, countsOf, localDay, Business, Customer, X });
};
