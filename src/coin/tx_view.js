// What a coin transaction was about, for the details window (web + app): the business, the product bought
// (from the note the license service writes: "ev_feedback: item · 365 days · Business"), the period, cards used.
const Business = require("../biz/business.model");
const { PRODUCTS } = require("../license/license.products");
const { CoinOrder } = require("../platform/platform.model");

function productOf(t) {
  if (t.type !== "spend") return {};
  const note = String(t.note || "");
  if (/^New business:/i.test(note)) return { product: "new_business" };
  const m = note.match(/^([a-z0-9_]+)(?::\s*(.+?))?(?:\s·\s(\d+)\sdays)?\s·\s/);
  if (!m || !PRODUCTS[m[1]]) return {};
  return { product: m[1], item: m[2] || "", days: m[3] ? Number(m[3]) : null };
}

// rows: lean CoinTransaction docs → the same rows + business { _id, name, category }, product, item, days, cards
async function withDetails(rows) {
  const ids = [...new Set(rows.map((t) => t.business_id && String(t.business_id)).filter(Boolean))];
  const biz = ids.length ? await Business.find({ _id: { $in: ids } }).select("name category deleted").lean() : [];
  const byId = Object.fromEntries(biz.map((b) => [String(b._id), { _id: b._id, name: b.name, category: b.category, deleted: !!b.deleted }]));
  // a coin order (bank payment) that this transfer paid out
  const txIds = rows.filter((t) => t.type === "transfer").map((t) => t._id);
  const orders = txIds.length ? await CoinOrder.find({ tx_id: { $in: txIds } }).select("no coins bonus total_coins usd bank tx_id created_date done_at").lean() : [];
  const byTx = Object.fromEntries(orders.map((o) => [String(o.tx_id), { _id: o._id, no: o.no, coins: o.coins, bonus: o.bonus || 0, usd: o.usd, bank: o.bank?.name || "", ordered_at: o.created_date, approved_at: o.done_at }]));
  // coin packs bought in the Android app (Google Play): shown like an order, the "bank" is Google Play
  const gIds = rows.filter((t) => t.type === "transfer" && t.payment?.method === "Google Play").map((t) => t._id);
  if (gIds.length) {
    const { GooglePurchase } = require("./google_purchase.model");
    const gp = await GooglePurchase.find({ $or: [{ tx_id: { $in: gIds } }, { reverse_tx_id: { $in: gIds } }] }).select("order_id coins bonus usd tx_id reverse_tx_id purchased_at voided_at").lean();
    for (const g of gp) {
      const o = { _id: g._id, no: g.order_id || "Google Play", coins: g.coins, bonus: g.bonus || 0, usd: g.usd, bank: "Google Play", ordered_at: g.purchased_at, approved_at: g.purchased_at };
      if (g.tx_id) byTx[String(g.tx_id)] = o;
      if (g.reverse_tx_id) byTx[String(g.reverse_tx_id)] = { ...o, refunded_at: g.voided_at };
    }
  }
  // the same for coin packs bought in the iPhone app (App Store)
  const aIds = rows.filter((t) => t.type === "transfer" && t.payment?.method === "App Store").map((t) => t._id);
  if (aIds.length) {
    const { ApplePurchase } = require("./apple_purchase.model");
    const ap = await ApplePurchase.find({ $or: [{ tx_id: { $in: aIds } }, { reverse_tx_id: { $in: aIds } }] }).select("transaction_id environment coins bonus usd tx_id reverse_tx_id purchased_at revoked_at").lean();
    for (const a of ap) {
      const o = { _id: a._id, no: a.transaction_id || "App Store", coins: a.coins, bonus: a.bonus || 0, usd: a.usd, bank: a.environment === "Sandbox" ? "App Store (sandbox)" : "App Store", ordered_at: a.purchased_at, approved_at: a.purchased_at };
      if (a.tx_id) byTx[String(a.tx_id)] = o;
      if (a.reverse_tx_id) byTx[String(a.reverse_tx_id)] = { ...o, refunded_at: a.revoked_at };
    }
  }
  return rows.map((t) => {
    const { card_ids, ...rest } = t;
    return { ...rest, business: t.business_id ? byId[String(t.business_id)] || null : null, ...productOf(t), cards: (card_ids || []).length, order: byTx[String(t._id)] || null };
  });
}

module.exports = { withDetails, productOf };
