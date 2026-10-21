// Promotions maths (mart_promos) — the POS has the same file (bizhub/src/pos/mart/promo.js), so offline sales add up the same.
//   promos: [{ _id, name, kind: percent | amount | bxgy, value, buy_qty, get_qty, target: all | categories | products,
//              category_ids, product_ids, min_spend, code, where: both | pos | online, days, time_from, time_to, date_from, date_to, max_uses, uses, active }]
//   lines: [{ product_id, price, qty }]   categoryOf: { product_id: category_id }
// Order: "buy X get Y" first, then % off on what is left, then money off. Each line is never below 0.
// coupon: "" (none typed) | ok | invalid | expired | min_spend | no_match
function localParts(at) {
  const d = new Date(new Date(at).getTime() + 7 * 3600000); // Cambodia time
  return { day: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16), dow: d.getUTCDay() };
}
function promoLive(p, at, where) {
  if (!p || p.active === false) return false;
  if (where && p.where && p.where !== "both" && p.where !== where) return false;
  if (p.max_uses > 0 && (p.uses || 0) >= p.max_uses) return false;
  const t = localParts(at);
  if (p.date_from && t.day < p.date_from) return false;
  if (p.date_to && t.day > p.date_to) return false;
  if (p.days && p.days.length && !p.days.includes(t.dow)) return false;
  if (p.time_from && p.time_to && p.time_from !== p.time_to) {
    const inside = p.time_from < p.time_to ? t.hm >= p.time_from && t.hm < p.time_to : t.hm >= p.time_from || t.hm < p.time_to; // past midnight
    if (!inside) return false;
  }
  return true;
}
const ORDER = { bxgy: 0, percent: 1, amount: 2 };
function applyPromos({ lines = [], promos = [], at = Date.now(), where = "pos", coupon = "", currency = "USD", categoryOf = {} }) {
  const r = (v) => (currency === "KHR" ? Math.round(v) : Math.round(v * 100) / 100);
  const code = String(coupon || "")
    .trim()
    .toUpperCase();
  const rows = lines.map((l) => {
    const total = r(Number(l.price) * Number(l.qty));
    return { pid: l.product_id ? String(l.product_id) : "", price: Number(l.price) || 0, qty: Number(l.qty) || 0, total, left: total };
  });
  const subtotal = r(rows.reduce((a, x) => a + x.total, 0));
  let couponState = "";
  if (code) {
    const cp = promos.find((p) => p.code && p.code === code);
    couponState = !cp ? "invalid" : !promoLive(cp, at, where) ? "expired" : cp.min_spend > 0 && subtotal < cp.min_spend ? "min_spend" : "ok";
  }
  const fits = (p, row) => {
    if (!p.target || p.target === "all") return true;
    if (!row.pid) return false;
    if (p.target === "products") return (p.product_ids || []).map(String).includes(row.pid);
    return (p.category_ids || []).map(String).includes(String(categoryOf[row.pid] || ""));
  };
  const live = promos.filter((p) => promoLive(p, at, where) && (!p.code || p.code === code) && !(p.min_spend > 0 && subtotal < p.min_spend)).sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));
  const applied = [];
  for (const p of live) {
    const mine = rows.filter((row) => row.left > 0 && fits(p, row));
    let amount = 0;
    const take = (row, v) => {
      const x = r(Math.min(row.left, v));
      row.left = r(row.left - x);
      amount += x;
      return x;
    };
    if (p.kind === "bxgy") {
      const n = (p.buy_qty || 0) + (p.get_qty || 0);
      if (!(p.buy_qty > 0) || !(p.get_qty > 0)) continue;
      const groups = new Map();
      for (const row of mine) if (row.pid) groups.set(row.pid, [...(groups.get(row.pid) || []), row]);
      for (const g of groups.values()) {
        const qty = Math.floor(g.reduce((a, x) => a + x.qty, 0) + 1e-9);
        const free = Math.floor(qty / n) * p.get_qty;
        if (!free) continue;
        let want = r(free * Math.min(...g.map((x) => x.price)));
        for (const row of g) if (want > 0) want = r(want - take(row, want));
      }
    } else if (p.kind === "percent") {
      const pct = Math.min(100, Math.max(0, p.value || 0));
      for (const row of mine) take(row, r((row.left * pct) / 100));
    } else if (p.kind === "amount") {
      let want = r(Math.max(0, p.value || 0));
      for (const row of mine) if (want > 0) want = r(want - take(row, want));
    }
    amount = r(amount);
    if (amount > 0) applied.push({ id: String(p._id || ""), name: p.name, amount, code: p.code || "" });
  }
  if (couponState === "ok" && !applied.some((x) => x.code === code)) couponState = "no_match";
  const discount = r(
    Math.min(
      subtotal,
      applied.reduce((a, x) => a + x.amount, 0),
    ),
  );
  return { subtotal, discount, applied, coupon: couponState };
}

module.exports = { applyPromos, promoLive, localParts };
