// Promotions (gh_promos, 95 coins, forever): season / date deals — % off, an amount off, or a special price a night,
// for chosen room types between two dates. Shown on the website (old price crossed out) and used for customer bookings.
// Base: /api/user/businesses/:id/guesthouse
//   GET    /promos                     list + { on, price }
//   POST   /promos                     { name, badge, note, kind, value, type_ids, from, to, active }   (needs gh_promos)
//   PUT    /promos/:pid                same fields                                                      (needs gh_promos)
//   DELETE /promos/:pid
//   GET    /promos/preview?type_id&from&to     what a stay would cost with the deals
const { priceOf } = require("../../homepage/prices");
const D = require("./guesthouse.deals");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PROMOS = 50;

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, Bad, MSG, text, num, bool, validId, M } = kit;
  const T = {
    needAddon: "សូមដោះសោ “ការផ្សព្វផ្សាយ” ជាមុនសិន!",
    badDates: "ថ្ងៃចាប់ផ្តើម និងថ្ងៃបញ្ចប់មិនត្រឹមត្រូវ!",
    badValue: "តម្លៃបញ្ចុះមិនត្រឹមត្រូវ!",
    tooMany: `ការផ្សព្វផ្សាយច្រើនបំផុត ${MAX_PROMOS}`,
  };
  const needAddon = (ctx) => {
    if (!ctx.addons.gh_promos?.active) throw new Bad(T.needAddon, 402, { product: "gh_promos" });
  };
  const read = async (ctx, b, cur = {}) => {
    const out = {};
    const name = text(b, "name", 60, { required: !cur._id });
    if (name !== undefined) {
      if (!name) throw new Bad(`${MSG.required}: name`);
      out.name = name;
    }
    for (const [k, max] of [
      ["badge", 24],
      ["note", 200],
    ]) {
      const v = text(b, k, max);
      if (v !== undefined) out[k] = v;
    }
    if (b.kind !== undefined) {
      if (!M.PROMO_KINDS.includes(b.kind)) throw new Bad(T.badValue);
      out.kind = b.kind;
    }
    const kind = out.kind || cur.kind || "percent";
    const value = num(b, "value", 0, 100000000, { required: !cur._id });
    if (value !== undefined) out.value = value;
    const v = out.value ?? cur.value;
    if (!(v > 0) || (kind === "percent" && v > 100)) throw new Bad(T.badValue);
    for (const k of ["from", "to"]) {
      if (b[k] === undefined) continue;
      if (!DAY_RE.test(String(b[k]))) throw new Bad(T.badDates);
      out[k] = String(b[k]);
    }
    if (!cur._id && (!out.from || !out.to)) throw new Bad(T.badDates);
    if ((out.from || cur.from) > (out.to || cur.to)) throw new Bad(T.badDates);
    if (b.type_ids !== undefined) {
      if (!Array.isArray(b.type_ids) || b.type_ids.some((t) => !validId(String(t)))) throw new Bad(`${MSG.badValue} (type_ids)`);
      const ids = [...new Set(b.type_ids.map(String))];
      const found = await M.GhRoomType.countDocuments({ business_id: ctx.business._id, _id: { $in: ids } });
      if (found !== ids.length) throw new Bad(`${MSG.badValue} (type_ids)`);
      out.type_ids = ids;
    }
    const active = bool(b, "active");
    if (active !== undefined) out.active = active;
    return out;
  };
  const list = (bid) => M.GhPromo.find({ business_id: bid }).sort({ from: 1, sort: 1, created_date: 1 }).lean();

  prop.app.get(
    `${base}/promos`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      res.json({ success: true, data: await list(ctx.business._id), on: !!ctx.addons.gh_promos?.active, price: await priceOf("gh_promos") });
    }),
  );
  prop.app.post(
    `${base}/promos`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      if ((await M.GhPromo.countDocuments({ business_id: ctx.business._id })) >= MAX_PROMOS) throw new Bad(T.tooMany);
      const row = await M.GhPromo.create({ business_id: ctx.business._id, ...(await read(ctx, req.body || {})) });
      res.status(201).json({ success: true, data: row, message: MSG.saved });
    }),
  );
  prop.app.put(
    `${base}/promos/:pid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      if (!validId(req.params.pid)) throw new Bad(MSG.badId);
      const row = await M.GhPromo.findOne({ _id: req.params.pid, business_id: ctx.business._id });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      row.set(await read(ctx, req.body || {}, row));
      await row.save();
      res.json({ success: true, data: row, message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/promos/:pid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.pid)) throw new Bad(MSG.badId);
      const r = await M.GhPromo.deleteOne({ _id: req.params.pid, business_id: ctx.business._id });
      if (!r.deletedCount) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, message: MSG.deleted });
    }),
  );
  prop.app.get(
    `${base}/promos/preview`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const { type_id: tid, from, to } = req.query;
      if (!validId(String(tid || "")) || !DAY_RE.test(String(from)) || !DAY_RE.test(String(to)) || from >= to) throw new Bad(T.badDates);
      const type = await M.GhRoomType.findOne({ _id: tid, business_id: ctx.business._id }).lean();
      if (!type) throw new Bad(MSG.rowNotFound, 404);
      const promos = ctx.addons.gh_promos?.active ? await M.GhPromo.find({ business_id: ctx.business._id, active: true, to: { $gte: from }, from: { $lt: to } }).lean() : [];
      res.json({ success: true, data: D.stayPrice(promos, type._id, type.price, from, to, ctx.settings.currency) });
    }),
  );
};

// the deals a public page / a customer booking uses (only while the add-on is on)
module.exports.livePromos = async (M, bid, addons, fromDay) =>
  addons?.gh_promos?.active
    ? M.GhPromo.find({ business_id: bid, active: true, to: { $gte: fromDay } })
        .sort({ from: 1 })
        .lean()
    : [];
