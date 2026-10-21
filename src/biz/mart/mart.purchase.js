// Reorder list + purchase orders (mart_purchase, forever) — both doors (owner + POS manager); needs stock control to receive.
//   GET  /reorder                       low / sold-out products, grouped by supplier, with how many to order
//   GET  /po?status=open|all|draft|…     POST /po { supplier_id, items: [{ product_id, qty, cost }], note }
//   GET  /po/:poid   PUT /po/:poid (draft / sent: items, note, supplier)   DELETE /po/:poid (draft only)
//   POST /po/:poid/send                    marked sent (the dashboard shares the text by Telegram / copies it)
//   POST /po/:poid/receive { items: [{ product_id, qty, cost, expires }], invoice_no }   the delivery came → stock in (partial is fine)
//   POST /po/:poid/cancel
const T = {
  need: "សូមដោះសោ “បញ្ជាទិញ” ជាមុនសិន!",
  noItems: "សូមបន្ថែមទំនិញ!",
  locked: "បញ្ជាទិញនេះមិនអាចកែបានទៀតទេ!",
  notDraft: "អាចលុបបានតែសេចក្តីព្រាងប៉ុណ្ណោះ!",
  needStock: "សូមដោះសោ “គ្រប់គ្រងស្តុក” ដើម្បីទទួលទំនិញ!",
};
const OPEN = ["draft", "sent", "partial"];

module.exports = (prop, kit) => {
  const { dual, managerOnly, Bad, MSG, text, num, validId, roundOf, M } = kit;
  const need = (ctx) => {
    if (!ctx.addons.mart_purchase?.active) throw new Bad(T.need, 402, { product: "mart_purchase" });
    managerOnly(ctx);
  };
  const r3 = (v) => Math.round(v * 1000) / 1000;
  // how many to order: the product's own number, or enough to be well over its "low" level
  const suggest = (p) => (p.reorder_qty > 0 ? p.reorder_qty : Math.max(1, Math.ceil((p.low_stock ?? 5) * 2 - Math.min(p.stock || 0, p.low_stock ?? 5))));

  dual("get", "/reorder", false, async (ctx, req, res) => {
    need(ctx);
    const bid = ctx.business._id;
    const prods = await M.MartProduct.find({ business_id: bid, active: true, track_stock: true, $expr: { $lte: ["$stock", { $ifNull: ["$low_stock", 5] }] } })
      .select("name barcode stock low_stock cost price supplier_id reorder_qty photo.url unit_id")
      .sort({ stock: 1, name: 1 })
      .limit(1000)
      .lean();
    // no supplier on the product: the one who brought it last time
    const missing = prods.filter((p) => !p.supplier_id).map((p) => p._id);
    const last = missing.length
      ? await M.MartStockMove.aggregate([{ $match: { business_id: bid, kind: "in", supplier_id: { $ne: null }, product_id: { $in: missing } } }, { $sort: { created_date: -1 } }, { $group: { _id: "$product_id", s: { $first: "$supplier_id" } } }])
      : [];
    const lastOf = new Map(last.map((x) => [String(x._id), x.s]));
    const sups = new Map((await M.MartSupplier.find({ business_id: bid, active: true }).select("name phone").lean()).map((s) => [String(s._id), s]));
    // what is already on its way (open purchase orders)
    const open = await M.MartPO.find({ business_id: bid, status: { $in: ["sent", "partial"] } })
      .select("items")
      .lean();
    const coming = new Map();
    for (const po of open) for (const it of po.items) coming.set(String(it.product_id), r3((coming.get(String(it.product_id)) || 0) + Math.max(0, it.qty - (it.received || 0))));
    const groups = new Map();
    for (const p of prods) {
      const sid = String(p.supplier_id || lastOf.get(String(p._id)) || "");
      const sup = sups.get(sid);
      const key = sup ? sid : "";
      const g = groups.get(key) || { supplier_id: sup ? sup._id : null, supplier: sup?.name || "", phone: sup?.phone || "", items: [] };
      g.items.push({ product_id: p._id, name: p.name, barcode: p.barcode, photo: p.photo?.url || "", stock: r3(p.stock || 0), low_stock: p.low_stock ?? 5, cost: p.cost || 0, qty: suggest(p), coming: coming.get(String(p._id)) || 0 });
      groups.set(key, g);
    }
    res.json({ success: true, data: { groups: [...groups.values()].sort((a, b) => (!a.supplier_id ? 1 : !b.supplier_id ? -1 : a.supplier.localeCompare(b.supplier))), count: prods.length, stock_on: !!ctx.addons.mart_stock?.active } });
  });

  const readItems = async (ctx, list) => {
    if (!Array.isArray(list) || !list.length) throw new Bad(T.noItems, 400, { code: "no_items" });
    if (list.length > 300) throw new Bad(MSG.tooMany);
    const pids = list.map((x) => String(x?.product_id || ""));
    if (!pids.every(validId)) throw new Bad(`${MSG.badValue} (items)`);
    const prods = new Map(
      (
        await M.MartProduct.find({ business_id: ctx.business._id, _id: { $in: pids } })
          .select("name cost")
          .lean()
      ).map((p) => [String(p._id), p]),
    );
    const out = new Map();
    for (const x of list) {
      const p = prods.get(String(x.product_id));
      if (!p) throw new Bad(MSG.rowNotFound, 404);
      const qty = r3(num(x, "qty", 0.001, 1000000, { required: true }));
      const cost = num(x, "cost", 0, 1000000000) ?? p.cost ?? 0;
      const k = String(p._id);
      if (out.has(k)) out.get(k).qty = r3(out.get(k).qty + qty);
      else out.set(k, { product_id: p._id, name: p.name, qty, cost, received: 0 });
    }
    return [...out.values()];
  };
  const supplierOf = async (ctx, sid) => {
    if (!sid) return { supplier_id: null, supplier_name: "" };
    if (!validId(sid)) throw new Bad(`${MSG.badValue} (supplier_id)`);
    const s = await M.MartSupplier.findOne({ _id: sid, business_id: ctx.business._id, active: true }).select("name").lean();
    if (!s) throw new Bad(`${MSG.badValue} (supplier_id)`);
    return { supplier_id: s._id, supplier_name: s.name };
  };
  const totalOf = (ctx, items) => roundOf(ctx.settings.currency)(items.reduce((a, x) => a + x.qty * (x.cost || 0), 0));

  dual("get", "/po", false, async (ctx, req, res) => {
    need(ctx);
    const st = String(req.query.status || "open");
    const filter = { business_id: ctx.business._id, ...(st === "all" ? {} : st === "open" ? { status: { $in: OPEN } } : M.PO_STATUSES.includes(st) ? { status: st } : {}) };
    const rows = await M.MartPO.find(filter).sort({ created_date: -1 }).limit(200).lean();
    const counts = Object.fromEntries((await M.MartPO.aggregate([{ $match: { business_id: ctx.business._id } }, { $group: { _id: "$status", n: { $sum: 1 } } }])).map((x) => [x._id, x.n]));
    res.json({ success: true, data: rows, counts });
  });
  dual("post", "/po", true, async (ctx, req, res) => {
    need(ctx);
    const b = req.body || {};
    const items = await readItems(ctx, b.items);
    const sup = await supplierOf(ctx, b.supplier_id);
    const seq = await M.MartSettings.findOneAndUpdate({ _id: ctx.settings._id }, { $inc: { next_po: 1 } }, { returnDocument: "before" }).lean();
    const row = await M.MartPO.create({ business_id: ctx.business._id, no: `PO-${String(seq?.next_po || 1).padStart(4, "0")}`, ...sup, items, total: totalOf(ctx, items), note: text(b, "note", 500) || "", by: ctx.by });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  const load = async (ctx, id) => {
    if (!validId(id)) throw new Bad(MSG.badId);
    const row = await M.MartPO.findOne({ _id: id, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  dual("get", "/po/:poid", false, async (ctx, req, res) => {
    need(ctx);
    res.json({ success: true, data: await load(ctx, req.params.poid) });
  });
  dual("put", "/po/:poid", true, async (ctx, req, res) => {
    need(ctx);
    const row = await load(ctx, req.params.poid);
    if (!["draft", "sent"].includes(row.status)) throw new Bad(T.locked, 409, { code: "locked" });
    const b = req.body || {};
    if (b.items !== undefined) {
      row.items = await readItems(ctx, b.items);
      row.total = totalOf(ctx, row.items);
    }
    if (b.supplier_id !== undefined) Object.assign(row, await supplierOf(ctx, b.supplier_id));
    const note = text(b, "note", 500);
    if (note !== undefined) row.note = note;
    await row.save();
    res.json({ success: true, data: row, message: MSG.saved });
  });
  dual("delete", "/po/:poid", true, async (ctx, req, res) => {
    need(ctx);
    const row = await load(ctx, req.params.poid);
    if (row.status !== "draft") throw new Bad(T.notDraft, 409, { code: "not_draft" });
    await row.deleteOne();
    res.json({ success: true, message: MSG.deleted });
  });
  dual("post", "/po/:poid/send", true, async (ctx, req, res) => {
    need(ctx);
    const row = await load(ctx, req.params.poid);
    if (!["draft", "sent"].includes(row.status)) throw new Bad(T.locked, 409, { code: "locked" });
    row.status = "sent";
    row.sent_at = new Date();
    await row.save();
    res.json({ success: true, data: row, message: MSG.saved });
  });
  dual("post", "/po/:poid/cancel", true, async (ctx, req, res) => {
    need(ctx);
    const row = await load(ctx, req.params.poid);
    if (!OPEN.includes(row.status)) throw new Bad(T.locked, 409, { code: "locked" });
    row.status = "cancelled";
    await row.save();
    res.json({ success: true, data: row, message: MSG.saved });
  });
  // the delivery arrived: what came in goes into the stock (with the supplier + invoice, and expiry days)
  dual("post", "/po/:poid/receive", true, async (ctx, req, res) => {
    need(ctx);
    if (!ctx.addons.mart_stock?.active) throw new Bad(T.needStock, 402, { product: "mart_stock" });
    const row = await load(ctx, req.params.poid);
    if (!["draft", "sent", "partial"].includes(row.status)) throw new Bad(T.locked, 409, { code: "locked" });
    const b = req.body || {};
    // nothing listed = everything still missing arrived
    const list = Array.isArray(b.items) && b.items.length ? b.items : row.items.map((x) => ({ product_id: x.product_id, qty: Math.max(0, r3(x.qty - (x.received || 0))), cost: x.cost })).filter((x) => x.qty > 0);
    const items = list.filter((x) => Number(x?.qty) > 0);
    if (!items.length) throw new Bad(T.noItems, 400, { code: "no_items" });
    for (const x of items) if (!row.items.some((it) => String(it.product_id) === String(x.product_id))) throw new Bad(`${MSG.badValue} (items)`);
    const ctxSup = row.supplier_id && ctx.addons.mart_suppliers?.active ? row.supplier_id : null;
    await kit.stock.receive(ctx, { items, note: row.no, supplier_id: ctxSup, invoice_no: text(b, "invoice_no", 60) || "" }, { po_id: row._id });
    for (const x of items) {
      const it = row.items.find((y) => String(y.product_id) === String(x.product_id));
      it.received = r3((it.received || 0) + Number(x.qty));
      if (x.cost !== undefined && x.cost !== "") it.cost = Number(x.cost) || 0;
    }
    row.markModified("items");
    row.total = totalOf(ctx, row.items);
    row.status = row.items.every((it) => it.received >= it.qty - 1e-9) ? "received" : "partial";
    if (row.status === "received") row.received_at = new Date();
    row.invoice_no = text(b, "invoice_no", 60) || row.invoice_no;
    await row.save();
    res.json({ success: true, data: row, message: MSG.saved });
  });
};
