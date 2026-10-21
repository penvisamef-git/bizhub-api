// Expiry dates (mart_expiry, yearly) — both doors (owner + POS manager):
//   GET    /expiry?show=all|soon|expired     batches still on the shelf, the soonest first (= sell these first) + counts, value at risk
//   POST   /expiry { product_id, qty, expires, note }     the expiry of stock already on the shelf (the stock does not change)
//   PUT    /expiry/:bid { left, expires, note }           DELETE /expiry/:bid   (sold / gone)
//   POST   /expiry/:bid/waste { qty, reason }             thrown away: leaves the batch and the stock (a "waste" stock move)
//   POST   /waste { product_id, qty, reason }             damaged / broken (no batch)
//   GET    /waste?month=YYYY-MM                           the waste record + what it cost
//   PUT    /expiry/settings { days }                      warn this many days before
// Stock received with an expiry day (Stock → Receive) makes a batch; each sale takes from the soonest batch; a void puts it back.
const T = {
  need: "សូមដោះសោ “ថ្ងៃផុតកំណត់” ជាមុនសិន!",
  badDay: "ថ្ងៃផុតកំណត់មិនត្រឹមត្រូវ!",
  tooMuch: "ចំនួនលើសពីអ្វីដែលនៅសល់!",
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

module.exports = (prop, kit) => {
  const { dual, managerOnly, Bad, MSG, text, num, validId, localDay, roundOf, M } = kit;
  const on = (ctx) => !!ctx.addons?.mart_expiry?.active;
  const need = (ctx) => {
    if (!on(ctx)) throw new Bad(T.need, 402, { product: "mart_expiry" });
  };
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const dayOf = (v) => {
    const d = String(v || "").slice(0, 10);
    if (!DAY_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new Bad(T.badDay, 400, { code: "bad_day" });
    return d;
  };
  const plusDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const daysLeft = (expires, today) => Math.round((Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const warnDays = (ctx) => ctx.settings.expiry_days || 30;

  async function addBatch(ctx, { product_id, qty, expires, cost = 0, note = "" }) {
    return M.MartBatch.create({ business_id: ctx.business._id, product_id, qty: r3(qty), left: r3(qty), expires: dayOf(expires), cost, note, by: ctx.by });
  }

  // the shelf: batches with something left, the soonest first
  async function shelf(bid, today, days, show = "all") {
    const q = { business_id: bid, left: { $gt: 0 } };
    if (show === "expired") q.expires = { $lt: today };
    else if (show === "soon") q.expires = { $lte: plusDays(today, days) };
    const rows = await M.MartBatch.find(q).sort({ expires: 1, created_date: 1 }).limit(1000).lean();
    const prods = new Map(
      (
        await M.MartProduct.find({ _id: { $in: [...new Set(rows.map((x) => String(x.product_id)))] } })
          .select("name barcode photo.url price cost stock")
          .lean()
      ).map((p) => [String(p._id), p]),
    );
    return rows
      .filter((x) => prods.has(String(x.product_id)))
      .map((x) => {
        const p = prods.get(String(x.product_id));
        const d = daysLeft(x.expires, today);
        return { ...x, name: p.name, barcode: p.barcode, photo: p.photo?.url || "", price: p.price, days_left: d, state: d < 0 ? "expired" : d <= days ? "soon" : "ok", value: r3(x.left * (x.cost || p.cost || 0)) };
      });
  }

  dual("get", "/expiry", false, async (ctx, req, res) => {
    need(ctx);
    const bid = ctx.business._id;
    const today = localDay();
    const days = warnDays(ctx);
    const all = await shelf(bid, today, days, "all");
    const show = ["soon", "expired"].includes(req.query.show) ? req.query.show : "all";
    const r = roundOf(ctx.settings.currency);
    const count = (k) => all.filter((x) => x.state === k).length;
    const risk = all.filter((x) => x.state !== "ok");
    res.json({
      success: true,
      data: {
        today,
        days,
        rows: show === "all" ? all : all.filter((x) => (show === "expired" ? x.state === "expired" : x.state !== "ok")),
        counts: { all: all.length, expired: count("expired"), soon: count("soon"), ok: count("ok") },
        at_risk: r(risk.reduce((a, x) => a + x.value, 0)),
        at_risk_sale: r(risk.reduce((a, x) => a + x.left * (x.price || 0), 0)),
      },
    });
  });
  dual("post", "/expiry", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const b = req.body || {};
    if (!validId(b.product_id)) throw new Bad(MSG.badId);
    const p = await M.MartProduct.findOne({ _id: b.product_id, business_id: ctx.business._id }).select("cost").lean();
    if (!p) throw new Bad(MSG.rowNotFound, 404);
    const row = await addBatch(ctx, { product_id: p._id, qty: num(b, "qty", 0.001, 1000000, { required: true }), expires: b.expires, cost: p.cost || 0, note: text(b, "note", 200) || "" });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  const load = async (ctx, id) => {
    if (!validId(id)) throw new Bad(MSG.badId);
    const row = await M.MartBatch.findOne({ _id: id, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  dual("put", "/expiry/settings", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const days = num(req.body || {}, "days", 1, 365, { required: true, int: true });
    ctx.settings.expiry_days = days;
    await ctx.settings.save();
    res.json({ success: true, data: { days }, message: MSG.saved });
  });
  dual("put", "/expiry/:bid", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const row = await load(ctx, req.params.bid);
    const b = req.body || {};
    const left = num(b, "left", 0, 1000000);
    if (left !== undefined) row.left = r3(left);
    if (b.expires !== undefined) row.expires = dayOf(b.expires);
    const note = text(b, "note", 200);
    if (note !== undefined) row.note = note;
    await row.save();
    res.json({ success: true, data: row, message: MSG.saved });
  });
  dual("delete", "/expiry/:bid", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const row = await load(ctx, req.params.bid);
    await row.deleteOne();
    res.json({ success: true, message: MSG.deleted });
  });

  // thrown away: the stock goes down (when stock control is on) and the waste record keeps what it cost
  async function waste(ctx, productId, qty, reason, batch) {
    const bid = ctx.business._id;
    const p = await M.MartProduct.findOne({ _id: productId, business_id: bid });
    if (!p) throw new Bad(MSG.rowNotFound, 404);
    const stockOn = !!ctx.addons?.mart_stock?.active && p.track_stock !== false;
    let after = p.stock || 0;
    if (stockOn) {
      const up = await M.MartProduct.findOneAndUpdate({ _id: p._id }, { $inc: { stock: -qty } }, { returnDocument: "after" }).lean();
      after = up.stock;
      kit.stock?.warn(ctx, [{ name: p.name, before: r3(after + qty), after, low: p.low_stock ?? 5, track: true }]);
    }
    await M.MartStockMove.create({ business_id: bid, product_id: p._id, kind: "waste", qty: -qty, stock_after: r3(after), cost: batch?.cost || p.cost || 0, note: reason || (batch ? `expired ${batch.expires}` : ""), by: ctx.by });
    return { stock: r3(after) };
  }
  dual("post", "/expiry/:bid/waste", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const b = req.body || {};
    const row = await load(ctx, req.params.bid);
    const qty = r3(num(b, "qty", 0.001, 1000000) ?? row.left);
    if (qty > row.left + 1e-9) throw new Bad(T.tooMuch, 400, { code: "too_much", left: row.left });
    row.left = r3(row.left - qty);
    row.wasted = r3((row.wasted || 0) + qty);
    await row.save();
    const out = await waste(ctx, row.product_id, qty, text(b, "reason", 200) || "", row);
    res.json({ success: true, data: { batch: row, ...out }, message: MSG.saved });
  });
  dual("post", "/waste", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const b = req.body || {};
    if (!validId(b.product_id)) throw new Bad(MSG.badId);
    const qty = r3(num(b, "qty", 0.001, 1000000, { required: true }));
    const out = await waste(ctx, b.product_id, qty, text(b, "reason", 200) || "", null);
    res.json({ success: true, data: out, message: MSG.saved });
  });
  dual("get", "/waste", false, async (ctx, req, res) => {
    need(ctx);
    const bid = ctx.business._id;
    const month = MONTH_RE.test(String(req.query.month || "")) ? String(req.query.month) : localDay().slice(0, 7);
    const [y, m] = month.split("-").map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1) - 7 * 3600000);
    const to = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 7 * 3600000);
    const rows = await M.MartStockMove.find({ business_id: bid, kind: "waste", created_date: { $gte: from, $lt: to } })
      .sort({ created_date: -1 })
      .limit(1000)
      .lean();
    const names = new Map(
      (
        await M.MartProduct.find({ _id: { $in: [...new Set(rows.map((x) => String(x.product_id)))] } })
          .select("name")
          .lean()
      ).map((p) => [String(p._id), p.name]),
    );
    const r = roundOf(ctx.settings.currency);
    const list = rows.map((x) => ({ ...x, name: names.get(String(x.product_id)) || "?", qty: -x.qty, value: r(-x.qty * (x.cost || 0)) }));
    const by = new Map();
    for (const x of list) {
      const t = by.get(String(x.product_id)) || { product_id: x.product_id, name: x.name, qty: 0, value: 0 };
      t.qty = r3(t.qty + x.qty);
      t.value = r(t.value + x.value);
      by.set(String(x.product_id), t);
    }
    res.json({ success: true, data: { month, rows: list, total: r(list.reduce((a, x) => a + x.value, 0)), count: list.length, by_product: [...by.values()].sort((a, b) => b.value - a.value) } });
  });

  // a sale takes from the soonest batch (expired ones too: they were on the shelf); a void puts it back on the latest one it could be
  async function take(ctx, sale) {
    if (!on(ctx)) return;
    const bid = ctx.business._id;
    const qty = new Map();
    for (const l of sale.items) if (l.product_id) qty.set(String(l.product_id), r3((qty.get(String(l.product_id)) || 0) + l.qty));
    if (!qty.size) return;
    const batches = await M.MartBatch.find({ business_id: bid, product_id: { $in: [...qty.keys()] }, left: { $gt: 0 } }).sort({ expires: 1, created_date: 1 });
    for (const bt of batches) {
      const k = String(bt.product_id);
      const want = qty.get(k) || 0;
      if (want <= 0) continue;
      const n = r3(Math.min(want, bt.left));
      bt.left = r3(bt.left - n);
      qty.set(k, r3(want - n));
      await bt.save();
    }
  }
  async function giveBack(ctx, sale) {
    if (!on(ctx)) return;
    const bid = ctx.business._id;
    const today = localDay();
    for (const l of sale.items) {
      if (!l.product_id) continue;
      const bt = (await M.MartBatch.findOne({ business_id: bid, product_id: l.product_id, expires: { $gte: today }, $expr: { $lt: ["$left", "$qty"] } }).sort({ expires: 1 })) || null;
      if (bt) {
        bt.left = r3(Math.min(bt.qty, bt.left + l.qty));
        await bt.save();
      }
    }
  }
  // for the daily Telegram summary
  async function summary(bid, settings) {
    const today = localDay();
    const rows = await shelf(bid, today, settings.expiry_days || 30, "soon");
    return { expired: rows.filter((x) => x.state === "expired"), soon: rows.filter((x) => x.state === "soon") };
  }
  return { on, dayOf, addBatch, take, giveBack, summary };
};
