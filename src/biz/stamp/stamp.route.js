// Loyalty Stamp Card (yearly): "10 stamps = 1 free coffee". Customers join from the shop QR (no app), each gets a card link;
// staff scan the card QR (or type the card number / phone) and add stamps; a full card = a reward. Staff use the owner's
// dashboard or the desk page on the counter phone (PIN). Add-ons: sc_check (customers open their card again with their phone,
// yearly), sc_telegram (owner alerts + daily summary, customers get their stamps on Telegram, yearly), sc_more (more than 100
// customers), sc_levels (several rewards on one card), sc_expiry (stamps end after N months without a visit) — forever,
// sc_theme (one premium card design, forever, item = key).
//
// Owner base: /api/user/businesses/:id/stamps
//   GET  ""                                everything the dashboard needs (program, totals, add-ons, prices, Telegram…)
//   GET  /members?q&filter&page            filter = all|ready|recent|sleeping|deleted
//   POST /members                          { name, phone, note, stamps }
//   GET  /members/:mid                     one customer + their history
//   PUT  /members/:mid  DELETE /members/:mid  POST /members/:mid/restore  POST /members/:mid/new-link
//   POST /members/:mid/stamp { n, note, force }   POST /members/:mid/reward { at }   POST /members/:mid/adjust { n, note }
//   POST /lookup { code }                  a scanned card QR, card number or phone → the customer(s)
//   GET  /history?page&kind                every stamp / reward, newest first
//   GET  /stats?days                       stamps + rewards per day, best customers
//   PUT  /settings                         design, rule, rewards, levels, terms, gap…
//   POST /members/:mid/reset (card → 0)   POST /reset-all { confirm: "RESET" } (every card → 0)
//   POST/DELETE /logo   POST /themes/:key (buy a premium design)   PUT /desk { on, pin }
//   POST /telegram/link  POST /telegram/test  PUT /telegram { reward, joined, daily, time }  DELETE /telegram
// Staff desk (PIN): POST /api/public/stamp/desk/:slug/login { pin } → { token }; then with header x-desk-token:
//   GET /api/public/stamp/desk/:slug       the program (rule, rewards)
//   GET .../members  GET .../history  GET .../stats (same as the owner's, no deleted cards)
//   POST .../lookup { code }   POST .../members { name, phone }   POST .../members/:mid/stamp { n }   POST .../members/:mid/reward { at }   POST .../members/:mid/reset (when the owner turned on desk.can_reset)
// Public (customers):
//   GET  /api/public/stamp/shop/:slug      the shop page behind the shop QR
//   POST /api/public/stamp/shop/:slug/join { name, phone }     → { token }  (a phone already on a card → sc_check finds it)
//   POST /api/public/stamp/shop/:slug/find { phone } | { name, last } → { token } | { need_last } (sc_check; by name the last 3 phone digits confirm it)
//   GET  /api/public/stamp/card/:token     the customer's card
// Scheduler: dailyReports() — run by /api/cron/daily-report (owner's summary + stamps that ended)
const mongoose = require("mongoose");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const multer = require("multer");
const M = require("./stamp.models");
const { THEMES, FREE_THEMES, POSTERS, FREE_POSTERS, ICONS } = require("./stamp.themes");
const Business = require("../business.model");
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const { statusOf, buy, LicenseError, DAY } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");
const { rate_limit } = require("../../util/rate_limit");
const cloud = require("../../util/cloudinary");
const telegram = require("../../telegram");

const PRODUCT = "stamp_card";
const ADDONS = ["sc_check", "sc_telegram", "sc_more", "sc_levels", "sc_expiry"];
const YEARLY_ADDONS = ["sc_check", "sc_telegram"];
const LIMITS = { customers: 100, customers_more: 20000 };
const GRACE_DAYS = 7;
const TZ = 7;
const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  noReset: "ម្ចាស់ហាងមិនទាន់អនុញ្ញាតឱ្យបុគ្គលិកកំណត់ត្រាឡើងវិញទេ! / The owner hasn't allowed staff to reset stamps.",
  badLast: "លេខ ៣ ខ្ទង់ចុងក្រោយមិនត្រូវ! / The last 3 digits don't match.",
  askStaff: "សូមសួរបុគ្គលិក ដើម្បីបង្ហាញកាតរបស់អ្នក។ / Please ask the staff to show your card.",
  notStamp: "អាជីវកម្មនេះមិនមែនជាកាតប្រមូលត្រាទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ Biz Hub។",
  locked: "កាតប្រមូលត្រាផុតកំណត់ហើយ! សូមបន្តដើម្បីប្រើប្រាស់។",
  rowNotFound: "រកមិនឃើញអតិថិជន!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
  badValue: "តម្លៃមិនត្រឹមត្រូវ!",
  needName: "សូមបញ្ចូលឈ្មោះ!",
  badPhone: "សូមបញ្ចូលលេខទូរស័ព្ទត្រឹមត្រូវ!",
  phoneTaken: "លេខទូរស័ព្ទនេះមានកាតរួចហើយ!",
  customerLimit: "អតិថិជនឥតគិតថ្លៃមានតែ 100។ សូមដោះសោ “អតិថិជនគ្មានកំណត់”។",
  customerMax: "អតិថិជនច្រើនពេក!",
  tooSoon: "កាតនេះទើបបានត្រាថ្មីៗ។ សូមរង់ចាំបន្តិចសិន។",
  tooMany: "ត្រាច្រើនពេកក្នុងមួយដង!",
  notReady: "រង្វាន់នេះមិនទាន់គ្រប់ត្រាទេ!",
  stamped: "បានបន្ថែមត្រា!",
  rewarded: "បានផ្តល់រង្វាន់!",
  ownerOnly: "មានតែម្ចាស់ទេដែលអាចធ្វើបាន!",
  needTelegram: "សូមដោះសោ “Telegram” ជាមុនសិន!",
  needCheck: "ហាងនេះមិនទាន់បើកការពិនិត្យកាតដោយខ្លួនឯងទេ។ សូមសួរបុគ្គលិក។",
  needLevels: "សូមដោះសោ “រង្វាន់ច្រើនកម្រិត” ជាមុនសិន!",
  needExpiry: "សូមដោះសោ “ត្រាផុតកំណត់” ជាមុនសិន!",
  badImage: "សូមដាក់រូបភាព JPG / PNG / WEBP (តិចជាង 5MB)!",
  noFile: "សូមជ្រើសរើសរូបភាព!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  already: "បានទិញរួចហើយ!",
  busy: "កំពុងដំណើរការ សូមព្យាយាមម្តងទៀត!",
  changed: "តម្លៃបានផ្លាស់ប្តូរ។ សូមផ្ទុកទំព័រឡើងវិញ។",
  needs: "សូមទិញសេវាដែលត្រូវការជាមុនសិន!",
  badTheme: "រចនាប័ទ្មនេះមិនមាន!",
  themeLocked: "សូមដោះសោរចនាប័ទ្មនេះជាមុនសិន!",
  tgNotConfigured: "Telegram មិនទាន់រៀបចំនៅលើម៉ាសុីនមេ។",
  tgBlocked: "Telegram៖ បុតត្រូវបានបិទ ឬដកចេញ។ សូមភ្ជាប់ម្តងទៀត។",
  tgUnreachable: "មិនអាចទាក់ទង Telegram បាន។ សូមព្យាយាមម្តងទៀត។",
  tgNotConnected: "មិនទាន់ភ្ជាប់ Telegram ទេ។",
  tgSent: "បានផ្ញើសារសាកល្បង!",
  cardOff: "កាតនេះមិនដំណើរការទេ។",
  joinOff: "ហាងនេះមិនទទួលសមាជិកថ្មីតាម QR ទេ។ សូមសួរបុគ្គលិក។",
  hasCard: "លេខនេះមានកាតរួចហើយ។ សូមសួរបុគ្គលិកឲ្យបង្ហាញ QR កាតរបស់អ្នក។",
  noCard: "រកមិនឃើញកាតសម្រាប់លេខនេះទេ។",
  pinNeeded: "សូមកំណត់ PIN ជាមុនសិន (4 ទៅ 8 ខ្ទង់)!",
  badPin: "PIN មិនត្រឹមត្រូវ!",
  deskOff: "ទំព័របុគ្គលិកត្រូវបានបិទ។",
  deskLogin: "សូមចូលម្តងទៀត។",
  slow: "សូមរង់ចាំបន្តិច រួចព្យាយាមម្តងទៀត។",
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
const token = (n = 20) => crypto.randomBytes(n * 2).toString("base64url").replace(/[-_]/g, "").slice(0, n);
const localDay = (d = new Date()) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 10);
const dayStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - TZ * 3600000);
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Cambodian phone → "0xxxxxxxx" (digits only); "" when empty; null when wrong
function phoneOf(v) {
  let d = String(v ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("855")) d = `0${d.slice(3)}`;
  if (!d.startsWith("0")) d = `0${d}`;
  return d.length >= 9 && d.length <= 11 ? d : null;
}
const hexColor = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? String(v) : "");
const slugBase = (name) =>
  String(name || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

async function licenseState(businessId) {
  const rows = await License.find({ business_id: businessId, product: { $in: [PRODUCT, ...ADDONS, "sc_theme", "sc_poster"] } }).lean();
  const main = rows.find((r) => r.product === PRODUCT && !r.item);
  const license = statusOf(main);
  const endedAt = license.expires_at ? new Date(license.expires_at).getTime() : null;
  license.grace_until = endedAt ? new Date(endedAt + GRACE_DAYS * DAY) : null;
  license.locked = !main || (!license.active && endedAt !== null && Date.now() > endedAt + GRACE_DAYS * DAY);
  license.in_grace = !!main && !license.active && !license.locked;
  license.read_only = !license.active; // after the year: look only, no new stamps (customers' cards still open during the grace days)
  const addons = {};
  for (const key of ADDONS) addons[key] = statusOf(rows.find((r) => r.product === key && !r.item));
  const themes = [...FREE_THEMES, ...rows.filter((r) => r.product === "sc_theme" && r.item && statusOf(r).active).map((r) => r.item)];
  const posters = [...FREE_POSTERS, ...rows.filter((r) => r.product === "sc_poster" && r.item && statusOf(r).active).map((r) => r.item)];
  return { license, addons, themes, posters, maxCustomers: addons.sc_more.active ? LIMITS.customers_more : LIMITS.customers };
}

async function freeSlug(name) {
  const base = slugBase(name) || "shop";
  for (let i = 0; i < 20; i += 1) {
    const s = i === 0 ? base : `${base}-${token(4).toLowerCase()}`;
    if (!(await M.StampProgram.exists({ slug: s }))) return s;
  }
  return `${base}-${Date.now().toString(36)}`;
}
async function programOf(business) {
  const found = await M.StampProgram.findOne({ business_id: business._id });
  if (found) return found;
  try {
    return await M.StampProgram.create({ business_id: business._id, shop_name: business.name || "", phone: business.phone || "", address: business.address || "", slug: await freeSlug(business.name) });
  } catch (err) {
    if (err.code === 11000) return M.StampProgram.findOne({ business_id: business._id });
    throw err;
  }
}

// the rewards on the card, smallest first; the goal is always the last one
function levelsOf(p, addons) {
  const last = { at: p.goal, en: p.reward_en || "Reward", km: p.reward_km || p.reward_en || "រង្វាន់" };
  if (!addons?.sc_levels?.active) return [last];
  const more = (p.levels || [])
    .filter((l) => l.at >= 1 && l.at < p.goal && (l.en || l.km))
    .sort((a, b) => a.at - b.at)
    .filter((l, i, a) => i === 0 || a[i - 1].at !== l.at)
    .slice(0, 4)
    .map((l) => ({ at: l.at, en: l.en || l.km, km: l.km || l.en }));
  return [...more, last];
}
// rewards the customer can take now
const readyOf = (m, levels) => levels.filter((l) => (m.stamps || 0) >= l.at && !(m.claimed || []).includes(l.at));

const memberOut = (m, levels, full = false) => ({
  _id: m._id,
  no: m.no,
  name: m.name,
  phone: m.phone,
  note: m.note,
  stamps: m.stamps || 0,
  claimed: m.claimed || [],
  ready: readyOf(m, levels).map((l) => l.at),
  total_stamps: m.total_stamps || 0,
  rewards: m.rewards || 0,
  rounds: m.rounds || 0,
  last_stamp_at: m.last_stamp_at,
  last_visit_at: m.last_visit_at,
  via: m.via,
  tg_linked: !!m.tg?.chat_id,
  deleted: !!m.deleted,
  created_date: m.created_date,
  ...(full ? { token: m.token } : {}),
});
const eventOut = (e, member) => ({
  _id: e._id,
  member_id: e.member_id,
  ...(member ? { member: { _id: member._id, name: member.name, no: member.no, phone: member.phone } } : {}),
  kind: e.kind,
  n: e.n,
  after: e.after,
  reward: e.reward,
  note: e.note,
  by: e.by,
  at: e.at,
});
const programOut = (p) => {
  const o = p.toObject ? p.toObject() : { ...p };
  const desk = { on: o.desk?.on !== false, has_pin: !!o.desk?.pin_hash, can_reset: !!o.desk?.can_reset };
  delete o.tg;
  delete o.seq;
  delete o.logo_public_id;
  delete o.desk;
  return { ...o, desk };
};
const shopName = (p, business) => p?.shop_name || business?.name || "";
const cardLink = (p, m) => (p.web ? `${p.web}/stamp/c/${m.token}` : "");
const esc = telegram.escape;

// ---------- Telegram ----------
async function tellCustomer(m, text) {
  if (!m.tg?.chat_id || !telegram.ready()) return;
  await telegram.send(m.tg.chat_id, text).catch(async (err) => {
    if (err instanceof telegram.TelegramError && err.message === "blocked") await M.StampMember.updateOne({ _id: m._id }, { $set: { "tg.chat_id": "" } });
  });
}
async function tellOwner(p, kind, text) {
  if (!p.tg?.chat_id || p.tg[kind] === false || !telegram.ready()) return;
  await telegram.send(p.tg.chat_id, text).catch(async (err) => {
    if (err instanceof telegram.TelegramError && err.message === "blocked") await M.StampProgram.updateOne({ _id: p._id }, { $set: { "tg.chat_id": "" } });
  });
}
const later = (p) => p.catch(() => {}); // don't make the counter wait for Telegram

// stamps end after N months without a stamp (sc_expiry) — checked when the card is used / opened and once a day
async function expireIfOld(p, addons, m) {
  const last = m.last_stamp_at || m.created_date;
  if (!addons?.sc_expiry?.active || !p.expiry_months || !(m.stamps > 0) || !last) return m;
  const limit = new Date(last);
  limit.setMonth(limit.getMonth() + p.expiry_months);
  if (limit > new Date()) return m;
  const n = m.stamps;
  const after = await M.StampMember.findOneAndUpdate({ _id: m._id, stamps: n }, { $set: { stamps: 0, claimed: [] } }, { returnDocument: "after" });
  if (!after) return m;
  await M.StampEvent.create({ business_id: m.business_id, member_id: m._id, kind: "expire", n: -n, after: 0, note: `${p.expiry_months} months`, by: { kind: "system", name: "" } });
  return after;
}

// ---------- the shared actions (owner dashboard + staff desk) ----------
async function addMember(ctx, b, via) {
  const name = str(b.name, 80);
  if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
  const phone = phoneOf(b.phone);
  if (phone === null) throw new Bad(MSG.badPhone, 400, { code: "bad_phone" });
  if (phone && (await M.StampMember.exists({ business_id: ctx.business._id, phone, deleted: false }))) throw new Bad(MSG.phoneTaken, 409, { code: "phone_taken" });
  const count = await M.StampMember.countDocuments({ business_id: ctx.business._id, deleted: false });
  if (count >= ctx.maxCustomers) throw new Bad(ctx.addons.sc_more?.active ? MSG.customerMax : MSG.customerLimit, 402, ctx.addons.sc_more?.active ? { code: "max" } : { product: "sc_more", code: "customer_limit" });
  const seq = await M.StampProgram.findOneAndUpdate({ _id: ctx.program._id }, { $inc: { seq: 1 } }, { returnDocument: "after" })
    .select("seq")
    .lean();
  const start = Math.min(ctx.program.welcome || 0, ctx.program.goal);
  const now = new Date();
  const m = await M.StampMember.create({
    business_id: ctx.business._id,
    no: seq?.seq || count + 1,
    name,
    phone,
    note: str(b.note, 300),
    token: token(20),
    tg: { code: token(16) },
    stamps: start,
    total_stamps: start,
    last_visit_at: now, // (no last_stamp_at: a welcome stamp must not block the first real one)
    via,
  });
  await M.StampEvent.create({ business_id: ctx.business._id, member_id: m._id, kind: "join", n: start, after: start, note: via === "shop" ? "QR" : "", by: ctx.who });
  if (ctx.addons.sc_telegram?.active)
    later(tellOwner(ctx.program, "joined", `👋 <b>${esc(shopName(ctx.program, ctx.business))}</b>\nNew customer · អតិថិជនថ្មី: <b>${esc(m.name)}</b>${m.phone ? ` · ${esc(m.phone)}` : ""} · #${m.no}`));
  return m;
}

async function addStamps(ctx, m, b) {
  const p = ctx.program;
  const n = int(b.n ?? 1, 1, 20, 1);
  if (n > (p.max_per_visit || 5) && !ctx.owner) throw new Bad(MSG.tooMany, 400, { code: "too_many", max: p.max_per_visit });
  m = await expireIfOld(p, ctx.addons, m);
  const levels = levelsOf(p, ctx.addons);
  const before = readyOf(m, levels).length;
  const cap = p.goal * 2; // a card can't hold more than two rounds
  const add = Math.max(0, Math.min(n, cap - (m.stamps || 0)));
  const now = new Date();
  const after = await M.StampMember.findOneAndUpdate({ _id: m._id }, { $inc: { stamps: add, total_stamps: add }, $set: { last_stamp_at: now, last_visit_at: now } }, { returnDocument: "after" });
  const ev = await M.StampEvent.create({ business_id: ctx.business._id, member_id: m._id, kind: "stamp", n: add, after: after.stamps, note: str(b.note, 200), by: ctx.who });
  const ready = readyOf(after, levels);
  if (ctx.addons.sc_telegram?.active) {
    const shop = esc(shopName(p, ctx.business));
    const top = ready[ready.length - 1];
    later(
      tellCustomer(
        after,
        top
          ? `🎉 <b>${shop}</b>\nអ្នកមាន ${after.stamps}/${p.goal} ត្រា — ${esc(top.km)} រួចរាល់ហើយ!\nYou have ${after.stamps}/${p.goal} stamps — ${esc(top.en)} is ready!`
          : `✅ <b>${shop}</b>\n+${add} ត្រា · ${after.stamps}/${p.goal}\n+${add} stamp${add > 1 ? "s" : ""} · ${after.stamps}/${p.goal}${cardLink(p, after) ? `\n${cardLink(p, after)}` : ""}`,
      ),
    );
    if (ready.length > before && top)
      later(tellOwner(p, "reward", `🎉 <b>${shop}</b>\n<b>${esc(after.name)}</b>${after.phone ? ` · ${esc(after.phone)}` : ""} · #${after.no}\n${after.stamps}/${p.goal} — ${esc(top.km)} · ${esc(top.en)}`));
  }
  return { member: after, event: ev, added: add, ready: ready.map((l) => l.at), full: add < n };
}

async function giveReward(ctx, m, b) {
  const p = ctx.program;
  const levels = levelsOf(p, ctx.addons);
  const ready = readyOf(m, levels);
  const at = b.at !== undefined && b.at !== null ? int(b.at, 1, 20, 0) : ready[ready.length - 1]?.at;
  const level = ready.find((l) => l.at === at);
  if (!level) throw new Bad(MSG.notReady, 400, { code: "not_ready" });
  const last = level.at === p.goal;
  // the full card starts again (extra stamps stay); a smaller reward is just marked as given for this round
  const update = last ? { $inc: { stamps: -p.goal, rewards: 1, rounds: 1 }, $set: { claimed: [], last_visit_at: new Date() } } : { $inc: { rewards: 1 }, $push: { claimed: level.at }, $set: { last_visit_at: new Date() } };
  const after = await M.StampMember.findOneAndUpdate({ _id: m._id, stamps: { $gte: level.at }, claimed: { $ne: level.at } }, update, { returnDocument: "after" });
  if (!after) throw new Bad(MSG.busy, 409);
  const ev = await M.StampEvent.create({ business_id: ctx.business._id, member_id: m._id, kind: "reward", n: last ? -p.goal : 0, after: after.stamps, reward: `${level.km} · ${level.en}`.slice(0, 120), note: str(b.note, 200), by: ctx.who });
  if (ctx.addons.sc_telegram?.active) later(tellCustomer(after, `🎁 <b>${esc(shopName(p, ctx.business))}</b>\nសូមរីករាយជាមួយ ${esc(level.km)}! អរគុណ 🙏\nEnjoy your ${esc(level.en)}! Thank you 🙏`));
  return { member: after, event: ev, reward: level };
}

// a scanned card QR (link or token), a card number (#12) or a phone → customers
async function lookup(ctx, code) {
  const raw = str(code, 300);
  const bid = ctx.business._id;
  const link = raw.match(/\/stamp\/c\/([A-Za-z0-9]{12,40})/);
  const tok = link ? link[1] : /^[A-Za-z0-9]{16,40}$/.test(raw) ? raw : "";
  if (tok) {
    const m = await M.StampMember.findOne({ business_id: bid, token: tok, deleted: false });
    return m ? [m] : [];
  }
  const no = raw.match(/^#?\s*(\d{1,6})$/);
  const digits = raw.replace(/\D/g, "");
  const or = [];
  if (no) or.push({ no: Number(no[1]) });
  if (digits.length >= 6) {
    const ph = phoneOf(digits);
    if (ph) or.push({ phone: ph });
    or.push({ phone: { $regex: `${escRe(digits.slice(-6))}$` } });
  }
  if (!or.length && raw.length >= 2) or.push({ name: { $regex: escRe(raw), $options: "i" } });
  if (!or.length) return [];
  return M.StampMember.find({ business_id: bid, deleted: false, $or: or }).sort({ last_visit_at: -1 }).limit(10);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});
const logoUpload = (req, res, next) =>
  upload.single("logo")(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: MSG.badImage });
    next();
  });

module.exports = (prop) => {
  const base = "/api/user/businesses/:id/stamps";
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
      if (err instanceof LicenseError) return res.status(err.status).json({ success: false, message: MSG[err.message] || err.message, code: err.message, ...err.extra });
      if (err?.name === "ValidationError" || err?.name === "CastError") return res.status(400).json({ success: false, message: MSG.badValue });
      console.error("[stamp]", err);
      res.status(500).json({ success: false, message: MSG.server });
    }
  };

  // ---------- the owner (customer_auth) ----------
  async function ownerCtx(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    const [business, state] = await Promise.all([Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false }), licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== PRODUCT) throw new Bad(MSG.notStamp);
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (state.license.read_only) throw new Bad(MSG.locked, 402, { product: PRODUCT });
    }
    const program = await programOf(business);
    return { business, program, ...state, owner: true, who: { kind: "owner", name: req.customer.name || "" } };
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
  const memberOf = async (ctx, mid, withDeleted = false) => {
    if (!validId(mid)) throw new Bad(MSG.badId);
    const m = await M.StampMember.findOne({ _id: mid, business_id: ctx.business._id, ...(withDeleted ? {} : { deleted: false }) });
    if (!m) throw new Bad(MSG.rowNotFound, 404);
    return m;
  };
  const tgOut = (p, addons) => ({
    configured: telegram.ready(),
    active: !!addons.sc_telegram?.active,
    connected: !!p.tg?.chat_id,
    chat_name: p.tg?.chat_name || "",
    reward: p.tg?.reward !== false,
    joined: !!p.tg?.joined,
    daily: p.tg?.daily !== false,
    time: p.tg?.time || "20:00",
  });

  async function totalsOf(ctx) {
    const bid = ctx.business._id;
    const today = dayStart(localDay());
    const month = dayStart(`${localDay().slice(0, 7)}-01`);
    const levels = levelsOf(ctx.program, ctx.addons);
    const minAt = levels[0].at;
    const [customers, todayRows, monthRows, readyRows] = await Promise.all([
      M.StampMember.countDocuments({ business_id: bid, deleted: false }),
      M.StampEvent.aggregate([{ $match: { business_id: bid, at: { $gte: today } } }, { $group: { _id: "$kind", n: { $sum: "$n" }, c: { $sum: 1 } } }]),
      M.StampEvent.aggregate([{ $match: { business_id: bid, at: { $gte: month } } }, { $group: { _id: "$kind", n: { $sum: "$n" }, c: { $sum: 1 } } }]),
      M.StampMember.find({ business_id: bid, deleted: false, stamps: { $gte: minAt } })
        .select("stamps claimed")
        .lean(),
    ]);
    const pick = (rows, kind, f) => rows.find((r) => r._id === kind)?.[f] || 0;
    return {
      customers,
      ready: readyRows.filter((m) => readyOf(m, levels).length).length,
      today: { stamps: pick(todayRows, "stamp", "n"), visits: pick(todayRows, "stamp", "c"), rewards: pick(todayRows, "reward", "c"), joined: pick(todayRows, "join", "c") },
      month: { stamps: pick(monthRows, "stamp", "n"), visits: pick(monthRows, "stamp", "c"), rewards: pick(monthRows, "reward", "c"), joined: pick(monthRows, "join", "c") },
    };
  }

  // ---------------------------------------- overview ----------------------------------------
  door("get", "", {}, async (ctx, req, res) => {
    const origin = String(req.get("origin") || "");
    if (/^https?:\/\/[^/]+$/.test(origin) && ctx.program.web !== origin) M.StampProgram.updateOne({ _id: ctx.program._id }, { $set: { web: origin.slice(0, 200) } }).catch(() => {});
    const keys = [PRODUCT, ...ADDONS, "sc_theme", "sc_poster"];
    const [prices, totals] = await Promise.all([Promise.all(keys.map((k) => priceOf(k))), totalsOf(ctx)]);
    const price = Object.fromEntries(keys.map((k, i) => [k, prices[i]]));
    res.json({
      success: true,
      data: {
        business: { _id: ctx.business._id, name: ctx.business.name, status: ctx.business.status },
        program: programOut(ctx.program),
        levels: levelsOf(ctx.program, ctx.addons),
        license: { ...ctx.license, price: price[PRODUCT], days: 365 },
        addons: Object.fromEntries(ADDONS.map((k) => [k, { ...ctx.addons[k], price: price[k], days: YEARLY_ADDONS.includes(k) ? 365 : null }])),
        themes: { owned: ctx.themes, all: THEMES, price: price.sc_theme },
        posters: { owned: ctx.posters, price: price.sc_poster },
        icons: ICONS,
        limits: { customers: ctx.maxCustomers, free: LIMITS.customers },
        totals,
        telegram: tgOut(ctx.program, ctx.addons),
        bot: telegram.ready() ? await telegram.botUsername().catch(() => "") : "",
      },
    });
  });

  // ---------------------------------------- customers ----------------------------------------
  const listMembers = async (ctx, req, res) => {
    const bid = ctx.business._id;
    const filter = String(req.query.filter || "all");
    const q = str(req.query.q, 60);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 50;
    const levels = levelsOf(ctx.program, ctx.addons);
    const where = { business_id: bid, deleted: filter === "deleted" && ctx.owner !== false };
    if (filter === "ready") where.stamps = { $gte: levels[0].at };
    if (filter === "sleeping") where.last_visit_at = { $lt: new Date(Date.now() - 30 * DAY) };
    if (q) {
      const re = { $regex: escRe(q), $options: "i" };
      const or = [{ name: re }, { phone: { $regex: escRe(q.replace(/\D/g, "") || q) } }, { note: re }];
      if (/^#?\d{1,6}$/.test(q)) or.push({ no: Number(q.replace("#", "")) });
      where.$or = or;
    }
    const sorts = { recent: { last_visit_at: -1 }, name: { name: 1 }, stamps: { stamps: -1, last_visit_at: -1 }, best: { total_stamps: -1 }, new: { created_date: -1 } };
    const sort = sorts[req.query.sort] || (filter === "ready" ? sorts.stamps : sorts.recent);
    let [rows, total] = await Promise.all([
      M.StampMember.find(where)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.StampMember.countDocuments(where),
    ]);
    if (filter === "ready") rows = rows.filter((m) => readyOf(m, levels).length);
    res.json({ success: true, data: rows.map((m) => memberOut(m, levels)), pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page } });
  };
  door("get", "/members", {}, listMembers);

  door("post", "/members", { write: true }, async (ctx, req, res) => {
    const levels = levelsOf(ctx.program, ctx.addons);
    let m = await addMember(ctx, req.body || {}, "staff");
    // stamps they already had on a paper card
    const extra = int(req.body?.stamps, 0, ctx.program.goal * 2, 0);
    if (extra > 0) {
      m = await M.StampMember.findOneAndUpdate({ _id: m._id }, { $inc: { stamps: extra, total_stamps: extra } }, { returnDocument: "after" });
      await M.StampEvent.create({ business_id: ctx.business._id, member_id: m._id, kind: "adjust", n: extra, after: m.stamps, note: "Paper card · កាតក្រដាស", by: ctx.who });
    }
    res.status(201).json({ success: true, data: memberOut(m, levels, true), message: MSG.saved });
  });

  door("get", "/members/:mid", {}, async (ctx, req, res) => {
    let m = await memberOf(ctx, req.params.mid, true);
    m = await expireIfOld(ctx.program, ctx.addons, m);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 50;
    const where = { business_id: ctx.business._id, member_id: m._id };
    const [rows, total] = await Promise.all([
      M.StampEvent.find(where)
        .sort({ at: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.StampEvent.countDocuments(where),
    ]);
    res.json({
      success: true,
      data: { member: memberOut(m, levelsOf(ctx.program, ctx.addons), true), events: rows.map((e) => eventOut(e)), link: cardLink(ctx.program, m) },
      pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page },
    });
  });

  door("put", "/members/:mid", { write: true }, async (ctx, req, res) => {
    const m = await memberOf(ctx, req.params.mid);
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = str(b.name, 80);
      if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
      m.name = name;
    }
    if (b.phone !== undefined) {
      const phone = phoneOf(b.phone);
      if (phone === null) throw new Bad(MSG.badPhone, 400, { code: "bad_phone" });
      if (phone && phone !== m.phone && (await M.StampMember.exists({ business_id: ctx.business._id, phone, deleted: false, _id: { $ne: m._id } }))) throw new Bad(MSG.phoneTaken, 409, { code: "phone_taken" });
      m.phone = phone;
    }
    if (b.note !== undefined) m.note = str(b.note, 300);
    await m.save();
    res.json({ success: true, data: memberOut(m, levelsOf(ctx.program, ctx.addons), true), message: MSG.saved });
  });
  door("delete", "/members/:mid", { write: true }, async (ctx, req, res) => {
    const m = await memberOf(ctx, req.params.mid);
    m.deleted = true;
    m.deleted_at = new Date();
    await m.save();
    res.json({ success: true, message: MSG.deleted });
  });
  door("post", "/members/:mid/restore", { write: true }, async (ctx, req, res) => {
    const m = await memberOf(ctx, req.params.mid, true);
    if (m.deleted) {
      const count = await M.StampMember.countDocuments({ business_id: ctx.business._id, deleted: false });
      if (count >= ctx.maxCustomers) throw new Bad(MSG.customerLimit, 402, { product: "sc_more", code: "customer_limit" });
      if (m.phone && (await M.StampMember.exists({ business_id: ctx.business._id, phone: m.phone, deleted: false }))) throw new Bad(MSG.phoneTaken, 409, { code: "phone_taken" });
      m.deleted = false;
      m.deleted_at = null;
      await m.save();
    }
    res.json({ success: true, data: memberOut(m, levelsOf(ctx.program, ctx.addons), true), message: MSG.saved });
  });
  // a new card link (the old one stops working: lost phone, someone else saw it)
  door("post", "/members/:mid/new-link", { write: true }, async (ctx, req, res) => {
    const m = await memberOf(ctx, req.params.mid);
    m.token = token(20);
    await m.save();
    res.json({ success: true, data: memberOut(m, levelsOf(ctx.program, ctx.addons), true), link: cardLink(ctx.program, m), message: MSG.saved });
  });

  door("post", "/members/:mid/stamp", { write: true }, async (ctx, req, res) => {
    const r = await addStamps(ctx, await memberOf(ctx, req.params.mid), req.body || {});
    res.json({ success: true, data: { ...r, member: memberOut(r.member, levelsOf(ctx.program, ctx.addons)), event: eventOut(r.event) }, message: MSG.stamped });
  });
  door("post", "/members/:mid/reward", { write: true }, async (ctx, req, res) => {
    const r = await giveReward(ctx, await memberOf(ctx, req.params.mid), req.body || {});
    res.json({ success: true, data: { ...r, member: memberOut(r.member, levelsOf(ctx.program, ctx.addons)), event: eventOut(r.event) }, message: MSG.rewarded });
  });
  // fix a mistake: add or take stamps by hand (owner)
  door("post", "/members/:mid/adjust", { write: true }, async (ctx, req, res) => {
    const m = await memberOf(ctx, req.params.mid);
    const n = int(req.body?.n, -40, 40, 0);
    if (!n) throw new Bad(MSG.badValue);
    const next = Math.max(0, Math.min(ctx.program.goal * 2, (m.stamps || 0) + n));
    const diff = next - (m.stamps || 0);
    const set = { stamps: next, ...(next < (m.stamps || 0) ? { claimed: (m.claimed || []).filter((at) => at <= next) } : {}) };
    const after = await M.StampMember.findOneAndUpdate({ _id: m._id, stamps: m.stamps }, { $set: set, ...(diff > 0 ? { $inc: { total_stamps: diff } } : {}) }, { returnDocument: "after" });
    if (!after) throw new Bad(MSG.busy, 409);
    const ev = await M.StampEvent.create({ business_id: ctx.business._id, member_id: m._id, kind: "adjust", n: diff, after: after.stamps, note: str(req.body?.note, 200), by: ctx.who });
    res.json({ success: true, data: { member: memberOut(after, levelsOf(ctx.program, ctx.addons)), event: eventOut(ev) }, message: MSG.saved });
  });

  // reset one card to 0 (stamps + claimed rewards); the total stays for the stats
  const resetOne = async (ctx, m, note) => {
    if (!(m.stamps || 0) && !(m.claimed || []).length) return { member: m, event: null };
    const after = await M.StampMember.findOneAndUpdate({ _id: m._id, stamps: m.stamps }, { $set: { stamps: 0, claimed: [] } }, { returnDocument: "after" });
    if (!after) throw new Bad(MSG.busy, 409);
    const event = await M.StampEvent.create({ business_id: ctx.business._id, member_id: m._id, kind: "adjust", n: -(m.stamps || 0), after: 0, note: str(note, 200) || "Reset · កំណត់ឡើងវិញ", by: ctx.who });
    return { member: after, event };
  };
  door("post", "/members/:mid/reset", { write: true }, async (ctx, req, res) => {
    const r = await resetOne(ctx, await memberOf(ctx, req.params.mid), req.body?.note);
    res.json({ success: true, data: { member: memberOut(r.member, levelsOf(ctx.program, ctx.addons)), event: r.event && eventOut(r.event) }, message: MSG.saved });
  });
  // every card back to 0 (e.g. a new season) — owner only, the body must say { confirm: "RESET" }
  door("post", "/reset-all", { write: true }, async (ctx, req, res) => {
    if (req.body?.confirm !== "RESET") throw new Bad(MSG.badValue, 400, { code: "confirm" });
    const bid = ctx.business._id;
    const rows = await M.StampMember.find({ business_id: bid, deleted: false, $or: [{ stamps: { $gt: 0 } }, { "claimed.0": { $exists: true } }] })
      .select("_id stamps")
      .lean();
    if (rows.length) {
      await M.StampMember.updateMany({ _id: { $in: rows.map((m) => m._id) } }, { $set: { stamps: 0, claimed: [] } });
      const note = str(req.body?.note, 200) || "Reset all · កំណត់ទាំងអស់ឡើងវិញ";
      await M.StampEvent.insertMany(rows.map((m) => ({ business_id: bid, member_id: m._id, kind: "adjust", n: -(m.stamps || 0), after: 0, note, by: ctx.who })));
    }
    res.json({ success: true, data: { reset: rows.length }, message: MSG.saved });
  });

  door("post", "/lookup", {}, async (ctx, req, res) => {
    const levels = levelsOf(ctx.program, ctx.addons);
    const rows = await lookup(ctx, req.body?.code);
    const out = [];
    for (const m of rows) out.push(memberOut(await expireIfOld(ctx.program, ctx.addons, m), levels, true));
    res.json({ success: true, data: out });
  });

  const listHistory = async (ctx, req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 50;
    const where = { business_id: ctx.business._id };
    if (["join", "stamp", "reward", "adjust", "expire"].includes(req.query.kind)) where.kind = req.query.kind;
    const [rows, total] = await Promise.all([
      M.StampEvent.find(where)
        .sort({ at: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.StampEvent.countDocuments(where),
    ]);
    const members = await M.StampMember.find({ _id: { $in: [...new Set(rows.map((e) => String(e.member_id)))] } })
      .select("name no phone")
      .lean();
    const byId = new Map(members.map((m) => [String(m._id), m]));
    res.json({ success: true, data: rows.map((e) => eventOut(e, byId.get(String(e.member_id)) || { _id: e.member_id, name: "—" })), pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page } });
  };
  door("get", "/history", {}, listHistory);

  // stamps + visits + rewards per day, busiest hours, best customers
  const getStats = async (ctx, req, res) => {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const bid = ctx.business._id;
    const from = dayStart(localDay(new Date(Date.now() - (days - 1) * DAY)));
    const [perDay, hours, best, joined] = await Promise.all([
      M.StampEvent.aggregate([
        { $match: { business_id: bid, at: { $gte: from }, kind: { $in: ["stamp", "reward"] } } },
        { $group: { _id: { d: { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: "+07:00" } }, k: "$kind" }, n: { $sum: "$n" }, c: { $sum: 1 } } },
      ]),
      M.StampEvent.aggregate([{ $match: { business_id: bid, at: { $gte: from }, kind: "stamp" } }, { $group: { _id: { $hour: { date: "$at", timezone: "+07:00" } }, c: { $sum: 1 } } }]),
      M.StampEvent.aggregate([{ $match: { business_id: bid, at: { $gte: from }, kind: "stamp" } }, { $group: { _id: "$member_id", n: { $sum: "$n" }, c: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }]),
      M.StampEvent.countDocuments({ business_id: bid, at: { $gte: from }, kind: "join" }),
    ]);
    const list = [];
    for (let i = 0; i < days; i += 1) {
      const d = localDay(new Date(from.getTime() + i * DAY + 12 * 3600000));
      const s = perDay.find((r) => r._id.d === d && r._id.k === "stamp");
      const r = perDay.find((x) => x._id.d === d && x._id.k === "reward");
      list.push({ day: d, stamps: s?.n || 0, visits: s?.c || 0, rewards: r?.c || 0 });
    }
    const people = await M.StampMember.find({ _id: { $in: best.map((b) => b._id) } })
      .select("name no phone stamps")
      .lean();
    const byId = new Map(people.map((m) => [String(m._id), m]));
    res.json({
      success: true,
      data: {
        days: list,
        hours: Array.from({ length: 24 }, (_, h) => hours.find((x) => x._id === h)?.c || 0),
        best: best.filter((b) => byId.has(String(b._id))).map((b) => ({ ...byId.get(String(b._id)), period_stamps: b.n, visits: b.c })),
        joined,
        totals: { stamps: list.reduce((a, d) => a + d.stamps, 0), visits: list.reduce((a, d) => a + d.visits, 0), rewards: list.reduce((a, d) => a + d.rewards, 0) },
      },
    });
  };
  door("get", "/stats", {}, getStats);

  // ---------------------------------------- settings ----------------------------------------
  door("put", "/settings", { write: true }, async (ctx, req, res) => {
    const p = ctx.program;
    const b = req.body || {};
    for (const [k, max] of [
      ["shop_name", 80],
      ["phone", 40],
      ["address", 200],
      ["reward_en", 80],
      ["reward_km", 120],
      ["terms_en", 300],
      ["terms_km", 400],
    ])
      if (b[k] !== undefined) p[k] = str(b[k], max);
    // the shop name is also the business name (dashboard list, licenses)
    if (b.shop_name !== undefined && p.shop_name.length >= 2 && p.shop_name.slice(0, 100) !== ctx.business.name) {
      await Business.updateOne({ _id: ctx.business._id }, { $set: { name: p.shop_name.slice(0, 100) } });
      ctx.business.name = p.shop_name.slice(0, 100);
    }
    if (b.theme !== undefined) {
      if (!THEMES[b.theme]) throw new Bad(MSG.badTheme);
      if (!ctx.themes.includes(b.theme)) throw new Bad(MSG.themeLocked, 402, { product: "sc_theme", item: b.theme });
      p.theme = b.theme;
    }
    if (b.poster_info !== undefined && b.poster_info && typeof b.poster_info === "object") {
      const i = b.poster_info;
      for (const [k, max] of [["title", 60], ["sub", 80], ["rule", 80], ["scan", 90], ["note", 90]]) if (i[k] !== undefined) p.poster_info[k] = str(i[k], max);
      if (i.phone !== undefined) p.poster_info.phone = !!i.phone;
      if (i.address !== undefined) p.poster_info.address = !!i.address;
    }
    if (b.poster !== undefined) {
      if (!POSTERS[b.poster]) throw new Bad(MSG.badTheme);
      if (!ctx.posters.includes(b.poster)) throw new Bad(MSG.themeLocked, 402, { product: "sc_poster", item: b.poster });
      p.poster = b.poster;
    }
    if (b.color !== undefined) p.color = hexColor(b.color);
    if (b.icon !== undefined && ICONS.includes(b.icon)) p.icon = b.icon;
    if (b.goal !== undefined) p.goal = int(b.goal, 3, 20, p.goal);
    if (b.welcome !== undefined) p.welcome = int(b.welcome, 0, 3, 0);
    if (b.max_per_visit !== undefined) p.max_per_visit = int(b.max_per_visit, 1, 20, 5);
    if (b.join_on !== undefined) p.join_on = !!b.join_on;
    if (b.levels !== undefined) {
      need(ctx, "sc_levels", MSG.needLevels);
      const list = Array.isArray(b.levels) ? b.levels : [];
      p.levels = list
        .slice(0, 4)
        .map((l) => ({ at: int(l?.at, 1, 19, 0), en: str(l?.en, 80), km: str(l?.km, 120) }))
        .filter((l) => l.at >= 1 && l.at < p.goal && (l.en || l.km));
    }
    if (b.expiry_months !== undefined) {
      const v = int(b.expiry_months, 0, 24, 0);
      if (v) need(ctx, "sc_expiry", MSG.needExpiry);
      p.expiry_months = v;
    }
    await p.save();
    res.json({ success: true, data: { program: programOut(p), levels: levelsOf(p, ctx.addons) }, message: MSG.saved });
  });
  door(
    "post",
    "/logo",
    { write: true },
    async (ctx, req, res) => {
      if (!req.file) throw new Bad(MSG.noFile);
      const up = await cloud.uploadBuffer(req.file, "stamp");
      const old = ctx.program.logo_public_id;
      ctx.program.logo = up.url;
      ctx.program.logo_public_id = up.public_id;
      await ctx.program.save();
      if (old) cloud.deleteFile(old).catch(() => {});
      res.json({ success: true, data: { logo: up.url }, message: MSG.saved });
    },
    [logoUpload],
  );
  door("delete", "/logo", { write: true }, async (ctx, req, res) => {
    const old = ctx.program.logo_public_id;
    ctx.program.logo = "";
    ctx.program.logo_public_id = "";
    await ctx.program.save();
    if (old) cloud.deleteFile(old).catch(() => {});
    res.json({ success: true, data: { logo: "" }, message: MSG.saved });
  });
  // buy a premium design (forever) and use it
  door("post", "/themes/:key", { write: true }, async (ctx, req, res) => {
    const key = String(req.params.key);
    if (THEMES[key] !== "premium") throw new Bad(MSG.badTheme);
    const r = ctx.themes.includes(key) ? null : await buy({ customer: req.customer, business: ctx.business, product: "sc_theme", item: key });
    ctx.program.theme = key;
    await ctx.program.save();
    res.json({ success: true, data: { theme: key, charged: r?.charged || 0, balance: r?.balance }, balance: r?.balance, message: MSG.saved });
  });
  // buy a shop QR poster design (forever) and use it
  door("post", "/posters/:key", { write: true }, async (ctx, req, res) => {
    const key = String(req.params.key);
    if (POSTERS[key] !== "premium") throw new Bad(MSG.badTheme);
    const r = ctx.posters.includes(key) ? null : await buy({ customer: req.customer, business: ctx.business, product: "sc_poster", item: key });
    ctx.program.poster = key;
    await ctx.program.save();
    res.json({ success: true, data: { poster: key, charged: r?.charged || 0, balance: r?.balance }, balance: r?.balance, message: MSG.saved });
  });

  // the staff desk: on / off and its PIN (4–8 digits)
  door("put", "/desk", { write: true }, async (ctx, req, res) => {
    const b = req.body || {};
    const p = ctx.program;
    if (b.pin !== undefined && b.pin !== "") {
      const pin = String(b.pin);
      if (!/^\d{4,8}$/.test(pin)) throw new Bad(MSG.pinNeeded, 400, { code: "bad_pin" });
      p.desk.pin_hash = await bcrypt.hash(pin, 8);
      p.desk.ver = (p.desk.ver || 1) + 1;
    }
    if (b.on !== undefined) p.desk.on = !!b.on;
    if (b.can_reset !== undefined) p.desk.can_reset = !!b.can_reset;
    if (b.logout_all) p.desk.ver = (p.desk.ver || 1) + 1;
    await p.save();
    res.json({ success: true, data: { on: p.desk.on !== false, has_pin: !!p.desk.pin_hash, can_reset: !!p.desk.can_reset }, message: MSG.saved });
  });

  // ---------------------------------------- Telegram (sc_telegram) ----------------------------------------
  const tgFail = (err) => {
    if (err instanceof telegram.TelegramError) throw new Bad(err.message === "not_configured" ? MSG.tgNotConfigured : err.message === "blocked" ? MSG.tgBlocked : MSG.tgUnreachable, err.status);
    throw err;
  };
  telegram.onStart(async (code, chat) => {
    // the owner connects the shop's chat
    if (/^sp_[A-Za-z0-9]{10,40}$/.test(code)) {
      const p = await M.StampProgram.findOne({ "tg.link_code": code });
      if (!p || !p.tg.link_expires || p.tg.link_expires < new Date()) return "This link has expired. Make a new one in Biz Hub.\nតំណនេះផុតកំណត់ហើយ។ សូមបង្កើតថ្មីក្នុង Biz Hub។";
      p.tg.chat_id = String(chat.id);
      p.tg.chat_name = (chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "")).slice(0, 80);
      p.tg.connected_at = new Date();
      p.tg.link_code = "";
      p.tg.link_expires = null;
      await p.save();
      return `✅ <b>${esc(p.shop_name)}</b>\nConnected! Stamp card alerts will come here.\nបានភ្ជាប់! ការជូនដំណឹងកាតប្រមូលត្រានឹងមកទីនេះ។`;
    }
    // a customer wants their stamps on Telegram (button on their card)
    if (/^sc_[A-Za-z0-9]{10,40}$/.test(code)) {
      const m = await M.StampMember.findOne({ "tg.code": code.slice(3), deleted: false });
      if (!m) return "This link doesn't work any more.\nតំណនេះមិនដំណើរការទៀតទេ។";
      const p = await M.StampProgram.findOne({ business_id: m.business_id }).lean();
      m.tg.chat_id = String(chat.id);
      m.tg.chat_name = [chat.first_name, chat.last_name].filter(Boolean).join(" ").slice(0, 80) || (chat.username ? `@${chat.username}` : "");
      m.tg.linked_at = new Date();
      await m.save();
      return `✅ <b>${esc(p?.shop_name || "")}</b>\nសួស្តី ${esc(m.name)}! អ្នកនឹងទទួលដំណឹងត្រានៅទីនេះ។\nHello ${esc(m.name)}! Your stamps will show up here.\n\n⭐ ${m.stamps}/${p?.goal || 10}`;
    }
    return null;
  });
  door("post", "/telegram/link", { write: true }, async (ctx, req, res) => {
    need(ctx, "sc_telegram", MSG.needTelegram);
    if (!telegram.ready()) throw new Bad(MSG.tgNotConfigured, 503);
    const bot = await telegram.botUsername().catch(tgFail);
    const code = `sp_${token(24)}`;
    const expires = new Date(Date.now() + 15 * 60000);
    ctx.program.tg.link_code = code;
    ctx.program.tg.link_expires = expires;
    await ctx.program.save();
    res.json({ success: true, data: { url: `https://t.me/${bot}?start=${code}`, group_url: `https://t.me/${bot}?startgroup=${code}`, bot, expires_at: expires } });
  });
  door("post", "/telegram/test", { write: true }, async (ctx, req, res) => {
    need(ctx, "sc_telegram", MSG.needTelegram);
    const chat = ctx.program.tg?.chat_id;
    if (!chat) throw new Bad(MSG.tgNotConnected);
    try {
      await telegram.send(chat, `🔔 <b>${esc(shopName(ctx.program, ctx.business))}</b>\nTest message from Biz Hub — everything works.\nសារសាកល្បងពី Biz Hub — ដំណើរការល្អ។`);
    } catch (err) {
      if (err instanceof telegram.TelegramError && err.message === "blocked") {
        ctx.program.tg.chat_id = "";
        await ctx.program.save();
      }
      tgFail(err);
    }
    res.json({ success: true, message: MSG.tgSent });
  });
  door("put", "/telegram", { write: true }, async (ctx, req, res) => {
    const b = req.body || {};
    for (const k of ["reward", "joined", "daily"]) if (b[k] !== undefined) ctx.program.tg[k] = !!b[k];
    if (b.time !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time))) ctx.program.tg.time = String(b.time);
    await ctx.program.save();
    res.json({ success: true, data: tgOut(ctx.program, ctx.addons), message: MSG.saved });
  });
  door("delete", "/telegram", { write: true }, async (ctx, req, res) => {
    const chat = ctx.program.tg?.chat_id;
    ctx.program.tg.chat_id = "";
    ctx.program.tg.chat_name = "";
    ctx.program.tg.connected_at = null;
    await ctx.program.save();
    if (chat) telegram.send(chat, "🔌 Biz Hub disconnected from this chat.\nបានផ្តាច់ពី Biz Hub ហើយ។").catch(() => {});
    res.json({ success: true, data: tgOut(ctx.program, ctx.addons), message: MSG.saved });
  });

  // ---------------------------------------- public: shop page, join, find, card ----------------------------------------
  // the shop is open when the business, its owner and the card's year (or grace days) are fine
  async function openShop(slug) {
    const s = str(slug, 60).toLowerCase();
    const p = s ? await M.StampProgram.findOne({ slug: s }) : null;
    if (!p) throw new Bad(MSG.cardOff, 404, { code: "not_found" });
    const [business, state] = await Promise.all([Business.findOne({ _id: p.business_id, deleted: false }), licenseState(p.business_id)]);
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || !owner?.status || state.license.locked) throw new Bad(MSG.cardOff, 404, { code: "off" });
    return { business, program: p, ...state };
  }
  const look = (p, addons) => ({
    name: p.shop_name,
    phone: p.phone,
    address: p.address,
    logo: p.logo,
    theme: THEMES[p.theme] ? p.theme : "classic",
    color: p.color,
    icon: p.icon,
    goal: p.goal,
    levels: levelsOf(p, addons),
    terms: { en: p.terms_en, km: p.terms_km },
    expiry_months: addons.sc_expiry?.active ? p.expiry_months : 0,
  });
  const pub = (path) => `/api/public/stamp${path}`;
  const limiter = rate_limit({ windowMs: 10 * 60 * 1000, max: 15, message: MSG.slow });

  prop.app.get(
    pub("/shop/:slug"),
    handle(async (req, res) => {
      const ctx = await openShop(req.params.slug);
      res.set("Cache-Control", "no-store");
      res.json({ success: true, data: { shop: look(ctx.program, ctx.addons), join: ctx.program.join_on !== false && !ctx.license.read_only, check: !!ctx.addons.sc_check?.active, welcome: ctx.program.welcome || 0 } });
    }),
  );
  prop.app.post(
    pub("/shop/:slug/join"),
    limiter,
    handle(async (req, res) => {
      const ctx = await openShop(req.params.slug);
      if (ctx.program.join_on === false || ctx.license.read_only) throw new Bad(MSG.joinOff, 403, { code: "join_off" });
      const phone = phoneOf(req.body?.phone);
      if (!phone) throw new Bad(MSG.badPhone, 400, { code: "bad_phone" });
      const old = await M.StampMember.findOne({ business_id: ctx.business._id, phone, deleted: false });
      if (old) {
        // the phone already has a card: give it back only when the shop pays for self-check
        if (ctx.addons.sc_check?.active) return res.json({ success: true, data: { token: old.token, existing: true } });
        throw new Bad(MSG.hasCard, 409, { code: "has_card" });
      }
      const m = await addMember({ ...ctx, who: { kind: "shop", name: "" } }, { name: req.body?.name, phone }, "shop");
      res.status(201).json({ success: true, data: { token: m.token, existing: false } });
    }),
  );
  prop.app.post(
    pub("/shop/:slug/find"),
    limiter,
    handle(async (req, res) => {
      const ctx = await openShop(req.params.slug);
      if (!ctx.addons.sc_check?.active) throw new Bad(MSG.needCheck, 403, { code: "check_off" });
      const b = req.body || {};
      const phone = phoneOf(b.phone);
      if (phone) {
        const m = await M.StampMember.findOne({ business_id: ctx.business._id, phone, deleted: false });
        if (!m) throw new Bad(MSG.noCard, 404, { code: "no_card" });
        return res.json({ success: true, data: { token: m.token } });
      }
      // by name: the name alone could open someone else's card (and their reward), so the last 3 digits of the phone confirm it
      const name = str(b.name ?? (/\d{6,}/.test(String(b.phone || "")) ? "" : b.phone), 80);
      if (name.length < 2) throw new Bad(MSG.badPhone, 400, { code: "bad_phone" });
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      const found = await M.StampMember.find({ business_id: ctx.business._id, deleted: false, name: new RegExp(`^\\s*${esc}\\s*$`, "i") }).select("token phone").limit(20).lean();
      if (!found.length) throw new Bad(MSG.noCard, 404, { code: "no_card" });
      const withPhone = found.filter((m) => m.phone && m.phone.length >= 3);
      if (!withPhone.length) throw new Bad(MSG.askStaff, 409, { code: "ask_staff" });
      const last = String(b.last || "").replace(/\D/g, "");
      if (!last) return res.json({ success: true, data: { need_last: true } });
      if (last.length !== 3) throw new Bad(MSG.badLast, 400, { code: "bad_last" });
      const hit = withPhone.filter((m) => m.phone.endsWith(last));
      if (hit.length !== 1) throw new Bad(hit.length ? MSG.askStaff : MSG.badLast, hit.length ? 409 : 404, { code: hit.length ? "ask_staff" : "bad_last" });
      res.json({ success: true, data: { token: hit[0].token } });
    }),
  );
  prop.app.get(
    pub("/card/:token"),
    handle(async (req, res) => {
      const t = str(req.params.token, 40);
      let m = t.length >= 16 ? await M.StampMember.findOne({ token: t, deleted: false }) : null;
      if (!m) throw new Bad(MSG.cardOff, 404, { code: "not_found" });
      const p = await M.StampProgram.findOne({ business_id: m.business_id });
      const ctx = await openShop(p?.slug);
      m = await expireIfOld(ctx.program, ctx.addons, m);
      const levels = levelsOf(ctx.program, ctx.addons);
      const events = await M.StampEvent.find({ member_id: m._id, kind: { $in: ["join", "stamp", "reward", "expire", "adjust"] } })
        .sort({ at: -1 })
        .limit(15)
        .lean();
      const tgOn = !!ctx.addons.sc_telegram?.active && telegram.ready();
      res.set("Cache-Control", "no-store");
      res.json({
        success: true,
        data: {
          shop: { ...look(ctx.program, ctx.addons), slug: ctx.program.slug },
          member: { no: m.no, name: m.name, stamps: m.stamps || 0, claimed: m.claimed || [], ready: readyOf(m, levels).map((l) => l.at), rewards: m.rewards || 0, rounds: m.rounds || 0, last_stamp_at: m.last_stamp_at, since: m.created_date, tg_linked: !!m.tg?.chat_id },
          events: events.map((e) => ({ kind: e.kind, n: e.n, after: e.after, reward: e.reward, at: e.at })),
          telegram: tgOn && m.tg?.code ? { bot: await telegram.botUsername().catch(() => ""), start: `sc_${m.tg.code}` } : null,
        },
      });
    }),
  );

  // ---------------------------------------- the staff desk (PIN) ----------------------------------------
  const deskSign = (p) => prop.jwt.sign({ type: "stamp_desk", pid: String(p._id), bid: String(p.business_id), v: p.desk?.ver || 1 }, process.env.JWT_SECRET, { expiresIn: "14d" });
  async function deskCtx(req, write) {
    const ctx = await openShop(req.params.slug);
    const p = ctx.program;
    if (p.desk?.on === false || !p.desk?.pin_hash) throw new Bad(MSG.deskOff, 403, { code: "desk_off" });
    let d;
    try {
      d = prop.jwt.verify(String(req.get("x-desk-token") || ""), process.env.JWT_SECRET);
    } catch {
      throw new Bad(MSG.deskLogin, 401, { code: "desk_login" });
    }
    if (d.type !== "stamp_desk" || d.pid !== String(p._id) || d.v !== (p.desk?.ver || 1)) throw new Bad(MSG.deskLogin, 401, { code: "desk_login" });
    if (write && ctx.license.read_only) throw new Bad(MSG.locked, 402, { code: "locked" });
    return { ...ctx, owner: false, who: { kind: "desk", name: str(req.get("x-desk-name"), 40) } };
  }
  const desk = (method, path, write, fn) =>
    prop.app[method](
      pub(`/desk/:slug${path}`),
      handle(async (req, res) => fn(await deskCtx(req, write), req, res)),
    );
  prop.app.post(
    pub("/desk/:slug/login"),
    rate_limit({ windowMs: 15 * 60 * 1000, max: 10, message: MSG.slow }),
    handle(async (req, res) => {
      const ctx = await openShop(req.params.slug);
      const p = ctx.program;
      if (p.desk?.on === false || !p.desk?.pin_hash) throw new Bad(MSG.deskOff, 403, { code: "desk_off" });
      if (!(await bcrypt.compare(String(req.body?.pin || ""), p.desk.pin_hash))) throw new Bad(MSG.badPin, 401, { code: "bad_pin" });
      res.json({ success: true, data: { token: deskSign(p) } });
    }),
  );
  desk("get", "", false, async (ctx, req, res) => {
    const today = dayStart(localDay());
    const [stamps, rewards] = await Promise.all([
      M.StampEvent.aggregate([{ $match: { business_id: ctx.business._id, at: { $gte: today }, kind: "stamp" } }, { $group: { _id: null, n: { $sum: "$n" }, c: { $sum: 1 } } }]),
      M.StampEvent.countDocuments({ business_id: ctx.business._id, at: { $gte: today }, kind: "reward" }),
    ]);
    res.json({
      success: true,
      data: { shop: look(ctx.program, ctx.addons), max_per_visit: ctx.program.max_per_visit || 5, can_reset: !!ctx.program.desk?.can_reset, read_only: ctx.license.read_only, today: { stamps: stamps[0]?.n || 0, visits: stamps[0]?.c || 0, rewards } },
    });
  });
  desk("post", "/lookup", false, async (ctx, req, res) => {
    const levels = levelsOf(ctx.program, ctx.addons);
    const rows = await lookup(ctx, req.body?.code);
    const out = [];
    for (const m of rows) out.push(memberOut(await expireIfOld(ctx.program, ctx.addons, m), levels, true));
    res.json({ success: true, data: out });
  });
  // the staff also see the customers, the history and the stats (read only)
  desk("get", "/members", false, listMembers);
  desk("get", "/history", false, listHistory);
  desk("get", "/stats", false, getStats);
  desk("post", "/members", true, async (ctx, req, res) => {
    const m = await addMember(ctx, req.body || {}, "desk");
    res.status(201).json({ success: true, data: memberOut(m, levelsOf(ctx.program, ctx.addons), true), message: MSG.saved });
  });
  const deskMember = async (ctx, mid) => {
    if (!validId(mid)) throw new Bad(MSG.badId);
    const m = await M.StampMember.findOne({ _id: mid, business_id: ctx.business._id, deleted: false });
    if (!m) throw new Bad(MSG.rowNotFound, 404);
    return m;
  };
  desk("post", "/members/:mid/stamp", true, async (ctx, req, res) => {
    const r = await addStamps(ctx, await deskMember(ctx, req.params.mid), { n: req.body?.n });
    res.json({ success: true, data: { ...r, member: memberOut(r.member, levelsOf(ctx.program, ctx.addons)), event: eventOut(r.event) }, message: MSG.stamped });
  });
  desk("post", "/members/:mid/reset", true, async (ctx, req, res) => {
    if (!ctx.program.desk?.can_reset) throw new Bad(MSG.noReset, 403, { code: "no_reset" });
    const r = await resetOne(ctx, await deskMember(ctx, req.params.mid), req.body?.note);
    res.json({ success: true, data: { member: memberOut(r.member, levelsOf(ctx.program, ctx.addons)) }, message: MSG.saved });
  });
  desk("post", "/members/:mid/reward", true, async (ctx, req, res) => {
    const r = await giveReward(ctx, await deskMember(ctx, req.params.mid), { at: req.body?.at });
    res.json({ success: true, data: { ...r, member: memberOut(r.member, levelsOf(ctx.program, ctx.addons)), event: eventOut(r.event) }, message: MSG.rewarded });
  });
};
module.exports.licenseState = licenseState;
module.exports.levelsOf = levelsOf;
module.exports.phoneOf = phoneOf;

// ---------------------------------------- scheduler (run by /api/cron/daily-report) ----------------------------------------
// After the owner's time (Cambodia, default 20:00): the day's summary on Telegram (sc_telegram).
// Once a day: cards with stamps older than the expiry months go back to 0 (sc_expiry).
module.exports.dailyReports = async function dailyReports(now = new Date()) {
  const day = localDay(now);
  const hhmm = new Date(now.getTime() + TZ * 3600000).toISOString().slice(11, 16);
  const today = dayStart(day);
  let summaries = 0;
  let expired = 0;
  // summaries
  const withChat = await M.StampProgram.find({ "tg.chat_id": { $gt: "" }, "tg.daily": { $ne: false }, $or: [{ "tg.last_daily_at": null }, { "tg.last_daily_at": { $lt: today } }] }).limit(500);
  for (const p of withChat) {
    if ((p.tg?.time || "20:00") > hhmm) continue;
    p.tg.last_daily_at = now;
    await p.save();
    const [state, business] = await Promise.all([licenseState(p.business_id), Business.findOne({ _id: p.business_id, deleted: false, status: true }).lean()]);
    if (!business || !state.license.active || !state.addons.sc_telegram?.active || !telegram.ready()) continue;
    const rows = await M.StampEvent.aggregate([{ $match: { business_id: p.business_id, at: { $gte: today } } }, { $group: { _id: "$kind", n: { $sum: "$n" }, c: { $sum: 1 } } }]);
    const pick = (k, f) => rows.find((r) => r._id === k)?.[f] || 0;
    const levels = levelsOf(p, state.addons);
    const readyRows = await M.StampMember.find({ business_id: p.business_id, deleted: false, stamps: { $gte: levels[0].at } })
      .select("name stamps claimed")
      .lean();
    const ready = readyRows.filter((m) => readyOf(m, levels).length);
    const lines = [
      `⭐ <b>${esc(p.shop_name || business.name)}</b> · ${day}`,
      `☕ Visits · ការមកលេង: <b>${pick("stamp", "c")}</b>   ⭐ Stamps · ត្រា: <b>${pick("stamp", "n")}</b>`,
      `🎁 Rewards · រង្វាន់: <b>${pick("reward", "c")}</b>   👋 New · ថ្មី: <b>${pick("join", "c")}</b>`,
      ...(ready.length ? ["", `🎉 Reward ready · រង្វាន់រួចរាល់ (${ready.length})`, ...ready.slice(0, 10).map((m) => `• ${esc(m.name)} — ${m.stamps}/${p.goal}`)] : []),
    ];
    const ok = await telegram
      .send(p.tg.chat_id, lines.join("\n"))
      .then(() => true)
      .catch(() => false);
    if (ok) summaries += 1;
  }
  // stamps that ended
  const withExpiry = await M.StampProgram.find({ expiry_months: { $gt: 0 }, $or: [{ last_expiry_at: null }, { last_expiry_at: { $lt: today } }] }).limit(500);
  for (const p of withExpiry) {
    p.last_expiry_at = now;
    await p.save();
    const state = await licenseState(p.business_id);
    if (!state.addons.sc_expiry?.active) continue;
    const limit = new Date(now);
    limit.setMonth(limit.getMonth() - p.expiry_months);
    const old = await M.StampMember.find({ business_id: p.business_id, deleted: false, stamps: { $gt: 0 }, $or: [{ last_stamp_at: { $lt: limit } }, { last_stamp_at: null, created_date: { $lt: limit } }] }).limit(2000);
    for (const m of old) {
      const n = m.stamps;
      const r = await M.StampMember.updateOne({ _id: m._id, stamps: n }, { $set: { stamps: 0, claimed: [] } });
      if (r.modifiedCount) {
        expired += 1;
        await M.StampEvent.create({ business_id: p.business_id, member_id: m._id, kind: "expire", n: -n, after: 0, note: `${p.expiry_months} months`, by: { kind: "system", name: "" } });
      }
    }
  }
  return { summaries, expired };
};
