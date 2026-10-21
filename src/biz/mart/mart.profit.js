// Profit report (mart_profit, yearly) — both doors (owner + POS manager):
//   GET /profit?day=YYYY-MM-DD | ?month=YYYY-MM | ?from&to
//       totals { revenue, cost, profit, margin }, by product, by category, by day / hour, lowest margins, products sold without a cost
// Each sale line keeps what the product cost at the time of the sale; older sales use today's cost (marked "estimated").
// Revenue is after every discount (promotions, the cashier's discount, points), shared over the lines.
const T = { need: "សូមដោះសោ “របាយការណ៍ប្រាក់ចំណេញ” ជាមុនសិន!" };

module.exports = (prop, kit) => {
  const { dual, managerOnly, Bad, roundOf, M } = kit;
  const need = (ctx) => {
    if (!ctx.addons.mart_profit?.active) throw new Bad(T.need, 402, { product: "mart_profit" });
  };
  dual("get", "/profit", false, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const { rangeOf, limitRange, startOf } = kit.range;
    const { from, to, kind, since, limited } = limitRange(ctx, rangeOf(req.query));
    const bid = ctx.business._id;
    const cur = ctx.settings.currency;
    const r = roundOf(cur);
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const sales = await M.MartSale.find({ business_id: bid, status: "paid", at: { $gte: startOf(from), $lt: startOf(to) } })
      .select("items subtotal total at")
      .lean();
    const pids = [...new Set(sales.flatMap((x) => x.items.filter((l) => l.product_id).map((l) => String(l.product_id))))];
    const [prods, cats] = await Promise.all([
      M.MartProduct.find({ business_id: bid, _id: { $in: pids } })
        .select("name cost category_id price")
        .lean(),
      M.MartCategory.find({ business_id: bid }).select("name color").lean(),
    ]);
    const prodOf = new Map(prods.map((p) => [String(p._id), p]));
    const catOf = new Map(cats.map((c) => [String(c._id), c]));
    const local = (d) => new Date(new Date(d).getTime() + 7 * 3600000).toISOString();
    const byProduct = new Map();
    const byCat = new Map();
    const series = {};
    let revenue = 0;
    let cost = 0;
    let estimated = 0;
    let noCost = 0;
    for (const s of sales) {
      const share = s.subtotal > 0 ? s.total / s.subtotal : 1; // every discount, shared over the lines
      const sk = kind === "day" ? local(s.at).slice(11, 13) : local(s.at).slice(0, 10);
      series[sk] = series[sk] || { key: sk, revenue: 0, cost: 0, profit: 0 };
      for (const l of s.items) {
        const p = l.product_id ? prodOf.get(String(l.product_id)) : null;
        const net = l.total * share;
        let unit = l.cost;
        if (unit === undefined || unit === null) {
          unit = p ? p.cost || 0 : 0;
          if (p) estimated += 1;
        }
        const c = unit * l.qty;
        if (!unit && l.product_id) noCost += 1;
        revenue += net;
        cost += c;
        series[sk].revenue += net;
        series[sk].cost += c;
        const key = l.product_id ? String(l.product_id) : `n:${l.name}`;
        const t = byProduct.get(key) || { product_id: l.product_id || null, name: p?.name || l.name, qty: 0, revenue: 0, cost: 0, no_cost: false, category_id: p?.category_id ? String(p.category_id) : "" };
        t.qty = r3(t.qty + l.qty);
        t.revenue += net;
        t.cost += c;
        if (!unit && l.product_id) t.no_cost = true;
        byProduct.set(key, t);
        const ck = l.product_id ? t.category_id || "-" : "x"; // x = delivery fees and lines without a product
        const ct = byCat.get(ck) || { category_id: ck, name: catOf.get(ck)?.name || "", color: catOf.get(ck)?.color || "", revenue: 0, cost: 0, qty: 0 };
        ct.revenue += net;
        ct.cost += c;
        ct.qty = r3(ct.qty + l.qty);
        byCat.set(ck, ct);
      }
    }
    const fin = (x) => {
      const rev = r(x.revenue);
      const cst = r(x.cost);
      return { ...x, revenue: rev, cost: cst, profit: r(rev - cst), margin: rev > 0 ? Math.round(((rev - cst) / rev) * 1000) / 10 : 0 };
    };
    const products = [...byProduct.values()].map(fin);
    res.json({
      success: true,
      data: {
        kind,
        from,
        to,
        since,
        limited,
        currency: cur,
        totals: { ...fin({ revenue, cost }), receipts: sales.length, estimated, no_cost: noCost },
        products: [...products].sort((a, b) => b.profit - a.profit).slice(0, 100),
        low_margin: products
          .filter((x) => x.product_id && !x.no_cost && x.revenue > 0 && x.margin < 10)
          .sort((a, b) => a.margin - b.margin)
          .slice(0, 20),
        no_cost: products.filter((x) => x.no_cost).slice(0, 50),
        categories: [...byCat.values()].map(fin).sort((a, b) => b.profit - a.profit),
        series: Object.values(series)
          .map(fin)
          .sort((a, b) => (a.key < b.key ? -1 : 1)),
      },
    });
  });
};
