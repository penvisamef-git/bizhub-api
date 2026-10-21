// Stock control (mart_stock, yearly) — both doors (owner dashboard + POS manager):
//   GET  /stock?filter=low|out|all        products with their stock + counts (low = at or under its "low" level)
//   POST /stock/in { items: [{ product_id, qty, cost }], note }     stock received (cost updates the product cost)
//   POST /stock/count { product_id, count, note }                   counted on the shelf: the stock becomes this
//   GET  /stock/moves?product_id=          the history (last 300)
// Each paid sale takes its items from the stock, a voided sale puts them back (also offline sales, when they arrive).
// When the add-on ends, the stock stays as it is and sales stop changing it.
const T = {
  needStock: "សូមដោះសោ “គ្រប់គ្រងស្តុក” ជាមុនសិន!",
  noItems: "សូមបន្ថែមទំនិញ!",
};

module.exports = (prop, kit) => {
  const { dual, managerOnly, Bad, MSG, text, num, validId, M } = kit;
  const on = (ctx) => !!ctx.addons.mart_stock?.active;
  const need = (ctx) => {
    if (!on(ctx)) throw new Bad(T.needStock, 402, { product: "mart_stock" });
  };
  const r3 = (v) => Math.round(v * 1000) / 1000;
  // Telegram (mart_telegram): a product that just went low or sold out (only when it crosses the line, so no repeats)
  const warn = (ctx, list) => {
    const items = list.filter((x) => x.track && ((x.before > 0 && x.after <= 0) || (x.before > x.low && x.after <= x.low && x.after > 0))).map((x) => ({ name: x.name, stock: r3(x.after), low: x.low }));
    if (items.length) kit.tg?.alert(ctx.business._id, "low_stock", { items }, { settings: ctx.settings, addons: ctx.addons, name: ctx.business.name }).catch(() => {});
  };
  const stateOf = (p) => (!p.track_stock ? "off" : p.stock <= 0 ? "out" : p.stock <= (p.low_stock ?? 5) ? "low" : "ok");

  dual("get", "/stock", false, async (ctx, req, res) => {
    need(ctx);
    const rows = await M.MartProduct.find({ business_id: ctx.business._id, active: true }).select("name barcode category_id unit_id price cost stock low_stock track_stock photo.url").sort({ name: 1 }).lean();
    const list = rows.map((p) => ({ ...p, state: stateOf(p) }));
    const f = String(req.query.filter || "all");
    const count = (k) => list.filter((p) => p.state === k).length;
    const value = list.filter((p) => p.track_stock && p.stock > 0).reduce((a, p) => a + p.stock * (p.cost || 0), 0);
    res.json({
      success: true,
      data: {
        rows: f === "low" ? list.filter((p) => p.state === "low") : f === "out" ? list.filter((p) => p.state === "out") : list,
        counts: { all: list.length, ok: count("ok"), low: count("low"), out: count("out"), off: count("off") },
        value: Math.round(value * 100) / 100,
      },
    });
  });

  dual("post", "/stock/in", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const out = await receive(ctx, req.body || {});
    res.json({ success: true, data: out, message: MSG.saved });
  });
  // stock received (also from a purchase order): items [{ product_id, qty, cost, expires }] — expires (YYYY-MM-DD) makes a batch (mart_expiry)
  async function receive(ctx, b, extra = {}) {
    if (!Array.isArray(b.items) || !b.items.length) throw new Bad(T.noItems);
    if (b.items.length > 500) throw new Bad(MSG.tooMany);
    const note = text(b, "note", 200) || "";
    // suppliers add-on: which supplier brought it + their invoice number
    let supplierId = null;
    if (b.supplier_id && ctx.addons.mart_suppliers?.active) {
      if (!validId(b.supplier_id) || !(await M.MartSupplier.exists({ _id: b.supplier_id, business_id: ctx.business._id, active: true }))) throw new Bad(`${MSG.badValue} (supplier_id)`);
      supplierId = b.supplier_id;
    }
    const invoiceNo = ctx.addons.mart_suppliers?.active ? text(b, "invoice_no", 60) || "" : "";
    const batch = require("crypto").randomBytes(6).toString("hex");
    const bid = ctx.business._id;
    const lines = b.items.map((it, i) => {
      const x = it || {};
      if (!validId(x.product_id)) throw new Bad(`${MSG.badValue} (items[${i}].product_id)`);
      const qty = num(x, "qty", 0.001, 1000000, { required: true });
      const cost = num(x, "cost", 0, 1000000000);
      const expires = x.expires ? kit.expiry?.dayOf(x.expires) : "";
      return { product_id: String(x.product_id), qty: r3(qty), cost, expires };
    });
    const found = await M.MartProduct.find({ business_id: bid, _id: { $in: lines.map((l) => l.product_id) } })
      .select("_id cost")
      .lean();
    if (found.length !== new Set(lines.map((l) => l.product_id)).size) throw new Bad(MSG.rowNotFound, 404);
    const out = [];
    for (const l of lines) {
      const p = await M.MartProduct.findOneAndUpdate({ _id: l.product_id, business_id: bid }, { $inc: { stock: l.qty }, ...(l.cost !== undefined ? { $set: { cost: l.cost } } : {}) }, { returnDocument: "after" }).lean();
      await M.MartStockMove.create({
        business_id: bid,
        product_id: p._id,
        kind: "in",
        qty: l.qty,
        stock_after: r3(p.stock),
        cost: l.cost ?? p.cost ?? 0,
        note,
        supplier_id: supplierId,
        batch,
        invoice_no: invoiceNo,
        po_id: extra.po_id || null,
        by: ctx.by,
      });
      if (l.expires && kit.expiry?.on(ctx)) await kit.expiry.addBatch(ctx, { product_id: p._id, qty: l.qty, expires: l.expires, cost: l.cost ?? p.cost ?? 0, note });
      out.push({ _id: p._id, stock: r3(p.stock) });
    }
    return out;
  }

  dual("post", "/stock/count", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const b = req.body || {};
    if (!validId(b.product_id)) throw new Bad(MSG.badId);
    const count = r3(num(b, "count", -1000000, 1000000, { required: true }));
    const bid = ctx.business._id;
    const before = await M.MartProduct.findOneAndUpdate({ _id: b.product_id, business_id: bid }, { $set: { stock: count } }, { returnDocument: "before" }).lean();
    if (!before) throw new Bad(MSG.rowNotFound, 404);
    warn(ctx, [{ name: before.name, before: before.stock || 0, after: count, low: before.low_stock ?? 5, track: before.track_stock !== false }]);
    const diff = r3(count - (before.stock || 0));
    if (diff !== 0) await M.MartStockMove.create({ business_id: bid, product_id: before._id, kind: "adjust", qty: diff, stock_after: count, note: text(b, "note", 200) || "", by: ctx.by });
    res.json({ success: true, data: { _id: before._id, stock: count, diff }, message: MSG.saved });
  });

  dual("get", "/stock/moves", false, async (ctx, req, res) => {
    need(ctx);
    const q = { business_id: ctx.business._id };
    if (req.query.product_id) {
      if (!validId(req.query.product_id)) throw new Bad(MSG.badId);
      q.product_id = req.query.product_id;
    }
    const rows = await M.MartStockMove.find(q).sort({ created_date: -1 }).limit(300).lean();
    const sups = new Map((await M.MartSupplier.find({ business_id: ctx.business._id }).select("name").lean()).map((x) => [String(x._id), x.name]));
    const names = new Map(
      (
        await M.MartProduct.find({ _id: { $in: [...new Set(rows.map((x) => String(x.product_id)))] } })
          .select("name")
          .lean()
      ).map((p) => [String(p._id), p.name]),
    );
    res.json({ success: true, data: rows.map((x) => ({ ...x, name: names.get(String(x.product_id)) || "?", supplier: x.supplier_id ? sups.get(String(x.supplier_id)) || "" : "" })) });
  });

  // a sale takes its items from the stock (sign = -1), a void puts them back (sign = +1)
  async function apply(ctx, sale, sign) {
    if (!on(ctx)) return;
    const bid = ctx.business._id;
    const qty = new Map();
    for (const l of sale.items) if (l.product_id) qty.set(String(l.product_id), r3((qty.get(String(l.product_id)) || 0) + l.qty));
    if (!qty.size) return;
    const tracked = await M.MartProduct.find({ business_id: bid, _id: { $in: [...qty.keys()] }, track_stock: true })
      .select("_id")
      .lean();
    const changes = [];
    for (const p of tracked) {
      const n = qty.get(String(p._id)) * sign;
      const after = await M.MartProduct.findOneAndUpdate({ _id: p._id }, { $inc: { stock: n } }, { returnDocument: "after" })
        .select("stock name low_stock")
        .lean();
      changes.push({ name: after.name, before: r3(after.stock - n), after: after.stock, low: after.low_stock ?? 5, track: true });
      await M.MartStockMove.create({ business_id: bid, product_id: p._id, kind: sign < 0 ? "sale" : "void", qty: n, stock_after: r3(after.stock), sale_id: sale._id, sale_no: sale.no, by: ctx.by });
    }
    if (sign < 0) warn(ctx, changes);
  }
  return { on, need, warn, receive, take: (ctx, sale) => apply(ctx, sale, -1), giveBack: (ctx, sale) => apply(ctx, sale, 1) };
};
