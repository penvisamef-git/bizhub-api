// Delivery zones + drivers (mart_delivery, yearly)
//   GET  /delivery                     zones + drivers + this month per driver       (both doors)
//   PUT  /delivery/zones { zones: [{ key?, name, fee, min_order, eta, active }] }     (owner) the whole list
//   POST /drivers { name, phone, telegram }   PUT /drivers/:did   DELETE /drivers/:did   (both doors, manager)
//   POST /orders/:oid/driver { driver_id | null }                                       (both doors) who takes it
//   GET  /drivers/report?month=YYYY-MM  deliveries + fees per driver
// The website: delivery customers pick their zone; the zone's fee and smallest order apply (instead of the one fee).
const crypto = require("crypto");

const T = {
  need: "សូមដោះសោ “តំបន់ដឹកជញ្ជូន” ជាមុនសិន!",
  needZone: "សូមជ្រើសរើសតំបន់ដឹកជញ្ជូន!",
  badZone: "តំបន់នេះមិនមានទេ!",
  minZone: "តំបន់ {zone}: ការកម្ម៉ង់តិចបំផុត {amt}។",
  notDelivery: "ការកម្ម៉ង់នេះមិនមែនដឹកជញ្ជូនទេ!",
  closed: "ការកម្ម៉ង់នេះបានបិទហើយ!",
};
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

module.exports = (prop, kit) => {
  const { own, dual, managerOnly, Bad, MSG, text, num, bool, validId, localDay, roundOf, phoneKey, M } = kit;
  const on = (ctx) => !!(ctx.addons || ctx.state?.addons)?.mart_delivery?.active;
  const need = (ctx) => {
    if (!on(ctx)) throw new Bad(T.need, 402, { product: "mart_delivery" });
  };
  const zonesOf = (s) => (s.zones || []).filter((z) => z.active !== false);
  const driverOut = (d) => ({ _id: d._id, name: d.name, phone: d.phone, telegram: d.telegram, active: d.active });

  dual("get", "/delivery", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const drivers = await M.MartDriver.find({ business_id: bid, active: true }).sort({ name: 1 }).lean();
    const month = localDay().slice(0, 7);
    const report = await reportOf(ctx, month);
    res.json({ success: true, data: { active: on(ctx), zones: ctx.settings.zones || [], drivers: drivers.map(driverOut), report } });
  });
  own("put", "/delivery/zones", true, async (ctx, req, res) => {
    need(ctx);
    const list = req.body?.zones;
    if (!Array.isArray(list) || list.length > 50) throw new Bad(`${MSG.badValue} (zones)`);
    const r = roundOf(ctx.settings.currency);
    const seen = new Set();
    const zones = list.map((z) => {
      const x = z || {};
      const name = text(x, "name", 60, { required: true });
      let key = /^z_[a-z0-9]{6}$/.test(String(x.key || "")) ? x.key : `z_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`;
      while (seen.has(key)) key = `z_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`;
      seen.add(key);
      return { key, name, fee: r(num(x, "fee", 0, 100000000) || 0), min_order: r(num(x, "min_order", 0, 100000000) || 0), eta: text(x, "eta", 40) || "", active: bool(x, "active") !== false };
    });
    ctx.settings.zones = zones;
    await ctx.settings.save();
    res.json({ success: true, data: ctx.settings.zones, message: MSG.saved });
  });

  const readDriver = (b, partial) => {
    const out = {};
    const name = text(b, "name", 60, { required: !partial });
    if (name !== undefined) {
      if (!name) throw new Bad(`${MSG.required}: name`);
      out.name = name;
    }
    if (b.phone !== undefined) out.phone = phoneKey(b.phone).slice(0, 30);
    const tg = text(b, "telegram", 60);
    if (tg !== undefined) out.telegram = tg.replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
    return out;
  };
  dual("post", "/drivers", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    if ((await M.MartDriver.countDocuments({ business_id: ctx.business._id, active: true })) >= 100) throw new Bad(MSG.tooMany);
    const row = await M.MartDriver.create({ business_id: ctx.business._id, ...readDriver(req.body || {}, false) });
    res.status(201).json({ success: true, data: driverOut(row), message: MSG.saved });
  });
  const load = async (ctx, did) => {
    if (!validId(did)) throw new Bad(MSG.badId);
    const row = await M.MartDriver.findOne({ _id: did, business_id: ctx.business._id, active: true });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  dual("put", "/drivers/:did", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const row = await load(ctx, req.params.did);
    row.set(readDriver(req.body || {}, true));
    await row.save();
    res.json({ success: true, data: driverOut(row), message: MSG.saved });
  });
  dual("delete", "/drivers/:did", true, async (ctx, req, res) => {
    managerOnly(ctx);
    const row = await load(ctx, req.params.did);
    row.active = false; // old orders keep the name
    await row.save();
    res.json({ success: true, message: MSG.deleted });
  });
  dual("post", "/orders/:oid/driver", true, async (ctx, req, res) => {
    need(ctx);
    if (!validId(req.params.oid)) throw new Bad(MSG.badId);
    const o = await M.MartOrder.findOne({ _id: req.params.oid, business_id: ctx.business._id });
    if (!o) throw new Bad(MSG.rowNotFound, 404);
    if (o.fulfil !== "delivery") throw new Bad(T.notDelivery, 400, { code: "not_delivery" });
    if (!M.OPEN_ORDER.includes(o.status) && o.status !== "done") throw new Bad(T.closed, 409, { code: "closed" });
    const did = req.body?.driver_id;
    if (did) {
      const d = await load(ctx, did);
      Object.assign(o, { driver_id: d._id, driver_name: d.name, driver_phone: d.phone });
    } else Object.assign(o, { driver_id: null, driver_name: "", driver_phone: "" });
    await o.save();
    res.json({ success: true, data: { _id: o._id, driver_id: o.driver_id, driver_name: o.driver_name, driver_phone: o.driver_phone }, message: MSG.saved });
  });
  async function reportOf(ctx, month) {
    const [y, m] = month.split("-").map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1) - 7 * 3600000);
    const to = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 7 * 3600000);
    const rows = await M.MartOrder.aggregate([
      { $match: { business_id: ctx.business._id, fulfil: "delivery", status: "done", created_date: { $gte: from, $lt: to } } },
      { $group: { _id: { d: "$driver_id", n: "$driver_name" }, orders: { $sum: 1 }, fees: { $sum: "$delivery_fee" }, total: { $sum: "$total" } } },
    ]);
    const r = roundOf(ctx.settings.currency);
    return { month, rows: rows.map((x) => ({ driver_id: x._id.d, name: x._id.n || "", orders: x.orders, fees: r(x.fees), total: r(x.total) })).sort((a, b) => b.orders - a.orders) };
  }
  dual("get", "/drivers/report", false, async (ctx, req, res) => {
    need(ctx);
    const month = MONTH_RE.test(String(req.query.month || "")) ? String(req.query.month) : localDay().slice(0, 7);
    res.json({ success: true, data: await reportOf(ctx, month) });
  });

  // checkout: the zone the customer picked → { zone, fee, min_order } (null = no zones, the one fee applies)
  function zoneFor(p, key, subtotal, { strict = true } = {}) {
    if (!on({ addons: p.state.addons })) return null;
    const zones = zonesOf(p.settings);
    if (!zones.length) return null;
    const z = zones.find((x) => x.key === key);
    if (!z) {
      if (!strict) return { zone: null, fee: 0, min_order: 0 };
      throw new Bad(key ? T.badZone : T.needZone, 400, { code: key ? "bad_zone" : "need_zone" });
    }
    if (strict && z.min_order > 0 && subtotal < z.min_order) {
      const cur = p.settings.currency || "USD";
      const amt = cur === "KHR" ? `${Math.round(z.min_order).toLocaleString("en-US")}៛` : `$${z.min_order.toFixed(2)}`;
      throw new Bad(T.minZone.replace("{zone}", z.name).replace("{amt}", amt), 400, { code: "min_zone", min: z.min_order });
    }
    return { zone: z, fee: z.fee || 0, min_order: z.min_order || 0 };
  }
  // the website shows the zones (when the add-on is on)
  const publicZones = (p) => (on({ addons: p.state.addons }) ? zonesOf(p.settings).map((z) => ({ key: z.key, name: z.name, fee: z.fee, min_order: z.min_order, eta: z.eta })) : []);
  return { on, zoneFor, publicZones };
};
