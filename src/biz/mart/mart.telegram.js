// Telegram alerts (mart_telegram, 90 coins a year): the owner links a Telegram chat (or a team group) to the BizHub bot,
// which sends: a new website order, a closed POS shift (count + difference), products going low / sold out, "Contact us" messages.
// Base: /api/user/businesses/:id/mart/telegram
//   GET    /          status { configured, active, connected, chat_name, new_order, shift_close, low_stock, new_message }
//   POST   /link      → { url, group_url, expires_at }   open it, press Start → linked (poll GET until connected)
//   PUT    /          { new_order, shift_close, low_stock, new_message }
//   POST   /test      DELETE /
const crypto = require("crypto");
const M = require("./mart.models");
const telegram = require("../../telegram");

const LINK_MINUTES = 15;
const FLAGS = ["new_order", "shift_close", "low_stock", "new_message", "daily"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const T = {
  needAddon: "សូមដោះសោ “ការជូនដំណឹង Telegram” ជាមុនសិន!",
  notConfigured: "ក្រុមការងារ BizHub មិនទាន់រៀបចំ Telegram bot ទេ។ សូមព្យាយាមពេលក្រោយ។",
  notConnected: "មិនទាន់ភ្ជាប់ Telegram ទេ!",
  blocked: "Telegram នេះបានបិទ bot ហើយ។ សូមភ្ជាប់ម្តងទៀត។",
  unreachable: "មិនអាចទាក់ទង Telegram បានទេ សូមព្យាយាមម្តងទៀត។",
  sent: "បានផ្ញើសារសាកល្បង!",
  disconnected: "បានផ្តាច់ Telegram!",
};
const token = (n) => crypto.randomBytes(24).toString("base64url").replace(/[-_]/g, "").slice(0, n);
const esc = telegram.escape;
const moneyOf = (cur) => (v) => (cur === "KHR" ? `${Math.round(Number(v) || 0).toLocaleString("en-US")}៛` : `$${(Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const usd = moneyOf("USD");
const riel = moneyOf("KHR");
const timeOf = (d) => new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Phnom_Penh" });
const METHOD = { cash: "Cash", aba: "ABA", khqr: "KHQR", acleda: "ACLEDA", wing: "Wing", card: "Card", other: "Other", debt: "Debt" };

const statusOf = (s, addons) => {
  const t = s.tg || {};
  return {
    configured: telegram.ready(),
    active: !!addons.mart_telegram?.active,
    connected: !!t.chat_id,
    chat_name: t.chat_name || "",
    chat_type: t.chat_type || "",
    connected_at: t.connected_at || null,
    ...Object.fromEntries(FLAGS.map((k) => [k, t[k] !== false])),
    report_time: t.report_time || "21:00",
    last_report_at: t.last_report_at || null,
  };
};
const setMany = (doc, values) => Object.entries(values).forEach(([k, v]) => doc.set(`tg.${k}`, v));

// ---------- the messages ----------
function alertText(kind, name, cur, info, settings) {
  const money = moneyOf(cur);
  const head = (icon, en, km) => `${icon} <b>${en}</b> · ${km}\n🛒 ${esc(name)}`;
  const methodName = (k, saved) => METHOD[k] || saved || (settings?.custom_methods || []).find((x) => x.key === k)?.name || k;
  if (kind === "new_order") {
    const o = info.order;
    return [
      head("🛍", `New online order ${esc(o.no)}`, "ការកម្ម៉ង់អនឡាញថ្មី"),
      "",
      `👤 ${esc(o.name)} · ${esc(o.phone)}`,
      ...o.items.slice(0, 15).map((l) => `• ${l.qty}× ${esc(l.name)} — ${money(l.total)}`),
      o.items.length > 15 ? `… +${o.items.length - 15} more` : "",
      o.delivery_fee > 0 ? `🚚 Delivery ${money(o.delivery_fee)}` : "",
      `💰 <b>${money(o.total)}</b>`,
      o.fulfil === "delivery" ? `📍 Delivery: ${esc(o.address?.address || "")}${o.address?.note ? ` (${esc(o.address.note)})` : ""}` : "🏪 Pickup at the shop · មកយកផ្ទាល់",
      o.pay_method === "qr" ? "💳 Paid by QR — screenshot sent · បង់តាម QR" : "💵 Cash · សាច់ប្រាក់",
      o.note ? `📝 ${esc(o.note)}` : "",
      "",
      "➡️ Open the POS or the dashboard to accept.",
    ]
      .filter((l, i, a) => l !== "" || (a[i - 1] !== "" && i > 0))
      .join("\n");
  }
  if (kind === "shift_close") {
    const sh = info.shift;
    const off = Math.abs(sh.diff_usd) >= 0.01 || Math.abs(sh.diff_khr) >= 1;
    const sign = (v, f) => (v > 0 ? `+${f(v)}` : v < 0 ? `-${f(-v)}` : f(0));
    return [
      head("🔒", `Shift closed ${esc(sh.no)}`, "បិទវេន"),
      `🖥 ${esc(sh.device_name || "Dashboard")} · ${esc(sh.opened_by)}${sh.closed_by && sh.closed_by !== sh.opened_by ? ` → ${esc(sh.closed_by)}` : ""}`,
      `🕐 ${timeOf(sh.opened_at)} → ${timeOf(sh.closed_at)}`,
      "",
      `🧾 Sales: <b>${money(sh.sales_total)}</b> (${sh.sales_count} receipts)`,
      ...Object.entries(sh.by_method || {}).map(([k, v]) => `   · ${esc(methodName(k))} ${money(v)}`),
      "",
      `💵 Expected: ${usd(sh.expected_usd)} + ${riel(sh.expected_khr)}`,
      `🧮 Counted: ${usd(sh.counted_usd)} + ${riel(sh.counted_khr)}`,
      off ? `⚠️ <b>Difference: ${sign(sh.diff_usd, usd)} ${sign(sh.diff_khr, riel)}</b>` : "✅ Exact · ត្រឹមត្រូវ",
      sh.note ? `📝 ${esc(sh.note)}` : "",
    ]
      .filter((l, i, a) => l !== "" || (a[i - 1] !== "" && i > 0))
      .join("\n");
  }
  if (kind === "low_stock") {
    const out = info.items.filter((x) => x.stock <= 0);
    const low = info.items.filter((x) => x.stock > 0);
    return [
      head(out.length ? "🚨" : "⚠️", out.length ? "Sold out" : "Low stock", out.length ? "អស់ស្តុក" : "ស្តុកជិតអស់"),
      "",
      ...out.map((x) => `⛔️ ${esc(x.name)} — <b>0 left</b>`),
      ...low.map((x) => `🟠 ${esc(x.name)} — <b>${x.stock}</b> left (low at ${x.low})`),
      "",
      "➡️ Receive stock in Stock control.",
    ].join("\n");
  }
  if (kind === "new_message") {
    const m = info.message;
    return [head("✉️", "New message from your website", "សារថ្មីពីគេហទំព័រ"), "", `👤 ${esc(m.name)}${m.contact ? ` · ${esc(m.contact)}` : ""}`, `💬 ${esc(m.message.slice(0, 1500))}`, "", "➡️ Website → Inbox"].join("\n");
  }
  return "";
}

// the day's summary (free with mart_telegram): sales, payment methods, best sellers, online orders, stock, expiry, profit
async function summaryOf(bid, name, settings, addons, day) {
  const money = moneyOf(settings.currency);
  const start = new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 3600000);
  const end = new Date(start.getTime() + 86400000);
  const sales = await M.MartSale.find({ business_id: bid, at: { $gte: start, $lt: end } }).lean();
  const paid = sales.filter((x) => x.status === "paid");
  const total = paid.reduce((a, x) => a + x.total, 0);
  const byMethod = {};
  for (const x of paid) byMethod[x.method] = (byMethod[x.method] || 0) + x.total;
  const top = new Map();
  for (const x of paid) for (const l of x.items) if (l.product_id) top.set(l.name, (top.get(l.name) || 0) + l.qty);
  const best = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const methodName = (k) => METHOD[k] || (settings.custom_methods || []).find((x) => x.key === k)?.name || k;
  const lines = [
    `📊 <b>Daily summary · ${day}</b> · សង្ខេបប្រចាំថ្ងៃ`,
    `🛒 ${esc(name)}`,
    "",
    `💰 Sales: <b>${money(total)}</b> · ${paid.length} receipts${paid.length ? ` · avg ${money(total / paid.length)}` : ""}`,
    ...Object.entries(byMethod).map(([k, v]) => `   · ${esc(methodName(k))} ${money(v)}`),
    sales.length - paid.length ? `🗑 Voided: ${sales.length - paid.length}` : "",
    paid.some((x) => x.discount || x.promo_discount) ? `🏷 Discounts: ${money(paid.reduce((a, x) => a + (x.discount || 0) + (x.promo_discount || 0) + (x.points_value || 0), 0))}` : "",
  ];
  if (best.length) lines.push("", "🔥 Best sellers · លក់ដាច់", ...best.map(([n, q], i) => `${i + 1}. ${esc(n)} × ${Math.round(q * 1000) / 1000}`));
  if (addons.mart_profit?.active) {
    let cost = 0;
    for (const x of paid) for (const l of x.items) cost += (l.cost || 0) * l.qty;
    lines.push("", `📈 Profit: <b>${money(total - cost)}</b>${total > 0 ? ` (${Math.round(((total - cost) / total) * 100)}%)` : ""}`);
  }
  if (addons.mart_shop?.active) {
    const [done, waiting] = await Promise.all([M.MartOrder.countDocuments({ business_id: bid, status: "done", created_date: { $gte: start, $lt: end } }), M.MartOrder.countDocuments({ business_id: bid, status: { $in: M.OPEN_ORDER } })]);
    lines.push("", `🛍 Online orders done: ${done}${waiting ? ` · ⏳ still open: ${waiting}` : ""}`);
  }
  if (addons.mart_stock?.active) {
    const prods = await M.MartProduct.find({ business_id: bid, active: true, track_stock: true }).select("name stock low_stock").lean();
    const out = prods.filter((p) => p.stock <= 0);
    const low = prods.filter((p) => p.stock > 0 && p.stock <= (p.low_stock ?? 5));
    if (out.length || low.length) lines.push("", `📦 Sold out: ${out.length} · Low: ${low.length}`, ...out.slice(0, 5).map((p) => `   ⛔️ ${esc(p.name)}`), ...low.slice(0, 5).map((p) => `   🟠 ${esc(p.name)} (${p.stock})`));
  }
  if (addons.mart_expiry?.active) {
    const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    const until = new Date(Date.parse(`${today}T00:00:00Z`) + (settings.expiry_days || 30) * 86400000).toISOString().slice(0, 10);
    const [expired, soon] = await Promise.all([M.MartBatch.countDocuments({ business_id: bid, left: { $gt: 0 }, expires: { $lt: today } }), M.MartBatch.countDocuments({ business_id: bid, left: { $gt: 0 }, expires: { $gte: today, $lte: until } })]);
    if (expired || soon) lines.push("", `⏰ Expired: ${expired} · Expiring soon: ${soon}`);
  }
  return lines.filter((l, i, a) => l !== "" || (a[i - 1] !== "" && i > 0)).join("\n");
}
// the scheduler (/api/cron/daily-report, with the restaurant + guest house ones): each shop once a day after its time
async function dailyReports() {
  if (!telegram.ready()) return { checked: 0, sent: 0 };
  const now = new Date();
  const local = new Date(now.getTime() + 7 * 3600000);
  const hhmm = local.toISOString().slice(11, 16);
  const day = local.toISOString().slice(0, 10);
  const dayStart = new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 3600000);
  const list = await M.MartSettings.find({
    "tg.chat_id": { $gt: "" },
    "tg.daily": { $ne: false },
    $or: [{ "tg.report_time": { $lte: hhmm } }, { "tg.report_time": { $exists: false } }],
    $and: [{ $or: [{ "tg.last_report_at": null }, { "tg.last_report_at": { $exists: false } }, { "tg.last_report_at": { $lt: dayStart } }] }],
  }).limit(300);
  const Business = require("../business.model");
  const { licenseState } = require("./mart.route");
  let sent = 0;
  for (const s of list) {
    if ((s.tg.report_time || "21:00") > hhmm) continue;
    s.set("tg.last_report_at", now);
    await s.save();
    const [business, state] = await Promise.all([Business.findOne({ _id: s.business_id, deleted: false, status: true }).select("name").lean(), licenseState(s.business_id)]);
    if (!business || !state.addons.mart_telegram?.active || state.license.locked) continue;
    const ok = await telegram
      .send(s.tg.chat_id, await summaryOf(s.business_id, business.name, s, state.addons, day))
      .then(() => true)
      .catch(() => false);
    if (ok) sent += 1;
  }
  return { checked: list.length, sent };
}

// send one alert if this shop wants it
async function alert(bid, kind, info, pre = {}) {
  try {
    if (!telegram.ready()) return false;
    const settings = pre.settings || (await M.MartSettings.findOne({ business_id: bid }).lean());
    const t = settings?.tg;
    if (!t?.chat_id || t[kind] === false) return false;
    const addons = pre.addons || (await require("./mart.route").licenseState(bid)).addons;
    if (!addons.mart_telegram?.active) return false;
    const name = pre.name || (await require("../business.model").findById(bid).select("name").lean())?.name || "Mini Mart";
    const html = alertText(kind, name, settings.currency, info, settings);
    if (!html) return false;
    await telegram.send(t.chat_id, html);
    return true;
  } catch (err) {
    if (err instanceof telegram.TelegramError && err.message === "blocked") await M.MartSettings.updateOne({ business_id: bid }, { $set: { "tg.chat_id": "" } }).catch(() => {});
    return false;
  }
}
// don't keep the customer / cashier waiting for Telegram: wait a moment, then answer anyway
const soon = (p, ms = 1500) => Promise.race([p.catch(() => false), new Promise((r) => setTimeout(r, ms))]);

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, Bad, MSG, bool } = kit;
  const path = `${base}/telegram`;
  const needAddon = (ctx) => {
    if (!ctx.addons.mart_telegram?.active) throw new Bad(T.needAddon, 402, { product: "mart_telegram" });
  };
  const fail = (err) => {
    if (err instanceof telegram.TelegramError) throw new Bad(err.message === "not_configured" ? T.notConfigured : err.message === "blocked" ? T.blocked : T.unreachable, err.status);
    throw err;
  };

  // someone pressed Start in Telegram with a mini mart code (mt_…; other codes → null → the next handler)
  telegram.onStart(async (code, chat) => {
    if (!/^mt_[A-Za-z0-9]{12,40}$/.test(code)) return null;
    const s = await M.MartSettings.findOne({ "tg.link_code": code });
    if (!s || !s.tg.link_expires || s.tg.link_expires < new Date()) return "⌛️ This link has expired. Open BizHub → Mini Mart → Telegram → Connect again.\nតំណនេះផុតកំណត់ហើយ។ សូមចុច “ភ្ជាប់” ម្តងទៀត។";
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "Telegram");
    setMany(s, { chat_id: String(chat.id), chat_name: name.slice(0, 80), chat_type: chat.type || "private", connected_at: new Date(), link_code: "", link_expires: null });
    await s.save();
    const biz = await require("../business.model").findById(s.business_id).select("name").lean();
    return `✅ <b>${esc(biz?.name || "Mini Mart")}</b> is connected to this chat.\nបានភ្ជាប់ជាមួយ BizHub ហើយ។\n\n🛍 New website orders · 🔒 shift closed · ⚠️ low / sold-out stock · ✉️ website messages`;
  });

  prop.app.get(
    path,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      res.json({ success: true, data: statusOf(ctx.settings, ctx.addons) });
    }),
  );
  prop.app.post(
    `${path}/link`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      if (!telegram.ready()) throw new Bad(T.notConfigured, 503);
      const bot = await telegram.botUsername().catch(fail);
      const code = `mt_${token(24)}`;
      const expires = new Date(Date.now() + LINK_MINUTES * 60000);
      setMany(ctx.settings, { link_code: code, link_expires: expires });
      await ctx.settings.save();
      res.json({ success: true, data: { url: `https://t.me/${bot}?start=${code}`, group_url: `https://t.me/${bot}?startgroup=${code}`, bot, expires_at: expires } });
    }),
  );
  prop.app.put(
    path,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      const b = req.body || {};
      for (const k of FLAGS) if (b[k] !== undefined) ctx.settings.set(`tg.${k}`, bool(b, k));
      if (b.report_time !== undefined) {
        if (!TIME_RE.test(String(b.report_time))) throw new Bad(`${MSG.badValue} (report_time)`);
        ctx.settings.set("tg.report_time", String(b.report_time));
      }
      await ctx.settings.save();
      res.json({ success: true, data: statusOf(ctx.settings, ctx.addons), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${path}/test`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      const chat = ctx.settings.tg?.chat_id;
      if (!chat) throw new Bad(T.notConnected);
      try {
        await telegram.send(chat, `🔔 <b>${esc(ctx.business.name)}</b>\nTest message from BizHub — everything works.\nសារសាកល្បងពី BizHub — ដំណើរការល្អ។`);
      } catch (err) {
        if (err instanceof telegram.TelegramError && err.message === "blocked") {
          ctx.settings.set("tg.chat_id", "");
          await ctx.settings.save();
        }
        fail(err);
      }
      res.json({ success: true, message: T.sent });
    }),
  );
  // the day's summary now (to see what it looks like)
  prop.app.post(
    `${path}/daily`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      const chat = ctx.settings.tg?.chat_id;
      if (!chat) throw new Bad(T.notConnected);
      const day = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
      const html = await summaryOf(ctx.business._id, ctx.business.name, ctx.settings, ctx.addons, day);
      await telegram.send(chat, html).catch(fail);
      res.json({ success: true, data: { text: html }, message: T.sent });
    }),
  );
  prop.app.delete(
    path,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const chat = ctx.settings.tg?.chat_id;
      setMany(ctx.settings, { chat_id: "", chat_name: "", chat_type: "", connected_at: null, link_code: "", link_expires: null });
      await ctx.settings.save();
      if (chat) telegram.send(chat, "🔌 BizHub disconnected from this chat.\nបានផ្តាច់ពី BizHub ហើយ។").catch(() => {});
      res.json({ success: true, data: statusOf(ctx.settings, ctx.addons), message: T.disconnected });
    }),
  );
  return { alert, soon };
};
module.exports.alert = alert;
module.exports.soon = soon;
module.exports.alertText = alertText;
module.exports.dailyReports = dailyReports;
module.exports.summaryOf = summaryOf;
