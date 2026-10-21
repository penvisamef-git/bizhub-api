// Weighing-scale barcodes (mart_scale, forever) — owner:
//   GET /scale    PUT /scale { on, prefix, item_len, mode: weight | price }
// The scale prints EAN-13 labels: prefix (1–2 digits, usually 20–29) + the product's item code (its "PLU", item_len digits)
// + the weight in grams (or the price in cents / riel) + a check digit. The POS reads them (also offline).
// Customer screen (mart_display, forever): nothing to keep here — the POS opens the second window when it is unlocked.
const T = { need: "សូមដោះសោ “បាកូដជញ្ជីង” ជាមុនសិន!" };

module.exports = (prop, kit) => {
  const { own, Bad, MSG, bool, num, oneOf, M } = kit;
  const scaleOf = (s) => {
    const x = s.scale || {};
    return { on: !!x.on, prefix: x.prefix || "21", item_len: x.item_len || 5, mode: x.mode || "weight" };
  };
  own("get", "/scale", false, async (ctx, req, res) => {
    const plus = await M.MartProduct.countDocuments({ business_id: ctx.business._id, plu: { $gt: "" } });
    res.json({ success: true, data: { active: !!ctx.addons.mart_scale?.active, ...scaleOf(ctx.settings), products: plus } });
  });
  own("put", "/scale", true, async (ctx, req, res) => {
    if (!ctx.addons.mart_scale?.active) throw new Bad(T.need, 402, { product: "mart_scale" });
    const b = req.body || {};
    const s = ctx.settings;
    const ON = bool(b, "on");
    if (ON !== undefined) s.set("scale.on", ON);
    if (b.prefix !== undefined) {
      const p = String(b.prefix || "");
      if (!/^\d{1,2}$/.test(p)) throw new Bad(`${MSG.badValue} (prefix)`);
      s.set("scale.prefix", p);
    }
    const len = num(b, "item_len", 4, 6, { int: true });
    if (len !== undefined) s.set("scale.item_len", len);
    const mode = oneOf(b, "mode", ["weight", "price"]);
    if (mode) s.set("scale.mode", mode);
    const x = scaleOf(s);
    if (x.prefix.length + x.item_len > 8) throw new Bad(`${MSG.badValue} (item_len)`); // at least 4 digits left for the weight / price
    await s.save();
    res.json({ success: true, data: { active: true, ...x }, message: MSG.saved });
  });
  return { scaleOf };
};
