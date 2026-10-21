// BizHub ↔ customers
// Customer (/api/user, business owner login):
//   GET  /coin-shop                         packages, bank accounts (QR), hotline, my last orders
//   POST /coin-orders  (multipart)          items (JSON [{ key, qty }]), bank, reference, note, proof (image) → waiting for the team
//   GET  /coin-orders                       POST /coin-orders/:oid/cancel (still waiting only)
//   GET  /support                           "Chat with BizHub": my conversation (opening it = read)
//   POST /support      (multipart)          text + files (up to 5: images, PDF, Word, Excel…)
//   GET  /support/unread                    { n } for the menu badge
// Super admin (/api/admin):
//   GET/PUT /platform                       packages, hotline, Telegram switches
//   POST /platform/banks (multipart qr)     PUT/DELETE /platform/banks/:key   (PUT can carry a new qr)
//   POST /platform/banks/:key/amount-qrs (multipart qr, usd, link)   PUT (link) / DELETE /platform/banks/:key/amount-qrs/:usd
//        QR pictures with the amount already in them — checkout shows the one that matches the cart total
//   POST /platform/telegram/link            → { url } open it, press Start   · POST /platform/telegram/test · DELETE /platform/telegram
//   GET  /coin-orders?status=&page=         POST /coin-orders/:oid/approve   POST /coin-orders/:oid/reject { reason }
//   GET  /support?q=&page=                  conversations (newest first)    GET /support/:tid (opening = read)   POST /support/:tid (multipart)
//   GET  /platform/badges                   { orders, chats } waiting (the menu)
const crypto = require("crypto");
const mongoose = require("mongoose");
const multer = require("multer");
const P = require("./platform.model");
const Customer = require("../user/customer.model");
const coin = require("../coin/coin.service");
const telegram = require("../telegram");
const { customer_auth } = require("../user/customer_auth");
const { only_super_admin } = require("../util/permission");
const { uploadBuffer, deleteFile } = require("../util/cloudinary");
const { rate_limit } = require("../util/rate_limit");
const { escapeRegex } = require("../util/helper");

const T = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញ!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
  badValue: "តម្លៃមិនត្រឹមត្រូវ!",
  empty: "សូមជ្រើសរើសកញ្ចប់កាក់!",
  badBank: "សូមជ្រើសរើសធនាគារដែលអ្នកបានផ្ទេរប្រាក់!",
  needProof: "សូមបញ្ចូលរូបភាពវិក្កយបត្រផ្ទេរប្រាក់!",
  badImage: "សូមដាក់រូបភាព JPG / PNG / WEBP (តិចជាង 5MB)!",
  badFile: "ឯកសារមិនត្រឹមត្រូវ ឬធំពេក (តិចជាង 10MB)!",
  tooManyWaiting: "អ្នកមានការកម្ម៉ង់កាក់កំពុងរង់ចាំច្រើនពេក។ សូមរង់ចាំការបញ្ជាក់។",
  sent: "បានផ្ញើការកម្ម៉ង់! ក្រុមការងារ BizHub នឹងពិនិត្យ និងបញ្ជាក់ឆាប់ៗ។",
  notPending: "ការកម្ម៉ង់នេះត្រូវបានដំណើរការរួចហើយ!",
  approved: "បានបញ្ជាក់ និងបញ្ចូលកាក់!",
  rejected: "បានបដិសេធ!",
  needReason: "សូមសរសេរមូលហេតុ!",
  emptyMsg: "សូមសរសេរសារ ឬភ្ជាប់ឯកសារ!",
  needQr: "សូមបញ្ចូលរូប QR!",
  needBankName: "សូមបំពេញឈ្មោះធនាគារ!",
  tgNotReady: "Telegram bot មិនទាន់រៀបចំទេ (TELEGRAM_BOT_TOKEN)!",
  tgNotConnected: "មិនទាន់ភ្ជាប់ Telegram ទេ!",
};
const MAX_WAITING = 5;
const IMG = ["image/jpeg", "image/png", "image/webp"];
const DOCS = [
  ...IMG,
  "image/gif",
  "application/pdf",
  "text/plain",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // voice messages
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/x-m4a",
];
const imageUp = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: (req, f, cb) => (IMG.includes(f.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))) });
const filesUp = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 5 }, fileFilter: (req, f, cb) => (DOCS.includes(f.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))) });
const one = (field) => (req, res, next) => imageUp.single(field)(req, res, (err) => (err ? res.status(400).json({ success: false, message: T.badImage }) : next()));
const many = (req, res, next) => filesUp.array("files", 5)(req, res, (err) => (err ? res.status(400).json({ success: false, message: T.badFile }) : next()));

class Bad extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const validId = (id) => mongoose.Types.ObjectId.isValid(id) && String(id).length === 24;
const r2 = (v) => Math.round(v * 100) / 100;
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
    if (err instanceof coin.CoinError) return res.status(err.status).json({ success: false, message: err.message });
    if (err?.isCloudinary) return res.status(err.status).json({ success: false, message: err.message });
    if (err?.name === "ValidationError" || err?.name === "CastError") return res.status(400).json({ success: false, message: T.badValue });
    console.error("[platform]", err);
    res.status(500).json({ success: false, message: T.server });
  }
};
const str = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);

async function settings() {
  const found = await P.PlatformSettings.findOne({ key: "main" });
  if (found) return found;
  try {
    return await P.PlatformSettings.create({ key: "main" });
  } catch (err) {
    if (err.code === 11000) return P.PlatformSettings.findOne({ key: "main" });
    throw err;
  }
}
const pkgOut = (p) => ({ key: p.key, coins: p.coins, usd: p.usd, bonus_pct: p.bonus_pct, bonus: Math.floor((p.coins * (p.bonus_pct || 0)) / 100), active: p.active !== false });
const bankOut = (b) => ({
  key: b.key,
  name: b.name,
  account_name: b.account_name,
  account_no: b.account_no,
  note: b.note,
  qr: b.qr?.url || "",
  link: b.link || "",
  amount_qrs: (b.amount_qrs || [])
    .filter((a) => a.qr?.url)
    .map((a) => ({ usd: a.usd, qr: a.qr.url, link: a.link || "" }))
    .sort((x, y) => x.usd - y.usd),
  active: b.active !== false,
});
const cents = (v) => Math.round(Number(v) * 100);
// a pay link (ABA PayWay, bank app link): https only, "" clears it
const payLink = (v) => {
  const s = String(v ?? "").trim().slice(0, 300);
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol === "https:") return u.toString();
  } catch {
    /* not a link */
  }
  throw new Bad(T.badValue, 400, { code: "bad_link" });
};
const orderOut = (o) => ({ ...(o.toObject ? o.toObject() : o), proof: o.proof?.url || "" });
const who = (c) => `${c.name || ""}${c.email ? ` · ${c.email}` : ""}${c.phone ? ` · ${c.phone}` : ""}`;
const moneyUsd = (v) => `$${Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PAY = (name) => {
  const n = String(name || "").toUpperCase();
  return n.includes("KHQR") || n.includes("BAKONG") ? "KHQR" : n.includes("ABA") ? "ABA" : n.includes("ACLEDA") ? "ACLEDA" : n.includes("WING") ? "Wing" : "Bank";
};

// ---------- the super admin's Telegram ----------
async function alertAdmin(kind, html) {
  try {
    if (!telegram.ready()) return false;
    const s = await P.PlatformSettings.findOne({ key: "main" }).lean();
    if (!s?.tg?.chat_id || s.tg[kind] === false) return false;
    await telegram.send(s.tg.chat_id, html);
    return true;
  } catch (err) {
    if (err instanceof telegram.TelegramError && err.message === "blocked") await P.PlatformSettings.updateOne({ key: "main" }, { $set: { "tg.chat_id": "" } }).catch(() => {});
    return false;
  }
}
const soon = (p, ms = 1500) => Promise.race([p.catch(() => false), new Promise((r) => setTimeout(r, ms))]);

// files of one chat message → Cloudinary
async function saveFiles(list, folder) {
  const out = [];
  for (const f of list || []) {
    const isImg = f.mimetype.startsWith("image/");
    // voice: Cloudinary keeps audio as "video" (plays in every browser)
    const rt = isImg ? "image" : f.mimetype.startsWith("audio/") ? "video" : "raw";
    const up = await uploadBuffer(f, folder, rt);
    out.push({ url: up.url, public_id: up.public_id, resource_type: up.resource_type || rt, name: up.original_name || f.originalname, type: f.mimetype, size: f.size });
  }
  return out;
}

// a message in a customer's conversation (the system uses this too: coin order approved…)
async function post(customerId, { from, text = "", files = [], by_name = "", by_user = null, kind = "" }) {
  const thread = await P.SupportThread.findOneAndUpdate({ customer_id: customerId }, { $setOnInsert: { customer_id: customerId } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
  const msg = await P.SupportMessage.create({ thread_id: thread._id, from, text, files, by_name, by_user, kind });
  const last = text || (files.length ? `📎 ${files.map((f) => f.name).join(", ")}` : "");
  const inc = from === "customer" ? { unread_admin: 1 } : { unread_customer: 1 };
  const updated = await P.SupportThread.findOneAndUpdate({ _id: thread._id }, { $set: { last_at: new Date(), last_text: last.slice(0, 200), last_from: from }, $inc: inc }, { returnDocument: "after" });
  return { thread: updated, msg };
}

module.exports = (prop) => {
  const user = [prop.api_auth, customer_auth];
  const admin = [prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin];
  const U = "/api/user";
  const A = "/api/admin";
  const orderLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 10 });
  const chatLimit = rate_limit({ windowMs: 60 * 1000, max: 30 });

  // someone pressed Start with the super admin code (sa_…)
  telegram.onStart(async (code, chat) => {
    if (!/^sa_[A-Za-z0-9]{12,40}$/.test(code)) return null;
    const s = await P.PlatformSettings.findOne({ "tg.link_code": code });
    if (!s || !s.tg.link_expires || s.tg.link_expires < new Date()) return "⌛️ This link has expired. Open BizHub → Super admin → Coin orders → Telegram again.";
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "Telegram");
    s.set("tg.chat_id", String(chat.id));
    s.set("tg.chat_name", name.slice(0, 80));
    s.set("tg.connected_at", new Date());
    s.set("tg.link_code", "");
    s.set("tg.link_expires", null);
    await s.save();
    return "✅ <b>BizHub super admin</b> is connected to this chat.\n\n💰 New coin orders · 💬 New messages from customers";
  });

  // ================================================================ customer: buy coins
  prop.app.get(
    `${U}/coin-shop`,
    ...user,
    handle(async (req, res) => {
      const s = await settings();
      const orders = await P.CoinOrder.find({ customer_id: req.customer._id }).sort({ created_date: -1 }).limit(20).lean();
      res.json({
        success: true,
        data: {
          packages: s.packages.filter((p) => p.active !== false).map(pkgOut),
          banks: s.banks.filter((b) => b.active !== false && b.qr?.url).map(bankOut),
          hotline: s.hotline,
          orders: orders.map(orderOut),
          waiting: orders.filter((o) => o.status === "pending").length,
        },
      });
    }),
  );
  prop.app.post(
    `${U}/coin-orders`,
    ...user,
    orderLimit,
    one("proof"),
    handle(async (req, res) => {
      const b = req.body || {};
      const s = await settings();
      let items = b.items;
      if (typeof items === "string") {
        try {
          items = JSON.parse(items);
        } catch {
          items = null;
        }
      }
      if (!Array.isArray(items) || !items.length || items.length > 10) throw new Bad(T.empty, 400, { code: "empty" });
      const lines = [];
      for (const it of items) {
        const p = s.packages.find((x) => x.key === it?.key && x.active !== false);
        const qty = Number(it?.qty);
        if (!p || !Number.isInteger(qty) || qty < 1 || qty > 20) throw new Bad(T.empty, 400, { code: "bad_item" });
        const same = lines.find((l) => l.key === p.key);
        if (same) same.qty = Math.min(20, same.qty + qty);
        else lines.push({ key: p.key, coins: p.coins, usd: p.usd, bonus_pct: p.bonus_pct || 0, qty });
      }
      const bank = s.banks.find((x) => x.key === b.bank && x.active !== false);
      if (!bank) throw new Bad(T.badBank, 400, { code: "bad_bank" });
      if (!req.file) throw new Bad(T.needProof, 400, { code: "need_proof" });
      if ((await P.CoinOrder.countDocuments({ customer_id: req.customer._id, status: "pending" })) >= MAX_WAITING) throw new Bad(T.tooManyWaiting, 429, { code: "too_many" });
      const coins = lines.reduce((a, l) => a + l.coins * l.qty, 0);
      const bonus = lines.reduce((a, l) => a + Math.floor((l.coins * l.bonus_pct) / 100) * l.qty, 0);
      const usd = r2(lines.reduce((a, l) => a + l.usd * l.qty, 0));
      const up = await uploadBuffer(req.file, "coin-orders");
      const seq = await P.PlatformSettings.findOneAndUpdate({ _id: s._id }, { $inc: { next_order: 1 } }, { returnDocument: "before" }).lean();
      const order = await P.CoinOrder.create({
        no: `CO-${String(seq?.next_order || 1).padStart(4, "0")}`,
        customer_id: req.customer._id,
        items: lines,
        coins,
        bonus,
        total_coins: coins + bonus,
        usd,
        bank: { key: bank.key, name: bank.name },
        proof: { url: up.url, public_id: up.public_id },
        reference: str(b.reference, 80),
        note: str(b.note, 300),
      });
      const c = req.customer;
      await soon(
        alertAdmin(
          "coin_orders",
          [
            `💰 <b>New coin order ${order.no}</b>`,
            `👤 ${telegram.escape(who(c))}`,
            ...lines.map((l) => `• ${l.qty}× ${l.coins.toLocaleString("en-US")} coins${l.bonus_pct ? ` (+${l.bonus_pct}%)` : ""} — ${moneyUsd(l.usd * l.qty)}`),
            `🪙 <b>${(coins + bonus).toLocaleString("en-US")} coins</b>${bonus ? ` (${bonus.toLocaleString("en-US")} free)` : ""}`,
            `💵 <b>${moneyUsd(usd)}</b> · ${telegram.escape(bank.name)}${order.reference ? ` · ref ${telegram.escape(order.reference)}` : ""}`,
            order.note ? `📝 ${telegram.escape(order.note)}` : "",
            `🧾 <a href="${up.url}">Transfer screenshot</a>`,
            "",
            "➡️ Check the bank, then BizHub → Super admin → Coin orders → Approve.",
          ]
            .filter((x) => x !== "")
            .join("\n"),
        ),
      );
      res.status(201).json({ success: true, data: orderOut(order), hotline: s.hotline, message: T.sent });
    }),
  );
  prop.app.get(
    `${U}/coin-orders`,
    ...user,
    handle(async (req, res) => {
      const rows = await P.CoinOrder.find({ customer_id: req.customer._id }).sort({ created_date: -1 }).limit(100).lean();
      res.json({ success: true, data: rows.map(orderOut) });
    }),
  );
  prop.app.post(
    `${U}/coin-orders/:oid/cancel`,
    ...user,
    handle(async (req, res) => {
      if (!validId(req.params.oid)) throw new Bad(T.badId);
      const o = await P.CoinOrder.findOneAndUpdate({ _id: req.params.oid, customer_id: req.customer._id, status: "pending" }, { $set: { status: "cancelled", done_at: new Date() } }, { returnDocument: "after" });
      if (!o) throw new Bad(T.notPending, 409, { code: "not_pending" });
      res.json({ success: true, data: orderOut(o), message: T.saved });
    }),
  );

  // ================================================================ customer: chat with BizHub
  const myThread = (cid) => P.SupportThread.findOne({ customer_id: cid });
  prop.app.get(
    `${U}/support`,
    ...user,
    handle(async (req, res) => {
      const t = await myThread(req.customer._id);
      const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
      const msgs = t
        ? await P.SupportMessage.find({ thread_id: t._id, ...(before ? { created_date: { $lt: before } } : {}) })
            .sort({ created_date: -1 })
            .limit(60)
            .lean()
        : [];
      if (t && !before) await P.SupportThread.updateOne({ _id: t._id }, { $set: { unread_customer: 0, customer_seen_at: new Date() } });
      const s = await settings();
      res.json({ success: true, data: { messages: msgs.reverse(), more: msgs.length === 60, hotline: s.hotline, seen_at: t?.admin_seen_at || null } });
    }),
  );
  prop.app.get(
    `${U}/support/unread`,
    ...user,
    handle(async (req, res) => {
      const t = await myThread(req.customer._id);
      res.json({ success: true, data: { n: t?.unread_customer || 0 } });
    }),
  );
  prop.app.post(
    `${U}/support`,
    ...user,
    chatLimit,
    many,
    handle(async (req, res) => {
      const text = str(req.body?.text, 4000);
      if (!text && !req.files?.length) throw new Bad(T.emptyMsg, 400, { code: "empty" });
      const files = await saveFiles(req.files, "support");
      const c = req.customer;
      const { thread, msg } = await post(c._id, { from: "customer", text, files, by_name: c.name || "" });
      // Telegram: not one alert per message — when the team hasn't read the last ones, once every 10 minutes
      if (thread.unread_admin === 1 || !thread.alerted_at || Date.now() - new Date(thread.alerted_at).getTime() > 10 * 60000) {
        await P.SupportThread.updateOne({ _id: thread._id }, { $set: { alerted_at: new Date() } });
        await soon(
          alertAdmin(
            "chat",
            [`💬 <b>New message</b> · Chat with BizHub`, `👤 ${telegram.escape(who(c))}`, text ? `\n${telegram.escape(text.slice(0, 800))}` : "", files.length ? `📎 ${files.length} file(s)` : "", "", "➡️ BizHub → Super admin → Inbox"]
              .filter((x) => x !== "")
              .join("\n"),
          ),
        );
      }
      res.status(201).json({ success: true, data: msg });
    }),
  );

  // ================================================================ super admin: settings
  prop.app.get(
    `${A}/platform`,
    ...admin,
    handle(async (req, res) => {
      const s = await settings();
      res.json({
        success: true,
        data: {
          packages: s.packages.map(pkgOut),
          banks: s.banks.map(bankOut),
          hotline: s.hotline,
          tg: { configured: telegram.ready(), connected: !!s.tg.chat_id, chat_name: s.tg.chat_name, connected_at: s.tg.connected_at, coin_orders: s.tg.coin_orders !== false, chat: s.tg.chat !== false },
        },
      });
    }),
  );
  prop.app.put(
    `${A}/platform`,
    ...admin,
    handle(async (req, res) => {
      const b = req.body || {};
      const s = await settings();
      if (b.hotline && typeof b.hotline === "object") for (const [k, max] of Object.entries({ phone: 40, telegram: 80, email: 120, hours: 120, note: 300 })) if (b.hotline[k] !== undefined) s.set(`hotline.${k}`, str(b.hotline[k], max));
      if (b.packages !== undefined) {
        if (!Array.isArray(b.packages) || b.packages.length > 12) throw new Bad(T.badValue);
        const seen = new Set();
        s.packages = b.packages.map((p) => {
          const coins = Number(p?.coins);
          const usd = Number(p?.usd);
          const bonus = Number(p?.bonus_pct || 0);
          if (!Number.isInteger(coins) || coins < 1 || coins > 1000000 || !Number.isFinite(usd) || usd < 0 || usd > 100000 || !Number.isFinite(bonus) || bonus < 0 || bonus > 100) throw new Bad(T.badValue, 400, { code: "bad_package" });
          let key = /^p[a-z0-9]{1,12}$/.test(String(p.key || "")) ? p.key : `p${coins}`;
          while (seen.has(key)) key = `p${crypto.randomBytes(3).toString("hex")}`;
          seen.add(key);
          return { key, coins, usd: r2(usd), bonus_pct: bonus, active: p.active !== false };
        });
      }
      if (b.tg && typeof b.tg === "object") for (const k of ["coin_orders", "chat"]) if (b.tg[k] !== undefined) s.set(`tg.${k}`, b.tg[k] === true);
      await s.save();
      res.json({ success: true, message: T.saved });
    }),
  );
  const readBank = (b, cur) => {
    const name = b.name !== undefined ? str(b.name, 60) : cur?.name;
    if (!name) throw new Bad(T.needBankName, 400, { code: "need_name" });
    return {
      name,
      account_name: b.account_name !== undefined ? str(b.account_name, 80) : cur?.account_name || "",
      account_no: b.account_no !== undefined ? str(b.account_no, 60) : cur?.account_no || "",
      note: b.note !== undefined ? str(b.note, 200) : cur?.note || "",
      link: b.link !== undefined ? payLink(b.link) : cur?.link || "",
      active: b.active !== undefined ? b.active === true || b.active === "true" : cur ? cur.active !== false : true,
    };
  };
  prop.app.post(
    `${A}/platform/banks`,
    ...admin,
    one("qr"),
    handle(async (req, res) => {
      const s = await settings();
      if (s.banks.length >= 12) throw new Bad(T.badValue);
      if (!req.file) throw new Bad(T.needQr, 400, { code: "need_qr" });
      const set = readBank(req.body || {});
      const up = await uploadBuffer(req.file, "platform");
      s.banks.push({ key: `b_${crypto.randomBytes(4).toString("hex")}`, ...set, qr: { url: up.url, public_id: up.public_id } });
      await s.save();
      res.status(201).json({ success: true, data: s.banks.map(bankOut), message: T.saved });
    }),
  );
  prop.app.put(
    `${A}/platform/banks/:key`,
    ...admin,
    one("qr"),
    handle(async (req, res) => {
      const s = await settings();
      const bank = s.banks.find((x) => x.key === req.params.key);
      if (!bank) throw new Bad(T.notFound, 404);
      Object.assign(bank, readBank(req.body || {}, bank));
      let old = "";
      if (req.file) {
        const up = await uploadBuffer(req.file, "platform");
        old = bank.qr?.public_id || "";
        bank.qr = { url: up.url, public_id: up.public_id };
      }
      s.markModified("banks");
      await s.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: s.banks.map(bankOut), message: T.saved });
    }),
  );
  prop.app.delete(
    `${A}/platform/banks/:key`,
    ...admin,
    handle(async (req, res) => {
      const s = await settings();
      const bank = s.banks.find((x) => x.key === req.params.key);
      if (!bank) throw new Bad(T.notFound, 404);
      s.banks = s.banks.filter((x) => x.key !== req.params.key);
      await s.save();
      for (const id of [bank.qr?.public_id, ...(bank.amount_qrs || []).map((q) => q.qr?.public_id)]) if (id) deleteFile(id).catch(() => {});
      res.json({ success: true, data: s.banks.map(bankOut), message: T.deleted });
    }),
  );
  // a QR picture with the amount in it (one per amount: a new picture for the same amount replaces the old one)
  prop.app.post(
    `${A}/platform/banks/:key/amount-qrs`,
    ...admin,
    one("qr"),
    handle(async (req, res) => {
      const usd = Math.round(Number(req.body?.usd) * 100) / 100;
      if (!(usd > 0) || usd > 100000) throw new Bad(T.badValue);
      if (!req.file) throw new Bad(T.needQr, 400, { code: "need_qr" });
      const s = await settings();
      const bank = s.banks.find((x) => x.key === req.params.key);
      if (!bank) throw new Bad(T.notFound, 404);
      const list = bank.amount_qrs || [];
      const same = list.find((q) => cents(q.usd) === cents(usd));
      if (!same && list.length >= 30) throw new Bad(T.badValue);
      const up = await uploadBuffer(req.file, "platform");
      const old = same?.qr?.public_id || "";
      bank.amount_qrs = [...list.filter((q) => q !== same), { usd, qr: { url: up.url, public_id: up.public_id }, link: payLink(req.body?.link) }];
      s.markModified("banks");
      await s.save();
      if (old) deleteFile(old).catch(() => {});
      res.status(201).json({ success: true, data: s.banks.map(bankOut), message: T.saved });
    }),
  );
  // change only the pay link of an amount QR
  prop.app.put(
    `${A}/platform/banks/:key/amount-qrs/:usd`,
    ...admin,
    handle(async (req, res) => {
      const s = await settings();
      const bank = s.banks.find((x) => x.key === req.params.key);
      const q = (bank?.amount_qrs || []).find((x) => cents(x.usd) === cents(req.params.usd));
      if (!q) throw new Bad(T.notFound, 404);
      q.link = payLink(req.body?.link);
      s.markModified("banks");
      await s.save();
      res.json({ success: true, data: s.banks.map(bankOut), message: T.saved });
    }),
  );
  prop.app.delete(
    `${A}/platform/banks/:key/amount-qrs/:usd`,
    ...admin,
    handle(async (req, res) => {
      const s = await settings();
      const bank = s.banks.find((x) => x.key === req.params.key);
      if (!bank) throw new Bad(T.notFound, 404);
      const gone = (bank.amount_qrs || []).find((q) => cents(q.usd) === cents(req.params.usd));
      if (!gone) throw new Bad(T.notFound, 404);
      bank.amount_qrs = bank.amount_qrs.filter((q) => q !== gone);
      s.markModified("banks");
      await s.save();
      if (gone.qr?.public_id) deleteFile(gone.qr.public_id).catch(() => {});
      res.json({ success: true, data: s.banks.map(bankOut), message: T.deleted });
    }),
  );
  prop.app.post(
    `${A}/platform/telegram/link`,
    ...admin,
    handle(async (req, res) => {
      if (!telegram.ready()) throw new Bad(T.tgNotReady, 503);
      const bot = await telegram.botUsername();
      const s = await settings();
      const code = `sa_${crypto.randomBytes(24).toString("base64url").replace(/[-_]/g, "").slice(0, 24)}`;
      s.set("tg.link_code", code);
      s.set("tg.link_expires", new Date(Date.now() + 15 * 60000));
      await s.save();
      res.json({ success: true, data: { url: `https://t.me/${bot}?start=${code}`, group_url: `https://t.me/${bot}?startgroup=${code}` } });
    }),
  );
  prop.app.post(
    `${A}/platform/telegram/test`,
    ...admin,
    handle(async (req, res) => {
      const s = await settings();
      if (!s.tg.chat_id) throw new Bad(T.tgNotConnected);
      await telegram.send(s.tg.chat_id, "🔔 <b>BizHub super admin</b>\nTest message — everything works.");
      res.json({ success: true, message: T.saved });
    }),
  );
  prop.app.delete(
    `${A}/platform/telegram`,
    ...admin,
    handle(async (req, res) => {
      const s = await settings();
      for (const k of ["chat_id", "chat_name", "link_code"]) s.set(`tg.${k}`, "");
      s.set("tg.connected_at", null);
      await s.save();
      res.json({ success: true, message: T.saved });
    }),
  );
  prop.app.get(
    `${A}/platform/badges`,
    ...admin,
    handle(async (req, res) => {
      const [orders, chats] = await Promise.all([P.CoinOrder.countDocuments({ status: "pending" }), P.SupportThread.countDocuments({ unread_admin: { $gt: 0 } })]);
      res.json({ success: true, data: { orders, chats } });
    }),
  );

  // ================================================================ super admin: coin orders
  prop.app.get(
    `${A}/coin-orders`,
    ...admin,
    handle(async (req, res) => {
      const st = String(req.query.status || "pending");
      const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
      const filter = P.ORDER_STATUSES.includes(st) ? { status: st } : {};
      const q = str(req.query.q, 60);
      if (q) {
        const re = { $regex: escapeRegex(q), $options: "i" };
        const cs = await Customer.find({ $or: [{ name: re }, { email: re }, { phone: re }] })
          .select("_id")
          .limit(200)
          .lean();
        filter.$or = [{ no: re }, { reference: re }, { customer_id: { $in: cs.map((x) => x._id) } }];
      }
      const [rows, total, counts] = await Promise.all([
        P.CoinOrder.find(filter)
          .sort({ created_date: st === "pending" ? 1 : -1 })
          .skip((page - 1) * 30)
          .limit(30)
          .populate("customer_id", "name email phone")
          .populate("done_by", "firstname lastname email")
          .lean(),
        P.CoinOrder.countDocuments(filter),
        P.CoinOrder.aggregate([{ $group: { _id: "$status", n: { $sum: 1 }, usd: { $sum: "$usd" }, coins: { $sum: "$total_coins" } } }]),
      ]);
      res.json({ success: true, data: rows.map(orderOut), counts: Object.fromEntries(counts.map((x) => [x._id, { n: x.n, usd: r2(x.usd), coins: x.coins }])), pagination: { total, totalPages: Math.max(1, Math.ceil(total / 30)), currentPage: page } });
    }),
  );
  const loadPending = async (oid) => {
    if (!validId(oid)) throw new Bad(T.badId);
    const o = await P.CoinOrder.findById(oid);
    if (!o) throw new Bad(T.notFound, 404);
    if (o.status !== "pending") throw new Bad(T.notPending, 409, { code: "not_pending" });
    return o;
  };
  prop.app.post(
    `${A}/coin-orders/:oid/approve`,
    ...admin,
    handle(async (req, res) => {
      const o = await loadPending(req.params.oid);
      // only one approve wins
      const locked = await P.CoinOrder.findOneAndUpdate({ _id: o._id, status: "pending" }, { $set: { status: "approved", done_by: req.user?._id || null, done_at: new Date() } }, { returnDocument: "after" });
      if (!locked) throw new Bad(T.notPending, 409, { code: "not_pending" });
      try {
        const treasury = await coin.getTreasury();
        // the bank received the money: when the treasury is short, the missing coins are made first (recorded)
        if (treasury.balance < locked.total_coins) await coin.generate({ amount: locked.total_coins - treasury.balance, note: `Coin order ${locked.no} (bank payment)`, userId: req.user?._id || null });
        const tx = await coin.transfer({
          from: await coin.getTreasury(),
          to: await coin.getCustomerWallet(locked.customer_id),
          amount: locked.total_coins,
          note: `Coin order ${locked.no}${locked.bonus ? ` (${locked.coins} + ${locked.bonus} free)` : ""}`,
          payment: { method: PAY(locked.bank.name), reference: locked.reference || locked.no, amount_usd: locked.usd },
          userId: req.user?._id || null,
        });
        locked.tx_id = tx._id;
        await locked.save();
      } catch (err) {
        await P.CoinOrder.updateOne({ _id: locked._id }, { $set: { status: "pending", done_by: null, done_at: null } }); // nothing happened
        throw err;
      }
      // the customer sees it in their chat with BizHub too
      await post(locked.customer_id, {
        from: "admin",
        kind: "coin_order",
        by_name: "BizHub",
        text: `✅ ${locked.no}: +${locked.total_coins.toLocaleString("en-US")} coins added to your wallet. Thank you! · បានបញ្ចូលកាក់ ${locked.total_coins.toLocaleString("en-US")} ទៅកាបូបរបស់អ្នក។ អរគុណ!`,
      });
      res.json({ success: true, data: orderOut(locked), message: T.approved });
    }),
  );
  prop.app.post(
    `${A}/coin-orders/:oid/reject`,
    ...admin,
    handle(async (req, res) => {
      const reason = str(req.body?.reason, 300);
      if (!reason) throw new Bad(T.needReason, 400, { code: "need_reason" });
      const o = await loadPending(req.params.oid);
      const done = await P.CoinOrder.findOneAndUpdate({ _id: o._id, status: "pending" }, { $set: { status: "rejected", reason, done_by: req.user?._id || null, done_at: new Date() } }, { returnDocument: "after" });
      if (!done) throw new Bad(T.notPending, 409, { code: "not_pending" });
      await post(done.customer_id, { from: "admin", kind: "coin_order", by_name: "BizHub", text: `❌ ${done.no}: ${reason}` });
      res.json({ success: true, data: orderOut(done), message: T.rejected });
    }),
  );

  // ================================================================ super admin: inbox
  prop.app.get(
    `${A}/support`,
    ...admin,
    handle(async (req, res) => {
      const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
      const filter = {};
      const q = str(req.query.q, 60);
      if (q) {
        const re = { $regex: escapeRegex(q), $options: "i" };
        const cs = await Customer.find({ $or: [{ name: re }, { email: re }, { phone: re }] })
          .select("_id")
          .limit(200)
          .lean();
        filter.customer_id = { $in: cs.map((x) => x._id) };
      }
      if (req.query.unread === "1") filter.unread_admin = { $gt: 0 };
      const [rows, total] = await Promise.all([
        P.SupportThread.find(filter)
          .sort({ last_at: -1 })
          .skip((page - 1) * 40)
          .limit(40)
          .populate("customer_id", "name email phone photo")
          .lean(),
        P.SupportThread.countDocuments(filter),
      ]);
      res.json({ success: true, data: rows, pagination: { total, totalPages: Math.max(1, Math.ceil(total / 40)), currentPage: page } });
    }),
  );
  const loadThread = async (tid) => {
    if (!validId(tid)) throw new Bad(T.badId);
    const t = await P.SupportThread.findById(tid).populate("customer_id", "name email phone photo created_date");
    if (!t) throw new Bad(T.notFound, 404);
    return t;
  };
  prop.app.get(
    `${A}/support/:tid`,
    ...admin,
    handle(async (req, res) => {
      const t = await loadThread(req.params.tid);
      const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
      const msgs = await P.SupportMessage.find({ thread_id: t._id, ...(before ? { created_date: { $lt: before } } : {}) })
        .sort({ created_date: -1 })
        .limit(80)
        .lean();
      if (!before) await P.SupportThread.updateOne({ _id: t._id }, { $set: { unread_admin: 0, admin_seen_at: new Date() } });
      // what helps to answer: their businesses, coins, last coin orders
      const cid = t.customer_id?._id;
      const [businesses, wallet, orders] = cid
        ? await Promise.all([mongoose.model("Business").find({ owner_id: cid, deleted: false }).select("name category status").lean(), coin.getCustomerWallet(cid), P.CoinOrder.find({ customer_id: cid }).sort({ created_date: -1 }).limit(5).lean()])
        : [[], null, []];
      res.json({ success: true, data: { thread: t, messages: msgs.reverse(), more: msgs.length === 80, seen_at: t.customer_seen_at || null, customer: { businesses, coins: wallet?.balance || 0, orders: orders.map(orderOut) } } });
    }),
  );
  prop.app.post(
    `${A}/support/:tid`,
    ...admin,
    many,
    handle(async (req, res) => {
      const t = await loadThread(req.params.tid);
      const text = str(req.body?.text, 4000);
      if (!text && !req.files?.length) throw new Bad(T.emptyMsg, 400, { code: "empty" });
      const files = await saveFiles(req.files, "support");
      const name = [req.user?.firstname, req.user?.lastname].filter(Boolean).join(" ") || "BizHub";
      const { msg } = await post(t.customer_id._id, { from: "admin", text, files, by_name: name, by_user: req.user?._id || null });
      await P.SupportThread.updateOne({ _id: t._id }, { $set: { unread_admin: 0 } });
      res.status(201).json({ success: true, data: msg });
    }),
  );
  // start a conversation with any customer (from the customer list)
  prop.app.post(
    `${A}/support-start/:cid`,
    ...admin,
    handle(async (req, res) => {
      if (!validId(req.params.cid) || !(await Customer.exists({ _id: req.params.cid }))) throw new Bad(T.notFound, 404);
      const t = await P.SupportThread.findOneAndUpdate({ customer_id: req.params.cid }, { $setOnInsert: { customer_id: req.params.cid } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
      res.json({ success: true, data: { _id: t._id } });
    }),
  );
};
module.exports.alertAdmin = alertAdmin;
module.exports.post = post;
