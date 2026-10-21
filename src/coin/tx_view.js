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
  return rows.map((t) => {
    const { card_ids, ...rest } = t;
    return { ...rest, business: t.business_id ? byId[String(t.business_id)] || null : null, ...productOf(t), cards: (card_ids || []).length, order: byTx[String(t._id)] || null };
  });
}

module.exports = { withDetails, productOf };
