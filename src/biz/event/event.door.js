// Event Tickets — the door phones (/pos/event): paired with a 6-digit code, then each team member logs in with their PIN.
// Roles: door (scan) · crew (scan + guest list + counts, no money) · cashier (crew + sell at the gate, ev_cashier) · manager (everything).
// Device (x-api-key + x-ev-device [+ x-ev-session]):
//   POST /api/evdoor/pair { code, name }   → { token }      (1 phone free, ev_doors: up to 20)
//   POST /api/evdoor/login { pin }         → { session, member }
//   GET  /api/evdoor/boot                  the organiser, my role, the events (today / soon / recent)
//   GET  /api/evdoor/events/:eid           the event + counts (+ every ticket code for offline scanning)
//   POST /api/evdoor/scan { event_id, code, show }        → { result: ok|used|cancelled|other_event|other_show|not_found, ticket }
//   POST /api/evdoor/sync { event_id, scans: [{ code, at }] }   scans made offline
//   GET  /api/evdoor/events/:eid/guests?q&status&type      (crew, cashier, manager)
//   POST /api/evdoor/events/:eid/sell { lines, name, phone, method }   (cashier, manager — ev_cashier)
//   GET  /api/evdoor/orders?event&status   POST /api/evdoor/orders/:oid/approve | /reject   (manager)
//   GET  /api/evdoor/events/:eid/report    (manager)
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { rate_limit } = require("../../util/rate_limit");

const SESSION_HOURS = 16;
const T = {
  badCode: "លេខកូដមិនត្រឹមត្រូវ ឬផុតកំណត់ហើយ! / Wrong or expired code.",
  deviceLimit: "ទូរស័ព្ទច្រកចូលឥតគិតថ្លៃមានតែ 1។ សូមដោះសោ “ទូរស័ព្ទស្កេនច្រើន”។ / 1 door phone is free — unlock “More door scanners”.",
  noDevice: "ទូរស័ព្ទនេះមិនទាន់ភ្ជាប់ ឬត្រូវបានដកចេញ។ / This phone is not paired (or was removed).",
  badLogin: "PIN មិនត្រឹមត្រូវ! / Wrong PIN.",
  login: "សូមចូលម្តងទៀត។ / Please log in again.",
  role: "តួនាទីរបស់អ្នកមិនអាចធ្វើបានទេ។ / Your role can't do this.",
};
const CAN = {
  guests: ["crew", "cashier", "manager"],
  sell: ["cashier", "manager"],
  money: ["manager"],
};

module.exports = (prop, kit) => {
  const { M, Bad, MSG, handle, licenseState, settingsOf, validId, str, sha, pinKey, token, linesOf, take, giveBack, nextNo, makeTickets, releaseExpired, approve, reject, listOrders, listTickets, reportOf, eventOut, orderOut, ticketOut, saleState, countsOf, Business, Customer, X } = kit;
  const mongoose = require("mongoose");
  const D = (path) => `/api/evdoor${path}`;
  const pairLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 15 });
  const loginLimit = rate_limit({ windowMs: 5 * 60 * 1000, max: 30 });

  async function deviceOf(req) {
    const raw = String(req.headers["x-ev-device"] || "");
    const device = raw && (await M.EvDevice.findOne({ token_hash: sha(raw), revoked: false }));
    if (!device) throw new Bad(T.noDevice, 401, { code: "no_device" });
    return device;
  }
  async function bizOf(bid) {
    const [business, state] = await Promise.all([Business.findOne({ _id: bid, deleted: false }), licenseState(bid)]);
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || !owner?.status) throw new Bad(MSG.suspended, 403, { code: "suspended" });
    if (state.license.locked) throw new Bad(MSG.locked, 402, { code: "locked" });
    return { business, ...state };
  }
  // a logged-in team member on a paired phone
  async function doorCtx(req, can) {
    const device = await deviceOf(req);
    let d;
    try {
      d = jwt.verify(String(req.headers["x-ev-session"] || ""), process.env.JWT_SECRET);
    } catch {
      throw new Bad(T.login, 401, { code: "login" });
    }
    if (d.type !== "ev_member" || d.did !== String(device._id)) throw new Bad(T.login, 401, { code: "login" });
    const member = await M.EvMember.findOne({ _id: d.mid, business_id: device.business_id, active: true }).lean();
    if (!member || (member.pin_v || 0) !== d.v) throw new Bad(T.login, 401, { code: "login" });
    if (can && !CAN[can].includes(member.role)) throw new Bad(T.role, 403, { code: "role" });
    const ctx = await bizOf(device.business_id);
    if (member.role === "cashier" && !ctx.addons.ev_cashier?.active && can === "sell") throw new Bad(MSG.needCashier, 402, { code: "need_cashier" });
    if (!device.last_seen || Date.now() - device.last_seen.getTime() > 5 * 60000) M.EvDevice.updateOne({ _id: device._id }, { $set: { last_seen: new Date() } }).catch(() => {});
    return { ...ctx, device, member, who: member.name, money: CAN.money.includes(member.role) };
  }
  const route = (method, path, can, fn) => prop.app[method](D(path), prop.api_auth, handle(async (req, res) => fn(await doorCtx(req, can), req, res)));
  const eventOf = async (ctx, eid) => {
    if (!validId(eid)) throw new Bad(MSG.badId);
    const ev = await M.EvEvent.findOne({ _id: eid, business_id: ctx.business._id, status: { $ne: "draft" } });
    if (!ev) throw new Bad(MSG.rowNotFound, 404);
    return ev;
  };
  const memberOut = (m) => ({ _id: m._id, name: m.name, role: m.role });

  // ---------- pair + login ----------
  prop.app.post(
    D("/pair"),
    prop.api_auth,
    pairLimit,
    handle(async (req, res) => {
      const code = String(req.body?.code || "").replace(/\D/g, "");
      if (!/^\d{6}$/.test(code)) throw new Bad(T.badCode, 400, { code: "bad_code" });
      const s = await M.EvSettings.findOne({ pair_code: code, pair_expires: { $gt: new Date() } });
      if (!s) throw new Bad(T.badCode, 400, { code: "bad_code" });
      const ctx = await bizOf(s.business_id);
      if ((await M.EvDevice.countDocuments({ business_id: s.business_id, revoked: false })) >= ctx.limits.devices) throw new Bad(T.deviceLimit, 402, { code: "device_limit", product: "ev_doors" });
      const used = await M.EvSettings.updateOne({ _id: s._id, pair_code: code }, { $set: { pair_code: "", pair_expires: null } });
      if (!used.modifiedCount) throw new Bad(T.badCode, 400, { code: "bad_code" });
      const tok = crypto.randomBytes(32).toString("hex");
      await M.EvDevice.create({ business_id: s.business_id, name: str(req.body?.name, 60) || "Door", token_hash: sha(tok), last_seen: new Date() });
      res.status(201).json({ success: true, data: { token: tok, org: { name: s.org_name || ctx.business.name, logo: s.logo?.url || "" } } });
    }),
  );
  prop.app.post(
    D("/login"),
    prop.api_auth,
    loginLimit,
    handle(async (req, res) => {
      const device = await deviceOf(req);
      const pin = String(req.body?.pin || "");
      if (!/^\d{4}$/.test(pin)) throw new Bad(T.badLogin, 400, { code: "bad_pin" });
      const member = await M.EvMember.findOne({ business_id: device.business_id, pin_key: pinKey(device.business_id, pin), active: true }).lean();
      if (!member) throw new Bad(T.badLogin, 401, { code: "bad_pin" });
      await bizOf(device.business_id);
      const session = jwt.sign({ type: "ev_member", mid: String(member._id), did: String(device._id), v: member.pin_v || 0 }, process.env.JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
      res.json({ success: true, data: { session, member: memberOut(member) } });
    }),
  );

  // ---------- what the phone shows ----------
  route("get", "/boot", null, async (ctx, req, res) => {
    const s = await settingsOf(ctx.business);
    const since = new Date(Date.now() - 3 * 86400000);
    const events = await M.EvEvent.find({ business_id: ctx.business._id, status: { $ne: "draft" }, $or: [{ starts_at: { $gte: since } }, { ends_at: { $gte: since } }, { "shows.starts_at": { $gte: since } }] })
      .sort({ starts_at: 1 })
      .limit(60)
      .lean();
    const counts = await countsOf(ctx.business._id, events.map((e) => e._id));
    res.json({
      success: true,
      data: {
        org: { name: s.org_name || ctx.business.name, logo: s.logo?.url || "" },
        member: memberOut(ctx.member),
        device: { _id: ctx.device._id, name: ctx.device.name },
        cashier: !!ctx.addons.ev_cashier?.active,
        read_only: ctx.license.read_only,
        events: events.map((e) => {
          const c = counts[String(e._id)];
          return { _id: e._id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, venue: e.venue, poster: e.poster?.url || "", kind: e.kind, status: e.status, sale: saleState(e), tickets: c.tickets, used: c.used, review: ctx.money ? c.review : undefined, shows: (e.shows || []).map((s) => ({ key: s.key, starts_at: s.starts_at, label: s.label })) };
        }),
      },
    });
  });
  // the event + counts; ?codes=1 also sends every ticket code so the door can check offline
  route("get", "/events/:eid", null, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.params.eid);
    const c = (await countsOf(ctx.business._id, [ev._id]))[String(ev._id)];
    const byType = await M.EvTicket.aggregate([{ $match: { event_id: ev._id, status: { $ne: "cancelled" } } }, { $group: { _id: "$type_key", n: { $sum: 1 }, used: { $sum: { $cond: [{ $eq: ["$status", "used"] }, 1, 0] } } } }]);
    const out = eventOut(ev);
    if (!ctx.money) out.types = out.types.map((t) => ({ ...t, price: ctx.member.role === "cashier" ? t.price : undefined, now: ctx.member.role === "cashier" ? t.now : undefined, tier: undefined, tiers: undefined, bundles: undefined }));
    const data = {
      event: { ...out, sale: saleState(ev) },
      counts: { tickets: c.tickets, used: c.used, review: ctx.money ? c.review : undefined, money: ctx.money ? c.money : undefined },
      by_type: ev.types.map((t) => {
        const r = byType.find((x) => x._id === t.key) || {};
        return { key: t.key, name: t.name, color: t.color, sold: r.n || 0, used: r.used || 0 };
      }),
      at: new Date(),
    };
    if (req.query.codes) {
      const rows = await M.EvTicket.find({ event_id: ev._id }).select("code status type_name holder used_at used_by show seat_label").lean();
      data.codes = rows.map((t) => [t.code, t.status, t.type_name, t.holder, t.used_at, t.used_by, t.show || "", t.seat_label || ""]);
    }
    res.json({ success: true, data });
  });

  // ---------- scan ----------
  const codeOf = (raw) => {
    const s = String(raw || "").trim();
    const m = s.match(/\/ev\/t\/([A-Za-z0-9]{8,14})/);
    return (m ? m[1] : s).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14);
  };
  async function scanOne(ctx, ev, raw, at, show) {
    const code = codeOf(raw);
    const t = code.length >= 8 ? await M.EvTicket.findOne({ business_id: ctx.business._id, code }) : null;
    if (!t) return { result: "not_found", code };
    const brief = (x) => ({ code: x.code, type_name: x.type_name, holder: x.holder, no: x.no, used_at: x.used_at, used_by: x.used_by, status: x.status, show: x.show || "", show_at: x.show_at || null, seat_label: x.seat_label || "" });
    if (String(t.event_id) !== String(ev._id)) {
      const other = await M.EvEvent.findById(t.event_id).select("title starts_at").lean();
      return { result: "other_event", ticket: brief(t), other: other ? { title: other.title, starts_at: other.starts_at } : null };
    }
    if (t.status === "cancelled") return { result: "cancelled", ticket: brief(t) };
    // a ticket for another date / time of the same event
    if (show && t.show && t.show !== show) return { result: "other_show", ticket: brief(t) };
    const when = at && !Number.isNaN(new Date(at).getTime()) && new Date(at) < new Date() ? new Date(at) : new Date();
    const done = await M.EvTicket.findOneAndUpdate({ _id: t._id, status: "valid" }, { $set: { status: "used", used_at: when, used_by: ctx.who, used_device: String(ctx.device._id) } }, { returnDocument: "after" });
    if (done) return { result: "ok", ticket: brief(done) };
    return { result: "used", ticket: brief(await M.EvTicket.findById(t._id).lean()) };
  }
  route("post", "/scan", null, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.body?.event_id);
    if (ev.status === "cancelled") throw new Bad(MSG.cancelledEv, 409, { code: "cancelled" });
    const r = await scanOne(ctx, ev, req.body?.code, undefined, String(req.body?.show || ""));
    const used = await M.EvTicket.countDocuments({ event_id: ev._id, status: "used" });
    res.json({ success: true, data: { ...r, used } });
  });
  route("post", "/sync", null, async (ctx, req, res) => {
    const ev = await eventOf(ctx, req.body?.event_id);
    const scans = Array.isArray(req.body?.scans) ? req.body.scans.slice(0, 500) : [];
    const results = [];
    for (const s of scans) results.push({ code: codeOf(s?.code), ...(await scanOne(ctx, ev, s?.code, s?.at, String(s?.show || req.body?.show || ""))) });
    res.json({ success: true, data: { results, used: await M.EvTicket.countDocuments({ event_id: ev._id, status: "used" }) } });
  });

  // ---------- crew: the guest list ----------
  route("get", "/events/:eid/guests", "guests", async (ctx, req, res) => res.json({ success: true, ...(await listTickets(ctx, await eventOf(ctx, req.params.eid), req.query, ctx.money)) }));

  // ---------- cashier: sell at the gate ----------
  route("post", "/events/:eid/sell", "sell", async (ctx, req, res) => {
    if (!ctx.addons.ev_cashier?.active) throw new Bad(MSG.needCashier, 402, { code: "need_cashier", product: "ev_cashier" });
    if (ctx.license.read_only) throw new Bad(MSG.locked, 402, { code: "locked" });
    const ev = await eventOf(ctx, req.params.eid);
    if (ev.status === "cancelled") throw new Bad(MSG.cancelledEv, 409, { code: "cancelled" });
    const b = req.body || {};
    await releaseExpired({ event_id: ev._id });
    const { lines, qty, total } = linesOf(ev, b.lines, { gate: true });
    const show = X.pickShow(ev, b.show, { gate: true });
    await take(ev, lines, { gate: true, show });
    const _id = new mongoose.Types.ObjectId();
    const seats = [];
    try {
      for (const l of lines) if (X.isSeated(ev, l.key)) seats.push(...(await X.autoSeats(ev, show, l.key, l.qty)));
      await X.holdSeats(ev, show, _id, seats);
    } catch (err) {
      await giveBack({ _id, event_id: ev._id, show, lines });
      throw err;
    }
    const settings = await settingsOf(ctx.business);
    let o;
    try {
      o = await M.EvOrder.create({
        _id,
        show,
        seats,
        business_id: ctx.business._id,
        event_id: ev._id,
        no: await nextNo(settings),
        token: token(24),
        buyer: { name: str(b.name, 80) || "Walk-in", phone: String(b.phone || "").replace(/\D/g, "").slice(0, 20) },
        lines,
        qty,
        total,
        status: "paid",
        via: "gate",
        method: b.method === "qr" ? "qr" : "cash",
        decided_by: ctx.who,
        decided_at: new Date(),
      });
    } catch (err) {
      await giveBack({ _id, event_id: ev._id, show, lines });
      throw err;
    }
    // walk-in tickets go straight through the door
    const tickets = await makeTickets(o);
    if (b.checkin !== false) await M.EvTicket.updateMany({ order_id: o._id, status: "valid" }, { $set: { status: "used", used_at: new Date(), used_by: ctx.who, used_device: String(ctx.device._id) } });
    res.status(201).json({ success: true, data: { order: orderOut(o), tickets: (await M.EvTicket.find({ order_id: o._id }).sort({ no: 1 }).lean()).map(ticketOut) }, message: MSG.saved });
  });

  // ---------- manager: orders + money ----------
  route("get", "/orders", "money", async (ctx, req, res) => {
    await releaseExpired({ business_id: ctx.business._id });
    res.json({ success: true, ...(await listOrders(ctx, req.query)) });
  });
  const orderOf = async (ctx, oid) => {
    if (!validId(oid)) throw new Bad(MSG.badId);
    const o = await M.EvOrder.findOne({ _id: oid, business_id: ctx.business._id });
    if (!o) throw new Bad(MSG.rowNotFound, 404);
    return o;
  };
  route("post", "/orders/:oid/approve", "money", async (ctx, req, res) => {
    if (ctx.license.read_only) throw new Bad(MSG.locked, 402, { code: "locked" });
    const r = await approve(ctx, await orderOf(ctx, req.params.oid), ctx.who);
    res.json({ success: true, data: { order: orderOut(r.order), tickets: r.tickets.map(ticketOut) }, message: MSG.saved });
  });
  route("post", "/orders/:oid/reject", "money", async (ctx, req, res) => {
    if (ctx.license.read_only) throw new Bad(MSG.locked, 402, { code: "locked" });
    const o = await reject(ctx, await orderOf(ctx, req.params.oid), ctx.who, req.body?.reason);
    res.json({ success: true, data: orderOut(o), message: MSG.saved });
  });
  route("get", "/events/:eid/report", "money", async (ctx, req, res) => res.json({ success: true, data: await reportOf(ctx, await eventOf(ctx, req.params.eid)) }));

};
