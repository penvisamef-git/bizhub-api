// Telegram alerts (gh_telegram, yearly): the owner links a Telegram chat (or a team group) to the BizHub bot,
// which sends alerts (new online booking, check-in, check-out, payment) and a daily summary.
// Base: /api/user/businesses/:id/guesthouse/telegram
//   GET    /          status { configured, active, connected, chat_name, daily_report, report_time, new_booking, check_in, check_out, payment }
//   POST   /link      → { url, group_url, expires_at }  open it, press Start → linked (poll GET until connected)
//   PUT    /          { daily_report, report_time, new_booking, check_in, check_out, payment }
//   POST   /test      send a test message
//   DELETE /          disconnect
// Scheduler: GET /api/cron/guesthouse-report (also run by /api/cron/daily-report)
const crypto = require("crypto");
const M = require("./guesthouse.models");
const telegram = require("../../telegram");

const LINK_MINUTES = 15;
const FLAGS = ["daily_report", "new_booking", "check_in", "check_out", "payment"];
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
const localDay = (t = Date.now()) => new Date(t + 7 * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const nightsOf = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const dayText = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "");
const moneyOf = (cur) => (v) => (cur === "KHR" ? `${Math.round(Number(v) || 0).toLocaleString("en-US")}៛` : `$${(Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const METHOD = { cash: "Cash", aba: "ABA", acleda: "ACLEDA", wing: "Wing", card: "Card", bank: "Bank", other: "Other" };

const statusOf = (s, addons) => {
  const t = s.tg || {};
  return {
    configured: telegram.ready(),
    active: !!addons.gh_telegram?.active,
    connected: !!t.chat_id,
    chat_name: t.chat_name || "",
    chat_type: t.chat_type || "",
    connected_at: t.connected_at || null,
    report_time: t.report_time || "21:00",
    ...Object.fromEntries(FLAGS.map((k) => [k, t[k] !== false])),
  };
};
const setMany = (doc, values) => Object.entries(values).forEach(([k, v]) => doc.set(`tg.${k}`, v));

// ---------- the messages ----------
function alertText(kind, name, cur, info) {
  const money = moneyOf(cur);
  const head = (icon, en, km) => `${icon} <b>${en}</b> · ${km}\n🏠 ${esc(name)}\n`;
  const s = info.stay;
  const who = s ? `🛏 ${esc(info.room || "?")} · ${esc(s.guest?.name || "")}${s.guest?.phone ? ` · ${esc(s.guest.phone)}` : ""}` : "";
  const dates = (from, to) => `📅 ${dayText(from)} → ${dayText(to)} (${nightsOf(from, to)} night${nightsOf(from, to) === 1 ? "" : "s"})`;
  const by = info.by ? `\n👤 ${esc(info.by)}` : "";
  if (kind === "new_booking" && info.request.kind === "ota") {
    const r = info.request;
    return [head("📥", `New ${esc(r.ota)} booking`, "ការកក់ថ្មីពី OTA").trim(), `${esc(r.type_name)}`, dates(r.from, r.to), "\n➡️ Added to your bookings by the calendar link."].join("\n");
  }
  if (kind === "new_booking" && info.request.kind === "conflict") {
    const r = info.request;
    return [head("⚠️", "Double booking!", "កក់ជាន់គ្នា!").trim(), `${esc(r.ota)} · ${esc(r.type_name)}`, dates(r.from, r.to), `Already booked here: ${esc(r.with_no)}`, "\n➡️ Move one of the guests to another room."].join("\n");
  }
  if (kind === "new_booking") {
    const r = info.request;
    return [
      head("🛎", r.kind === "account" ? "New online booking" : "New booking request", "ការកក់តាមអនឡាញថ្មី").trim(),
      `👤 ${esc(r.name)}${r.contact ? ` · ${esc(r.contact)}` : ""}`,
      r.type_name ? `🛏 ${esc(r.type_name)} · ${r.guests} guest${r.guests === 1 ? "" : "s"}` : `👥 ${r.guests} guest${r.guests === 1 ? "" : "s"}`,
      dates(r.from, r.to),
      r.estimate ? `💰 ${money(r.estimate)}` : "",
      r.pay ? (r.pay === "qr" ? "💳 Paid by QR — transfer photo sent · បង់តាម QR" : "💵 Pay at the guest house · បង់នៅផ្ទះសំណាក់") : "",
      r.kind === "account" ? "\n➡️ Open the desk POS or dashboard to accept." : "\n➡️ Call or message the guest, then book the room.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (kind === "check_in") return [head("🟢", "Check-in", "ចូលស្នាក់").trim(), who, dates(s.from, s.to), `👥 ${s.adults || 1}${s.children ? ` + ${s.children}` : ""}${by}`].join("\n");
  if (kind === "check_out") {
    const b = info.bill;
    return [head("🔴", "Check-out", "ចេញពីបន្ទប់").trim(), who, dates(s.from, s.to), `🧾 ${money(b.total)} · paid ${money(b.paid)}${b.balance ? ` · <b>left ${money(b.balance)}</b>` : " ✅"}${by}`].join("\n");
  }
  if (kind === "payment") {
    const b = info.bill;
    return (
      [
        head(info.amount < 0 ? "↩️" : "💵", info.amount < 0 ? "Refund" : "Payment", info.amount < 0 ? "ការសងប្រាក់វិញ" : "ការបង់ប្រាក់").trim(),
        `<b>${money(Math.abs(info.amount))}</b> · ${METHOD[info.method] || esc(info.method)}`,
        `${who} · ${esc(s.no)}`,
        b.balance > 0 ? `⏳ Left to pay: ${money(b.balance)}` : "✅ Fully paid",
      ].join("\n") + by
    );
  }
  return "";
}

// send one alert if this guest house wants it. pre = { settings, addons, name } when the caller already has them.
async function alert(bid, kind, info, pre = {}) {
  if (!telegram.ready()) return false;
  const settings = pre.settings || (await M.GhSettings.findOne({ business_id: bid }).lean());
  const t = settings?.tg;
  if (!t?.chat_id || t[kind] === false) return false;
  const addons = pre.addons || (await require("./guesthouse.route").licenseState(bid)).addons;
  if (!addons.gh_telegram?.active) return false;
  let name = pre.name;
  if (!name) name = (await require("../business.model").findById(bid).select("name").lean())?.name || "Guest house";
  if (info.stay && !info.room) info.room = (await M.GhRoom.findById(info.stay.room_id).select("name").lean())?.name || "";
  const html = alertText(kind, name, settings.currency, info);
  if (!html) return false;
  try {
    await telegram.send(t.chat_id, html);
    return true;
  } catch (err) {
    if (err instanceof telegram.TelegramError && err.message === "blocked") await M.GhSettings.updateOne({ business_id: bid }, { $set: { "tg.chat_id": "" } });
    return false;
  }
}
// don't keep the guest waiting for Telegram: wait a moment, then answer anyway
const soon = (p, ms = 1500) => Promise.race([p.catch(() => false), new Promise((r) => setTimeout(r, ms))]);

// ---------- the daily summary ----------
async function summaryOf(s, name, day) {
  const bid = s.business_id;
  const money = moneyOf(s.currency);
  const dayStart = new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 3600000);
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const [rooms, inHouse, ins, outs, tomorrow, paid, waiting, waitingSite] = await Promise.all([
    M.GhRoom.countDocuments({ business_id: bid, active: true }),
    M.GhStay.countDocuments({ business_id: bid, status: "in" }),
    M.GhStay.countDocuments({ business_id: bid, checked_in_at: { $gte: dayStart, $lt: dayEnd } }),
    M.GhStay.countDocuments({ business_id: bid, checked_out_at: { $gte: dayStart, $lt: dayEnd } }),
    M.GhStay.countDocuments({ business_id: bid, status: "booked", from: addDays(day, 1) }),
    M.GhStay.aggregate([
      { $match: { business_id: bid, "payments.at": { $gte: dayStart, $lt: dayEnd } } },
      { $unwind: "$payments" },
      { $match: { "payments.at": { $gte: dayStart, $lt: dayEnd } } },
      { $group: { _id: "$payments.method", total: { $sum: "$payments.amount" } } },
    ]),
    M.GhCustBooking.countDocuments({ business_id: bid, status: "pending" }),
    M.GhSiteRequest.countDocuments({ business_id: bid, status: "new" }),
  ]);
  // monthly tenants (gh_longstay): bills not made yet this month + money owed
  const leases = await M.GhStay.find({ business_id: bid, lease: { $exists: true }, status: "in" })
    .select("lease charges payments discount from to rate")
    .lean();
  const { billOf } = require("./guesthouse.route");
  const toBill = leases.filter((l) => Number(day.slice(8)) >= (l.lease.bill_day || 1) && !(l.lease.bills || []).some((x) => x.month === day.slice(0, 7))).length;
  const owed = leases.reduce((a, l) => a + Math.max(0, billOf(l, s.currency).balance), 0);
  const total = paid.reduce((a, p) => a + p.total, 0);
  const pct = rooms ? Math.round((inHouse / rooms) * 100) : 0;
  return [
    `📊 <b>Daily summary · ${dayText(day)}</b> · សេចក្តីសង្ខេបប្រចាំថ្ងៃ`,
    `🏠 ${esc(name)}`,
    "",
    `🛏 In house: <b>${inHouse}</b> / ${rooms} rooms (${pct}%)`,
    `🟢 Check-ins today: ${ins}`,
    `🔴 Check-outs today: ${outs}`,
    `📅 Arriving tomorrow: ${tomorrow}`,
    `💵 Money in: <b>${money(total)}</b>`,
    ...paid.filter((p) => p.total).map((p) => `   · ${METHOD[p._id] || p._id} ${money(p.total)}`),
    waiting + waitingSite ? `🛎 Online requests waiting: <b>${waiting + waitingSite}</b>` : "",
    toBill ? `🏠 Monthly bills to make: <b>${toBill}</b>` : "",
    owed > 0 ? `🏠 Tenants owe: <b>${money(owed)}</b>` : "",
  ]
    .filter((l, i, a) => l !== "" || (a[i - 1] !== "" && i > 0))
    .join("\n");
}
async function dailyReports() {
  if (!telegram.ready()) return { checked: 0, sent: 0 };
  const now = new Date();
  const local = new Date(now.getTime() + 7 * 3600000);
  const hhmm = local.toISOString().slice(11, 16);
  const day = local.toISOString().slice(0, 10);
  const dayStart = new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 3600000);
  const list = await M.GhSettings.find({ "tg.chat_id": { $gt: "" }, "tg.daily_report": { $ne: false }, "tg.report_time": { $lte: hhmm }, $or: [{ "tg.last_report_at": null }, { "tg.last_report_at": { $lt: dayStart } }] }).limit(200);
  const Business = require("../business.model");
  const { licenseState } = require("./guesthouse.route");
  let sent = 0;
  for (const s of list) {
    s.set("tg.last_report_at", now);
    await s.save();
    const [business, state] = await Promise.all([Business.findOne({ _id: s.business_id, deleted: false, status: true }).select("name").lean(), licenseState(s.business_id)]);
    if (!business || !state.addons.gh_telegram?.active || state.license.locked) continue;
    const ok = await telegram
      .send(s.tg.chat_id, await summaryOf(s, business.name, day))
      .then(() => true)
      .catch(() => false);
    if (ok) sent += 1;
  }
  return { checked: list.length, sent };
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, Bad, MSG, bool } = kit;
  const path = `${base}/telegram`;
  const needAddon = (ctx) => {
    if (!ctx.addons.gh_telegram?.active) throw new Bad(T.needAddon, 402, { product: "gh_telegram" });
  };
  const fail = (err) => {
    if (err instanceof telegram.TelegramError) throw new Bad(err.message === "not_configured" ? T.notConfigured : err.message === "blocked" ? T.blocked : T.unreachable, err.status);
    throw err;
  };

  // someone pressed Start in Telegram with a guest house code (gh_…; other codes → null → the next handler)
  telegram.onStart(async (code, chat) => {
    if (!/^gh_[A-Za-z0-9]{12,40}$/.test(code)) return null;
    const s = await M.GhSettings.findOne({ "tg.link_code": code });
    if (!s || !s.tg.link_expires || s.tg.link_expires < new Date()) return "⌛️ This link has expired. Open BizHub → Guest house → Telegram → Connect again.\nតំណនេះផុតកំណត់ហើយ។ សូមចុច “ភ្ជាប់” ម្តងទៀត។";
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "Telegram");
    setMany(s, { chat_id: String(chat.id), chat_name: name.slice(0, 80), chat_type: chat.type || "private", connected_at: new Date(), link_code: "", link_expires: null });
    await s.save();
    const biz = await require("../business.model").findById(s.business_id).select("name").lean();
    const t = s.tg;
    return `✅ <b>${esc(biz?.name || "Guest house")}</b> is connected to this chat.\nបានភ្ជាប់ជាមួយ BizHub ហើយ។\n\n🛎 New online bookings · 🟢 check-in · 🔴 check-out · 💵 payments${t.daily_report ? `\n📊 Daily summary: every day at ${t.report_time}.` : ""}`;
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
      const code = `gh_${token(24)}`;
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
        if (!M.HHMM.test(String(b.report_time))) throw new Bad(`${MSG.badValue} (report_time)`);
        ctx.settings.set("tg.report_time", b.report_time);
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

  // what the daily summary looks like right now (owner preview)
  prop.app.get(
    `${path}/preview`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      res.json({ success: true, data: { html: await summaryOf(ctx.settings, ctx.business.name, localDay()) } });
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

  prop.app.get("/api/cron/guesthouse-report", async (req, res) => {
    const secret = process.env.CRON_SECRET || "";
    const given = (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || String(req.query.key || "");
    if (!secret || given !== secret) return res.sendStatus(404);
    try {
      res.json({ success: true, ...(await dailyReports()) });
    } catch (err) {
      console.error("[guesthouse-report]", err);
      res.status(500).json({ success: false });
    }
  });
};
module.exports.alert = alert;
module.exports.soon = soon;
module.exports.dailyReports = dailyReports;
module.exports.alertText = alertText;
module.exports.summaryOf = summaryOf;
