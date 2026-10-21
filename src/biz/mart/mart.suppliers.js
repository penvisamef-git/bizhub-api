// Suppliers (mart_suppliers, forever) — both doors (owner + POS manager):
//   GET  /suppliers                 everyone you buy from + deliveries count, what you paid, last delivery
//   POST /suppliers { name, contact, phone, address, note }    PUT /suppliers/:sid    DELETE /suppliers/:sid
//   GET  /suppliers/:sid            one supplier + their deliveries (each stock-in = one delivery, with its products)
// Receiving stock (POST /stock/in) can name the supplier + their invoice number.
const T = { needSup: "សូមដោះសោ “អ្នកផ្គត់ផ្គង់” ជាមុនសិន!" };

module.exports = (prop, kit) => {
  const { dual, managerOnly, Bad, MSG, text, validId, roundOf, M } = kit;
  const need = (ctx) => {
    if (!ctx.addons.mart_suppliers?.active) throw new Bad(T.needSup, 402, { product: "mart_suppliers" });
  };
  const read = (b, partial) => {
    const out = {};
    const name = text(b, "name", 100, { required: !partial });
    if (name !== undefined) {
      if (!name) throw new Bad(`${MSG.required}: name`);
      out.name = name;
    }
    for (const [k, max] of [
      ["contact", 80],
      ["phone", 40],
      ["address", 300],
      ["note", 1000],
    ]) {
      const v = text(b, k, max);
      if (v !== undefined) out[k] = v;
    }
    return out;
  };

  dual("get", "/suppliers", false, async (ctx, req, res) => {
    need(ctx);
    const bid = ctx.business._id;
    const [rows, sums] = await Promise.all([
      M.MartSupplier.find({ business_id: bid, active: true }).sort({ name: 1 }).lean(),
      M.MartStockMove.aggregate([
        { $match: { business_id: bid, kind: "in", supplier_id: { $ne: null } } },
        { $group: { _id: { s: "$supplier_id", b: "$batch" }, cost: { $sum: { $multiply: ["$qty", "$cost"] } }, at: { $max: "$created_date" } } },
        { $group: { _id: "$_id.s", deliveries: { $sum: 1 }, cost: { $sum: "$cost" }, last: { $max: "$at" } } },
      ]),
    ]);
    const r = roundOf(ctx.settings.currency);
    const by = new Map(sums.map((x) => [String(x._id), x]));
    res.json({ success: true, data: rows.map((x) => ({ ...x, deliveries: by.get(String(x._id))?.deliveries || 0, spent: r(by.get(String(x._id))?.cost || 0), last: by.get(String(x._id))?.last || null })) });
  });
  dual("post", "/suppliers", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const row = await M.MartSupplier.create({ business_id: ctx.business._id, ...read(req.body || {}, false) });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  const load = async (ctx, sid) => {
    if (!validId(sid)) throw new Bad(MSG.badId);
    const row = await M.MartSupplier.findOne({ _id: sid, business_id: ctx.business._id, active: true });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  dual("put", "/suppliers/:sid", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const row = await load(ctx, req.params.sid);
    row.set(read(req.body || {}, true));
    await row.save();
    res.json({ success: true, data: row, message: MSG.saved });
  });
  dual("delete", "/suppliers/:sid", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const row = await load(ctx, req.params.sid);
    row.active = false; // the stock history keeps their name
    await row.save();
    res.json({ success: true, message: MSG.deleted });
  });
  dual("get", "/suppliers/:sid", false, async (ctx, req, res) => {
    need(ctx);
    const row = await load(ctx, req.params.sid);
    const moves = await M.MartStockMove.find({ business_id: ctx.business._id, supplier_id: row._id, kind: "in" }).sort({ created_date: -1 }).limit(600).lean();
    const names = new Map(
      (
        await M.MartProduct.find({ _id: { $in: [...new Set(moves.map((x) => String(x.product_id)))] } })
          .select("name")
          .lean()
      ).map((p) => [String(p._id), p.name]),
    );
    const r = roundOf(ctx.settings.currency);
    const batches = new Map();
    for (const x of moves) {
      const k = x.batch || String(x._id);
      if (!batches.has(k)) batches.set(k, { batch: k, at: x.created_date, invoice_no: x.invoice_no || "", note: x.note || "", by: x.by, items: [], total: 0 });
      const b = batches.get(k);
      b.items.push({ name: names.get(String(x.product_id)) || "?", qty: x.qty, cost: x.cost });
      b.total = r(b.total + x.qty * (x.cost || 0));
    }
    res.json({ success: true, data: { ...row.toObject(), deliveries: [...batches.values()].slice(0, 100) } });
  });
};
