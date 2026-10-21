// Event Tickets on Telegram (one BizHub bot, src/telegram):
//   ev_telegram (organisers, yearly): each payment screenshot with ✅ Approve / ❌ Reject buttons · the day's summary at 20:00
//   ev_guest_tg (guests, yearly): "Get my tickets on Telegram" on the order page → ticket QR pictures when paid, a reminder the day
//                 before + 2 hours before, live updates and documents from the organiser
// Owner base: /api/user/businesses/:id/events/telegram
//   GET  ""   status   POST /link → { url, group_url }   PUT "" { daily, new_orders, remind_day, remind_hours }   POST /test   DELETE ""
// Scheduler: tick() — run by /api/cron/daily-report (and /api/cron/event-telegram)
const QRCode = require("qrcode");
const telegram = require("../../telegram");

const LINK_MINUTES = 15;
const DEFAULT_SITE = "https://bizhub-cambodia.web.app";
const T = {
  notConfigured: "ក្រុមការងារ BizHub មិនទាន់រៀបចំ Telegram bot ទេ។ / The BizHub Telegram bot isn't set up yet.",
  notConnected: "មិនទាន់ភ្ជាប់ Telegram ទេ! / Telegram is not connected.",
  blocked: "Telegram នេះបានបិទ bot ហើយ។ សូមភ្ជាប់ម្តងទៀត។ / This chat blocked the bot — connect again.",
  unreachable: "មិនអាចទាក់ទង Telegram បានទេ។ / Can't reach Telegram, try again.",
  sent: "បានផ្ញើសារសាកល្បង! / Test message sent.",
  saved: "បានរក្សាទុក! / Saved.",
  disconnected: "បានផ្តាច់ Telegram! / Telegram disconnected.",
};

module.exports = (prop, kit) => {
  const { M, X, Bad, MSG, handle, door, need, hooks, licenseState, settingsOf, approve, reject, str, r2, randCode, TZ } = kit;
  const esc = telegram.escape;
  const usd = (n) => `$${Number(n || 0).toFixed(2).replace(/\.00$/, "")}`;
  const when = (d) => (d ? new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 16).replace("T", " ") : "");
  const siteOf = (s) => String(s?.web || process.env.WEB_URL || DEFAULT_SITE).replace(/\/+$/, "");
  const fail = (err) => {
    if (err instanceof telegram.TelegramError) throw new Bad(err.message === "not_configured" ? T.notConfigured : err.message === "blocked" ? T.blocked : T.unreachable, err.status);
    throw err;
  };
  const chatName = (chat) => (chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "Telegram")).slice(0, 80);
  const startOf = (ev, o) => (o?.show ? X.showOf(ev, o.show)?.starts_at : null) || ev.starts_at;

  // ======================================== owner settings ========================================
  const statusOf = async (ctx) => ({
    configured: telegram.ready(),
    org: { active: !!ctx.addons.ev_telegram?.active, connected: !!ctx.settings.tg?.chat_id, chat_name: ctx.settings.tg?.chat_name || "", connected_at: ctx.settings.tg?.connected_at || null, daily: ctx.settings.tg?.daily !== false, new_orders: ctx.settings.tg?.new_orders !== false },
    guests: { active: !!ctx.addons.ev_guest_tg?.active, remind_day: ctx.settings.guest_tg?.remind_day !== false, remind_hours: ctx.settings.guest_tg?.remind_hours !== false, linked: await M.EvOrder.countDocuments({ business_id: ctx.business._id, "tg.chat_id": { $gt: "" } }) },
  });
  door("get", "/telegram", {}, async (ctx, req, res) => res.json({ success: true, data: await statusOf(ctx) }));
  // how many guests of one event get its updates on Telegram (paid orders linked to Telegram)
  door("get", "/events/:eid/telegram-guests", {}, async (ctx, req, res) => {
    const ev = await M.EvEvent.findOne({ _id: req.params.eid, business_id: ctx.business._id }).select("_id").lean();
    if (!ev) throw new Bad(MSG.rowNotFound, 404);
    const chats = await M.EvOrder.distinct("tg.chat_id", { event_id: ev._id, status: "paid", "tg.chat_id": { $gt: "" } });
    const orders = await M.EvOrder.countDocuments({ event_id: ev._id, status: "paid" });
    res.json({ success: true, data: { linked: chats.length, paid_orders: orders } });
  });
  door("post", "/telegram/link", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_telegram", MSG.needOrgTg);
    if (!telegram.ready()) throw new Bad(T.notConfigured, 503);
    const code = `evo_${randCode(20)}`;
    ctx.settings.set("tg.link_code", code);
    ctx.settings.set("tg.link_expires", new Date(Date.now() + LINK_MINUTES * 60000));
    await ctx.settings.save();
    const bot = await telegram.botUsername().catch(fail);
    res.json({ success: true, data: { url: `https://t.me/${bot}?start=${code}`, group_url: `https://t.me/${bot}?startgroup=${code}`, expires_at: ctx.settings.tg.link_expires } });
  });
  door("put", "/telegram", { write: true }, async (ctx, req, res) => {
    const b = req.body || {};
    for (const k of ["daily", "new_orders"]) if (b[k] !== undefined) ctx.settings.set(`tg.${k}`, !!b[k]);
    for (const k of ["remind_day", "remind_hours"]) if (b[k] !== undefined) ctx.settings.set(`guest_tg.${k}`, !!b[k]);
    await ctx.settings.save();
    res.json({ success: true, data: await statusOf(ctx), message: T.saved });
  });
  door("post", "/telegram/test", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_telegram", MSG.needOrgTg);
    if (!ctx.settings.tg?.chat_id) throw new Bad(T.notConnected, 400);
    await telegram.send(ctx.settings.tg.chat_id, `✅ <b>${esc(ctx.settings.org_name || ctx.business.name)}</b>\nTelegram works! New orders will arrive here with Approve / Reject buttons.\nតេឡេក្រាមដំណើរការហើយ!`).catch(fail);
    res.json({ success: true, message: T.sent });
  });
  door("delete", "/telegram", { write: true }, async (ctx, req, res) => {
    for (const k of ["chat_id", "chat_name"]) ctx.settings.set(`tg.${k}`, "");
    ctx.settings.set("tg.connected_at", null);
    await ctx.settings.save();
    res.json({ success: true, data: await statusOf(ctx), message: T.disconnected });
  });

  // ======================================== Start (link a chat) ========================================
  telegram.onStart(async (code, chat) => {
    // the organiser
    if (/^evo_[A-Za-z0-9]{12,40}$/.test(code)) {
      const s = await M.EvSettings.findOne({ "tg.link_code": code, "tg.link_expires": { $gt: new Date() } });
      if (!s) return "⌛️ This link has expired. Open BizHub → Event Tickets → Telegram → Connect again.\nតំណនេះផុតកំណត់ហើយ។";
      s.set("tg.chat_id", String(chat.id));
      s.set("tg.chat_name", chatName(chat));
      s.set("tg.connected_at", new Date());
      s.set("tg.link_code", "");
      s.set("tg.link_expires", null);
      await s.save();
      return `✅ <b>${esc(s.org_name || "Event Tickets")}</b> is connected.\nបានភ្ជាប់ហើយ។\n\n🧾 Each payment screenshot arrives here with ✅ Approve / ❌ Reject buttons.\n📊 The day's summary at 20:00.`;
    }
    // a guest
    if (/^evg_[A-Za-z0-9]{10,40}$/.test(code)) {
      const o = await M.EvOrder.findOne({ "tg.code": code });
      if (!o) return "⌛️ This link doesn't work any more. Open your order page again.\nតំណនេះមិនដំណើរការទេ។";
      const ev = await M.EvEvent.findById(o.event_id).lean();
      o.set("tg.chat_id", String(chat.id));
      o.set("tg.linked_at", new Date());
      await o.save();
      const s = await M.EvSettings.findOne({ business_id: o.business_id }).lean();
      const head = `👋 <b>${esc(ev?.title || "Event")}</b>\n📅 ${when(startOf(ev, o))}${ev?.venue ? `\n📍 ${esc(ev.venue)}` : ""}\n\n`;
      if (o.status === "paid") {
        await sendTickets(o, { ev, s, intro: false }).catch(() => {});
        return `${head}✅ Your tickets are below. Show the QR at the door.\nសំបុត្ររបស់អ្នកនៅខាងក្រោម។`;
      }
      if (["pending", "review"].includes(o.status)) return `${head}⏳ Order #${esc(o.no)} is waiting for the organiser. Your tickets will arrive here as soon as it's approved.\nសំបុត្រនឹងមកដល់ទីនេះពេលអនុម័ត។`;
      return `${head}This order is ${esc(o.status)}.`;
    }
    return null;
  });

  // ======================================== the organiser ========================================
  async function orgChat(businessId) {
    const [s, state] = await Promise.all([M.EvSettings.findOne({ business_id: businessId }), licenseState(businessId)]);
    if (!s?.tg?.chat_id || !state.addons.ev_telegram?.active) return null;
    return { s, state };
  }
  const orderText = (o, ev, s) =>
    [
      `🧾 <b>Order #${esc(o.no)}</b> · ${o.total ? `<b>${usd(o.total)}</b>` : "Free"}${o.promo?.code ? ` (code ${esc(o.promo.code)} −${usd(o.promo.off)})` : ""}`,
      `🎟 ${esc(ev?.title || "")}${o.show ? ` · ${when(startOf(ev, o))}` : ""}`,
      `👤 ${esc(o.buyer?.name)} · ${esc(o.buyer?.phone)}`,
      `🎫 ${(o.lines || []).map((l) => `${l.qty} × ${esc(l.name)}`).join(", ")}`,
      ...(o.seats?.length ? [`💺 ${o.seats.map((id) => esc(X.seatLabel(ev, id) || id)).join(", ")}`] : []),
      ...(o.pay_label ? [`💳 ${esc(o.pay_label)}`] : []),
      ...(o.reference ? [`🔖 Ref: ${esc(o.reference)}`] : []),
      ...(o.note ? [`📝 ${esc(o.note)}`] : []),
      ...(o.answers || []).map((a) => `❓ ${esc(a.label)}: ${esc(a.value)}`),
    ].join("\n");
  hooks.review = async (o) => {
    const c = await orgChat(o.business_id);
    if (!c || c.s.tg.new_orders === false) return;
    const ev = await M.EvEvent.findById(o.event_id).lean();
    const kb = telegram.keyboard([
      [
        { text: "✅ Approve", callback_data: `evo:a:${o._id}` },
        { text: "❌ Reject", callback_data: `evo:r:${o._id}` },
      ],
      [{ text: "Open in BizHub", url: `${siteOf(c.s)}/app/business/${o.business_id}?tab=orders&status=review` }],
    ]);
    const text = `${orderText(o, ev, c.s)}\n\n⏳ Check the money arrived, then press a button.`;
    const msg = o.proof?.url ? await telegram.sendPhoto(c.s.tg.chat_id, o.proof.url, text, kb) : await telegram.send(c.s.tg.chat_id, text, kb);
    await M.EvOrder.updateOne({ _id: o._id }, { $set: { tg_msg: { chat_id: String(c.s.tg.chat_id), id: msg.message_id } } });
  };
  // after Approve / Reject (anywhere): change the organiser's message
  async function markDone(o, line) {
    if (!o.tg_msg?.id) return;
    const ev = await M.EvEvent.findById(o.event_id).lean();
    const text = `${orderText(o, ev)}\n\n${line}`;
    const extra = { reply_markup: { inline_keyboard: [] } };
    await (o.proof?.url ? telegram.editCaption(o.tg_msg.chat_id, o.tg_msg.id, text, extra) : telegram.editText(o.tg_msg.chat_id, o.tg_msg.id, text, extra)).catch(() => {});
  }
  hooks.paid = async (o, { who } = {}) => {
    await markDone(o, `✅ <b>Approved</b>${who ? ` by ${esc(who)}` : ""} — tickets sent.`);
    if (o.tg?.chat_id && !o.tg.tickets_sent) await sendTickets(o).catch(() => {});
  };
  hooks.rejected = async (o, { who } = {}) => {
    await markDone(o, `${o.status === "cancelled" ? "🚫 <b>Cancelled</b>" : "❌ <b>Rejected</b>"}${who ? ` by ${esc(who)}` : ""}${o.reason ? `: ${esc(o.reason)}` : ""}`);
    if (o.tg?.chat_id) {
      const state = await licenseState(o.business_id);
      if (state.addons.ev_guest_tg?.active) await telegram.send(o.tg.chat_id, `${o.status === "cancelled" ? "🚫" : "❌"} Order #${esc(o.no)} was ${o.status === "cancelled" ? "cancelled" : "not approved"}${o.reason ? `: ${esc(o.reason)}` : "."}\nការកម្ម៉ង់មិនត្រូវបានអនុម័តទេ។ សូមទាក់ទងអ្នករៀបចំ។`).catch(() => {});
    }
  };
  // the buttons
  telegram.onCallback(async (data, q) => {
    const m = /^evo:([ar]):([a-f0-9]{24})$/.exec(data);
    if (!m) return null;
    const o = await M.EvOrder.findById(m[2]);
    if (!o) return { toast: "Order not found" };
    const c = await orgChat(o.business_id);
    if (!c || String(q.message?.chat?.id) !== String(c.s.tg.chat_id)) return { toast: "Not allowed", alert: true };
    if (c.state.license.read_only) return { toast: "Event Tickets ended — please renew in BizHub.", alert: true };
    const who = `${[q.from?.first_name, q.from?.last_name].filter(Boolean).join(" ") || q.from?.username || "Telegram"} (Telegram)`.slice(0, 60);
    try {
      if (m[1] === "a") {
        const r = await approve({}, o, who);
        return { toast: `✅ Approved — ${r.tickets.length} ticket(s) made` };
      }
      await reject({}, o, who, "Rejected in Telegram");
      return { toast: "❌ Rejected" };
    } catch (err) {
      if (err instanceof Bad) {
        await markDone(o, `ℹ️ Already ${esc(o.status)}`);
        return { toast: `This order is already ${o.status}` };
      }
      throw err;
    }
  });

  // ======================================== guests ========================================
  // the order page: "Get my tickets on Telegram"
  hooks.view = async (o, ctx) => {
    if (!ctx.addons.ev_guest_tg?.active || !telegram.ready() || !["pending", "review", "paid"].includes(o.status)) return {};
    let code = o.tg?.code;
    if (!code) {
      code = `evg_${randCode(16)}`;
      await M.EvOrder.updateOne({ _id: o._id }, { $set: { "tg.code": code } });
    }
    const bot = await telegram.botUsername().catch(() => "");
    if (!bot) return {};
    return { tg: { linked: !!o.tg?.chat_id, url: `https://t.me/${bot}?start=${code}` } };
  };
  async function sendTickets(o, { ev, s } = {}) {
    ev = ev || (await M.EvEvent.findById(o.event_id).lean());
    s = s || (await M.EvSettings.findOne({ business_id: o.business_id }).lean());
    const state = await licenseState(o.business_id);
    if (!state.addons.ev_guest_tg?.active) return;
    const site = siteOf(s);
    const tickets = await M.EvTicket.find({ order_id: o._id, status: { $ne: "cancelled" } }).sort({ no: 1 }).limit(20).lean();
    for (const t of tickets) {
      const url = `${site}/ev/t/${t.code}`;
      const png = await QRCode.toBuffer(url, { width: 640, margin: 2, errorCorrectionLevel: "M" });
      const cap = [`🎫 <b>${esc(ev.title)}</b>`, `${esc(t.type_name)}${t.seat_label ? ` · 💺 ${esc(t.seat_label)}` : ""}`, `👤 ${esc(t.holder)}`, `📅 ${when(t.show_at || ev.starts_at)}${ev.venue ? ` · 📍 ${esc(ev.venue)}` : ""}`, `<code>${t.code}</code> · ${tickets.length > 1 ? `${t.no}/${tickets.length} · ` : ""}Show this QR at the door`].join("\n");
      await telegram.sendPhoto(o.tg.chat_id, png, cap, telegram.keyboard([[{ text: "Open ticket", url }]]));
    }
    for (const d of ev.docs || []) await (d.kind === "pdf" ? telegram.sendDocument(o.tg.chat_id, d.url, `📄 ${esc(d.name)}`) : telegram.sendPhoto(o.tg.chat_id, d.url, `📄 ${esc(d.name)}`)).catch(() => {});
    await M.EvOrder.updateOne({ _id: o._id }, { $set: { "tg.tickets_sent": true } });
  }
  // everyone with a paid ticket and Telegram linked (one message per chat)
  async function guestChats(ev, show) {
    const orders = await M.EvOrder.find({ event_id: ev._id, status: "paid", "tg.chat_id": { $gt: "" }, ...(show ? { show } : {}) }).select("tg.chat_id").limit(5000).lean();
    return [...new Set(orders.map((o) => o.tg.chat_id))];
  }
  async function toAll(chats, fn) {
    let ok = 0;
    for (let i = 0; i < chats.length; i += 20) {
      const r = await Promise.allSettled(chats.slice(i, i + 20).map(fn));
      ok += r.filter((x) => x.status === "fulfilled").length;
    }
    return ok;
  }
  hooks.broadcast = async (ev, text) => {
    const state = await licenseState(ev.business_id);
    if (!state.addons.ev_guest_tg?.active || !telegram.ready()) return 0;
    return toAll(await guestChats(ev), (chat) => telegram.send(chat, `📢 <b>${esc(ev.title)}</b>\n\n${esc(text)}`));
  };
  hooks.sendDoc = async (ev, d) => {
    const state = await licenseState(ev.business_id);
    if (!state.addons.ev_guest_tg?.active || !telegram.ready()) return 0;
    const cap = `📄 <b>${esc(ev.title)}</b> · ${esc(d.name)}`;
    return toAll(await guestChats(ev), (chat) => (d.kind === "pdf" ? telegram.sendDocument(chat, d.url, cap) : telegram.sendPhoto(chat, d.url, cap)));
  };

  // ======================================== certificates (ev_certs) ========================================
  // one message per paid order: a link to each guest's certificate (checked-in only, or everyone)
  hooks.sendCerts = async (ev, { force = false } = {}) => {
    const state = await licenseState(ev.business_id);
    if (!state.addons.ev_certs?.active || !ev.cert?.on || !telegram.ready()) return 0;
    const s = await M.EvSettings.findOne({ business_id: ev.business_id }).lean();
    const orders = await M.EvOrder.find({ event_id: ev._id, status: "paid", "tg.chat_id": { $gt: "" }, ...(force ? {} : { cert_sent: null }) }).limit(2000).lean();
    let sent = 0;
    for (const o of orders) {
      const q = { order_id: o._id, status: ev.cert.who === "all" ? { $ne: "cancelled" } : "used" };
      const tickets = await M.EvTicket.find(q).sort({ no: 1 }).select("code holder").lean();
      if (!tickets.length) continue;
      await M.EvOrder.updateOne({ _id: o._id }, { $set: { cert_sent: new Date() } });
      const rows = tickets.slice(0, 8).map((t, i) => [{ text: `🎓 ${(t.holder || `Certificate ${i + 1}`).slice(0, 40)}`, url: `${siteOf(s)}/ev/c/${t.code}` }]);
      const text = `🎓 <b>${esc(ev.title)}</b>\n\nThank you for attending! Your certificate is ready — open it, save it as an image or PDF.\nអរគុណសម្រាប់ការចូលរួម! វិញ្ញាបនបត្ររបស់អ្នករួចរាល់ហើយ។`;
      if (await telegram.send(o.tg.chat_id, text, telegram.keyboard(rows)).then(() => true).catch(() => false)) sent += 1;
    }
    return sent;
  };

  // ======================================== scheduler ========================================
  // autopay (KHQR) runs even without Telegram; the rest needs the bot
  async function tick(now = new Date()) {
    const autopay = await Promise.resolve(require("./event.route").autopayTick?.()).catch((err) => ({ error: err.message }));
    const more = await Promise.resolve(require("./event.more").tick?.(now)).catch((err) => ({ error: err.message }));
    if (!telegram.ready()) return { summaries: 0, reminders: 0, certs: 0, autopay, more };
    const r = await tgTick(now);
    // certificates: events that ended in the last 3 days (end time, or 4 h after the start)
    let certs = 0;
    const ended = await M.EvEvent.find({ "cert.on": true, status: { $in: ["published", "closed"] }, starts_at: { $gte: new Date(now.getTime() - 4 * 86400000), $lte: now } }).limit(100).lean();
    for (const ev of ended) {
      const end = new Date(ev.ends_at || new Date(ev.starts_at).getTime() + 4 * 3600000);
      if (end > now || end < new Date(now.getTime() - 3 * 86400000)) continue;
      certs += await hooks.sendCerts(ev).catch(() => 0);
    }
    return { ...r, certs, autopay, more };
  }
  async function tgTick(now) {
    const local = new Date(now.getTime() + TZ * 3600000);
    const hhmm = local.toISOString().slice(11, 16);
    const dayStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TZ * 3600000);
    let summaries = 0;
    let reminders = 0;
    // 1. the organiser's day (after 20:00, once)
    if (hhmm >= "20:00") {
      const list = await M.EvSettings.find({ "tg.chat_id": { $gt: "" }, "tg.daily": { $ne: false }, $or: [{ "tg.last_daily_at": null }, { "tg.last_daily_at": { $lt: dayStart } }] }).limit(200);
      for (const s of list) {
        s.set("tg.last_daily_at", now);
        await s.save();
        const state = await licenseState(s.business_id);
        if (!state.addons.ev_telegram?.active) continue;
        const [paid, waiting, soon] = await Promise.all([
          M.EvOrder.aggregate([{ $match: { business_id: s.business_id, status: "paid", decided_at: { $gte: dayStart } } }, { $group: { _id: null, orders: { $sum: 1 }, tickets: { $sum: "$qty" }, money: { $sum: "$total" } } }]),
          M.EvOrder.countDocuments({ business_id: s.business_id, status: "review" }),
          M.EvEvent.find({ business_id: s.business_id, status: "published", starts_at: { $gte: now, $lte: new Date(now.getTime() + 14 * 86400000) } }).sort({ starts_at: 1 }).limit(5).lean(),
        ]);
        const p = paid[0] || { orders: 0, tickets: 0, money: 0 };
        const lines = [`📊 <b>${esc(s.org_name || "Event Tickets")}</b> · ${local.toISOString().slice(0, 10)}`, "", `🎫 Today: ${p.tickets} ticket(s) · ${p.orders} order(s) · <b>${usd(r2(p.money))}</b>`, `⏳ Waiting for you: ${waiting}`];
        for (const e of soon) {
          const sold = await M.EvTicket.countDocuments({ event_id: e._id, status: { $ne: "cancelled" } });
          lines.push(`• ${esc(e.title)} — ${when(e.starts_at)} · ${sold} sold`);
        }
        if (await telegram.send(s.tg.chat_id, lines.join("\n")).then(() => true).catch(() => false)) summaries += 1;
      }
    }
    // 2. guests: the day before (24 h → 3 h before) and 2 hours before
    const events = await M.EvEvent.find({ status: "published", $or: [{ starts_at: { $gte: now, $lte: new Date(now.getTime() + 26 * 3600000) } }, { shows: { $elemMatch: { starts_at: { $gte: now, $lte: new Date(now.getTime() + 26 * 3600000) } } } }] }).limit(200).lean();
    for (const ev of events) {
      const s = await M.EvSettings.findOne({ business_id: ev.business_id }).lean();
      const state = await licenseState(ev.business_id);
      if (!state.addons.ev_guest_tg?.active) continue;
      const starts = X.hasShows(ev) ? ev.shows.map((sh) => ({ show: sh.key, at: sh.starts_at })) : [{ show: "", at: ev.starts_at }];
      for (const st of starts) {
        const left = new Date(st.at).getTime() - now.getTime();
        if (left <= 0) continue;
        const kind = left <= 2.25 * 3600000 ? (s?.guest_tg?.remind_hours !== false ? "hours" : null) : left <= 24 * 3600000 && left > 3 * 3600000 ? (s?.guest_tg?.remind_day !== false ? "day" : null) : null;
        if (!kind) continue;
        const field = kind === "day" ? "tg.day_sent" : "tg.hours_sent";
        const orders = await M.EvOrder.find({ event_id: ev._id, status: "paid", show: st.show, "tg.chat_id": { $gt: "" }, [field]: null }).limit(300).lean();
        for (const o of orders) {
          await M.EvOrder.updateOne({ _id: o._id }, { $set: { [field]: now } });
          const text = `${kind === "day" ? "⏰ <b>Tomorrow</b>" : "⏰ <b>Starting soon</b>"} · ${esc(ev.title)}\n📅 ${when(st.at)}${ev.venue ? `\n📍 ${esc(ev.venue)}` : ""}${ev.map_url ? `\n🗺 ${esc(ev.map_url)}` : ""}\n\n🎫 ${o.qty} ticket(s) — show the QR at the door.\nកុំភ្លេចយកសំបុត្រ QR មកជាមួយ។`;
          const ok = await telegram
            .send(o.tg.chat_id, text, telegram.keyboard([[{ text: "My tickets", url: `${siteOf(s)}/ev/o/${o.token}` }]]))
            .then(() => true)
            .catch(() => false);
          if (ok) reminders += 1;
        }
      }
    }
    return { summaries, reminders };
  }
  module.exports.tick = tick;
  prop.app.get("/api/cron/event-telegram", async (req, res) => {
    const secret = process.env.CRON_SECRET || "";
    const given = (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || String(req.query.key || "");
    if (!secret || given !== secret) return res.sendStatus(404);
    res.json({ success: true, ...(await tick().catch((err) => ({ error: err.message }))) });
  });
  hooks.sendTickets = sendTickets;
};
