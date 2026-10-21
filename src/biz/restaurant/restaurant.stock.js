// Stock per menu item (add-on rest_stock). Cost price is free for everyone (profit in reports).
//
// Owner, base /api/user/businesses/:id/restaurant/stock
//   GET  /                       items that track stock + totals (left, low, sold out, stock value)
//   POST /:rid  { kind: in|out|count, qty, cost?, note? }   stock in (bought), out (waste, staff meal…), or a count (sets the qty)
//   GET  /moves?item=&page=1     history of every change (sales and cancelled sales too)
//   POST /sample                 adds 10 sample items with cost, price and quantity (to try the POS)
//
// Sales: when a POS bill becomes "paid" its items are taken out of stock once (order.stock_applied);
// if that bill is cancelled afterwards they go back. Linked POS devices get the quantities on every sync.
const M = require("./restaurant.models");
const telegram = require("../../telegram");

const S = {
  needStock: "សូមដោះសោ “ស្តុក” ជាមុនសិន!",
  notTracked: "មុខម្ហូបនេះមិនបានរាប់ស្តុកទេ",
  badQty: "ចំនួនមិនត្រឹមត្រូវ",
  notFound: "រកមិនឃើញមុខម្ហូប!",
  sampleBig: "ម៉ឺនុយមានមុខម្ហូបច្រើនហើយ — គំរូសម្រាប់តែម៉ឺនុយតូចប៉ុណ្ណោះ",
  sampleDone: "បានបន្ថែម 10 មុខគំរូ",
};
const PAGE = 30;
const SAMPLE_MAX_ITEMS = 40; // only for a small (new) menu

// 10 sample items: [category, en, km, price, cost, qty, low]
const SAMPLE = [
  ["Drinks", "Coca-Cola can", "កូកាកូឡា កំប៉ុង", 1.0, 0.45, 48, 12],
  ["Drinks", "Mineral water", "ទឹកសុទ្ធ", 0.5, 0.15, 60, 12],
  ["Drinks", "Angkor beer", "ស្រាបៀរអង្គរ", 1.5, 0.8, 24, 6],
  ["Drinks", "Red Bull", "រេដប៊ូល", 1.25, 0.6, 18, 6],
  ["Drinks", "Orange juice bottle", "ទឹកក្រូចដប", 1.75, 0.9, 12, 4],
  ["Bakery", "Croissant", "នំក្រូសង់", 1.75, 0.7, 20, 5],
  ["Bakery", "Chocolate muffin", "នំម៉ាហ្វីនសូកូឡា", 2.0, 0.85, 15, 5],
  ["Bakery", "Banana cake slice", "នំចេកមួយចំណិត", 1.5, 0.5, 4, 5], // already low → shows the alert
  ["Snacks", "Potato chips", "ដំឡូងបារាំងចៀន កញ្ចប់", 1.25, 0.55, 30, 8],
  ["Snacks", "Instant noodles cup", "មីកំប៉ុង", 1.0, 0.4, 0, 6], // sold out → shows "sold out"
];

// take a paid bill's items out of stock (or put them back when a paid bill is cancelled)
async function applyOrderStock(bid, order, sign, by) {
  const qty = {};
  for (const l of order.lines || []) if (l.status !== "void" && l.item_id && /^[a-f0-9]{24}$/.test(l.item_id)) qty[l.item_id] = (qty[l.item_id] || 0) + (Number(l.qty) || 0);
  const ids = Object.keys(qty);
  if (!ids.length) return;
  const items = await M.RestItem.find({ _id: { $in: ids }, business_id: bid, track_stock: true })
    .select("name_en name_km cost stock low_stock")
    .lean();
  const crossed = [];
  for (const it of items) {
    const change = sign * qty[String(it._id)];
    const before = await M.RestItem.findOneAndUpdate({ _id: it._id }, { $inc: { stock: change } }, { returnDocument: "before" })
      .select("stock")
      .lean();
    if (!before) continue;
    await M.RestStockMove.create({
      business_id: bid,
      item_id: it._id,
      item_name: it.name_en || it.name_km,
      kind: sign < 0 ? "sale" : "void",
      qty: change,
      before: before.stock,
      after: before.stock + change,
      cost: it.cost || 0,
      by: by || "",
      order_id: order._id,
      order_number: order.number || "",
    });
    const c = crossing(it, before.stock, before.stock + change);
    if (c) crossed.push(c);
  }
  return crossed;
}

// did this change make the item low or sold out? (only the moment it crosses the line, so one message each time)
function crossing(item, before, after) {
  const low = item.low_stock ?? 5;
  const name = item.name_km && item.name_en ? `${item.name_en} · ${item.name_km}` : item.name_en || item.name_km;
  if (before > 0 && after <= 0) return { kind: "out", name, left: after, low };
  if (before > low && after <= low && after > 0) return { kind: "low", name, left: after, low };
  return null;
}
// Telegram add-on: tell the owner's chat which items just got low or sold out
async function sendStockAlerts(settings, state, crossed) {
  const chat = settings?.telegram?.chat_id;
  if (!crossed?.length || !chat || settings.telegram?.stock_alerts === false || !state?.addons?.rest_telegram?.active || !telegram.ready()) return;
  const e = telegram.escape;
  const out = crossed.filter((c) => c.kind === "out");
  const low = crossed.filter((c) => c.kind === "low");
  const lines = [`📦 <b>${e(settings.name_km || settings.name_en || "Restaurant")}</b>`];
  if (out.length) lines.push("", "⛔ <b>Sold out · អស់ស្តុក</b>", ...out.map((c) => `• ${e(c.name)}`));
  if (low.length) lines.push("", "⚠️ <b>Low stock · ស្តុកជិតអស់</b>", ...low.map((c) => `• ${e(c.name)} — ${c.left} left · នៅសល់ ${c.left}`));
  await telegram.send(chat, lines.join("\n")).catch(() => {});
}

// quantities a POS needs (only items that track stock)
async function stockMap(bid) {
  const rows = await M.RestItem.find({ business_id: bid, track_stock: true }).select("stock").lean();
  return Object.fromEntries(rows.map((r) => [String(r._id), r.stock]));
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, withSettings, Bad, MSG, text, num, validId } = kit;
  const path = `${base}/stock`;
  const needStock = (ctx) => {
    if (!ctx.addons.rest_stock?.active) throw new Bad(S.needStock, 402, { product: "rest_stock" });
  };
  const view = (i) => ({
    _id: i._id,
    category_id: i.category_id,
    name_km: i.name_km,
    name_en: i.name_en,
    photo: i.photo?.url || "",
    price: i.price,
    cost: i.cost || 0,
    stock: i.stock || 0,
    low_stock: i.low_stock ?? 5,
    track_stock: !!i.track_stock,
    active: i.active,
  });

  prop.app.get(
    path,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const [items, categories] = await Promise.all([
        M.RestItem.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }).select("category_id name_km name_en photo price cost stock low_stock track_stock active").lean(),
        M.RestCategory.find({ business_id: bid }).sort({ sort: 1 }).select("name_km name_en color").lean(),
      ]);
      const tracked = items.filter((i) => i.track_stock);
      const summary = {
        items: items.length,
        tracked: tracked.length,
        low: tracked.filter((i) => i.stock > 0 && i.stock <= (i.low_stock ?? 5)).length,
        out: tracked.filter((i) => i.stock <= 0).length,
        value: Math.round(tracked.reduce((a, i) => a + Math.max(0, i.stock) * (i.cost || 0), 0) * 100) / 100,
        retail: Math.round(tracked.reduce((a, i) => a + Math.max(0, i.stock) * (i.price || 0), 0) * 100) / 100,
      };
      res.json({ success: true, data: { active: !!ctx.addons.rest_stock?.active, items: items.map(view), categories, summary } });
    }),
  );

  prop.app.post(
    `${path}/sample`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const bid = ctx.business._id;
      const count = await M.RestItem.countDocuments({ business_id: bid });
      if (count > SAMPLE_MAX_ITEMS) throw new Bad(S.sampleBig, 409);
      const track = !!ctx.addons.rest_stock?.active;
      // categories: reuse one with the same English name, else create it
      const cats = {};
      let sort = await M.RestCategory.countDocuments({ business_id: bid });
      const colors = { Drinks: "#1A73E8", Bakery: "#E0581A", Snacks: "#7B1FA2" };
      for (const name of [...new Set(SAMPLE.map((x) => x[0]))]) {
        const found = await M.RestCategory.findOne({ business_id: bid, name_en: name });
        cats[name] = found || (await M.RestCategory.create({ business_id: bid, name_en: name, name_km: { Drinks: "ភេសជ្ជៈ", Bakery: "នំ", Snacks: "អាហារសម្រន់" }[name], color: colors[name], sort: sort++ }));
      }
      const made = [];
      for (const [i, [cat, en, km, price, cost, qty, low]] of SAMPLE.entries()) {
        const row = await M.RestItem.create({ business_id: bid, category_id: cats[cat]._id, name_en: en, name_km: km, price, cost, stock: qty, low_stock: low, track_stock: track, sort: count + i });
        if (track && qty) await M.RestStockMove.create({ business_id: bid, item_id: row._id, item_name: en, kind: "opening", qty, before: 0, after: qty, cost, note: "Sample", by: "" });
        made.push(view(row.toObject()));
      }
      await M.RestCounter.updateOne({ business_id: bid }, { $inc: { setup: 1 } }, { upsert: true }); // POS devices download the menu again
      res.status(201).json({ success: true, data: made, tracked: track, message: S.sampleDone });
    }),
  );

  prop.app.get(
    `${path}/moves`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
      const filter = { business_id: ctx.business._id };
      if (req.query.item) {
        if (!validId(req.query.item)) throw new Bad(MSG.badId);
        filter.item_id = req.query.item;
      }
      if (M.STOCK_KINDS.includes(req.query.kind)) filter.kind = req.query.kind;
      const [rows, total] = await Promise.all([
        M.RestStockMove.find(filter)
          .sort({ created_date: -1 })
          .skip((page - 1) * PAGE)
          .limit(PAGE)
          .lean(),
        M.RestStockMove.countDocuments(filter),
      ]);
      res.json({ success: true, data: rows, pagination: { total, totalPages: Math.max(1, Math.ceil(total / PAGE)), currentPage: page, pageSize: PAGE } });
    }),
  );

  prop.app.post(
    `${path}/:rid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needStock(ctx);
      if (!validId(req.params.rid)) throw new Bad(MSG.badId);
      const bid = ctx.business._id;
      const item = await M.RestItem.findOne({ _id: req.params.rid, business_id: bid });
      if (!item) throw new Bad(S.notFound, 404);
      if (!item.track_stock) throw new Bad(S.notTracked);
      const b = req.body || {};
      const kind = ["in", "out", "count"].includes(b.kind) ? b.kind : null;
      if (!kind) throw new Bad(`${MSG.badValue} (kind)`);
      const qty = Number(b.qty);
      if (!Number.isFinite(qty) || qty < 0 || qty > 1000000 || (kind !== "count" && qty === 0)) throw new Bad(S.badQty);
      const cost = b.cost === undefined || b.cost === "" ? undefined : num(b, "cost", 0, 1000000);
      const note = text(b, "note", 200) || "";
      const change = kind === "in" ? qty : kind === "out" ? -qty : null;
      let before;
      if (kind === "count") {
        before = (await M.RestItem.findOneAndUpdate({ _id: item._id }, { $set: { stock: qty } }, { returnDocument: "before" }).lean()).stock;
      } else {
        before = (await M.RestItem.findOneAndUpdate({ _id: item._id }, { $inc: { stock: change } }, { returnDocument: "before" }).lean()).stock;
      }
      const after = kind === "count" ? qty : before + change;
      // buying at a new price: that becomes the item's cost
      if (kind === "in" && cost !== undefined) await M.RestItem.updateOne({ _id: item._id }, { $set: { cost } });
      const move = await M.RestStockMove.create({ business_id: bid, item_id: item._id, item_name: item.name_en || item.name_km, kind, qty: after - before, before, after, cost: cost ?? item.cost ?? 0, note, by: req.customer?.name || "" });
      const fresh = await M.RestItem.findById(item._id).lean();
      const c = crossing(fresh, before, after);
      if (c)
        withSettings(req, false)
          .then(({ settings }) => sendStockAlerts(settings, ctx, [c]))
          .catch(() => {});
      res.status(201).json({ success: true, data: { item: view(fresh), move }, message: MSG.saved });
    }),
  );
};

module.exports.applyOrderStock = applyOrderStock;
module.exports.sendStockAlerts = sendStockAlerts;
module.exports.crossing = crossing;
module.exports.stockMap = stockMap;
