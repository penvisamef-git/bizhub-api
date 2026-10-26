// Telegram Store — the staff order screen (/pos/tg-store): a tablet or phone at the counter, paired with a 6-digit code;
// each staff member logs in with their own 4-digit PIN. They see the orders come in (with a sound), accept them,
// mark them ready / on the way / done / paid, send them to the riders, and mark products sold out.
// Free: 1 screen + 2 staff. The add-on ts_pos (yearly): up to 10 screens and 50 staff.
//
// Owner (base /api/user/businesses/:id/tgstore):
//   GET  /pos                    staff, screens, limits, the POS link
//   POST /pos/staff { name, role, pin }   PUT /pos/staff/:sid   DELETE /pos/staff/:sid
//   POST /pos/pair-code          → { code, expires_at }  (10 minutes)
//   DELETE /pos/devices/:did
// Screen (x-api-key + x-ts-device [+ x-ts-session]):
//   POST /api/tspos/pair { code, name }     → { token, shop }   (kept on the device)
//   POST /api/tspos/login { pin }           → { session, staff }
//   GET  /api/tspos/boot                    the shop, me, counts, open now
//   GET  /api/tspos/orders?view=open|done   open orders (oldest first) · today's finished ones
//   POST /api/tspos/orders/:oid/status { status, eta, reason }   POST /orders/:oid/paid   POST /orders/:oid/riders
//   GET  /api/tspos/products     PUT /api/tspos/products/:pid { sold_out }
//   PUT  /api/tspos/open { open }           (manager)   GET /api/tspos/today (manager): the day's sales
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { rate_limit } = require("../../util/rate_limit");

const SESSION_HOURS = 16;
const FREE = { devices: 1, staff: 2 };
const MORE = { devices: 10, staff: 50 };
const OPEN = ["new", "accepted", "ready", "on_way"];
const T = {
  badCode: "លេខកូដមិនត្រឹមត្រូវ ឬផុតកំណត់ហើយ! / Wrong or expired code.",
  deviceLimit: "អេក្រង់ឥតគិតថ្លៃមានតែ {n}។ សូមដោះសោ “អេក្រង់បុគ្គលិកបន្ថែម”។ / {n} free screen — unlock “More staff screens”.",
  staffLimit: "បុគ្គលិកឥតគិតថ្លៃមានតែ {n} នាក់។ សូមដោះសោ “អេក្រង់បុគ្គលិកបន្ថែម”។ / {n} staff are free — unlock “More staff screens”.",
  noDevice: "ឧបករណ៍នេះមិនទាន់ភ្ជាប់ ឬត្រូវបានដកចេញ។ / This screen is not paired (or was removed).",
  badPin: "PIN ត្រូវមាន 4 ខ្ទង់! / The PIN is 4 numbers.",
  pinTaken: "PIN នេះមានបុគ្គលិកផ្សេងប្រើហើយ! / Another staff member has this PIN.",
  badLogin: "PIN មិនត្រឹមត្រូវ! / Wrong PIN.",
  login: "សូមចូលម្តងទៀត។ / Please log in again.",
  role: "មានតែអ្នកគ្រប់គ្រងទេ ដែលអាចធ្វើបាន។ / Only a manager can do this.",
};

module.exports = (prop, kit) => {
  const { M, Bad, MSG, handle, door, licenseState, addonsOf, moveOrder, markPaid, postToRiders, postToGroup, orderOut, productOut, countsOf, openNow, str, validId, fill, money, Business, Customer, siteOf } = kit;
  const D = (path) => `/api/tspos${path}`;
  const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
  const pinKey = (bid, pin) =>
    crypto
      .createHmac("sha256", process.env.JWT_SECRET || "bizhub")
      .update(`tspos:${bid}:${pin}`)
      .digest("hex");
  const limitsOf = (addons) => (addons.ts_pos?.active ? MORE : FREE);
  const staffOut = (s) => ({ _id: s._id, name: s.name, role: s.role, active: s.active !== false, created_date: s.created_date });
  const posUrl = (s) => `${siteOf(s)}/pos/tg-store`;
  const pinOf = (v, required) => {
    if (v === undefined || v === "") {
      if (required) throw new Bad(T.badPin, 400, { code: "bad_pin" });
      return undefined;
    }
    if (!/^\d{4}$/.test(String(v))) throw new Bad(T.badPin, 400, { code: "bad_pin" });
    return String(v);
  };

  // ---------------------------------------- the owner ----------------------------------------
  door("get", "/pos", {}, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const [staff, devices] = await Promise.all([M.TgPosStaff.find({ business_id: bid }).sort({ created_date: 1 }).lean(), M.TgPosDevice.find({ business_id: bid, revoked: false }).sort({ created_date: -1 }).select("name last_seen created_date").lean()]);
    res.json({ success: true, data: { staff: staff.map(staffOut), devices, limits: limitsOf(ctx.addons), free: FREE, more: MORE, url: posUrl(ctx.store) } });
  });
  door("post", "/pos/staff", { write: true }, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const b = req.body || {};
    const lim = limitsOf(ctx.addons);
    if ((await M.TgPosStaff.countDocuments({ business_id: bid })) >= lim.staff) throw new Bad(fill(T.staffLimit, { n: lim.staff }), 402, { code: "staff_limit", product: "ts_pos" });
    const name = str(b.name, 60);
    if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
    const pin = pinOf(b.pin, true);
    try {
      const row = await M.TgPosStaff.create({ business_id: bid, name, role: b.role === "manager" ? "manager" : "staff", pin_key: pinKey(bid, pin), active: b.active !== false });
      res.status(201).json({ success: true, data: staffOut(row), message: MSG.saved });
    } catch (err) {
      if (err.code === 11000) throw new Bad(T.pinTaken, 409, { code: "pin_taken" });
      throw err;
    }
  });
  door("put", "/pos/staff/:sid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.sid)) throw new Bad(MSG.badId);
    const row = await M.TgPosStaff.findOne({ _id: req.params.sid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    const b = req.body || {};
    let out = false; // log them out (new PIN, turned off, new role)
    if (b.name !== undefined) row.name = str(b.name, 60) || row.name;
    if (b.role !== undefined) {
      const role = b.role === "manager" ? "manager" : "staff";
      out = out || role !== row.role;
      row.role = role;
    }
    if (b.active !== undefined) {
      out = out || !b.active;
      row.active = !!b.active;
    }
    const pin = pinOf(b.pin, false);
    if (pin) {
      row.pin_key = pinKey(ctx.business._id, pin);
      out = true;
    }
    if (out) row.pin_v = (row.pin_v || 0) + 1;
    try {
      await row.save();
    } catch (err) {
      if (err.code === 11000) throw new Bad(T.pinTaken, 409, { code: "pin_taken" });
      throw err;
    }
    res.json({ success: true, data: staffOut(row), message: MSG.saved });
  });
  door("delete", "/pos/staff/:sid", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.sid)) throw new Bad(MSG.badId);
    const r = await M.TgPosStaff.deleteOne({ _id: req.params.sid, business_id: ctx.business._id });
    if (!r.deletedCount) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, message: MSG.deleted });
  });
  door("post", "/pos/pair-code", { write: true }, async (ctx, req, res) => {
    const lim = limitsOf(ctx.addons);
    if ((await M.TgPosDevice.countDocuments({ business_id: ctx.business._id, revoked: false })) >= lim.devices) throw new Bad(fill(T.deviceLimit, { n: lim.devices }), 402, { code: "device_limit", product: "ts_pos" });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    ctx.store.pos.pair_code = code;
    ctx.store.pos.pair_expires = new Date(Date.now() + 10 * 60000);
    await ctx.store.save();
    res.json({ success: true, data: { code, expires_at: ctx.store.pos.pair_expires, url: `${posUrl(ctx.store)}?code=${code}` } });
  });
  door("delete", "/pos/devices/:did", { write: true }, async (ctx, req, res) => {
    if (!validId(req.params.did)) throw new Bad(MSG.badId);
    const r = await M.TgPosDevice.updateOne({ _id: req.params.did, business_id: ctx.business._id }, { $set: { revoked: true } });
    if (!r.matchedCount) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, message: MSG.deleted });
  });

  // ---------------------------------------- the screen ----------------------------------------
  const pairLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 15 });
  const loginLimit = rate_limit({ windowMs: 5 * 60 * 1000, max: 30 });
  async function deviceOf(req) {
    const raw = String(req.headers["x-ts-device"] || "");
    const device = raw.length >= 32 ? await M.TgPosDevice.findOne({ token_hash: sha(raw), revoked: false }) : null;
    if (!device) throw new Bad(T.noDevice, 401, { code: "no_device" });
    return device;
  }
  async function shopOf(bid) {
    const [business, license, addons, store] = await Promise.all([Business.findOne({ _id: bid, deleted: false }), licenseState(bid), addonsOf(bid), M.TgStore.findOne({ business_id: bid })]);
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || !owner?.status || !store) throw new Bad(MSG.suspended, 403, { code: "suspended" });
    if (license.locked) throw new Bad(MSG.locked, 402, { code: "locked" });
    return { business, license, addons, store };
  }
  async function screenCtx(req, manager = false) {
    const device = await deviceOf(req);
    let d;
    try {
      d = jwt.verify(String(req.headers["x-ts-session"] || ""), process.env.JWT_SECRET);
    } catch {
      throw new Bad(T.login, 401, { code: "login" });
    }
    if (d.type !== "ts_staff" || d.did !== String(device._id)) throw new Bad(T.login, 401, { code: "login" });
    const [staff, shop] = await Promise.all([M.TgPosStaff.findOne({ _id: d.sid, business_id: device.business_id, active: true }).lean(), shopOf(device.business_id)]);
    if (!staff || (staff.pin_v || 0) !== d.v) throw new Bad(T.login, 401, { code: "login" });
    if (manager && staff.role !== "manager") throw new Bad(T.role, 403, { code: "role" });
    if (!device.last_seen || Date.now() - device.last_seen.getTime() > 5 * 60000) M.TgPosDevice.updateOne({ _id: device._id }, { $set: { last_seen: new Date() } }).catch(() => {});
    return { ...shop, device, staff, who: staff.name };
  }
  // changing something needs the year to be paid (looking doesn't)
  const writable = (ctx) => {
    if (ctx.license.read_only) throw new Bad(MSG.locked, 402, { code: "locked" });
  };
  const route = (method, path, manager, fn) => prop.app[method](D(path), prop.api_auth, handle(async (req, res) => fn(await screenCtx(req, manager), req, res)));
  const shopOut = (s, addons) => ({ name: s.shop_name, logo: s.logo?.url || "", color: s.color || "", theme: s.theme, currency: s.currency, slug: s.slug, riders: !!(addons.ts_riders?.active && s.riders?.chat_id) });
  const orderIn = async (ctx, oid) => {
    if (!validId(oid)) throw new Bad(MSG.badId);
    const o = await M.TgOrder.findOne({ _id: oid, business_id: ctx.business._id });
    if (!o) throw new Bad(MSG.orderGone, 404);
    return o;
  };
  const counts = (ctx) => countsOf({ business: ctx.business });

  prop.app.post(
    D("/pair"),
    prop.api_auth,
    pairLimit,
    handle(async (req, res) => {
      const code = String(req.body?.code || "").replace(/\D/g, "");
      if (!/^\d{6}$/.test(code)) throw new Bad(T.badCode, 400, { code: "bad_code" });
      const s = await M.TgStore.findOne({ "pos.pair_code": code, "pos.pair_expires": { $gt: new Date() } });
      if (!s) throw new Bad(T.badCode, 400, { code: "bad_code" });
      const shop = await shopOf(s.business_id);
      const lim = limitsOf(shop.addons);
      if ((await M.TgPosDevice.countDocuments({ business_id: s.business_id, revoked: false })) >= lim.devices) throw new Bad(fill(T.deviceLimit, { n: lim.devices }), 402, { code: "device_limit", product: "ts_pos" });
      const used = await M.TgStore.updateOne({ _id: s._id, "pos.pair_code": code }, { $set: { "pos.pair_code": "", "pos.pair_expires": null } });
      if (!used.modifiedCount) throw new Bad(T.badCode, 400, { code: "bad_code" });
      const tok = crypto.randomBytes(32).toString("hex");
      await M.TgPosDevice.create({ business_id: s.business_id, name: str(req.body?.name, 60) || "Counter", token_hash: sha(tok), last_seen: new Date() });
      res.status(201).json({ success: true, data: { token: tok, shop: shopOut(s, shop.addons) } });
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
      const staff = await M.TgPosStaff.findOne({ business_id: device.business_id, pin_key: pinKey(device.business_id, pin), active: true }).lean();
      if (!staff) throw new Bad(T.badLogin, 401, { code: "bad_pin" });
      await shopOf(device.business_id);
      const session = jwt.sign({ type: "ts_staff", sid: String(staff._id), did: String(device._id), v: staff.pin_v || 0 }, process.env.JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
      res.json({ success: true, data: { session, staff: staffOut(staff) } });
    }),
  );
  // the shop's name + logo before logging in (the PIN screen)
  prop.app.get(
    D("/shop"),
    prop.api_auth,
    handle(async (req, res) => {
      const device = await deviceOf(req);
      const shop = await shopOf(device.business_id);
      res.json({ success: true, data: { shop: shopOut(shop.store, shop.addons), device: { name: device.name } } });
    }),
  );

  route("get", "/boot", false, async (ctx, req, res) => {
    res.json({
      success: true,
      data: {
        shop: shopOut(ctx.store, ctx.addons),
        staff: staffOut(ctx.staff),
        device: { _id: ctx.device._id, name: ctx.device.name },
        open: !!ctx.store.open,
        open_now: openNow(ctx.store, ctx.license, ctx.addons),
        read_only: !!ctx.license.read_only,
        counts: await counts(ctx),
      },
    });
  });
  route("get", "/orders", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const done = req.query.view === "done";
    const today = kit.dayStart(kit.localDay());
    const q = done ? { business_id: bid, status: { $in: ["done", "cancelled"] }, updated_date: { $gte: today } } : { business_id: bid, status: { $in: OPEN } };
    const [rows, c] = await Promise.all([
      M.TgOrder.find(q)
        .sort(done ? { updated_date: -1 } : { created_date: 1 })
        .limit(done ? 80 : 100)
        .lean(),
      counts(ctx),
    ]);
    res.set("Cache-Control", "no-store");
    res.json({ success: true, data: rows.map((o) => orderOut(o)), counts: c, open: !!ctx.store.open, open_now: openNow(ctx.store, ctx.license, ctx.addons) });
  });
  route("post", "/orders/:oid/status", false, async (ctx, req, res) => {
    writable(ctx);
    const o = await orderIn(ctx, req.params.oid);
    const b = req.body || {};
    const after = await moveOrder(ctx.store, o, String(b.status || ""), ctx.who, { eta: b.eta, reason: b.reason });
    res.json({ success: true, data: orderOut(after) });
  });
  route("post", "/orders/:oid/paid", false, async (ctx, req, res) => {
    writable(ctx);
    const o = await orderIn(ctx, req.params.oid);
    res.json({ success: true, data: orderOut(await markPaid(ctx.store, o, ctx.who)) });
  });
  route("post", "/orders/:oid/riders", false, async (ctx, req, res) => {
    writable(ctx);
    if (!ctx.addons.ts_riders?.active || !ctx.store.riders?.chat_id) throw new Bad(MSG.ridersNotConnected, 400, { code: "riders_off" });
    const o = await orderIn(ctx, req.params.oid);
    if (o.mode !== "delivery") throw new Bad(MSG.notDelivery, 400, { code: "not_delivery" });
    if (["done", "cancelled"].includes(o.status)) throw new Bad(MSG.badStep, 409, { code: "bad_step" });
    if (!(await postToRiders(ctx.store, o, true))) throw new Bad(MSG.tgUnreachable, 502);
    await postToGroup(ctx.store, o);
    res.json({ success: true, data: orderOut(o), message: MSG.ridersSent });
  });
  route("get", "/products", false, async (ctx, req, res) => {
    const [rows, cats] = await Promise.all([M.TgProduct.find({ business_id: ctx.business._id, deleted: false }).sort({ sort: 1, created_date: 1 }).lean(), M.TgCategory.find({ business_id: ctx.business._id, deleted: false }).sort({ sort: 1 }).lean()]);
    res.json({ success: true, data: rows.map(productOut), categories: cats.map((c) => ({ _id: c._id, name: c.name, name_km: c.name_km })) });
  });
  route("put", "/products/:pid", false, async (ctx, req, res) => {
    writable(ctx);
    if (!validId(req.params.pid)) throw new Bad(MSG.badId);
    const set = {};
    if (req.body?.sold_out !== undefined) set.sold_out = !!req.body.sold_out;
    if (req.body?.sold_out === false) {
      // back on sale: a stock count at 0 would keep it sold out
      const p = await M.TgProduct.findOne({ _id: req.params.pid, business_id: ctx.business._id }).select("stock").lean();
      if (p?.stock === 0) set.stock = null;
    }
    const p = await M.TgProduct.findOneAndUpdate({ _id: req.params.pid, business_id: ctx.business._id, deleted: false }, { $set: set }, { returnDocument: "after" });
    if (!p) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, data: productOut(p) });
  });
  route("put", "/open", true, async (ctx, req, res) => {
    writable(ctx);
    ctx.store.open = !!req.body?.open;
    await ctx.store.save();
    res.json({ success: true, data: { open: ctx.store.open, open_now: openNow(ctx.store, ctx.license, ctx.addons) } });
  });
  route("get", "/today", true, async (ctx, req, res) => {
    const today = kit.dayStart(kit.localDay());
    const rows = await M.TgOrder.find({ business_id: ctx.business._id, created_date: { $gte: today }, status: { $ne: "cancelled" } })
      .select("total pay status mode")
      .lean();
    const by = (k) => rows.reduce((a, o) => ((a[k(o)] = money((a[k(o)] || 0) + o.total, ctx.store.currency)), a), {});
    res.json({
      success: true,
      data: {
        orders: rows.length,
        total: money(rows.reduce((a, o) => a + o.total, 0), ctx.store.currency),
        paid: money(rows.filter((o) => o.pay?.status === "paid").reduce((a, o) => a + o.total, 0), ctx.store.currency),
        by_pay: by((o) => (o.pay?.method === "custom" ? o.pay.custom?.name || "custom" : o.pay?.method || "cash")),
        by_mode: by((o) => o.mode),
        currency: ctx.store.currency,
      },
    });
  });
};

module.exports.LIMITS = { FREE, MORE };
