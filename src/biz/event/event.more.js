// Event Tickets — growth + care features:
//   waitlist (ev_waitlist) · promoters / referral links (ev_referrals) · duplicate an event · refunds + transfers
//   · search + all-events report · "my tickets" (device list + Telegram /mytickets) · feedback (ev_feedback)
//   · add to calendar (.ics) · sponsors (ev_sponsors) · public "Events in Cambodia" page + featured events (ev_feature)
const telegram = require("../../telegram");
const { rate_limit } = require("../../util/rate_limit");
const { buy } = require("../../license/license.service");

const MSG = {
  slow: "សូមរង់ចាំបន្តិច! / Too many tries, wait a little.",
  notFound: "រកមិនឃើញ! / Not found.",
  needPhone: "សូមបញ្ចូលលេខទូរស័ព្ទត្រឹមត្រូវ! / Enter a valid phone number.",
  needName: "សូមបញ្ចូលឈ្មោះ! / Enter a name.",
  already: "អ្នកមានក្នុងបញ្ជីរង់ចាំរួចហើយ! / You're already on the waitlist.",
  notSoldOut: "នៅមានសំបុត្រ — អាចទិញបានឥឡូវ! / Tickets are still on sale — buy now.",
  badCode: "លេខកូដត្រូវមាន 3-24 អក្សរ (A-Z 0-9)! / The code needs 3–24 letters or numbers.",
  codeTaken: "លេខកូដនេះមានរួចហើយ! / This code already exists.",
  notPaid: "តែការកម្ម៉ង់ដែលបានបង់ប៉ុណ្ណោះ! / Only for paid orders.",
  tooManyReq: "អ្នកមានសំណើកំពុងរង់ចាំហើយ! / You already have a request waiting.",
  pickTickets: "សូមជ្រើសសំបុត្រ! / Pick the tickets.",
  ticketUsed: "សំបុត្រនេះបានប្រើរួចហើយ! / This ticket was already used.",
  done: "រួចរាល់! / Done.",
  saved: "បានរក្សាទុក! / Saved.",
  deleted: "បានលុប! / Deleted.",
  noFile: "សូមជ្រើសរូបភាព! / Choose a picture.",
  tooManySponsors: "អ្នកឧបត្ថម្ភបានច្រើនបំផុត 12! / Up to 12 sponsors.",
  feedbackClosed: "មិនទាន់អាចផ្តល់មតិបានទេ (ក្រោយកម្មវិធីចាប់ផ្តើម)! / Feedback opens once the event starts.",
  badRating: "សូមជ្រើសផ្កាយ 1–5! / Pick 1–5 stars.",
  notPublished: "សូមផ្សព្វផ្សាយកម្មវិធីជាមុនសិន! / Publish the event first.",
};
const DEFAULT_SITE = "https://bizhub-cambodia.web.app";
const CATEGORIES = ["music", "workshop", "seminar", "sport", "party", "festival", "food", "art", "business", "kids", "religion", "other"];

module.exports = (prop, kit) => {
  const { M, X, Bad, handle, door, need, hooks, licenseState, settingsOf, openBiz, openEvent, publicEvent, buyerOrder, eventOf, ticketOf, eventOut, orderOut, ticketOut, saleState, countsOf, freeSlug, giveBack, uploadBuffer, deleteFile, withFile, phoneOf, httpsLink, str, int, r2, randCode, token, validId, escRe, priceNow, TZ, Business, License, statusOf } = kit;
  const pub = (path) => `/api/public/ev${path}`;
  const esc = telegram.escape;
  const usd = (n) => `$${Number(n || 0).toFixed(2).replace(/\.00$/, "")}`;
  const when = (d) => (d ? new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 16).replace("T", " ") : "");
  const siteOf = (s) => String(s?.web || process.env.WEB_URL || DEFAULT_SITE).replace(/\/+$/, "");
  const endOf = (ev) => new Date(ev.ends_at || new Date(ev.starts_at).getTime() + 4 * 3600000);
  const tgOk = () => telegram.ready();
  const linkOf = (v) => {
    const t = str(v, 300);
    if (!t) return "";
    return httpsLink(/^https?:\/\//i.test(t) ? t : `https://${t}`) || "";
  };
  const smallLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 30, message: MSG.slow });
  const clickLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 60, message: MSG.slow });
  const tell = (chat, text, kb) => (tgOk() && chat ? telegram.send(chat, text, kb ? telegram.keyboard(kb) : undefined).then(() => true).catch(() => false) : Promise.resolve(false));

  // ============================================ 1. waitlist (ev_waitlist) ============================================
  // tickets left right now, per type ("" show = no showtimes)
  async function leftOf(ev, show) {
    if (show) return (await X.showLeft(ev))[show] || {};
    return Object.fromEntries(ev.types.filter((t) => t.active !== false).map((t) => [t.key, Math.max(0, t.qty - (t.taken || 0))]));
  }
  const waitOut = (w) => ({ _id: w._id, name: w.name, phone: w.phone, qty: w.qty, type_key: w.type_key, show: w.show, status: w.status, told_at: w.told_at, tg: !!w.tg?.chat_id, created_date: w.created_date });
  prop.app.post(
    pub("/e/:slug/waitlist"),
    smallLimit,
    handle(async (req, res) => {
      const ctx = await openEvent(req.params.slug);
      if (!ctx.addons.ev_waitlist?.active) throw new Bad(MSG.notFound, 404);
      const ev = ctx.ev;
      const b = req.body || {};
      const name = str(b.name, 80);
      if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
      const phone = phoneOf(b.phone);
      if (!phone) throw new Bad(MSG.needPhone, 400, { code: "bad_phone" });
      const show = X.hasShows(ev) ? str(b.show, 20) : "";
      const typeKey = ev.types.some((t) => t.key === b.type_key) ? b.type_key : "";
      const left = await leftOf(ev, show);
      const free = typeKey ? left[typeKey] || 0 : Object.values(left).reduce((a, n) => a + n, 0);
      if (free > 0 && saleState(ev) === "open") throw new Bad(MSG.notSoldOut, 409, { code: "not_sold_out" });
      if (await M.EvWait.exists({ event_id: ev._id, phone, status: { $in: ["waiting", "told"] } })) throw new Bad(MSG.already, 409, { code: "already" });
      const w = await M.EvWait.create({ business_id: ev.business_id, event_id: ev._id, type_key: typeKey, show, name, phone, qty: int(b.qty, 1, 10, 1), token: token(20), tg: { code: tgOk() ? `evw_${randCode(16)}` : "" } });
      const bot = tgOk() ? await telegram.botUsername().catch(() => "") : "";
      const ahead = await M.EvWait.countDocuments({ event_id: ev._id, status: "waiting", created_date: { $lt: w.created_date } });
      res.status(201).json({ success: true, data: { token: w.token, ahead, tg_url: bot ? `https://t.me/${bot}?start=${w.tg.code}` : "" } });
    }),
  );
  prop.app.get(
    pub("/w/:token"),
    handle(async (req, res) => {
      const w = await M.EvWait.findOne({ token: str(req.params.token, 40) }).lean();
      if (!w) throw new Bad(MSG.notFound, 404);
      const ahead = w.status === "waiting" ? await M.EvWait.countDocuments({ event_id: w.event_id, status: "waiting", created_date: { $lt: w.created_date } }) : 0;
      const bot = tgOk() && w.tg?.code ? await telegram.botUsername().catch(() => "") : "";
      res.json({ success: true, data: { status: w.status, ahead, tg_linked: !!w.tg?.chat_id, tg_url: bot && !w.tg?.chat_id ? `https://t.me/${bot}?start=${w.tg.code}` : "" } });
    }),
  );
  prop.app.delete(
    pub("/w/:token"),
    handle(async (req, res) => {
      await M.EvWait.updateOne({ token: str(req.params.token, 40), status: { $in: ["waiting", "told"] } }, { $set: { status: "left" } });
      res.json({ success: true, message: MSG.done });
    }),
  );
  // tickets came back (expired / rejected / cancelled): tell the next people on the list
  const busy = new Set();
  async function offer(eventId, { force = 0 } = {}) {
    const key = String(eventId);
    if (busy.has(key)) return 0;
    busy.add(key);
    try {
      const ev = await M.EvEvent.findById(eventId);
      if (!ev || ev.status !== "published" || saleState(ev) !== "open") return 0;
      const state = await licenseState(ev.business_id);
      if (!state.addons.ev_waitlist?.active) return 0;
      const waiting = await M.EvWait.find({ event_id: ev._id, status: "waiting" }).sort({ created_date: 1 }).limit(200);
      if (!waiting.length) return 0;
      const s = await M.EvSettings.findOne({ business_id: ev.business_id }).lean();
      const cache = {};
      let told = 0;
      for (const w of waiting) {
        cache[w.show] = cache[w.show] || (await leftOf(ev, w.show));
        const left = cache[w.show];
        const free = w.type_key ? left[w.type_key] || 0 : Object.values(left).reduce((a, n) => a + n, 0);
        if (free <= 0 && !force) continue;
        if (force && told >= force) break;
        // "kept" tickets: count what we told against what is free (don't tell 50 people about 1 ticket)
        if (w.type_key) left[w.type_key] = Math.max(0, (left[w.type_key] || 0) - w.qty);
        else {
          let need_ = w.qty;
          for (const k of Object.keys(left)) {
            const n = Math.min(left[k], need_);
            left[k] -= n;
            need_ -= n;
          }
        }
        w.status = "told";
        w.told_at = new Date();
        await w.save();
        told += 1;
        await tell(w.tg?.chat_id, `🎉 <b>Tickets are back!</b>\n🎟 ${esc(ev.title)}\n📅 ${when(ev.starts_at)}\n\nBe quick — first come, first served.\nមានសំបុត្រវិញហើយ! សូមទិញឱ្យលឿន។`, [[{ text: "Buy now", url: `${siteOf(s)}/ev/${ev.slug}` }]]);
      }
      return told;
    } finally {
      busy.delete(key);
    }
  }
  hooks.freed = (eventId) => offer(eventId);
  door("get", "/events/:eid/waitlist", {}, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    const list = await M.EvWait.find({ event_id: ev._id, status: { $ne: "left" } }).sort({ created_date: 1 }).limit(2000).lean();
    // bought = an order with the same phone after joining
    const phones = [...new Set(list.map((w) => w.phone))];
    const orders = phones.length ? await M.EvOrder.find({ event_id: ev._id, status: "paid", "buyer.phone": { $in: phones } }).select("buyer.phone created_date").lean() : [];
    for (const w of list) if (w.status !== "bought" && orders.some((o) => o.buyer.phone === w.phone && o.created_date > w.created_date)) w.status = "bought";
    const left = await leftOf(ev, "");
    res.json({ success: true, data: { list: list.map(waitOut), counts: { waiting: list.filter((w) => w.status === "waiting").length, told: list.filter((w) => w.status === "told").length, bought: list.filter((w) => w.status === "bought").length }, left } });
  });
  door("post", "/events/:eid/waitlist/notify", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_waitlist", MSG.notFound);
    const ev = await eventOf(ctx, req.params.eid);
    const n = await offer(ev._id, { force: int(req.body?.n, 1, 200, 10) });
    res.json({ success: true, told: n, message: MSG.done });
  });
  door("delete", "/waitlist/:wid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.wid)) throw new Bad(MSG.notFound, 404);
    await M.EvWait.updateOne({ _id: req.params.wid, business_id: ctx.business._id }, { $set: { status: "left" } });
    res.json({ success: true, message: MSG.deleted });
  });

  // ============================================ 2. promoters (ev_referrals) ============================================
  const refCode = (v) => {
    const c = str(v, 24).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (c.length < 3) throw new Bad(MSG.badCode, 400, { code: "bad_code" });
    return c;
  };
  const commissionOf = (r, o) => r2(r.commission?.kind === "amount" ? (r.commission.value || 0) * (o.qty || 0) : ((o.total || 0) * (r.commission?.value || 0)) / 100);
  async function refList(ctx) {
    const refs = await M.EvRef.find({ business_id: ctx.business._id }).sort({ created_date: -1 }).lean();
    const orders = await M.EvOrder.find({ business_id: ctx.business._id, status: "paid", ref: { $gt: "" } }).select("ref qty total event_id").lean();
    const evIds = [...new Set(refs.filter((r) => r.event_id).map((r) => String(r.event_id)))];
    const evs = evIds.length ? Object.fromEntries((await M.EvEvent.find({ _id: { $in: evIds } }).select("title slug").lean()).map((e) => [String(e._id), e])) : {};
    return refs.map((r) => {
      const mine = orders.filter((o) => o.ref === r.code);
      const earned = r2(mine.reduce((a, o) => a + commissionOf(r, o), 0));
      return { _id: r._id, code: r.code, name: r.name, phone: r.phone, event_id: r.event_id, event: r.event_id ? evs[String(r.event_id)] || null : null, commission: r.commission, clicks: r.clicks || 0, active: r.active, orders: mine.length, tickets: mine.reduce((a, o) => a + (o.qty || 0), 0), money: r2(mine.reduce((a, o) => a + (o.total || 0), 0)), earned, paid_out: r2(r.paid_out || 0), owed: r2(Math.max(0, earned - (r.paid_out || 0))), created_date: r.created_date };
    });
  }
  function refBody(b, ctx) {
    const set = {};
    if (b.name !== undefined) set.name = str(b.name, 60);
    if (b.phone !== undefined) set.phone = phoneOf(b.phone) || "";
    if (b.event_id !== undefined) set.event_id = b.event_id && validId(b.event_id) ? b.event_id : null;
    if (b.commission !== undefined) set.commission = { kind: b.commission?.kind === "amount" ? "amount" : "percent", value: Math.max(0, Math.min(b.commission?.kind === "amount" ? 100000 : 100, Number(b.commission?.value) || 0)) };
    if (b.active !== undefined) set.active = !!b.active;
    return set;
  }
  door("get", "/refs", {}, async (ctx, req, res) => res.json({ success: true, data: await refList(ctx) }));
  door("post", "/refs", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_referrals", MSG.notFound);
    const b = req.body || {};
    const code = refCode(b.code || `${str(b.name, 20)}${randCode(3)}`);
    if (await M.EvRef.exists({ business_id: ctx.business._id, code })) throw new Bad(MSG.codeTaken, 409, { code: "taken" });
    if ((await M.EvRef.countDocuments({ business_id: ctx.business._id })) >= 300) throw new Bad(MSG.slow, 400);
    await M.EvRef.create({ business_id: ctx.business._id, code, ...refBody(b, ctx), name: str(b.name, 60) || code });
    res.status(201).json({ success: true, data: await refList(ctx), message: MSG.saved });
  });
  door("put", "/refs/:rid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.rid)) throw new Bad(MSG.notFound, 404);
    await M.EvRef.updateOne({ _id: req.params.rid, business_id: ctx.business._id }, { $set: refBody(req.body || {}, ctx) });
    res.json({ success: true, data: await refList(ctx), message: MSG.saved });
  });
  door("post", "/refs/:rid/payout", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.rid)) throw new Bad(MSG.notFound, 404);
    const amount = r2(Math.max(0, Number(req.body?.amount) || 0));
    await M.EvRef.updateOne({ _id: req.params.rid, business_id: ctx.business._id }, { $inc: { paid_out: amount } });
    res.json({ success: true, data: await refList(ctx), message: MSG.saved });
  });
  door("delete", "/refs/:rid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.rid)) throw new Bad(MSG.notFound, 404);
    await M.EvRef.deleteOne({ _id: req.params.rid, business_id: ctx.business._id });
    res.json({ success: true, data: await refList(ctx), message: MSG.deleted });
  });
  // a visit through a promoter's link
  prop.app.post(
    pub("/e/:slug/ref"),
    clickLimit,
    handle(async (req, res) => {
      const ev = await M.EvEvent.findOne({ slug: str(req.params.slug, 80).toLowerCase() }).select("business_id").lean();
      const code = str(req.body?.code, 24).toUpperCase();
      if (ev && code) await M.EvRef.updateOne({ business_id: ev.business_id, code, active: true }, { $inc: { clicks: 1 } });
      res.json({ success: true });
    }),
  );

  // ============================================ 3. duplicate an event ============================================
  door("post", "/events/:eid/duplicate", { write: true }, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    const src = ev.toObject();
    const shift = Number(req.body?.days) ? int(req.body.days, -3650, 3650, 0) * 86400000 : 0;
    const move = (d) => (d ? new Date(new Date(d).getTime() + shift) : d);
    const title = str(req.body?.title, 120) || `${src.title} (copy)`.slice(0, 120);
    const copy = {
      ...src,
      _id: undefined,
      title,
      slug: await freeSlug(title),
      status: "draft",
      starts_at: move(src.starts_at),
      ends_at: move(src.ends_at),
      sale_ends_at: move(src.sale_ends_at),
      types: (src.types || []).map((t) => ({ ...t, taken: 0, tiers: (t.tiers || []).map((x) => ({ ...x, until: move(x.until) })) })),
      shows: (src.shows || []).map((s) => ({ ...s, starts_at: move(s.starts_at), ends_at: move(s.ends_at) })),
      updates: [],
      docs: [],
      featured_until: null,
      poster: { url: src.poster?.url || "", public_id: "" }, // shared picture: never deleted with the copy
      cert: src.cert ? { ...src.cert, signature: { url: src.cert.signature?.url || "", public_id: "" } } : undefined,
      sponsors: (src.sponsors || []).map((x) => ({ ...x, logo: { url: x.logo?.url || "", public_id: "" } })),
      created_date: undefined,
      updated_date: undefined,
    };
    delete copy.__v;
    const made = await M.EvEvent.create(copy);
    res.status(201).json({ success: true, data: { ...eventOut(made), sale: saleState(made) }, message: MSG.saved });
  });

  // ============================================ 4. refunds + transfers ============================================
  // give one ticket back to the stock (and its seat)
  async function freeTicket(t) {
    if (t.seat) await M.EvSeat.deleteOne({ event_id: t.event_id, show: t.show || "", seat: t.seat });
    if (t.show) await X.giveShow(t.event_id, t.show, [{ key: t.type_key, qty: 1 }]);
    else await M.EvEvent.updateOne({ _id: t.event_id }, { $inc: { "types.$[t].taken": -1 } }, { arrayFilters: [{ "t.key": t.type_key }] });
    hooks.freed(t.event_id).catch(() => {});
  }
  // a new holder: a new code (the old QR stops working)
  async function transferTicket(t, name, phone, by) {
    for (let i = 0; i < 3; i += 1) {
      try {
        t.transfers.push({ from: t.holder, to: name, phone, at: new Date(), by });
        t.holder = name;
        t.code = randCode(10);
        await t.save();
        return t;
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
    }
    throw new Bad(MSG.slow, 409);
  }
  prop.app.post(
    pub("/o/:token/request"),
    smallLimit,
    handle(async (req, res) => {
      const o = await buyerOrder(req.params.token);
      if (o.status !== "paid") throw new Bad(MSG.notPaid, 409, { code: "not_paid" });
      if ((o.requests || []).some((q) => q.status === "open")) throw new Bad(MSG.tooManyReq, 409, { code: "open" });
      const b = req.body || {};
      const kind = b.kind === "transfer" ? "transfer" : "refund";
      const mine = await M.EvTicket.find({ order_id: o._id, status: "valid" }).select("code").lean();
      const codes = (Array.isArray(b.tickets) ? b.tickets : []).map(String).filter((c) => mine.some((t) => t.code === c));
      if (!codes.length) throw new Bad(MSG.pickTickets, 400, { code: "pick" });
      const q = { kind, tickets: codes, note: str(b.note, 300) };
      if (kind === "transfer") {
        q.to_name = str(b.to_name, 80);
        if (!q.to_name) throw new Bad(MSG.needName, 400, { code: "need_name" });
        q.to_phone = phoneOf(b.to_phone) || "";
      }
      o.requests.push(q);
      await o.save();
      // the organiser on Telegram (if connected)
      const s = await M.EvSettings.findOne({ business_id: o.business_id }).lean();
      const state = await licenseState(o.business_id);
      if (s?.tg?.chat_id && state.addons.ev_telegram?.active) {
        const ev = await M.EvEvent.findById(o.event_id).select("title").lean();
        await tell(s.tg.chat_id, `${kind === "refund" ? "↩️ <b>Refund asked</b>" : "🔁 <b>Transfer asked</b>"} · Order #${esc(o.no)}\n🎟 ${esc(ev?.title || "")}\n👤 ${esc(o.buyer?.name)} · ${esc(o.buyer?.phone)}\n🎫 ${codes.length} ticket(s)${q.to_name ? `\n➡️ ${esc(q.to_name)} ${esc(q.to_phone || "")}` : ""}${q.note ? `\n📝 ${esc(q.note)}` : ""}\n\nOpen BizHub → Orders → Requests.`);
      }
      res.status(201).json({ success: true, data: { requests: orderOut(o).requests }, message: MSG.done });
    }),
  );
  door("get", "/requests", {}, async (ctx, req, res) => {
    const st = ["open", "done", "declined"].includes(req.query.status) ? req.query.status : "open";
    const orders = await M.EvOrder.find({ business_id: ctx.business._id, "requests.status": st }).sort({ updated_date: -1 }).limit(300).lean();
    const evs = Object.fromEntries((await M.EvEvent.find({ _id: { $in: [...new Set(orders.map((o) => String(o.event_id)))] } }).select("title starts_at").lean()).map((e) => [String(e._id), e]));
    const codes = orders.flatMap((o) => o.requests.flatMap((q) => q.tickets));
    const tix = Object.fromEntries((await M.EvTicket.find({ order_id: { $in: orders.map((o) => o._id) } }).select("code holder type_name price status seat_label").lean()).map((t) => [t.code, t]));
    const rows = [];
    for (const o of orders)
      for (const q of o.requests)
        if (q.status === st) rows.push({ order: orderOut(o), event: evs[String(o.event_id)] || null, request: orderOut({ requests: [q] }).requests[0], tickets: q.tickets.map((c) => tix[c] || { code: c }) });
    rows.sort((a, b) => new Date(b.request.at) - new Date(a.request.at));
    res.json({ success: true, data: rows, open: await M.EvOrder.countDocuments({ business_id: ctx.business._id, "requests.status": "open" }) });
  });
  door("post", "/orders/:oid/requests/:rid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.oid)) throw new Bad(MSG.notFound, 404);
    const o = await M.EvOrder.findOne({ _id: req.params.oid, business_id: ctx.business._id });
    const q = o?.requests.id(req.params.rid);
    if (!q || q.status !== "open") throw new Bad(MSG.notFound, 404);
    const b = req.body || {};
    q.reply = str(b.reply, 200);
    q.decided_at = new Date();
    q.decided_by = ctx.who;
    let note = "";
    if (b.ok) {
      const tickets = await M.EvTicket.find({ order_id: o._id, code: { $in: q.tickets } });
      if (q.kind === "refund") {
        let back = 0;
        for (const t of tickets) {
          if (t.status === "cancelled") continue;
          if (t.status === "used" && !b.force) throw new Bad(MSG.ticketUsed, 409, { code: "used", ticket: t.code });
          t.status = "cancelled";
          await t.save();
          await freeTicket(t);
          back += t.price || 0;
        }
        const amount = b.amount !== undefined ? r2(Math.max(0, Number(b.amount) || 0)) : r2(Math.min(back, o.total - (o.refunded || 0)));
        o.refunded = r2((o.refunded || 0) + amount);
        note = `↩️ Refund approved: ${usd(amount)}. The organiser sends the money back to you.\nការសងប្រាក់ត្រូវបានអនុម័ត។`;
      } else {
        const s = await M.EvSettings.findOne({ business_id: o.business_id }).lean();
        const links = [];
        for (const t of tickets) {
          if (t.status !== "valid") continue;
          await transferTicket(t, q.to_name, q.to_phone, ctx.who);
          links.push(`${siteOf(s)}/ev/t/${t.code}`);
        }
        q.tickets = tickets.map((t) => t.code);
        note = `🔁 Transfer done: ${links.length} ticket(s) now belong to ${esc(q.to_name)}. The old QR no longer works — send them these links:\n${links.join("\n")}`;
      }
      q.status = "done";
    } else {
      q.status = "declined";
      note = `❌ Your ${q.kind} request was declined.${q.reply ? `\n${esc(q.reply)}` : ""}`;
    }
    o.markModified("requests");
    await o.save();
    if (o.tg?.chat_id) await tell(o.tg.chat_id, `${note}${q.reply && b.ok ? `\n\n📝 ${esc(q.reply)}` : ""}`);
    res.json({ success: true, data: orderOut(o), message: MSG.done });
  });
  // the organiser gives a ticket to someone else directly
  door("post", "/tickets/:tid/transfer", { write: true }, async (ctx, req, res) => {
    const t = await ticketOf(ctx, req.params.tid);
    if (t.status !== "valid") throw new Bad(MSG.ticketUsed, 409, { code: "not_valid" });
    const name = str(req.body?.name, 80);
    if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
    await transferTicket(t, name, phoneOf(req.body?.phone) || "", ctx.who);
    res.json({ success: true, data: ticketOut(t), message: MSG.done });
  });

  // ============================================ 5. search + the all-events report ============================================
  door("get", "/event-search", {}, async (ctx, req, res) => {
    const q = { business_id: ctx.business._id };
    const s = str(req.query.q, 80);
    if (s) q.$or = [{ title: new RegExp(escRe(s), "i") }, { venue: new RegExp(escRe(s), "i") }, { slug: new RegExp(escRe(s), "i") }];
    const now = new Date();
    const ph = String(req.query.phase || "");
    if (ph === "draft" || ph === "cancelled") q.status = ph;
    else if (ph === "active") Object.assign(q, { status: { $in: ["published", "closed"] }, starts_at: { $gte: new Date(now.getTime() - 86400000) } });
    else if (ph === "past") Object.assign(q, { status: { $in: ["published", "closed"] }, starts_at: { $lt: now } });
    if (["paid", "free"].includes(req.query.kind)) q.kind = req.query.kind;
    if (req.query.from || req.query.to) q.starts_at = { ...(q.starts_at || {}), ...(req.query.from ? { $gte: new Date(req.query.from) } : {}), ...(req.query.to ? { $lte: new Date(req.query.to) } : {}) };
    const sort = { soon: { starts_at: 1 }, latest: { starts_at: -1 }, az: { title: 1 }, created: { created_date: -1 } }[req.query.sort] || { starts_at: -1 };
    const page = int(req.query.page, 1, 10000, 1);
    const size = int(req.query.size, 1, 100, 24);
    const [total, rows] = await Promise.all([M.EvEvent.countDocuments(q), M.EvEvent.find(q).sort(sort).skip((page - 1) * size).limit(size).lean()]);
    const counts = await countsOf(ctx.business._id, rows.map((e) => e._id));
    res.json({ success: true, data: rows.map((e) => ({ ...eventOut(e), sale: saleState(e), counts: counts[String(e._id)] })), total, page, pages: Math.ceil(total / size) });
  });
  door("get", "/report/overview", {}, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const months = int(req.query.months, 1, 36, 12);
    const since = new Date();
    since.setMonth(since.getMonth() - months + 1, 1);
    since.setHours(0, 0, 0, 0);
    const paid = { business_id: bid, status: "paid", decided_at: { $gte: since } };
    const [perMonth, topEvents, byPay, byVia, fb, refunds] = await Promise.all([
      M.EvOrder.aggregate([{ $match: paid }, { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$decided_at", timezone: "+07:00" } }, orders: { $sum: 1 }, tickets: { $sum: "$qty" }, money: { $sum: "$total" } } }, { $sort: { _id: 1 } }]),
      M.EvOrder.aggregate([{ $match: paid }, { $group: { _id: "$event_id", orders: { $sum: 1 }, tickets: { $sum: "$qty" }, money: { $sum: "$total" } } }, { $sort: { money: -1, tickets: -1 } }, { $limit: 10 }]),
      M.EvOrder.aggregate([{ $match: { ...paid, via: "online", total: { $gt: 0 } } }, { $group: { _id: { $ifNull: ["$pay_label", ""] }, orders: { $sum: 1 }, money: { $sum: "$total" } } }, { $sort: { money: -1 } }, { $limit: 8 }]),
      M.EvOrder.aggregate([{ $match: paid }, { $group: { _id: "$via", orders: { $sum: 1 }, tickets: { $sum: "$qty" }, money: { $sum: "$total" } } }]),
      M.EvFeedback.aggregate([{ $match: { business_id: bid, created_date: { $gte: since } } }, { $group: { _id: null, n: { $sum: 1 }, avg: { $avg: "$rating" } } }]),
      M.EvOrder.aggregate([{ $match: { business_id: bid, refunded: { $gt: 0 }, decided_at: { $gte: since } } }, { $group: { _id: null, money: { $sum: "$refunded" } } }]),
    ]);
    const evs = Object.fromEntries((await M.EvEvent.find({ _id: { $in: topEvents.map((t) => t._id) } }).select("title starts_at status").lean()).map((e) => [String(e._id), e]));
    const used = await M.EvTicket.countDocuments({ business_id: bid, status: "used", used_at: { $gte: since } });
    // every month, also the empty ones
    const series = [];
    const d = new Date(since);
    for (let i = 0; i < months; i += 1) {
      const key = new Date(d.getTime() + TZ * 3600000).toISOString().slice(0, 7);
      const r = perMonth.find((x) => x._id === key) || {};
      series.push({ month: key, orders: r.orders || 0, tickets: r.tickets || 0, money: r2(r.money || 0) });
      d.setMonth(d.getMonth() + 1);
    }
    const tot = (k) => series.reduce((a, x) => a + x[k], 0);
    res.json({
      success: true,
      data: {
        since,
        series,
        totals: { orders: tot("orders"), tickets: tot("tickets"), money: r2(tot("money")), used, refunded: r2(refunds[0]?.money || 0), events: await M.EvEvent.countDocuments({ business_id: bid, starts_at: { $gte: since } }) },
        top: topEvents.map((t) => ({ event: evs[String(t._id)] ? { _id: t._id, ...evs[String(t._id)] } : { _id: t._id, title: "—" }, orders: t.orders, tickets: t.tickets, money: r2(t.money) })),
        pay: byPay.map((p) => ({ label: p._id || "—", orders: p.orders, money: r2(p.money) })),
        via: byVia.map((v) => ({ via: v._id, orders: v.orders, tickets: v.tickets, money: r2(v.money) })),
        feedback: { n: fb[0]?.n || 0, avg: fb[0]?.avg ? Math.round(fb[0].avg * 10) / 10 : null },
      },
    });
  });

  // ============================================ 6. my tickets ============================================
  // the tickets this phone / browser bought (the order links it keeps) — no account needed
  prop.app.post(
    pub("/my"),
    clickLimit,
    handle(async (req, res) => {
      const tokens = (Array.isArray(req.body?.tokens) ? req.body.tokens : []).map((t) => str(t, 40)).filter(Boolean).slice(0, 60);
      const orders = tokens.length ? await M.EvOrder.find({ token: { $in: tokens } }).lean() : [];
      const evs = Object.fromEntries((await M.EvEvent.find({ _id: { $in: [...new Set(orders.map((o) => String(o.event_id)))] } }).lean()).map((e) => [String(e._id), e]));
      const rows = orders
        .map((o) => {
          const e = evs[String(o.event_id)];
          if (!e) return null;
          const at = (o.show ? X.showOf(e, o.show)?.starts_at : null) || e.starts_at;
          return { token: o.token, no: o.no, status: o.status, qty: o.qty, total: o.total, event: { title: e.title, slug: e.slug, starts_at: at, ends_at: e.ends_at, venue: e.venue, poster: e.poster?.url || "", status: e.status } };
        })
        .filter(Boolean)
        .sort((a, b) => new Date(a.event.starts_at) - new Date(b.event.starts_at));
      res.set("Cache-Control", "no-store");
      res.json({ success: true, data: rows });
    }),
  );
  // Telegram: /mytickets → every upcoming ticket linked to this chat
  telegram.onCommand(async (cmd, chat) => {
    if (!["mytickets", "tickets", "my"].includes(cmd)) return null;
    const orders = await M.EvOrder.find({ "tg.chat_id": String(chat.id), status: "paid" }).sort({ created_date: -1 }).limit(40).lean();
    if (!orders.length) return "🎫 No tickets linked to this chat yet. Open your order page and press “Get my tickets on Telegram”.\nមិនទាន់មានសំបុត្រភ្ជាប់ទេ។";
    const evs = Object.fromEntries((await M.EvEvent.find({ _id: { $in: orders.map((o) => o.event_id) } }).lean()).map((e) => [String(e._id), e]));
    const s = await M.EvSettings.findOne({ business_id: orders[0].business_id }).lean();
    const soon = orders.filter((o) => evs[String(o.event_id)] && endOf(evs[String(o.event_id)]) > new Date());
    const list = (soon.length ? soon : orders.slice(0, 5)).slice(0, 10);
    return {
      text: `🎫 <b>${soon.length ? "Your upcoming tickets" : "Your last tickets"}</b>\n\n${list.map((o) => { const e = evs[String(o.event_id)]; return `• <b>${esc(e?.title || "")}</b>\n  📅 ${when((o.show ? X.showOf(e, o.show)?.starts_at : null) || e?.starts_at)} · ${o.qty} ticket(s)`; }).join("\n")}`,
      extra: telegram.keyboard(list.map((o) => [{ text: `🎫 ${String(evs[String(o.event_id)]?.title || "Tickets").slice(0, 40)}`, url: `${siteOf(s)}/ev/o/${o.token}` }])),
    };
  });

  // ============================================ 7. feedback (ev_feedback) ============================================
  async function feedbackCtx(tok) {
    const o = await buyerOrder(tok);
    const ev = await M.EvEvent.findById(o.event_id).lean();
    const state = await licenseState(o.business_id);
    if (!ev || !state.addons.ev_feedback?.active || !ev.feedback?.on) throw new Bad(MSG.notFound, 404, { code: "off" });
    return { o, ev };
  }
  prop.app.get(
    pub("/f/:token"),
    handle(async (req, res) => {
      const { o, ev } = await feedbackCtx(req.params.token);
      const mine = await M.EvFeedback.findOne({ order_id: o._id }).lean();
      const s = await M.EvSettings.findOne({ business_id: o.business_id }).lean();
      res.json({ success: true, data: { open: o.status === "paid" && new Date(ev.starts_at) <= new Date(), event: { title: ev.title, starts_at: ev.starts_at, venue: ev.venue, poster: ev.poster?.url || "", slug: ev.slug }, org: { name: s?.org_name || "", logo: s?.logo?.url || "" }, question: ev.feedback.question || "", mine: mine ? { rating: mine.rating, answer: mine.answer, comment: mine.comment } : null, name: o.buyer?.name || "" } });
    }),
  );
  async function saveFeedback(o, ev, b) {
    const rating = int(b.rating, 1, 5, 0);
    if (!rating) throw new Bad(MSG.badRating, 400, { code: "rating" });
    const set = { business_id: o.business_id, event_id: o.event_id, order_id: o._id, name: o.buyer?.name || "", rating };
    if (b.answer !== undefined) set.answer = str(b.answer, 500);
    if (b.comment !== undefined) set.comment = str(b.comment, 1000);
    await M.EvFeedback.updateOne({ order_id: o._id }, { $set: set }, { upsert: true });
  }
  prop.app.post(
    pub("/f/:token"),
    smallLimit,
    handle(async (req, res) => {
      const { o, ev } = await feedbackCtx(req.params.token);
      if (o.status !== "paid" || new Date(ev.starts_at) > new Date()) throw new Bad(MSG.feedbackClosed, 409, { code: "closed" });
      await saveFeedback(o, ev, req.body || {});
      res.json({ success: true, message: MSG.done });
    }),
  );
  // ⭐ buttons in Telegram
  telegram.onCallback(async (data) => {
    const m = /^evf:([a-f0-9]{24}):([1-5])$/.exec(data);
    if (!m) return null;
    const o = await M.EvOrder.findById(m[1]).lean();
    const ev = o && (await M.EvEvent.findById(o.event_id).lean());
    if (!o || !ev?.feedback?.on) return { toast: "⌛️" };
    await saveFeedback(o, ev, { rating: m[2] });
    return { toast: `${"⭐".repeat(Number(m[2]))} Thank you! អរគុណ!` };
  });
  door("get", "/events/:eid/feedback", {}, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    const list = await M.EvFeedback.find({ event_id: ev._id }).sort({ updated_date: -1 }).limit(1000).lean();
    const dist = [1, 2, 3, 4, 5].map((n) => list.filter((f) => f.rating === n).length);
    const avg = list.length ? Math.round((list.reduce((a, f) => a + f.rating, 0) / list.length) * 10) / 10 : null;
    const paid = await M.EvOrder.countDocuments({ event_id: ev._id, status: "paid" });
    res.json({ success: true, data: { avg, n: list.length, dist, paid, list: list.map((f) => ({ _id: f._id, name: f.name, rating: f.rating, answer: f.answer, comment: f.comment, at: f.updated_date })) } });
  });
  door("post", "/events/:eid/feedback/send", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_feedback", MSG.notFound);
    const ev = await eventOf(ctx, req.params.eid);
    res.json({ success: true, sent: await askFeedback(ev.toObject(), true), message: MSG.done });
  });
  async function askFeedback(ev, force = false) {
    if (!tgOk() || !ev.feedback?.on) return 0;
    const state = await licenseState(ev.business_id);
    if (!state.addons.ev_feedback?.active) return 0;
    const s = await M.EvSettings.findOne({ business_id: ev.business_id }).lean();
    const orders = await M.EvOrder.find({ event_id: ev._id, status: "paid", "tg.chat_id": { $gt: "" }, ...(force ? {} : { feedback_sent: null }) }).limit(2000).lean();
    let sent = 0;
    for (const o of orders) {
      if (await M.EvFeedback.exists({ order_id: o._id })) continue;
      await M.EvOrder.updateOne({ _id: o._id }, { $set: { feedback_sent: new Date() } });
      const kb = [[1, 2, 3, 4, 5].map((n) => ({ text: `${n}⭐`, callback_data: `evf:${o._id}:${n}` })), [{ text: "✍️ Write a comment", url: `${siteOf(s)}/ev/f/${o.token}` }]];
      if (await tell(o.tg.chat_id, `🙏 <b>${esc(ev.title)}</b>\n\nHow was it? Tap the stars.${ev.feedback.question ? `\n\n❓ ${esc(ev.feedback.question)}` : ""}\nតើកម្មវិធីយ៉ាងម៉េចដែរ? ចុចផ្កាយ។`, kb)) sent += 1;
    }
    return sent;
  }

  // ============================================ 8. add to calendar (.ics) ============================================
  const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const icsText = (v) => String(v || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => `\\${c}`);
  function ics({ uid, title, start, end, venue, about, url }) {
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//BizHub//Event Tickets//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT", `UID:${uid}@bizhub`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsText(title)}`, ...(venue ? [`LOCATION:${icsText(venue)}`] : []), `DESCRIPTION:${icsText(`${about ? `${String(about).slice(0, 500)}\n\n` : ""}${url}`)}`, `URL:${url}`, "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY", `DESCRIPTION:${icsText(title)}`, "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  }
  const sendIcs = (res, name, body) => {
    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${String(name).replace(/[^a-z0-9-]/gi, "-").slice(0, 60) || "event"}.ics"`);
    res.send(body);
  };
  prop.app.get(
    pub("/e/:slug/ics"),
    handle(async (req, res) => {
      const ev = await M.EvEvent.findOne({ slug: str(req.params.slug, 80).toLowerCase(), status: { $ne: "draft" } }).lean();
      if (!ev) throw new Bad(MSG.notFound, 404);
      const sh = req.query.show ? X.showOf(ev, String(req.query.show)) : null;
      const start = sh?.starts_at || ev.starts_at;
      const s = await M.EvSettings.findOne({ business_id: ev.business_id }).lean();
      sendIcs(res, ev.slug, ics({ uid: `${ev._id}${sh ? `-${sh.key}` : ""}`, title: ev.title, start, end: sh?.ends_at || (sh ? new Date(new Date(start).getTime() + 2 * 3600000) : endOf(ev)), venue: ev.venue, about: ev.about, url: `${siteOf(s)}/ev/${ev.slug}` }));
    }),
  );

  // ============================================ 9. sponsors (ev_sponsors) ============================================
  door("post", "/events/:eid/sponsors", { write: true }, async (ctx, req, res) => {
    need(ctx, "ev_sponsors", MSG.notFound);
    const ev = await eventOf(ctx, req.params.eid);
    if ((ev.sponsors || []).length >= 12) throw new Bad(MSG.tooManySponsors, 400);
    if (!req.file) throw new Bad(MSG.noFile);
    const name = str(req.body?.name, 60);
    if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
    const up = await uploadBuffer(req.file, "event");
    ev.sponsors.push({ key: `s_${randCode(6).toLowerCase()}`, name, link: linkOf(req.body?.link), tier: ["main", "gold", "partner"].includes(req.body?.tier) ? req.body.tier : "partner", logo: { url: up.url, public_id: up.public_id || "" } });
    await ev.save();
    res.status(201).json({ success: true, data: { ...eventOut(ev), sale: saleState(ev) }, message: MSG.saved });
  }, [withFile("file")]);
  door("put", "/events/:eid/sponsors/:key", { write: true }, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    const sp = ev.sponsors.find((x) => x.key === req.params.key);
    if (!sp) throw new Bad(MSG.notFound, 404);
    const b = req.body || {};
    if (b.name !== undefined) sp.name = str(b.name, 60) || sp.name;
    if (b.link !== undefined) sp.link = linkOf(b.link);
    if (["main", "gold", "partner"].includes(b.tier)) sp.tier = b.tier;
    if (Array.isArray(b.order)) ev.sponsors.sort((a, c) => b.order.indexOf(a.key) - b.order.indexOf(c.key));
    ev.markModified("sponsors");
    await ev.save();
    res.json({ success: true, data: { ...eventOut(ev), sale: saleState(ev) }, message: MSG.saved });
  });
  door("delete", "/events/:eid/sponsors/:key", { write: true }, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    const sp = ev.sponsors.find((x) => x.key === req.params.key);
    ev.sponsors = ev.sponsors.filter((x) => x.key !== req.params.key);
    await ev.save();
    if (sp?.logo?.public_id) deleteFile(sp.logo.public_id).catch(() => {});
    res.json({ success: true, data: { ...eventOut(ev), sale: saleState(ev) }, message: MSG.deleted });
  });

  // ============================================ 10. the public events page + featured (ev_feature) ============================================
  door("put", "/listing", { write: true }, async (ctx, req, res) => {
    ctx.settings.listed = !!req.body?.listed;
    await ctx.settings.save();
    listedCache.at = 0;
    res.json({ success: true, data: { listed: ctx.settings.listed }, message: MSG.saved });
  });
  door("post", "/events/:eid/feature", { write: true }, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    if (ev.status !== "published") throw new Bad(MSG.notPublished, 409, { code: "not_published" });
    const r = await buy({ customer: req.customer, business: ctx.business, product: "ev_feature", item: String(ev._id) });
    ev.featured_until = r.license.expires_at;
    await ev.save();
    if (!ctx.settings.listed) {
      ctx.settings.listed = true;
      await ctx.settings.save();
      listedCache.at = 0;
    }
    res.json({ success: true, data: { ...eventOut(ev), sale: saleState(ev) }, charged: r.charged, balance: r.balance, message: MSG.saved });
  });
  // organisers who show their events: listed + a live Event Tickets license
  let listedCache = { at: 0, ids: [] };
  async function listedBusinesses() {
    if (Date.now() - listedCache.at < 60000) return listedCache.ids;
    const ids = (await M.EvSettings.find({ listed: true }).select("business_id").limit(5000).lean()).map((s) => s.business_id);
    const lic = ids.length ? await License.find({ business_id: { $in: ids }, product: "event", item: "" }).lean() : [];
    const live = new Set(lic.filter((l) => statusOf(l).active).map((l) => String(l.business_id)));
    const biz = await Business.find({ _id: { $in: [...live] }, deleted: false, status: true }).select("_id").lean();
    listedCache = { at: Date.now(), ids: biz.map((b) => b._id) };
    return listedCache.ids;
  }
  prop.app.get(
    pub("/discover"),
    handle(async (req, res) => {
      const ids = await listedBusinesses();
      const now = new Date();
      const q = { business_id: { $in: ids }, status: { $in: ["published", "closed"] }, $or: [{ ends_at: { $gte: now } }, { ends_at: null, starts_at: { $gte: new Date(now.getTime() - 4 * 3600000) } }] };
      const s = str(req.query.q, 60);
      if (s) q.$and = [{ $or: [{ title: new RegExp(escRe(s), "i") }, { venue: new RegExp(escRe(s), "i") }, { city: new RegExp(escRe(s), "i") }] }];
      if (CATEGORIES.includes(req.query.category)) q.category = req.query.category;
      if (req.query.city) q.city = new RegExp(`^${escRe(str(req.query.city, 40))}$`, "i");
      if (req.query.kind === "free") q.kind = "free";
      const until = { today: 1, week: 7, month: 31 }[req.query.when];
      if (until) q.starts_at = { $lte: new Date(now.getTime() + until * 86400000) };
      const page = int(req.query.page, 1, 500, 1);
      const size = 24;
      const [total, rows, cities] = await Promise.all([
        M.EvEvent.countDocuments(q),
        M.EvEvent.aggregate([{ $match: q }, { $addFields: { feat: { $cond: [{ $gt: ["$featured_until", now] }, 1, 0] } } }, { $sort: { feat: -1, starts_at: 1 } }, { $skip: (page - 1) * size }, { $limit: size }]),
        page === 1 ? M.EvEvent.distinct("city", { business_id: { $in: ids }, status: "published", starts_at: { $gte: now }, city: { $gt: "" } }) : [],
      ]);
      const orgs = Object.fromEntries((await M.EvSettings.find({ business_id: { $in: [...new Set(rows.map((e) => String(e.business_id)))] } }).select("business_id org_name logo").lean()).map((x) => [String(x.business_id), x]));
      res.set("Cache-Control", "public, max-age=60");
      res.json({
        success: true,
        data: rows.map((e) => {
          const prices = (e.types || []).filter((t) => t.active !== false).map((t) => priceNow(t, e));
          const left = (e.types || []).reduce((a, t) => a + Math.max(0, t.qty - (t.taken || 0)), 0);
          const o = orgs[String(e.business_id)];
          return { slug: e.slug, title: e.title, poster: e.poster?.url || "", starts_at: e.starts_at, ends_at: e.ends_at, venue: e.venue, city: e.city || "", category: e.category || "", kind: e.kind, from: e.kind === "free" ? 0 : prices.length ? Math.min(...prices) : 0, sold_out: left === 0, featured: e.feat === 1, shows: (e.shows || []).filter((x) => x.active !== false).length, org: { name: o?.org_name || "", logo: o?.logo?.url || "" } };
        }),
        total,
        page,
        pages: Math.ceil(total / size),
        cities: cities.sort(),
        categories: CATEGORIES,
      });
    }),
  );

  // ============================================ Telegram: waitlist link + scheduler ============================================
  telegram.onStart(async (code, chat) => {
    if (!/^evw_[A-Za-z0-9]{10,40}$/.test(code)) return null;
    const w = await M.EvWait.findOne({ "tg.code": code });
    if (!w) return "⌛️ This link doesn't work any more.";
    const ev = await M.EvEvent.findById(w.event_id).select("title starts_at").lean();
    w.set("tg.chat_id", String(chat.id));
    await w.save();
    return `✅ You're on the waitlist for <b>${esc(ev?.title || "")}</b>.\nWe'll message you here the moment tickets come back.\nយើងនឹងផ្ញើសារមកអ្នក ពេលមានសំបុត្រវិញ។`;
  });
  module.exports.tick = async (now = new Date()) => {
    let feedback = 0;
    let waitlist = 0;
    // feedback: 2 hours after the end, up to 3 days
    const evs = await M.EvEvent.find({ "feedback.on": true, status: { $in: ["published", "closed"] }, starts_at: { $gte: new Date(now.getTime() - 5 * 86400000), $lte: now } }).limit(100).lean();
    for (const ev of evs) {
      const end = endOf(ev).getTime();
      if (end + 2 * 3600000 > now.getTime() || end < now.getTime() - 3 * 86400000) continue;
      feedback += await askFeedback(ev).catch(() => 0);
    }
    // waitlist: in case a hook was missed
    const ids = await M.EvWait.distinct("event_id", { status: "waiting" });
    for (const id of ids.slice(0, 100)) waitlist += await offer(id).catch(() => 0);
    return { feedback, waitlist };
  };
};
