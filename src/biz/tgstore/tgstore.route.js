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
// Telegram: /start st_<slug> → the "Open the store" button · /start ts_<code> → this chat gets the orders ·
//           buttons "tgo:<orderId>:<action>" in that chat
const mongoose = require("mongoose");
const crypto = require("crypto");
const multer = require("multer");
const M = require("./tgstore.models");
const Business = require("../business.model");
const { bizOwner } = require("../team/team.access"); // team members (Admin / View only) open it too
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const { statusOf, DAY } = require("../../license/license.service");
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
const LIMITS = { products: 500, categories: 40, items: 40, qty: 99, options: 6, choices: 12 };
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
  delete o.seq;
  return { ...o, logo: o.logo?.url || "", tg };
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
  fee: o.fee,
  total: o.total,
  currency: o.currency,
  pay: { method: o.pay?.method, status: o.pay?.status, proof: o.pay?.proof?.url || "", paid_at: o.pay?.paid_at || null },
  status: o.status,
  eta_min: o.eta_min,
  reason: o.reason,
  timeline: o.timeline,
  via: o.via,
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
  color: hexColor(s.color) || "#C4470F",
  currency: s.currency,
  open: !!s.open,
  delivery: s.delivery?.on ? { fee: s.delivery.fee || 0, free_from: s.delivery.free_from || 0, min_order: s.delivery.min_order || 0, note: s.delivery.note || "" } : null,
  pickup: s.pickup?.on ? { note: s.pickup.note || "" } : null,
  dine_in: s.dine_in?.on ? { tables: s.dine_in.tables || 10 } : null,
  pay: { khqr: !!(s.pay?.khqr?.on && khqr.isBakongId(s.pay.khqr.bakong_id)), cash: !!s.pay?.cash?.on },
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
  if (o.fee) lines.push(`Delivery · ដឹក ${fmtMoney(o.fee, cur)}`);
  lines.push(`<b>Total · សរុប ${fmtMoney(o.total, cur)}</b> · ${o.pay.method === "khqr" ? "KHQR" : "Cash · សាច់ប្រាក់"} · ${PAY[o.pay.status]}`, "");
  const who = [o.customer?.name && `<b>${esc(o.customer.name)}</b>`, o.customer?.phone && esc(o.customer.phone), o.customer?.username && `@${esc(o.customer.username)}`].filter(Boolean).join(" · ");
  if (who) lines.push(`👤 ${who}`);
  if (o.mode === "delivery" && o.address) lines.push(`📍 ${esc(o.address)}`);
  if (o.note) lines.push(`📝 ${esc(o.note)}`);
  if (o.status === "cancelled" && o.reason) lines.push(`❌ ${esc(o.reason)}`);
  const last = o.timeline?.[o.timeline.length - 1];
  if (last?.by && o.status !== "new") lines.push(`<i>${esc(last.by)}</i>`);
  lines.push(`<i>${esc(s.shop_name)}</i>`);
  return lines.join("\n");
}
function groupKeys(o) {
  const b = (text, act) => ({ text, callback_data: `tgo:${o._id}:${act}` });
  const rows = [];
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
  try {
    if (o.tg_msg?.message_id && o.tg_msg.chat_id === chat) {
      await telegram.editText(chat, o.tg_msg.message_id, groupText(s, o), groupKeys(o)).catch((err) => {
        if (!/not modified/i.test(err.message)) throw err;
      });
    } else {
      const m = await telegram.send(chat, groupText(s, o), groupKeys(o));
      o.tg_msg = { chat_id: chat, message_id: m.message_id };
      await M.TgOrder.updateOne({ _id: o._id }, { $set: { tg_msg: o.tg_msg } });
    }
  } catch (err) {
    if (err instanceof telegram.TelegramError && err.message === "blocked") await M.TgStore.updateOne({ _id: s._id }, { $set: { "tg.chat_id": "", "tg.chat_name": "" } });
  }
}
// the customer's own chat with the bot (only when they allowed messages)
async function tellCustomer(s, o, text) {
  if (!o.customer?.tg_id || !telegram.ready() || !o.customer_id) return;
  const c = await M.TgCustomer.findById(o.customer_id).select("can_message").lean();
  if (!c?.can_message) return;
  const link = `${siteOf(s)}/t/o/${o.token}`;
  await telegram
    .send(o.customer.tg_id, `<b>${esc(s.shop_name)}</b> · #${o.no}\n${text}`, telegram.keyboard([[{ text: "🧾 Order · ការកម្ម៉ង់", web_app: { url: link } }]]))
    .catch(async (err) => {
      if (err instanceof telegram.TelegramError && err.message === "blocked") await M.TgCustomer.updateOne({ _id: o.customer_id }, { $set: { can_message: false } });
    });
}
const CUSTOMER_TEXT = {
  accepted: (o) => `✅ The shop accepted your order${o.eta_min ? ` · about ${o.eta_min} min` : ""}.\nហាងបានទទួលការកម្ម៉ង់របស់អ្នក${o.eta_min ? ` · ប្រហែល ${o.eta_min} នាទី` : ""}។`,
  ready: () => "🍽 Your order is ready.\nការកម្ម៉ង់របស់អ្នករួចរាល់ហើយ។",
  on_way: () => "🛵 Your order is on the way.\nការកម្ម៉ង់របស់អ្នកកំពុងដឹកមក។",
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
  await postToGroup(s, after);
  await tellCustomer(s, after, CUSTOMER_TEXT[status](after));
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
  await tellCustomer(s, after, CUSTOMER_TEXT.paid());
  return after;
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
      if (err?.name === "ValidationError" || err?.name === "CastError") return res.status(400).json({ success: false, message: MSG.badValue });
      console.error("[tgstore]", err);
      res.status(500).json({ success: false, message: MSG.server });
    }
  };

  // ---------- the owner (customer_auth) ----------
  async function ownerCtx(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    const [business, license] = await Promise.all([Business.findOne({ _id: req.params.id, ...bizOwner(req), deleted: false }), licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== PRODUCT) throw new Bad(MSG.notStore);
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (license.read_only) throw new Bad(MSG.locked, 402, { product: PRODUCT });
    }
    const store = await storeOf(business);
    return { business, store, license, who: req.customer.name || "Owner" };
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
    const [open, todayRows, products, customers] = await Promise.all([
      M.TgOrder.countDocuments({ business_id: bid, status: { $in: ["new", "accepted", "ready", "on_way"] } }),
      M.TgOrder.aggregate([{ $match: { business_id: bid, created_date: { $gte: today }, status: { $ne: "cancelled" } } }, { $group: { _id: null, n: { $sum: 1 }, total: { $sum: "$total" } } }]),
      M.TgProduct.countDocuments({ business_id: bid, deleted: false }),
      M.TgCustomer.countDocuments({ business_id: bid }),
    ]);
    const fresh = await M.TgOrder.countDocuments({ business_id: bid, status: "new" });
    return { open, new: fresh, today_orders: todayRows[0]?.n || 0, today_total: todayRows[0]?.total || 0, products, customers };
  }

  // ---------------------------------------- overview ----------------------------------------
  door("get", "", {}, async (ctx, req, res) => {
    const origin = String(req.get("origin") || "");
    if (/^https:\/\/[^/]+$/.test(origin) && ctx.store.web !== origin) {
      ctx.store.web = origin.slice(0, 200);
      M.TgStore.updateOne({ _id: ctx.store._id }, { $set: { web: ctx.store.web } }).catch(() => {});
    }
    const [counts, price, links] = await Promise.all([countsOf(ctx), priceOf(PRODUCT), linksOf(ctx.store)]);
    res.json({
      success: true,
      data: {
        business: { _id: ctx.business._id, name: ctx.business.name, status: ctx.business.status },
        store: storeOut(ctx.store),
        license: { ...ctx.license, price },
        counts,
        links: { web: links.web, telegram: links.telegram, bot: links.bot },
        telegram: { configured: telegram.ready(), connected: !!ctx.store.tg?.chat_id, chat_name: ctx.store.tg?.chat_name || "" },
        khqr_auto: khqr.configured(),
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
    if (b.color !== undefined) s.color = hexColor(b.color) || "#C4470F";
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
    if (!s.delivery.on && !s.pickup.on && !s.dine_in.on) throw new Bad(MSG.badMode, 400, { code: "need_mode" });
    if (!s.pay.cash.on && !s.pay.khqr.on) throw new Bad(MSG.badPay, 400, { code: "need_pay" });
    await s.save();
    res.json({ success: true, data: { store: storeOut(s) }, message: MSG.saved });
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
  door("get", "/orders", {}, async (ctx, req, res) => {
    const st = String(req.query.status || "open");
    const q = { business_id: ctx.business._id };
    if (st === "open") q.status = { $in: OPEN };
    else if (["done", "cancelled"].includes(st)) q.status = st;
    const page = int(req.query.page, 1, 1000, 1);
    const limit = 30;
    const [rows, total] = await Promise.all([
      M.TgOrder.find(q)
        .sort({ created_date: st === "open" ? 1 : -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.TgOrder.countDocuments(q),
    ]);
    res.json({ success: true, data: rows.map((o) => orderOut(o)), pagination: { page, limit, total }, counts: await countsOf(ctx) });
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

  door("get", "/customers", {}, async (ctx, req, res) => {
    const q = { business_id: ctx.business._id };
    const text = str(req.query.q, 60);
    if (text) {
      const re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ name: re }, { phone: re }, { username: re }];
    }
    const page = int(req.query.page, 1, 1000, 1);
    const rows = await M.TgCustomer.find(q)
      .sort({ last_order_at: -1, created_date: -1 })
      .skip((page - 1) * 50)
      .limit(50)
      .lean();
    res.json({ success: true, data: rows.map((c) => ({ _id: c._id, name: c.name, phone: c.phone, username: c.username, telegram: !!c.tg_id, orders: c.orders, spent: c.spent, last_order_at: c.last_order_at })) });
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
    // a customer opened the shop's bot link: answer with the button that opens the store inside Telegram
    if (/^st_[a-z0-9-]{2,40}$/.test(code)) {
      const s = await M.TgStore.findOne({ slug: code.slice(3) }).lean();
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
    const m = /^tgo:([a-f0-9]{24}):(accept|eta15|eta30|reject|ready|on_way|done|paid)$/.exec(data);
    if (!m) return null;
    const o = await M.TgOrder.findById(m[1]);
    if (!o) return { toast: "Order not found · រកមិនឃើញ", alert: true };
    const s = await M.TgStore.findOne({ business_id: o.business_id });
    if (!s || String(q.message?.chat?.id) !== s.tg?.chat_id) return { toast: "Not this shop's chat · មិនមែនក្រុមហាងនេះ", alert: true };
    const by = [q.from?.first_name, q.from?.last_name].filter(Boolean).join(" ") || (q.from?.username ? `@${q.from.username}` : "Staff");
    try {
      const act = m[2];
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

  // ---------------------------------------- public: the store ----------------------------------------
  async function openStore(slug) {
    const sl = str(slug, 60).toLowerCase();
    const s = sl ? await M.TgStore.findOne({ slug: sl }) : null;
    if (!s) throw new Bad(MSG.storeOff, 404, { code: "not_found" });
    const [business, license] = await Promise.all([Business.findOne({ _id: s.business_id, deleted: false }), licenseState(s.business_id)]);
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || !owner?.status || license.locked) throw new Bad(MSG.storeOff, 404, { code: "off" });
    return { store: s, business, license };
  }
  const pub = (path) => `/api/public/tgstore${path}`;
  const orderLimiter = rate_limit({ windowMs: 10 * 60 * 1000, max: 20, message: MSG.slow });
  const proofLimiter = rate_limit({ windowMs: 10 * 60 * 1000, max: 10, message: MSG.slow });
  const who = (req) => tgUser(req.get("x-tg-init-data"));

  prop.app.get(
    pub("/:slug"),
    handle(async (req, res) => {
      if (req.params.slug === "order") throw new Bad(MSG.storeOff, 404);
      const { store, license } = await openStore(req.params.slug);
      const [cats, products, links] = await Promise.all([
        M.TgCategory.find({ business_id: store.business_id, deleted: false }).sort({ sort: 1, created_date: 1 }).lean(),
        M.TgProduct.find({ business_id: store.business_id, deleted: false, hidden: false }).sort({ sort: 1, created_date: 1 }).lean(),
        linksOf(store),
      ]);
      res.set("Cache-Control", "no-store");
      res.json({
        success: true,
        data: {
          store: { ...lookOut(store), open: store.open && !license.read_only },
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
      const { store } = await openStore(req.params.slug);
      const u = who(req);
      if (!u) return res.json({ success: true, data: { telegram: false, orders: [] } });
      const c = await M.TgCustomer.findOne({ business_id: store.business_id, tg_id: u.tg_id }).lean();
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
          orders: orders.map((o) => ({ token: o.token, no: o.no, total: o.total, currency: o.currency, status: o.status, created_date: o.created_date, items: o.items.length })),
        },
      });
    }),
  );

  // place an order: prices, choices and stock are worked out here, never trusted from the phone
  prop.app.post(
    pub("/:slug/orders"),
    orderLimiter,
    handle(async (req, res) => {
      const { store: s, license } = await openStore(req.params.slug);
      if (!s.open || license.read_only) throw new Bad(MSG.closed, 409, { code: "closed" });
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
      if (mode === "delivery") {
        if (s.delivery.min_order && subtotal < s.delivery.min_order) throw new Bad(fill(MSG.minOrder, { amount: fmtMoney(s.delivery.min_order, cur) }), 400, { code: "min_order" });
        fee = s.delivery.free_from && subtotal >= s.delivery.free_from ? 0 : money(s.delivery.fee || 0, cur);
      }
      const total = money(subtotal + fee, cur);
      const method = b.pay === "khqr" ? "khqr" : "cash";
      if (method === "khqr" && !(s.pay.khqr.on && khqr.isBakongId(s.pay.khqr.bakong_id))) throw new Bad(MSG.badPay, 400, { code: "bad_pay" });
      if (method === "cash" && !s.pay.cash.on) throw new Bad(MSG.badPay, 400, { code: "bad_pay" });
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

      // who is ordering
      let customer = null;
      const custSet = { name: name.slice(0, 80), ...(phone ? { phone } : {}), ...(mode === "delivery" ? { address } : {}) };
      if (u) {
        customer = await M.TgCustomer.findOneAndUpdate(
          { business_id: s.business_id, tg_id: u.tg_id },
          { $set: { ...custSet, username: u.username, ...(u.can_message || b.can_message === true ? { can_message: true } : {}) }, $setOnInsert: { business_id: s.business_id, tg_id: u.tg_id } },
          { upsert: true, returnDocument: "after" },
        );
      } else if (phone) {
        customer = await M.TgCustomer.findOneAndUpdate({ business_id: s.business_id, phone, tg_id: "" }, { $set: custSet, $setOnInsert: { business_id: s.business_id, tg_id: "" } }, { upsert: true, returnDocument: "after" });
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
        fee,
        total,
        currency: cur,
        pay: { method, status: "unpaid" },
        timeline: [{ status: "new", at: new Date(), by: name || "Customer" }],
        via: u ? "telegram" : "web",
      });
      if (method === "khqr") {
        const expires = new Date(Date.now() + 60 * 60000);
        const k = khqr.build({ bakongId: s.pay.khqr.bakong_id, name: s.pay.khqr.account_name || s.shop_name, amount: total, currency: cur, bill: `TG${o.no}`, store: s.shop_name, expiresAt: expires });
        o.pay.khqr = { qr: k.qr, md5: k.md5, amount: total, expires };
      }
      try {
        await o.save();
      } catch (err) {
        for (const [tid, tq] of taken) await M.TgProduct.updateOne({ _id: tid }, { $inc: { stock: tq } });
        throw err;
      }
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
      res.json({ success: true, data: { order: orderOut(o), khqr: kq, store: lookOut(s) } });
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

Object.assign(module.exports, { tgUser, licenseState, groupText });
