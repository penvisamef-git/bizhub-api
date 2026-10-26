// Debt Book (20 coins, paid once when the business is added): customers who owe money, debts + payments (USD and riel apart),
// credit limits, due dates, a statement link for each customer (/d/<token>), a ready-made reminder for Telegram.
// Add-ons: debt_remind (auto reminders on Telegram + the owner's daily summary, yearly), debt_more (more than 100 customers),
// debt_excel (import / export), debt_nobrand — forever. For shops selling on credit or anyone lending money (personal).
//
// Owner base: /api/user/businesses/:id/debt
//   GET  ""                                  everything the dashboard needs (book, totals, add-ons, prices…)
//   GET  /customers?q&filter&sort&page       filter = all|owing|overdue|week|paid|deleted (deleted: owner)
//   POST /customers                          { name, phone, telegram, address, note, limit, due_at, opening: { usd, khr } }
//   GET  /customers/:cid?page                one person + their lines
//   PUT  /customers/:cid  DELETE /customers/:cid  POST /customers/:cid/restore  POST /customers/:cid/new-link   (owner)
//   POST/DELETE /customers/:cid/photo        (owner)
//   POST /customers/:cid/entries             { kind: debt|pay, currency, amount, note, method, due_at, date, force }
//   POST /customers/:cid/reminded            a reminder was sent by hand (counts it)
//   POST /customers/:cid/remind              send the Telegram reminder now (debt_remind, the person linked the bot)
//   PUT  /entries/:eid { note, method, due_at }   POST /entries/:eid/void { reason }   POST /entries/:eid/restore   (owner)
//   GET  /history?page&by                    every line, newest first (owner)
//   PUT  /settings  POST/DELETE /logo        (owner)
//   GET /export   POST /import { rows }      (owner, debt_excel)
//   POST /telegram/link  POST /telegram/test  PUT /telegram { daily }  DELETE /telegram   (owner, debt_remind)
// Public: GET /api/public/debt/:token      the customer's statement
// Scheduler: dailyReports() — run by /api/cron/daily-report
const mongoose = require("mongoose");
const crypto = require("crypto");
const multer = require("multer");
const M = require("./debt.models");
const Business = require("../business.model");
const { bizOwner, roleIn } = require("../team/team.access"); // team members (Admin / View only) open it too
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const { statusOf, LicenseError, DAY } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");
const cloud = require("../../util/cloudinary");
const telegram = require("../../telegram");

const ADDONS = ["debt_remind", "debt_more", "debt_excel", "debt_nobrand"];
const YEARLY_ADDONS = ["debt_remind"];
const LIMITS = { customers: 100, customers_more: 5000, import: 2000 };
const TZ = 7;
const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  notBook: "អាជីវកម្មនេះមិនមែនជាសៀវភៅបំណុលទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  locked: "សៀវភៅបំណុលផុតកំណត់ហើយ! សូមបន្តដើម្បីប្រើប្រាស់។",
  rowNotFound: "រកមិនឃើញទិន្នន័យ!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
  badValue: "តម្លៃមិនត្រឹមត្រូវ!",
  needName: "សូមបញ្ចូលឈ្មោះ!",
  badAmount: "សូមបញ្ចូលចំនួនទឹកប្រាក់ត្រឹមត្រូវ!",
  customerLimit: "អតិថិជនឥតគិតថ្លៃមានតែ 100។ សូមដោះសោ “អតិថិជនគ្មានកំណត់”។",
  customerMax: "អតិថិជនច្រើនពេក!",
  overLimit: "លើសកម្រិតឥណទានរបស់អតិថិជននេះ!",
  tooMuch: "ច្រើនជាងប្រាក់ដែលជំពាក់!",
  ownerOnly: "មានតែម្ចាស់ទេដែលអាចធ្វើបាន!",
  needRemind: "សូមដោះសោ “រំលឹកស្វ័យប្រវត្តិ” ជាមុនសិន!",
  needExcel: "សូមដោះសោ “នាំចូល / នាំចេញ Excel” ជាមុនសិន!",
  badImage: "សូមដាក់រូបភាព JPG / PNG / WEBP (តិចជាង 5MB)!",
  noFile: "សូមជ្រើសរើសរូបភាព!",
  alreadyVoid: "បន្ទាត់នេះត្រូវបានលុបរួចហើយ!",
  notVoid: "បន្ទាត់នេះមិនទាន់ត្រូវបានលុបទេ!",
  noTelegram: "អតិថិជននេះមិនទាន់ចុចទទួលការរំលឹកលើ Telegram ទេ។",
  nothingOwed: "អតិថិជននេះមិនជំពាក់ទេ។",
  remindSent: "បានផ្ញើការរំលឹក!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  already: "បានទិញរួចហើយ!",
  busy: "កំពុងដំណើរការ សូមព្យាយាមម្តងទៀត!",
  tgNotConfigured: "Telegram មិនទាន់រៀបចំនៅលើម៉ាសុីនមេ។",
  tgBlocked: "Telegram៖ បុតត្រូវបានបិទ ឬដកចេញ។ សូមភ្ជាប់ម្តងទៀត។",
  tgUnreachable: "មិនអាចទាក់ទង Telegram បាន។ សូមព្យាយាមម្តងទៀត។",
  tgNotConnected: "មិនទាន់ភ្ជាប់ Telegram ទេ។",
  tgSent: "បានផ្ញើសារសាកល្បង!",
  imported: "បាននាំចូល!",
  slow: "សូមរង់ចាំបន្តិច រួចព្យាយាមម្តងទៀត។",
  statementOff: "តំណនេះមិនដំណើរការទេ។",
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
const rnd = (cur, v) => (cur === "KHR" ? Math.round(v) : Math.round(v * 100) / 100);
const cur = (v) => (v === "KHR" ? "KHR" : v === "USD" ? "USD" : null);
const field = (c) => (c === "KHR" ? "khr" : "usd");
const amountOf = (v, c) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > (c === "KHR" ? 4e9 : 1e6)) throw new Bad(MSG.badAmount, 400, { code: "bad_amount" });
  return rnd(c, n);
};
const moneyIn = (v) => {
  const o = v && typeof v === "object" ? v : {};
  const n = (x, c) => {
    const k = Number(x);
    return Number.isFinite(k) && k > 0 ? rnd(c, Math.min(k, c === "KHR" ? 4e9 : 1e6)) : 0;
  };
  return { usd: n(o.usd, "USD"), khr: n(o.khr, "KHR") };
};
const dateIn = (v) => {
  if (v === null || v === "" || v === undefined) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2100 ? null : d;
};
const token = (n = 20) => crypto.randomBytes(n).toString("base64url").replace(/[-_]/g, "").slice(0, n);
const localDay = (d = new Date()) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 10);
const dayStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - TZ * 3600000); // Cambodia midnight
const owes = (b) => (b?.usd || 0) > 0 || (b?.khr || 0) > 0;
const fmtMoney = (c, v) => (c === "KHR" ? `${Math.round(v).toLocaleString("en-US")}៛` : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`);
const owedText = (b) => [b.usd > 0 && fmtMoney("USD", b.usd), b.khr > 0 && fmtMoney("KHR", b.khr)].filter(Boolean).join(" + ") || "0";
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function licenseState(businessId) {
  // the book itself is paid once (when the business is added) — always on; only the add-ons have licenses
  const rows = await License.find({ business_id: businessId, product: { $in: ADDONS } }).lean();
  const license = { active: true, forever: true, expires_at: null, status: "forever", locked: false, in_grace: false, read_only: false };
  const addons = {};
  for (const key of ADDONS) addons[key] = statusOf(rows.find((r) => r.product === key && !r.item));
  return { license, addons, maxCustomers: addons.debt_more.active ? LIMITS.customers_more : LIMITS.customers };
}
async function bookOf(business) {
  const found = await M.DebtBook.findOne({ business_id: business._id });
  if (found) return found;
  try {
    return await M.DebtBook.create({ business_id: business._id, shop_name: business.name || "", phone: business.phone || "", address: business.address || "" });
  } catch (err) {
    if (err.code === 11000) return M.DebtBook.findOne({ business_id: business._id });
    throw err;
  }
}

// the reminder words (owner's own words, or the standard ones). {name} {amount} {due} {shop} {phone} {link}
function reminderText(book, c, lang, link = "") {
  const due = c.due_at ? new Date(new Date(c.due_at).getTime() + TZ * 3600000).toISOString().slice(0, 10).split("-").reverse().join("/") : "";
  const own = lang === "en" ? book.remind?.text_en : book.remind?.text_km;
  const std =
    lang === "en"
      ? `Hello {name}, this is a friendly reminder from {shop}: you owe {amount}${due ? " (due {due})" : ""}. Thank you!${link ? "\nYour statement: {link}" : ""}`
      : `សួស្តី {name} នេះជាការរំលឹកពី {shop}៖ ប្រាក់ជំពាក់ {amount}${due ? " (ដល់ថ្ងៃ {due})" : ""}។ សូមអរគុណ!${link ? "\nមើលបញ្ជី៖ {link}" : ""}`;
  const map = { name: c.name, amount: owedText(c.balance || {}), due, shop: book.shop_name || "", phone: book.phone || "", link };
  return String(own || std).replace(/\{(name|amount|due|shop|phone|link)\}/g, (m, k) => map[k] ?? "");
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});
const photoUpload = (req, res, next) =>
  upload.single("photo")(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: MSG.badImage });
    next();
  });

const custOut = (c, full = false) => ({
  _id: c._id,
  name: c.name,
  phone: c.phone,
  telegram: c.telegram,
  address: c.address,
  note: c.note,
  photo: c.photo,
  limit: c.limit || { usd: 0, khr: 0 },
  balance: c.balance || { usd: 0, khr: 0 },
  due_at: c.due_at,
  last_at: c.last_at,
  remind: c.remind !== false,
  tg_linked: !!c.tg?.chat_id,
  last_remind_at: c.last_remind_at,
  reminds: c.reminds || 0,
  deleted: !!c.deleted,
  created_date: c.created_date,
  ...(full ? { token: c.token } : {}),
});
const entryOut = (e) => ({
  _id: e._id,
  customer_id: e.customer_id,
  kind: e.kind,
  currency: e.currency,
  amount: e.amount,
  note: e.note,
  method: e.method,
  due_at: e.due_at,
  date: e.date,
  no: e.no,
  by: e.by,
  void: !!e.void,
  void_at: e.void_at,
  void_by: e.void_by,
  void_reason: e.void_reason,
  created_date: e.created_date,
});

module.exports = (prop) => {
  const base = "/api/user/businesses/:id/debt";

  // ---------- the owner of the book (customer_auth) ----------
  async function ownerCtx(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    const [business, state] = await Promise.all([Business.findOne({ _id: req.params.id, ...bizOwner(req), deleted: false }), licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== "debt_book") throw new Bad(MSG.notBook);
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (state.license.read_only) throw new Bad(MSG.locked, 402, { product: "debt_book" });
    }
    const book = await bookOf(business);
    return { business, book, ...state, owner: true, who: { kind: "owner", id: String(req.customer._id), name: req.customer.name || "" } };
  }
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
      if (err instanceof LicenseError) return res.status(err.status).json({ success: false, message: MSG[err.message] || err.message, code: err.message, ...err.extra });
      if (err?.name === "ValidationError" || err?.name === "CastError") return res.status(400).json({ success: false, message: MSG.badValue });
      console.error("[debt]", err);
      res.status(500).json({ success: false, message: MSG.server });
    }
  };
  // door(method, path, { write }, fn)
  const door = (method, path, o, fn, mw = []) => {
    prop.app[method](
      `${base}${path}`,
      prop.api_auth,
      customer_auth,
      ...mw,
      handle(async (req, res) => fn(await ownerCtx(req, o.write), req, res)),
    );
  };
  const need = (ctx, key, msg) => {
    if (!ctx.addons[key]?.active) throw new Bad(msg, 402, { product: key });
  };
  const ownerOnly = (ctx) => {
    if (!ctx.owner) throw new Bad(MSG.ownerOnly, 403, { code: "owner_only" });
  };
  const customerOf = async (ctx, cid, withDeleted = false) => {
    if (!validId(cid)) throw new Bad(MSG.badId);
    const c = await M.DebtCustomer.findOne({ _id: cid, business_id: ctx.business._id, ...(withDeleted ? {} : { deleted: false }) });
    if (!c) throw new Bad(MSG.rowNotFound, 404);
    return c;
  };
  const tgOut = (book, addons) => ({ configured: telegram.ready(), active: !!addons.debt_remind?.active, connected: !!book.tg?.chat_id, chat_name: book.tg?.chat_name || "", daily: book.tg?.daily !== false });
  const bookOut = (b, owner) => {
    const o = b.toObject ? b.toObject() : { ...b };
    delete o.tg;
    delete o.seq;
    delete o.logo_public_id;
    return o;
  };

  // ---------- totals: owed, people, overdue, this month ----------
  async function totalsOf(bid) {
    const today = dayStart(localDay());
    const month = dayStart(`${localDay().slice(0, 7)}-01`);
    const [owed, monthly] = await Promise.all([
      M.DebtCustomer.aggregate([
        { $match: { business_id: bid, deleted: false } },
        {
          $group: {
            _id: null,
            usd: { $sum: { $cond: [{ $gt: ["$balance.usd", 0] }, "$balance.usd", 0] } },
            khr: { $sum: { $cond: [{ $gt: ["$balance.khr", 0] }, "$balance.khr", 0] } },
            people: { $sum: { $cond: [{ $or: [{ $gt: ["$balance.usd", 0] }, { $gt: ["$balance.khr", 0] }] }, 1, 0] } },
            overdue: { $sum: { $cond: [{ $and: [{ $or: [{ $gt: ["$balance.usd", 0] }, { $gt: ["$balance.khr", 0] }] }, { $ne: ["$due_at", null] }, { $lt: ["$due_at", today] }] }, 1, 0] } },
            customers: { $sum: 1 },
          },
        },
      ]),
      M.DebtEntry.aggregate([{ $match: { business_id: bid, void: false, date: { $gte: month } } }, { $group: { _id: { kind: "$kind", currency: "$currency" }, sum: { $sum: "$amount" }, n: { $sum: 1 } } }]),
    ]);
    const o = owed[0] || { usd: 0, khr: 0, people: 0, overdue: 0, customers: 0 };
    const m = (kind, c) => monthly.find((x) => x._id.kind === kind && x._id.currency === c)?.sum || 0;
    return {
      owed: { usd: rnd("USD", o.usd), khr: rnd("KHR", o.khr) },
      people: o.people,
      overdue: o.overdue,
      customers: o.customers,
      month: { lent: { usd: rnd("USD", m("debt", "USD")), khr: m("debt", "KHR") }, paid: { usd: rnd("USD", m("pay", "USD")), khr: m("pay", "KHR") } },
    };
  }

  // ---------------------------------------- overview ----------------------------------------
  door("get", "", {}, async (ctx, req, res) => {
    // remember the web address the owner uses (for links in Telegram messages)
    const origin = String(req.get("origin") || "");
    if (ctx.owner && /^https?:\/\/[^/]+$/.test(origin) && ctx.book.web !== origin) M.DebtBook.updateOne({ _id: ctx.book._id }, { $set: { web: origin.slice(0, 200) } }).catch(() => {});
    const keys = ["debt_book", ...ADDONS];
    const [prices, totals] = await Promise.all([Promise.all(keys.map((k) => priceOf(k))), totalsOf(ctx.business._id)]);
    const price = Object.fromEntries(keys.map((k, i) => [k, prices[i]]));
    res.json({
      success: true,
      data: {
        business: { _id: ctx.business._id, name: ctx.business.name, status: ctx.business.status },
        book: bookOut(ctx.book, ctx.owner),
        license: ctx.license,
        addons: Object.fromEntries(ADDONS.map((k) => [k, { ...ctx.addons[k], price: price[k], days: YEARLY_ADDONS.includes(k) ? 365 : null }])),
        base_price: price.debt_book,
        limits: { customers: ctx.maxCustomers, free: LIMITS.customers },
        totals,
        telegram: ctx.owner ? tgOut(ctx.book, ctx.addons) : undefined,
        me: ctx.who,
        owner: ctx.owner,
        bot: telegram.ready() ? await telegram.botUsername().catch(() => "") : "",
      },
    });
  });

  // ---------------------------------------- customers ----------------------------------------
  door("get", "/customers", {}, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const filter = String(req.query.filter || "all");
    const q = str(req.query.q, 60);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 50;
    const today = dayStart(localDay());
    const owing = { $or: [{ "balance.usd": { $gt: 0 } }, { "balance.khr": { $gt: 0 } }] };
    const where = { business_id: bid, deleted: filter === "deleted" && ctx.owner };
    if (filter === "owing") Object.assign(where, owing);
    if (filter === "overdue") Object.assign(where, owing, { due_at: { $ne: null, $lt: today } });
    if (filter === "week") Object.assign(where, owing, { due_at: { $gte: today, $lt: new Date(today.getTime() + 7 * DAY) } });
    if (filter === "paid") Object.assign(where, { "balance.usd": { $lte: 0 }, "balance.khr": { $lte: 0 } });
    if (q) {
      const re = { $regex: escRe(q), $options: "i" };
      where.$and = [{ $or: [{ name: re }, { phone: re }, { telegram: re }, { note: re }] }];
    }
    const sorts = { name: { name: 1 }, due: { due_at: 1, name: 1 }, recent: { last_at: -1, created_date: -1 }, balance: { "balance.usd": -1, "balance.khr": -1, name: 1 } };
    const sort = sorts[req.query.sort] || (filter === "overdue" || filter === "week" ? sorts.due : sorts.balance);
    const [rows, total] = await Promise.all([
      M.DebtCustomer.find(where)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.DebtCustomer.countDocuments(where),
    ]);
    res.json({ success: true, data: rows.map((c) => custOut(c)), pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page } });
  });

  // add a line to a customer: balance + due date move with it (atomic $inc)
  async function addEntry(ctx, c, b, opts = {}) {
    const kind = b.kind === "pay" ? "pay" : b.kind === "debt" ? "debt" : null;
    if (!kind) throw new Bad(MSG.badValue);
    const currency = cur(b.currency) || ctx.book.main || "USD";
    const amount = amountOf(b.amount, currency);
    const f = field(currency);
    const bal = c.balance?.[f] || 0;
    if (kind === "debt" && !opts.skipLimit) {
      const lim = c.limit?.[f] || 0;
      if (lim > 0 && rnd(currency, bal + amount) > lim && !(b.force && ctx.owner)) throw new Bad(MSG.overLimit, 409, { code: "over_limit", limit: lim, balance: bal, currency, owner_can_force: true });
    }
    if (kind === "pay" && rnd(currency, amount) > rnd(currency, Math.max(0, bal)) && !b.force) throw new Bad(MSG.tooMuch, 409, { code: "too_much", balance: bal, currency });
    const due = kind === "debt" ? dateIn(b.due_at) : null;
    const date = dateIn(b.date) && dateIn(b.date) <= new Date(Date.now() + DAY) ? dateIn(b.date) : new Date();
    const seq = await M.DebtBook.findOneAndUpdate({ _id: ctx.book._id }, { $inc: { seq: 1 } }, { returnDocument: "after" })
      .select("seq")
      .lean();
    const row = await M.DebtEntry.create({
      business_id: ctx.business._id,
      customer_id: c._id,
      kind,
      currency,
      amount,
      note: str(b.note, 300),
      method: kind === "pay" ? str(b.method, 30) : "",
      due_at: due,
      date,
      no: seq?.seq || 0,
      by: ctx.who,
    });
    const after = await M.DebtCustomer.findOneAndUpdate({ _id: c._id }, { $inc: { [`balance.${f}`]: kind === "debt" ? amount : -amount }, $set: { last_at: new Date() } }, { returnDocument: "after" });
    // due date: a new debt with a date sets it (the earlier one wins while they still owe); paid off → no due date
    after.balance.usd = rnd("USD", after.balance.usd);
    after.balance.khr = rnd("KHR", after.balance.khr);
    if (kind === "debt" && due) {
      const owedBefore = owes(c.balance);
      if (!after.due_at || !owedBefore || due < after.due_at) after.due_at = due;
    }
    if (!owes(after.balance)) {
      after.due_at = null;
      after.reminds = 0;
    }
    await after.save();
    return { row, customer: after };
  }

  door("post", "/customers", { write: true }, async (ctx, req, res) => {
    const b = req.body || {};
    const name = str(b.name, 80);
    if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
    const count = await M.DebtCustomer.countDocuments({ business_id: ctx.business._id, deleted: false });
    if (count >= ctx.maxCustomers) throw new Bad(ctx.addons.debt_more?.active ? MSG.customerMax : MSG.customerLimit, 402, ctx.addons.debt_more?.active ? { code: "max" } : { product: "debt_more", code: "customer_limit" });
    let c = await M.DebtCustomer.create({
      business_id: ctx.business._id,
      name,
      phone: str(b.phone, 40),
      telegram: str(b.telegram, 60),
      address: str(b.address, 200),
      note: str(b.note, 500),
      limit: ctx.owner ? moneyIn(b.limit) : { usd: 0, khr: 0 },
      token: token(20),
      tg: { code: token(16) },
      due_at: dateIn(b.due_at),
    });
    // money they already owed before (from the old notebook)
    const opening = moneyIn(b.opening);
    for (const [k, currency] of [
      ["usd", "USD"],
      ["khr", "KHR"],
    ])
      if (opening[k] > 0) c = (await addEntry(ctx, c, { kind: "debt", currency, amount: opening[k], note: str(b.opening_note, 300) || "Opening balance · ជំពាក់ពីមុន", due_at: b.due_at }, { skipLimit: true })).customer;
    res.status(201).json({ success: true, data: custOut(c, true), message: MSG.saved });
  });

  door("get", "/customers/:cid", {}, async (ctx, req, res) => {
    const c = await customerOf(ctx, req.params.cid, ctx.owner);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 100;
    const where = { business_id: ctx.business._id, customer_id: c._id, ...(ctx.owner ? {} : { void: false }) };
    const [rows, total] = await Promise.all([
      M.DebtEntry.find(where)
        .sort({ date: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.DebtEntry.countDocuments(where),
    ]);
    const web = ctx.book.web;
    const link = web ? `${web}/d/${c.token}` : "";
    res.json({
      success: true,
      data: {
        customer: custOut(c, true),
        entries: rows.map(entryOut),
        remind_text: { km: reminderText(ctx.book, c, "km", link), en: reminderText(ctx.book, c, "en", link) },
        tg_start: c.tg?.code ? `dc_${c.tg.code}` : "",
      },
      pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page },
    });
  });

  door("put", "/customers/:cid", { write: true }, async (ctx, req, res) => {
    const c = await customerOf(ctx, req.params.cid);
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = str(b.name, 80);
      if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
      c.name = name;
    }
    for (const [k, max] of [
      ["phone", 40],
      ["telegram", 60],
      ["address", 200],
      ["note", 500],
    ])
      if (b[k] !== undefined) c[k] = str(b[k], max);
    if (b.limit !== undefined) c.limit = moneyIn(b.limit);
    if (b.due_at !== undefined) c.due_at = owes(c.balance) ? dateIn(b.due_at) : null;
    if (b.remind !== undefined) c.remind = !!b.remind;
    await c.save();
    res.json({ success: true, data: custOut(c, true), message: MSG.saved });
  });
  door("delete", "/customers/:cid", { write: true }, async (ctx, req, res) => {
    const c = await customerOf(ctx, req.params.cid);
    c.deleted = true;
    c.deleted_at = new Date();
    await c.save();
    res.json({ success: true, message: MSG.deleted });
  });
  door("post", "/customers/:cid/restore", { write: true }, async (ctx, req, res) => {
    const c = await customerOf(ctx, req.params.cid, true);
    if (c.deleted) {
      const count = await M.DebtCustomer.countDocuments({ business_id: ctx.business._id, deleted: false });
      if (count >= ctx.maxCustomers) throw new Bad(MSG.customerLimit, 402, { product: "debt_more", code: "customer_limit" });
    }
    c.deleted = false;
    c.deleted_at = null;
    await c.save();
    res.json({ success: true, data: custOut(c, true), message: MSG.saved });
  });
  door("post", "/customers/:cid/new-link", { write: true }, async (ctx, req, res) => {
    const c = await customerOf(ctx, req.params.cid);
    c.token = token(20);
    await c.save();
    res.json({ success: true, data: custOut(c, true), message: MSG.saved });
  });
  door(
    "post",
    "/customers/:cid/photo",
    { write: true },
    async (ctx, req, res) => {
      const c = await customerOf(ctx, req.params.cid);
      if (!req.file) throw new Bad(MSG.noFile);
      const saved = await cloud.uploadBuffer(req.file, `debt/${ctx.business._id}`);
      if (c.photo_public_id) cloud.deleteFile(c.photo_public_id).catch(() => {});
      c.photo = saved.url;
      c.photo_public_id = saved.public_id || "";
      await c.save();
      res.json({ success: true, data: custOut(c, true), message: MSG.saved });
    },
    [photoUpload],
  );
  door("delete", "/customers/:cid/photo", { write: true }, async (ctx, req, res) => {
    const c = await customerOf(ctx, req.params.cid);
    if (c.photo_public_id) cloud.deleteFile(c.photo_public_id).catch(() => {});
    c.photo = "";
    c.photo_public_id = "";
    await c.save();
    res.json({ success: true, data: custOut(c, true), message: MSG.saved });
  });

  // ---------------------------------------- debts + payments ----------------------------------------
  door("post", "/customers/:cid/entries", { write: true }, async (ctx, req, res) => {
    const c = await customerOf(ctx, req.params.cid);
    const { row, customer } = await addEntry(ctx, c, req.body || {});
    res.status(201).json({ success: true, data: { entry: entryOut(row), customer: custOut(customer, true) }, message: MSG.saved });
  });
  const entryOf = async (ctx, eid) => {
    if (!validId(eid)) throw new Bad(MSG.badId);
    const e = await M.DebtEntry.findOne({ _id: eid, business_id: ctx.business._id });
    if (!e) throw new Bad(MSG.rowNotFound, 404);
    return e;
  };
  // cancel / bring back a line: the balance moves back
  async function flip(ctx, e, toVoid, reason) {
    if (toVoid === e.void) throw new Bad(toVoid ? MSG.alreadyVoid : MSG.notVoid);
    const f = field(e.currency);
    const sign = (e.kind === "debt" ? 1 : -1) * (toVoid ? -1 : 1);
    e.void = toVoid;
    e.void_at = toVoid ? new Date() : null;
    e.void_by = toVoid ? ctx.who.name || ctx.who.kind : "";
    e.void_reason = toVoid ? str(reason, 200) : "";
    await e.save();
    const c = await M.DebtCustomer.findOneAndUpdate({ _id: e.customer_id }, { $inc: { [`balance.${f}`]: sign * e.amount } }, { returnDocument: "after" });
    if (c) {
      c.balance.usd = rnd("USD", c.balance.usd);
      c.balance.khr = rnd("KHR", c.balance.khr);
      if (!owes(c.balance)) c.due_at = null;
      else if (!c.due_at && e.kind === "debt" && !toVoid && e.due_at) c.due_at = e.due_at;
      await c.save();
    }
    return c;
  }
  door("post", "/entries/:eid/void", { write: true }, async (ctx, req, res) => {
    const e = await entryOf(ctx, req.params.eid);
    const c = await flip(ctx, e, true, req.body?.reason);
    res.json({ success: true, data: { entry: entryOut(e), customer: c && custOut(c, true) }, message: MSG.deleted });
  });
  door("post", "/entries/:eid/restore", { write: true }, async (ctx, req, res) => {
    const e = await entryOf(ctx, req.params.eid);
    const c = await flip(ctx, e, false);
    res.json({ success: true, data: { entry: entryOut(e), customer: c && custOut(c, true) }, message: MSG.saved });
  });
  door("put", "/entries/:eid", { write: true }, async (ctx, req, res) => {
    const e = await entryOf(ctx, req.params.eid);
    const b = req.body || {};
    if (b.note !== undefined) e.note = str(b.note, 300);
    if (b.method !== undefined && e.kind === "pay") e.method = str(b.method, 30);
    if (b.due_at !== undefined && e.kind === "debt") e.due_at = dateIn(b.due_at);
    await e.save();
    res.json({ success: true, data: entryOut(e), message: MSG.saved });
  });
  door("get", "/history", {}, async (ctx, req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 100;
    const where = { business_id: ctx.business._id };
    if (req.query.by === "void") where.void = true;
    const [rows, total] = await Promise.all([
      M.DebtEntry.find(where)
        .sort({ date: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.DebtEntry.countDocuments(where),
    ]);
    const names = await M.DebtCustomer.find({ _id: { $in: [...new Set(rows.map((r) => String(r.customer_id)))] } })
      .select("name")
      .lean();
    const nameOf = Object.fromEntries(names.map((n) => [String(n._id), n.name]));
    res.json({ success: true, data: rows.map((r) => ({ ...entryOut(r), customer_name: nameOf[String(r.customer_id)] || "" })), pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page } });
  });

  // ---------------------------------------- reminders ----------------------------------------
  door("post", "/customers/:cid/reminded", { write: true }, async (ctx, req, res) => {
    const c = await customerOf(ctx, req.params.cid);
    c.last_remind_at = new Date();
    c.reminds = (c.reminds || 0) + 1;
    await c.save();
    res.json({ success: true, data: custOut(c, true) });
  });
  async function sendReminder(book, c, lang = "km") {
    const web = book.web;
    const link = web ? `${web}/d/${c.token}` : "";
    const text = reminderText(book, c, lang, link);
    await telegram.send(c.tg.chat_id, telegram.escape(text));
    await M.DebtCustomer.updateOne({ _id: c._id }, { $set: { last_remind_at: new Date() }, $inc: { reminds: 1 } });
  }
  door("post", "/customers/:cid/remind", { write: true }, async (ctx, req, res) => {
    need(ctx, "debt_remind", MSG.needRemind);
    const c = await customerOf(ctx, req.params.cid);
    if (!owes(c.balance)) throw new Bad(MSG.nothingOwed);
    if (!c.tg?.chat_id) throw new Bad(MSG.noTelegram, 400, { code: "no_telegram" });
    try {
      await sendReminder(ctx.book, c, req.body?.lang === "en" ? "en" : "km");
    } catch (err) {
      if (err instanceof telegram.TelegramError && err.message === "blocked") await M.DebtCustomer.updateOne({ _id: c._id }, { $set: { "tg.chat_id": "" } });
      tgFail(err);
    }
    res.json({ success: true, message: MSG.remindSent });
  });

  // ---------------------------------------- settings ----------------------------------------
  door("put", "/settings", { write: true }, async (ctx, req, res) => {
    const b = req.body || {};
    const k = ctx.book;
    for (const [key, max] of [
      ["shop_name", 80],
      ["phone", 40],
      ["address", 200],
    ])
      if (b[key] !== undefined) k[key] = str(b[key], max);
    if (b.main !== undefined) k.main = cur(b.main) || "USD";
    if (b.rate !== undefined) {
      const r = Math.round(Number(b.rate));
      if (!(r >= 1000 && r <= 10000)) throw new Bad(MSG.badValue);
      k.rate = r;
    }
    if (b.remind && typeof b.remind === "object") {
      const r = b.remind;
      if (r.on !== undefined) k.remind.on = !!r.on;
      if (r.before !== undefined) k.remind.before = Math.max(0, Math.min(7, Math.round(Number(r.before) || 0)));
      if (r.every !== undefined) k.remind.every = Math.max(0, Math.min(30, Math.round(Number(r.every) || 0)));
      if (r.time !== undefined) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.time))) throw new Bad(MSG.badValue);
        k.remind.time = String(r.time);
      }
      if (r.text_km !== undefined) k.remind.text_km = str(r.text_km, 500);
      if (r.text_en !== undefined) k.remind.text_en = str(r.text_en, 500);
    }
    await k.save();
    res.json({ success: true, data: bookOut(k, true), message: MSG.saved });
  });
  door(
    "post",
    "/logo",
    { write: true },
    async (ctx, req, res) => {
      if (!req.file) throw new Bad(MSG.noFile);
      const saved = await cloud.uploadBuffer(req.file, `debt/${ctx.business._id}`);
      if (ctx.book.logo_public_id) cloud.deleteFile(ctx.book.logo_public_id).catch(() => {});
      ctx.book.logo = saved.url;
      ctx.book.logo_public_id = saved.public_id || "";
      await ctx.book.save();
      await Business.updateOne({ _id: ctx.business._id }, { $set: { logo_url: saved.url } });
      res.json({ success: true, data: bookOut(ctx.book, true), message: MSG.saved });
    },
    [photoUpload],
  );
  door("delete", "/logo", { write: true }, async (ctx, req, res) => {
    if (ctx.book.logo_public_id) cloud.deleteFile(ctx.book.logo_public_id).catch(() => {});
    ctx.book.logo = "";
    ctx.book.logo_public_id = "";
    await ctx.book.save();
    await Business.updateOne({ _id: ctx.business._id }, { $set: { logo_url: "" } });
    res.json({ success: true, data: bookOut(ctx.book, true), message: MSG.saved });
  });

  // ---------------------------------------- Excel (debt_excel) ----------------------------------------
  door("get", "/export", {}, async (ctx, req, res) => {
    need(ctx, "debt_excel", MSG.needExcel);
    const [customers, entries] = await Promise.all([
      M.DebtCustomer.find({ business_id: ctx.business._id, deleted: false }).sort({ name: 1 }).lean(),
      M.DebtEntry.find({ business_id: ctx.business._id, void: false }).sort({ date: 1 }).limit(50000).lean(),
    ]);
    const nameOf = Object.fromEntries(customers.map((c) => [String(c._id), c.name]));
    res.json({
      success: true,
      data: {
        customers: customers.map((c) => custOut(c)),
        entries: entries.filter((e) => nameOf[String(e.customer_id)]).map((e) => ({ ...entryOut(e), customer_name: nameOf[String(e.customer_id)] })),
      },
    });
  });
  door("post", "/import", { write: true }, async (ctx, req, res) => {
    need(ctx, "debt_excel", MSG.needExcel);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, LIMITS.import) : [];
    let count = await M.DebtCustomer.countDocuments({ business_id: ctx.business._id, deleted: false });
    const out = { added: 0, updated: 0, skipped: 0, full: false };
    for (const r of rows) {
      const name = str(r?.name, 80);
      if (!name) {
        out.skipped += 1;
        continue;
      }
      const phone = str(r.phone, 40);
      // same name + phone already there → add the money to that person
      let c = await M.DebtCustomer.findOne({ business_id: ctx.business._id, deleted: false, name, phone });
      if (!c) {
        if (count >= ctx.maxCustomers) {
          out.full = true;
          out.skipped += 1;
          continue;
        }
        c = await M.DebtCustomer.create({ business_id: ctx.business._id, name, phone, telegram: str(r.telegram, 60), address: str(r.address, 200), note: str(r.note, 500), token: token(20), tg: { code: token(16) } });
        count += 1;
        out.added += 1;
      } else out.updated += 1;
      const m = moneyIn({ usd: r.usd, khr: r.khr });
      for (const [k, currency] of [
        ["usd", "USD"],
        ["khr", "KHR"],
      ])
        if (m[k] > 0) c = (await addEntry(ctx, c, { kind: "debt", currency, amount: m[k], note: str(r.what, 300) || "Imported · នាំចូល", due_at: r.due }, { skipLimit: true })).customer;
    }
    res.json({ success: true, data: out, message: MSG.imported });
  });

  // ---------------------------------------- Telegram ----------------------------------------
  const esc = telegram.escape;
  const tgFail = (err) => {
    if (err instanceof telegram.TelegramError) throw new Bad(err.message === "not_configured" ? MSG.tgNotConfigured : err.message === "blocked" ? MSG.tgBlocked : MSG.tgUnreachable, err.status);
    throw err;
  };
  telegram.onStart(async (code, chat) => {
    // the owner's chat (daily summary)
    if (/^db_[A-Za-z0-9]{12,40}$/.test(code)) {
      const book = await M.DebtBook.findOne({ "tg.link_code": code });
      if (!book || !book.tg.link_expires || book.tg.link_expires < new Date()) return "⌛️ This link has expired. Open BizHub → Debt Book → Telegram → Connect again.\nតំណនេះផុតកំណត់ហើយ។ សូមចុច “ភ្ជាប់” ម្តងទៀត។";
      const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "Telegram");
      book.tg = { ...book.tg.toObject(), chat_id: String(chat.id), chat_name: name.slice(0, 80), connected_at: new Date(), link_code: "", link_expires: null };
      await book.save();
      return `✅ <b>${esc(book.shop_name || "Debt Book")}</b> is connected.\nបានភ្ជាប់សៀវភៅបំណុលហើយ។\n\n📒 You'll get a daily summary of who owes and who is late.`;
    }
    // a customer asks for reminders (from their statement page)
    if (/^dc_[A-Za-z0-9]{10,40}$/.test(code)) {
      const c = await M.DebtCustomer.findOne({ "tg.code": code.slice(3), deleted: false });
      if (!c) return "This link doesn't work any more.\nតំណនេះមិនដំណើរការទៀតទេ។";
      const book = await M.DebtBook.findOne({ business_id: c.business_id }).lean();
      c.tg.chat_id = String(chat.id);
      c.tg.chat_name = [chat.first_name, chat.last_name].filter(Boolean).join(" ").slice(0, 80) || (chat.username ? `@${chat.username}` : "");
      c.tg.linked_at = new Date();
      await c.save();
      return `✅ <b>${esc(book?.shop_name || "")}</b>\nសួស្តី ${esc(c.name)}! អ្នកនឹងទទួលការរំលឹកនៅទីនេះ។\nHello ${esc(c.name)}! You'll get payment reminders here.\n\n💵 ${esc(owedText(c.balance || {}))}`;
    }
    return null;
  });
  door("post", "/telegram/link", { write: true }, async (ctx, req, res) => {
    need(ctx, "debt_remind", MSG.needRemind);
    if (!telegram.ready()) throw new Bad(MSG.tgNotConfigured, 503);
    const bot = await telegram.botUsername().catch(tgFail);
    const code = `db_${token(24)}`;
    const expires = new Date(Date.now() + 15 * 60000);
    ctx.book.tg.link_code = code;
    ctx.book.tg.link_expires = expires;
    await ctx.book.save();
    res.json({ success: true, data: { url: `https://t.me/${bot}?start=${code}`, group_url: `https://t.me/${bot}?startgroup=${code}`, bot, expires_at: expires } });
  });
  door("post", "/telegram/test", { write: true }, async (ctx, req, res) => {
    need(ctx, "debt_remind", MSG.needRemind);
    const chat = ctx.book.tg?.chat_id;
    if (!chat) throw new Bad(MSG.tgNotConnected);
    try {
      await telegram.send(chat, `🔔 <b>${esc(ctx.book.shop_name || ctx.business.name)}</b>\nTest message from BizHub — everything works.\nសារសាកល្បងពី BizHub — ដំណើរការល្អ។`);
    } catch (err) {
      if (err instanceof telegram.TelegramError && err.message === "blocked") {
        ctx.book.tg.chat_id = "";
        await ctx.book.save();
      }
      tgFail(err);
    }
    res.json({ success: true, message: MSG.tgSent });
  });
  door("put", "/telegram", { write: true }, async (ctx, req, res) => {
    if (req.body?.daily !== undefined) ctx.book.tg.daily = !!req.body.daily;
    await ctx.book.save();
    res.json({ success: true, data: tgOut(ctx.book, ctx.addons), message: MSG.saved });
  });
  door("delete", "/telegram", { write: true }, async (ctx, req, res) => {
    const chat = ctx.book.tg?.chat_id;
    ctx.book.tg.chat_id = "";
    ctx.book.tg.chat_name = "";
    ctx.book.tg.connected_at = null;
    await ctx.book.save();
    if (chat) telegram.send(chat, "🔌 BizHub disconnected from this chat.\nបានផ្តាច់ពី BizHub ហើយ។").catch(() => {});
    res.json({ success: true, data: tgOut(ctx.book, ctx.addons), message: MSG.saved });
  });

  // ---------------------------------------- public: the customer's statement ----------------------------------------
  prop.app.get(
    "/api/public/debt/:token",
    handle(async (req, res) => {
      const t = str(req.params.token, 40);
      const c = t.length >= 16 ? await M.DebtCustomer.findOne({ token: t, deleted: false }).lean() : null;
      if (!c) throw new Bad(MSG.statementOff, 404, { code: "not_found" });
      const [business, state, book] = await Promise.all([Business.findOne({ _id: c.business_id, deleted: false }).lean(), licenseState(c.business_id), M.DebtBook.findOne({ business_id: c.business_id }).lean()]);
      const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
      if (!business?.status || !owner?.status || state.license.locked) throw new Bad(MSG.statementOff, 404, { code: "off" });
      const entries = await M.DebtEntry.find({ business_id: c.business_id, customer_id: c._id, void: false }).sort({ date: -1, _id: -1 }).limit(200).lean();
      const remind = !!state.addons.debt_remind?.active && telegram.ready() && book?.remind?.on !== false;
      res.set("Cache-Control", "no-store");
      res.json({
        success: true,
        data: {
          shop: { name: book?.shop_name || business.name, phone: book?.phone || "", address: book?.address || "", logo: book?.logo || "" },
          customer: { name: c.name, balance: c.balance, due_at: c.due_at, tg_linked: !!c.tg?.chat_id },
          entries: entries.map((e) => ({ _id: e._id, kind: e.kind, currency: e.currency, amount: e.amount, note: e.note, method: e.method, date: e.date, due_at: e.due_at, no: e.no })),
          rate: book?.rate || 4100,
          telegram: remind && c.tg?.code ? { bot: await telegram.botUsername().catch(() => ""), start: `dc_${c.tg.code}` } : null,
          branding: !state.addons.debt_nobrand?.active,
        },
      });
    }),
  );
};
module.exports.licenseState = licenseState;
module.exports.reminderText = reminderText;

// ---------------------------------------- scheduler (run by /api/cron/daily-report) ----------------------------------------
// After each book's reminder time (Cambodia): customers who linked Telegram and owe money get a reminder
// N days before the due date, on the day, then every N days while late. The owner gets a daily summary.
module.exports.dailyReports = async function dailyReports(now = new Date()) {
  const day = localDay(now);
  const hhmm = new Date(now.getTime() + TZ * 3600000).toISOString().slice(11, 16);
  const today = dayStart(day);
  const books = await M.DebtBook.find({ $or: [{ "remind.last_run_at": null }, { "remind.last_run_at": { $lt: today } }] }).limit(300);
  let reminders = 0;
  let summaries = 0;
  let checked = 0;
  for (const book of books) {
    if ((book.remind?.time || "09:00") > hhmm) continue;
    checked += 1;
    book.remind.last_run_at = now;
    await book.save();
    const [state, business] = await Promise.all([licenseState(book.business_id), Business.findOne({ _id: book.business_id, deleted: false, status: true }).lean()]);
    if (!business || !state.license.active || !state.addons.debt_remind?.active || !telegram.ready()) continue;
    const web = book.web || "";
    // customers
    if (book.remind?.on !== false) {
      const before = book.remind?.before ?? 1;
      const every = book.remind?.every ?? 7;
      const list = await M.DebtCustomer.find({
        business_id: book.business_id,
        deleted: false,
        remind: { $ne: false },
        "tg.chat_id": { $gt: "" },
        due_at: { $ne: null, $lt: new Date(today.getTime() + (before + 1) * DAY) },
        $or: [{ "balance.usd": { $gt: 0 } }, { "balance.khr": { $gt: 0 } }],
      }).limit(1000);
      for (const c of list) {
        const dueDay = localDay(c.due_at);
        const daysTo = Math.round((Date.parse(`${dueDay}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY);
        const last = c.last_remind_at ? localDay(c.last_remind_at) : "";
        if (last === day) continue;
        let send = false;
        if (daysTo === before || daysTo === 0)
          send = true; // before + on the day
        else if (daysTo < 0) {
          // late: on the first late day, then every N days
          const lastDays = last ? Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / DAY) : 999;
          send = every > 0 ? lastDays >= every : !last || last < dueDay;
        }
        if (!send) continue;
        const link = web ? `${web}/d/${c.token}` : "";
        const ok = await telegram
          .send(c.tg.chat_id, telegram.escape(reminderText(book, c, "km", link)))
          .then(() => true)
          .catch(async (err) => {
            if (err instanceof telegram.TelegramError && err.message === "blocked") await M.DebtCustomer.updateOne({ _id: c._id }, { $set: { "tg.chat_id": "" } });
            return false;
          });
        if (ok) {
          reminders += 1;
          await M.DebtCustomer.updateOne({ _id: c._id }, { $set: { last_remind_at: now }, $inc: { reminds: 1 } });
        }
      }
    }
    // the owner's summary
    if (book.tg?.chat_id && book.tg.daily !== false) {
      const owing = await M.DebtCustomer.find({ business_id: book.business_id, deleted: false, $or: [{ "balance.usd": { $gt: 0 } }, { "balance.khr": { $gt: 0 } }] })
        .select("name balance due_at")
        .lean();
      const late = owing.filter((c) => c.due_at && c.due_at < today).sort((a, b) => a.due_at - b.due_at);
      const dueToday = owing.filter((c) => c.due_at && localDay(c.due_at) === day);
      const sum = owing.reduce((a, c) => ({ usd: a.usd + Math.max(0, c.balance?.usd || 0), khr: a.khr + Math.max(0, c.balance?.khr || 0) }), { usd: 0, khr: 0 });
      const lines = [
        `📒 <b>${telegram.escape(book.shop_name || business.name)}</b> · ${day}`,
        `💵 Owed · ប្រាក់ជំពាក់: <b>${telegram.escape(owedText({ usd: rnd("USD", sum.usd), khr: sum.khr }))}</b> · ${owing.length} 👤`,
        `⏰ Late · ហួសកំណត់: <b>${late.length}</b>   📅 Due today · ដល់ថ្ងៃនេះ: <b>${dueToday.length}</b>`,
        ...(late.length ? ["", "⏰ Late", ...late.slice(0, 10).map((c) => `• ${telegram.escape(c.name)} — ${telegram.escape(owedText(c.balance))} (${localDay(c.due_at)})`)] : []),
        ...(dueToday.length ? ["", "📅 Today", ...dueToday.slice(0, 10).map((c) => `• ${telegram.escape(c.name)} — ${telegram.escape(owedText(c.balance))}`)] : []),
      ];
      const ok = await telegram
        .send(book.tg.chat_id, lines.join("\n"))
        .then(() => true)
        .catch(() => false);
      if (ok) {
        summaries += 1;
        book.tg.last_daily_at = now;
        await book.save();
      }
    }
  }
  return { checked, reminders, summaries };
};
