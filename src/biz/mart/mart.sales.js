// Mini Mart sales — both doors (owner dashboard + POS):
//   POST /sales { client_id, items: [{ product_id, name, barcode, price, qty }], discount, method, paid_usd, paid_khr, at }
//        the POS makes client_id: the same sale sent twice (offline queue) is saved once
//   GET  /sales?day=YYYY-MM-DD (or ?from&to)    the receipts of those days + totals
//   GET  /sales/:sid
//   POST /sales/:sid/void { reason }           (owner / manager)
//   GET  /report?day=YYYY-MM-DD | ?month=YYYY-MM   totals, by method, by hour / day, top products, by cashier
const { saleMoney } = require("./mart.calc");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const T = {
  history: "អាចមើលបានតែ 30 ថ្ងៃចុងក្រោយ។ សូមដោះសោ “ប្រវត្តិរបាយការណ៍ទាំងអស់”។",
  empty: "សូមបន្ថែមទំនិញជាមុនសិន!",
  short: "ប្រាក់ទទួលមិនគ្រប់! នៅខ្វះ {amt}។",
  tooManyLines: "ទំនិញច្រើនពេកក្នុងវិក្កយបត្រមួយ!",
  voided: "វិក្កយបត្រនេះត្រូវបានលុបចោលរួចហើយ!",
};

module.exports = (prop, kit) => {
  const { dual, managerOnly, Bad, MSG, text, num, validId, localDay, roundOf, methodKeys, methodName, M } = kit;
  const stock = () => kit.stock;
  const debt = () => kit.debt;
  const startOf = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 3600000);
  const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const nextMonth = (m) => {
    const [y, mm] = m.split("-").map(Number);
    return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
  };
  const realDay = (v) => DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  const rangeOf = (q) => {
    if (MONTH_RE.test(String(q.month || ""))) return { from: `${q.month}-01`, to: `${nextMonth(q.month)}-01`, kind: "month" };
    if (realDay(String(q.from || "")) && realDay(String(q.to || "")) && q.from <= q.to) return { from: q.from, to: nextDay(q.to), kind: "range" };
    const day = realDay(String(q.day || "")) ? String(q.day) : localDay();
    return { from: day, to: nextDay(day), kind: "day" };
  };

  dual("post", "/sales", true, async (ctx, req, res) => {
    const b = req.body || {};
    const bid = ctx.business._id;
    const s = ctx.settings;
    const clientId = b.client_id === undefined ? undefined : String(b.client_id);
    if (clientId !== undefined && !/^[A-Za-z0-9_-]{8,40}$/.test(clientId)) throw new Bad(`${MSG.badValue} (client_id)`);
    if (clientId) {
      const same = await M.MartSale.findOne({ business_id: bid, client_id: clientId }).lean();
      if (same) return res.json({ success: true, data: same, duplicate: true });
    }
    if (!Array.isArray(b.items) || !b.items.length) throw new Bad(T.empty, 400, { code: "empty" });
    if (b.items.length > 300) throw new Bad(T.tooManyLines);
    const r = roundOf(s.currency);
    const lines = b.items.map((it, i) => {
      const x = it || {};
      const name = text(x, "name", 120, { required: true });
      const price = num(x, "price", 0, 1000000000, { required: true });
      const qty = num(x, "qty", 0.001, 100000, { required: true });
      if (x.product_id && !validId(x.product_id)) throw new Bad(`${MSG.badValue} (items[${i}].product_id)`);
      const barcode = text(x, "barcode", 40) || "";
      return { product_id: x.product_id || null, name, barcode, price: r(price), qty: Math.round(qty * 1000) / 1000 };
    });
    // "debt": written in the debt book (mart_debt) — the customer pays later
    const isDebt = b.method === "debt";
    let debtor = null;
    if (isDebt) {
      debt().need(ctx);
      debtor = await debt().resolveDebtor(ctx, b);
    }
    const method = isDebt ? "debt" : methodKeys(s).includes(b.method) ? b.method : "cash";
    // the unit of each line, as it is today (Khmer + English), kept on the receipt
    const ids = [...new Set(lines.filter((l) => l.product_id).map((l) => String(l.product_id)))];
    const categoryOf = {};
    if (ids.length) {
      const prods = await M.MartProduct.find({ business_id: bid, _id: { $in: ids } })
        .select("unit_id cost category_id")
        .lean();
      const units = new Map((await M.MartUnit.find({ business_id: bid }).lean()).map((u) => [String(u._id), u]));
      const unitOf = new Map(prods.map((p) => [String(p._id), units.get(String(p.unit_id))]));
      const costOf = new Map(prods.map((p) => [String(p._id), p.cost || 0]));
      for (const p of prods) categoryOf[String(p._id)] = p.category_id ? String(p.category_id) : "";
      for (const l of lines) {
        const u = l.product_id && unitOf.get(String(l.product_id));
        if (u) Object.assign(l, { unit_en: u.name_en || u.name_km, unit_km: u.name_km || u.name_en });
        if (l.product_id && costOf.has(String(l.product_id))) l.cost = costOf.get(String(l.product_id)); // profit report
      }
    }
    // a sale made offline keeps its own time (up to 14 days back)
    let at = new Date();
    if (b.at) {
      const t = new Date(b.at).getTime();
      if (Number.isFinite(t) && t <= Date.now() + 5 * 60000 && t >= Date.now() - 14 * 86400000) at = new Date(Math.min(t, Date.now()));
    }
    const offline = b.offline === true;
    // promotions (mart_promos): worked out here again with the sale's time — the POS shows the same
    const promo = await kit.promos.forSale(ctx, lines, { at, where: "pos", coupon: b.coupon, categoryOf, strict: !offline });
    // loyalty (mart_loyalty): the member (by phone) + points used now
    const member = await kit.loyalty.memberFor(ctx, b, { create: true });
    const manual = num(b, "discount", 0, 1000000000) || 0;
    const pts = member ? kit.loyalty.redeemOf(ctx, member, b.redeem, { offline, left: r(lines.reduce((a, l) => a + l.price * l.qty, 0) - promo.discount - manual) }) : { points: 0, value: 0 };
    const money = saleMoney({
      lines,
      promo: promo.discount,
      points: pts.value,
      discount: manual,
      currency: s.currency,
      rate: s.khr_rate,
      method,
      paid_usd: num(b, "paid_usd", 0, 1000000) || 0,
      paid_khr: num(b, "paid_khr", 0, 10000000000) || 0,
      khr_round: s.khr_round || 100,
    });
    if (money.short > 0) throw new Bad(T.short.replace("{amt}", s.currency === "KHR" ? `${money.short}៛` : `$${money.short}`), 400, { code: "short", short: money.short });
    const seq = await M.MartSettings.findOneAndUpdate({ _id: s._id }, { $inc: { next_no: 1 } }, { returnDocument: "before" }).lean();
    const no = `S-${String(seq?.next_no || 1).padStart(6, "0")}`;
    try {
      const row = await M.MartSale.create({
        business_id: bid,
        no,
        client_id: clientId,
        items: money.items,
        subtotal: money.subtotal,
        discount: money.discount,
        promo_discount: money.promo_discount,
        promos: promo.applied.length ? promo.applied.map((x) => ({ id: x.id, name: x.name, amount: x.amount })) : undefined,
        coupon:
          promo.coupon === "ok"
            ? String(b.coupon || "")
                .trim()
                .toUpperCase()
            : "",
        member_id: member ? member._id : null,
        member_name: member ? member.name : "",
        member_phone: member ? member.phone : "",
        points_used: money.points_value > 0 ? pts.points : 0,
        points_value: money.points_value,
        total: money.total,
        currency: s.currency,
        khr_rate: s.khr_rate,
        method,
        method_name: methodName(s, method),
        debtor_id: debtor ? debtor._id : null,
        debtor_name: debtor ? debtor.name : "",
        paid_usd: method === "cash" ? Number(b.paid_usd) || 0 : 0,
        paid_khr: method === "cash" ? Number(b.paid_khr) || 0 : 0,
        change: money.change,
        change_khr: money.change_khr,
        at,
        by: ctx.by,
        staff_id: ctx.staff?._id || null,
        device_id: ctx.device?._id || null,
        offline,
      });
      await stock().take(ctx, row); // stock control: sold items leave the stock
      await kit.expiry.take(ctx, row); // expiry dates: from the soonest batch
      await kit.promos.used(promo.applied);
      if (member) {
        const done = await kit.loyalty.afterSale(ctx, member, row); // points used + earned
        if (done) row.points_earned = done.earned;
      }
      if (debtor) await debt().saleUp(ctx, debtor, row, 1); // written in the debt book
      res.status(201).json({ success: true, data: row, message: MSG.saved });
    } catch (err) {
      if (err.code === 11000 && clientId) {
        const same = await M.MartSale.findOne({ business_id: bid, client_id: clientId }).lean();
        if (same) return res.json({ success: true, data: same, duplicate: true });
      }
      throw err;
    }
  });

  const totalsOf = (rows, cur) => {
    const r = roundOf(cur);
    const paid = rows.filter((x) => x.status === "paid");
    const byMethod = {};
    for (const x of paid) byMethod[x.method] = r((byMethod[x.method] || 0) + x.total);
    const sales = r(paid.reduce((a, x) => a + x.total, 0));
    return { sales, count: paid.length, voids: rows.length - paid.length, avg: paid.length ? r(sales / paid.length) : 0, discount: r(paid.reduce((a, x) => a + (x.discount || 0), 0)), by_method: byMethod };
  };

  // free: the last 30 days only (today + 29 days back); mart_history (yearly) = everything
  const sinceOf = (ctx) => (ctx.limits.history_days ? new Date(Date.parse(`${localDay()}T00:00:00Z`) - (ctx.limits.history_days - 1) * 86400000).toISOString().slice(0, 10) : null);
  const limitRange = (ctx, range) => {
    const since = sinceOf(ctx);
    if (!since || range.from >= since) return { ...range, since, limited: false };
    if (range.to <= since) throw new Bad(T.history, 402, { code: "history", product: "mart_history", since });
    return { ...range, from: since, since, limited: true };
  };

  dual("get", "/sales", false, async (ctx, req, res) => {
    const { from, to, since, limited } = limitRange(ctx, rangeOf(req.query));
    const rows = await M.MartSale.find({ business_id: ctx.business._id, at: { $gte: startOf(from), $lt: startOf(to) } })
      .sort({ at: -1 })
      .limit(3000)
      .lean();
    res.json({ success: true, data: { from, to, since, limited, rows, totals: totalsOf(rows, ctx.settings.currency) } });
  });

  const loadSale = async (ctx, sid) => {
    if (!validId(sid)) throw new Bad(MSG.badId);
    const row = await M.MartSale.findOne({ _id: sid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  dual("get", "/sales/:sid", false, async (ctx, req, res) => {
    res.json({ success: true, data: await loadSale(ctx, req.params.sid) });
  });
  dual("post", "/sales/:sid/void", true, async (ctx, req, res) => {
    managerOnly(ctx);
    const row = await loadSale(ctx, req.params.sid);
    if (row.status === "void") return res.json({ success: true, data: row, already: true, message: T.voided });
    row.status = "void";
    row.void_by = ctx.by;
    row.void_at = new Date();
    row.void_reason = text(req.body || {}, "reason", 200) || "";
    await row.save();
    await stock().giveBack(ctx, row); // the items are back on the shelf
    await kit.expiry.giveBack(ctx, row);
    await kit.loyalty.voidSale(ctx, row); // points earned are taken back, points used come back
    if (row.method === "debt" && row.debtor_id) {
      const d = await M.MartDebtor.findOne({ _id: row.debtor_id, business_id: ctx.business._id });
      if (d) await debt().saleUp(ctx, d, row, -1); // the debt is crossed out
    }
    res.json({ success: true, data: row, message: MSG.saved });
  });

  dual("get", "/report", false, async (ctx, req, res) => {
    const { from, to, kind, since, limited } = limitRange(ctx, rangeOf(req.query));
    const bid = ctx.business._id;
    const cur = ctx.settings.currency;
    const r = roundOf(cur);
    const rows = await M.MartSale.find({ business_id: bid, at: { $gte: startOf(from), $lt: startOf(to) } })
      .select("items total discount method status at by")
      .lean();
    const paid = rows.filter((x) => x.status === "paid");
    const local = (d) => new Date(new Date(d).getTime() + 7 * 3600000).toISOString();
    // by hour for one day, by day for a month / range
    const series = {};
    for (const x of paid) {
      const k = kind === "day" ? local(x.at).slice(11, 13) : local(x.at).slice(0, 10);
      series[k] = series[k] || { key: k, sales: 0, count: 0 };
      series[k].sales = r(series[k].sales + x.total);
      series[k].count += 1;
    }
    const top = new Map();
    for (const x of paid)
      for (const l of x.items) {
        const k = l.product_id ? String(l.product_id) : `n:${l.name}`;
        const t = top.get(k) || { product_id: l.product_id, name: l.name, qty: 0, value: 0 };
        t.qty = Math.round((t.qty + l.qty) * 1000) / 1000;
        t.value = r(t.value + l.total);
        top.set(k, t);
      }
    const staff = {};
    for (const x of paid) {
      staff[x.by || "-"] = staff[x.by || "-"] || { name: x.by || "-", sales: 0, count: 0 };
      staff[x.by || "-"].sales = r(staff[x.by || "-"].sales + x.total);
      staff[x.by || "-"].count += 1;
    }
    res.json({
      success: true,
      data: {
        kind,
        since,
        limited,
        from,
        to,
        currency: cur,
        totals: totalsOf(rows, cur),
        series: Object.values(series).sort((a, b) => (a.key < b.key ? -1 : 1)),
        top: [...top.values()].sort((a, b) => b.value - a.value).slice(0, 20),
        by_staff: Object.values(staff).sort((a, b) => b.sales - a.sales),
      },
    });
  });
  return { rangeOf, limitRange, startOf, nextDay, totalsOf };
};
