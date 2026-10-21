// The money of one Mini Mart sale. The POS has the same maths (bizhub/src/pos/mart/calc.js) so offline sales add up the same.
//   lines: [{ price, qty }]  discount (shop currency)  promo (promotions)  points (loyalty points money)  method  paid_usd + paid_khr (cash received)
//   change: in the shop currency; change_khr: all of it in riel, rounded to khr_round (100 / 500 / 1000)
function saleMoney({ lines, discount = 0, promo = 0, points = 0, currency = "USD", rate = 4100, method = "cash", paid_usd = 0, paid_khr = 0, khr_round = 100 }) {
  const r = (v) => (currency === "KHR" ? Math.round(v) : Math.round(v * 100) / 100);
  const items = lines.map((l) => ({ ...l, total: r(Number(l.price) * Number(l.qty)) }));
  const subtotal = r(items.reduce((a, l) => a + l.total, 0));
  // promotions first, then the cashier's discount, then loyalty points — never below 0
  const promoOff = r(Math.min(Math.max(0, Number(promo) || 0), subtotal));
  const disc = r(Math.min(Math.max(0, Number(discount) || 0), subtotal - promoOff));
  const pointsOff = r(Math.min(Math.max(0, Number(points) || 0), subtotal - promoOff - disc));
  const total = r(subtotal - promoOff - disc - pointsOff);
  const total_khr = currency === "KHR" ? total : Math.round((total * rate) / khr_round) * khr_round;
  if (method !== "cash") return { items, subtotal, discount: disc, promo_discount: promoOff, points_value: pointsOff, total, total_khr, paid: total, change: 0, change_khr: 0, short: 0 };
  const usd = Math.max(0, Number(paid_usd) || 0);
  const khr = Math.max(0, Number(paid_khr) || 0);
  const paid = currency === "USD" ? usd + khr / rate : usd * rate + khr;
  // riel is rounded at the counter: up to one rounding step short still counts as paid
  const slack = currency === "USD" ? khr_round / rate : khr_round;
  const diff = paid - total;
  const short = diff + slack / 2 < 0 ? r(-diff) : 0;
  const change = Math.max(0, r(diff));
  const inKhr = currency === "USD" ? change * rate : change;
  const change_khr = Math.max(0, Math.round(inKhr / khr_round) * khr_round);
  return { items, subtotal, discount: disc, promo_discount: promoOff, points_value: pointsOff, total, total_khr, paid: r(paid), change, change_khr, short };
}

module.exports = { saleMoney };
