// Several shops (mart_branches, yearly, on the main shop) — owner dashboard only.
// A group = the main mini mart + the owner's other mini marts linked to it (each keeps its own license, products, POS, sales).
//   GET    /branches                    the group (main + branches) + the owner's mini marts that can join
//   POST   /branches { business_id }    link one of your mini marts      DELETE /branches/:bid   unlink
//   GET    /branches/report?day|month   sales, receipts, stock value, low / out — per shop and all together
//   GET    /branches/stock?q=           one product (name / barcode) in every shop
//   POST   /branches/transfer { from, to, items: [{ product_id, qty }], note }   stock moves from one shop to another
//   GET    /branches/transfers          the last 100 transfers
//   POST   /branches/copy { from, to, prices }   the product list of one shop into another (same barcode / name = same product)
const T = {
  need: "សូមដោះសោ “សាខាច្រើន” ជាមុនសិន!",
  notYours: "អាជីវកម្មនេះមិនមែនជាម៉ាតរបស់អ្នកទេ!",
  inGroup: "ម៉ាតនេះនៅក្នុងក្រុមមួយផ្សេងរួចហើយ!",
  isBranch: "ម៉ាតនេះជាសាខារបស់ម៉ាតផ្សេង។ សូមបើកពីម៉ាតមេ។",
  notInGroup: "ម៉ាតនេះមិននៅក្នុងក្រុមទេ!",
  same: "សូមជ្រើសរើសម៉ាតពីរផ្សេងគ្នា!",
  noItems: "សូមបន្ថែមទំនិញ!",
  tooMany: "សាខាច្រើនបំផុត 20!",
};

module.exports = (prop, kit) => {
  const { own, Bad, MSG, text, num, bool, validId, roundOf, licenseState, settingsOf, unitsOf, M, Business } = kit;
  const r3 = (v) => Math.round(v * 1000) / 1000;

  // the group this shop is in: the main shop + its branches (only the owner's live mini marts)
  async function groupOf(ctx) {
    const bid = String(ctx.business._id);
    let mainId = bid;
    let mainSettings = ctx.settings;
    let role = (ctx.settings.branches || []).length ? "main" : "none";
    if (role === "none") {
      const up = await M.MartSettings.findOne({ branches: ctx.business._id }).lean();
      if (up) {
        mainId = String(up.business_id);
        mainSettings = up;
        role = "branch";
      }
    }
    const ids = [mainId, ...(mainSettings.branches || []).map(String)];
    const shops = await Business.find({ _id: { $in: ids }, owner_id: ctx.business.owner_id, deleted: false, category: "mart" })
      .select("name logo_url status")
      .lean();
    const order = new Map(ids.map((x, i) => [x, i]));
    shops.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
    const state = mainId === bid ? { addons: ctx.addons } : await licenseState(mainId);
    return { role, mainId, active: !!state.addons.mart_branches?.active, shops: shops.map((s) => ({ _id: s._id, name: s.name, logo: s.logo_url || "", is_main: String(s._id) === mainId, here: String(s._id) === bid })) };
  }
  const needActive = (g) => {
    if (!g.active) throw new Bad(T.need, 402, { product: "mart_branches" });
  };
  const inGroup = (g, id) => {
    if (!validId(id) || !g.shops.some((s) => String(s._id) === String(id))) throw new Bad(T.notInGroup, 400, { code: "not_in_group" });
    return String(id);
  };

  own("get", "/branches", false, async (ctx, req, res) => {
    const g = await groupOf(ctx);
    let candidates = [];
    if (g.role !== "branch") {
      const mine = await Business.find({ owner_id: ctx.business.owner_id, deleted: false, category: "mart", _id: { $ne: ctx.business._id } })
        .select("name")
        .lean();
      const taken = new Set(
        (
          await M.MartSettings.find({ business_id: { $in: mine.map((x) => x._id) }, $or: [{ "branches.0": { $exists: true } }] })
            .select("business_id")
            .lean()
        ).map((x) => String(x.business_id)),
      );
      const linked = new Set(
        (
          await M.MartSettings.find({ branches: { $in: mine.map((x) => x._id) } })
            .select("branches")
            .lean()
        ).flatMap((x) => x.branches.map(String)),
      );
      candidates = mine.filter((x) => !taken.has(String(x._id)) && !linked.has(String(x._id))).map((x) => ({ _id: x._id, name: x.name }));
    }
    res.json({ success: true, data: { ...g, candidates, main: g.shops.find((s) => s.is_main) || null } });
  });
  own("post", "/branches", true, async (ctx, req, res) => {
    if (!ctx.addons.mart_branches?.active) throw new Bad(T.need, 402, { product: "mart_branches" });
    const g = await groupOf(ctx);
    if (g.role === "branch") throw new Bad(T.isBranch, 409, { code: "is_branch" });
    const id = String(req.body?.business_id || "");
    if (!validId(id) || id === String(ctx.business._id)) throw new Bad(T.notYours, 400, { code: "not_yours" });
    const biz = await Business.findOne({ _id: id, owner_id: ctx.business.owner_id, deleted: false, category: "mart" }).lean();
    if (!biz) throw new Bad(T.notYours, 404, { code: "not_yours" });
    if ((await M.MartSettings.exists({ business_id: id, "branches.0": { $exists: true } })) || (await M.MartSettings.exists({ branches: biz._id }))) throw new Bad(T.inGroup, 409, { code: "in_group" });
    if ((ctx.settings.branches || []).length >= 20) throw new Bad(T.tooMany, 400, { code: "too_many" });
    await settingsOf(biz._id); // the branch has its settings
    ctx.settings.branches = [...(ctx.settings.branches || []), biz._id];
    await ctx.settings.save();
    res.json({ success: true, data: await groupOf(ctx), message: MSG.saved });
  });
  own("delete", "/branches/:bid", true, async (ctx, req, res) => {
    const g = await groupOf(ctx);
    if (g.role === "branch") throw new Bad(T.isBranch, 409, { code: "is_branch" });
    ctx.settings.branches = (ctx.settings.branches || []).filter((x) => String(x) !== String(req.params.bid));
    await ctx.settings.save();
    res.json({ success: true, data: await groupOf(ctx), message: MSG.deleted });
  });

  own("get", "/branches/report", false, async (ctx, req, res) => {
    const g = await groupOf(ctx);
    needActive(g);
    const { rangeOf, limitRange, startOf, totalsOf } = kit.range;
    const { from, to, kind, since, limited } = limitRange(ctx, rangeOf(req.query));
    const shops = [];
    for (const s of g.shops) {
      const st = await M.MartSettings.findOne({ business_id: s._id }).select("currency khr_rate").lean();
      const cur = st?.currency || "USD";
      const [sales, prods] = await Promise.all([
        M.MartSale.find({ business_id: s._id, at: { $gte: startOf(from), $lt: startOf(to) } })
          .select("total discount method status")
          .lean(),
        M.MartProduct.find({ business_id: s._id, active: true }).select("stock cost low_stock track_stock").lean(),
      ]);
      const t = totalsOf(sales, cur);
      const tracked = prods.filter((p) => p.track_stock);
      shops.push({
        ...s,
        currency: cur,
        khr_rate: st?.khr_rate || 4100,
        sales: t.sales,
        count: t.count,
        avg: t.avg,
        voids: t.voids,
        products: prods.length,
        stock_value: roundOf(cur)(tracked.filter((p) => p.stock > 0).reduce((a, p) => a + p.stock * (p.cost || 0), 0)),
        low: tracked.filter((p) => p.stock > 0 && p.stock <= (p.low_stock ?? 5)).length,
        out: tracked.filter((p) => p.stock <= 0).length,
      });
    }
    // all together, in this shop's currency
    const cur = ctx.settings.currency;
    const conv = (v, s) => (s.currency === cur ? v : cur === "USD" ? v / (s.khr_rate || 4100) : v * (s.khr_rate || 4100));
    const r = roundOf(cur);
    const total = {
      sales: r(shops.reduce((a, s) => a + conv(s.sales, s), 0)),
      count: shops.reduce((a, s) => a + s.count, 0),
      stock_value: r(shops.reduce((a, s) => a + conv(s.stock_value, s), 0)),
      low: shops.reduce((a, s) => a + s.low, 0),
      out: shops.reduce((a, s) => a + s.out, 0),
    };
    total.avg = total.count ? r(total.sales / total.count) : 0;
    res.json({ success: true, data: { kind, from, to, since, limited, currency: cur, shops, total } });
  });

  own("get", "/branches/stock", false, async (ctx, req, res) => {
    const g = await groupOf(ctx);
    needActive(g);
    const q = String(req.query.q || "")
      .trim()
      .slice(0, 60);
    if (q.length < 2) return res.json({ success: true, data: [] });
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rows = await M.MartProduct.find({ business_id: { $in: g.shops.map((s) => s._id) }, active: true, $or: [{ name: { $regex: esc, $options: "i" } }, { barcode: q }] })
      .select("business_id name barcode stock price track_stock low_stock")
      .limit(400)
      .lean();
    const nameOf = new Map(g.shops.map((s) => [String(s._id), s.name]));
    const groups = new Map();
    for (const p of rows) {
      const k = p.barcode || `n:${p.name.toLowerCase()}`;
      const x = groups.get(k) || { name: p.name, barcode: p.barcode, shops: [] };
      x.shops.push({ business_id: p.business_id, shop: nameOf.get(String(p.business_id)), product_id: p._id, stock: p.track_stock ? r3(p.stock || 0) : null, low: p.low_stock ?? 5, price: p.price });
      groups.set(k, x);
    }
    res.json({ success: true, data: [...groups.values()].slice(0, 50) });
  });

  // the same product in the other shop: same barcode, else same name; none → a copy is made there (no stock yet)
  async function twin(p, toId, cache) {
    let t = p.barcode ? await M.MartProduct.findOne({ business_id: toId, barcode: p.barcode }) : null;
    if (!t) t = await M.MartProduct.findOne({ business_id: toId, name: { $regex: `^${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
    if (t) return { row: t, made: false };
    if (!cache.units) cache.units = await unitsOf(toId);
    if (!cache.fromUnits) cache.fromUnits = await M.MartUnit.find({ business_id: p.business_id }).lean();
    if (!cache.cats) cache.cats = await M.MartCategory.find({ business_id: toId }).lean();
    if (!cache.fromCats) cache.fromCats = await M.MartCategory.find({ business_id: p.business_id }).lean();
    const fu = cache.fromUnits.find((u) => String(u._id) === String(p.unit_id));
    const unit = (fu && cache.units.find((u) => (u.name_en && u.name_en.toLowerCase() === (fu.name_en || "").toLowerCase()) || (u.name_km && u.name_km === fu.name_km))) || cache.units[0];
    const fc = cache.fromCats.find((c) => String(c._id) === String(p.category_id));
    let cat = fc ? cache.cats.find((c) => c.name.toLowerCase() === fc.name.toLowerCase()) : null;
    if (fc && !cat && cache.cats.length < 100) {
      cat = (await M.MartCategory.create({ business_id: toId, name: fc.name, color: fc.color || "", sort: cache.cats.length })).toObject();
      cache.cats.push(cat);
    }
    const row = await M.MartProduct.create({
      business_id: toId,
      name: p.name,
      barcode: p.barcode || "",
      price: p.price,
      cost: p.cost || 0,
      unit_id: unit?._id || null,
      category_id: cat?._id || null,
      track_stock: p.track_stock !== false,
      low_stock: p.low_stock ?? 5,
      plu: p.plu || "",
      photo: p.photo?.url ? { url: p.photo.url, public_id: "" } : undefined,
    });
    return { row, made: true };
  }

  own("post", "/branches/transfer", true, async (ctx, req, res) => {
    const g = await groupOf(ctx);
    needActive(g);
    const b = req.body || {};
    const from = inGroup(g, b.from || ctx.business._id);
    const to = inGroup(g, b.to);
    if (from === to) throw new Bad(T.same, 400, { code: "same" });
    if (!Array.isArray(b.items) || !b.items.length) throw new Bad(T.noItems, 400, { code: "no_items" });
    if (b.items.length > 300) throw new Bad(MSG.tooMany);
    const lines = b.items.map((x) => ({ product_id: String(x?.product_id || ""), qty: r3(num(x || {}, "qty", 0.001, 1000000, { required: true })) }));
    if (!lines.every((l) => validId(l.product_id))) throw new Bad(`${MSG.badValue} (items)`);
    const prods = new Map((await M.MartProduct.find({ business_id: from, _id: { $in: lines.map((l) => l.product_id) } }).lean()).map((p) => [String(p._id), p]));
    if (lines.some((l) => !prods.has(l.product_id))) throw new Bad(MSG.rowNotFound, 404);
    const names = new Map(g.shops.map((s) => [String(s._id), s.name]));
    const tr = await M.MartTransfer.create({ group_id: g.mainId, from_id: from, to_id: to, from_name: names.get(from), to_name: names.get(to), note: text(b, "note", 200) || "", by: ctx.by });
    const cache = {};
    const items = [];
    for (const l of lines) {
      const p = prods.get(l.product_id);
      const { row } = await twin(p, to, cache);
      const out = await M.MartProduct.findOneAndUpdate({ _id: p._id }, { $inc: { stock: -l.qty } }, { returnDocument: "after" }).lean();
      const inn = await M.MartProduct.findOneAndUpdate({ _id: row._id }, { $inc: { stock: l.qty } }, { returnDocument: "after" }).lean();
      await M.MartStockMove.create({ business_id: from, product_id: p._id, kind: "transfer_out", qty: -l.qty, stock_after: r3(out.stock), cost: p.cost || 0, note: `→ ${names.get(to)}`, transfer_id: tr._id, by: ctx.by });
      await M.MartStockMove.create({ business_id: to, product_id: row._id, kind: "transfer_in", qty: l.qty, stock_after: r3(inn.stock), cost: p.cost || 0, note: `← ${names.get(from)}`, transfer_id: tr._id, by: ctx.by });
      items.push({ product_id: p._id, to_product_id: row._id, name: p.name, barcode: p.barcode || "", qty: l.qty });
    }
    tr.items = items;
    await tr.save();
    res.json({ success: true, data: tr, message: MSG.saved });
  });
  own("get", "/branches/transfers", false, async (ctx, req, res) => {
    const g = await groupOf(ctx);
    const rows = await M.MartTransfer.find({ group_id: g.mainId }).sort({ created_date: -1 }).limit(100).lean();
    res.json({ success: true, data: rows });
  });

  own("post", "/branches/copy", true, async (ctx, req, res) => {
    const g = await groupOf(ctx);
    needActive(g);
    const b = req.body || {};
    const from = inGroup(g, b.from || ctx.business._id);
    const to = inGroup(g, b.to);
    if (from === to) throw new Bad(T.same, 400, { code: "same" });
    const prices = bool(b, "prices") === true;
    const list = await M.MartProduct.find({ business_id: from, active: true }).limit(20000).lean();
    const limit = (await licenseState(to)).limits.products;
    let count = await M.MartProduct.countDocuments({ business_id: to, active: true });
    const out = { added: 0, updated: 0, same: 0, skipped: 0 };
    const cache = {};
    for (const p of list) {
      let t = p.barcode ? await M.MartProduct.findOne({ business_id: to, barcode: p.barcode }) : null;
      if (!t) t = await M.MartProduct.findOne({ business_id: to, name: { $regex: `^${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (t) {
        if (prices && (t.price !== p.price || (t.cost || 0) !== (p.cost || 0))) {
          t.price = p.price;
          t.cost = p.cost || 0;
          await t.save();
          out.updated += 1;
        } else out.same += 1;
        continue;
      }
      if (count >= limit) {
        out.skipped += 1;
        continue;
      }
      await twin(p, to, cache);
      count += 1;
      out.added += 1;
    }
    res.json({ success: true, data: out, message: MSG.saved });
  });
};
