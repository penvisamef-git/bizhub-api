// Season / date deals (gh_promos): the price of each night of a stay, with the best deal that covers it.
const DAY = 86400000;
const addDays = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const round = (v, currency) => (currency === "KHR" ? Math.round(v) : Math.round(v * 100) / 100);

// does this deal cover this room type on this night?
const covers = (p, typeId, day) => p.active !== false && p.from <= day && p.to >= day && (!p.type_ids?.length || p.type_ids.some((t) => String(t) === String(typeId)));
// the night's price after the deal
function after(p, price) {
  if (p.kind === "percent") return Math.max(0, price * (1 - Math.min(100, p.value) / 100));
  if (p.kind === "amount") return Math.max(0, price - p.value);
  return Math.min(price, p.value); // a special price never costs more than the normal one
}
// the best (lowest) price for one night
function nightPrice(promos, typeId, price, day, currency) {
  let best = { price, promo: null };
  for (const p of promos || []) {
    if (!covers(p, typeId, day)) continue;
    const v = after(p, price);
    if (v < best.price) best = { price: v, promo: p };
  }
  return { price: round(best.price, currency), promo: best.promo };
}
// every night of a stay
function stayPrice(promos, typeId, price, from, to, currency) {
  const nights = [];
  for (let d = from; d < to && nights.length < 366; d = addDays(d, 1)) nights.push({ day: d, ...nightPrice(promos, typeId, price, d, currency) });
  const total = round(
    nights.reduce((a, n) => a + n.price, 0),
    currency,
  );
  const base = round(price * nights.length, currency);
  return { nights, total, base, saved: round(base - total, currency), rate: nights.length ? round(total / nights.length, currency) : price };
}
const badgeOf = (p, currency) => p.badge || (p.kind === "percent" ? `-${p.value}%` : p.kind === "amount" ? `-${currency === "KHR" ? `${Math.round(p.value).toLocaleString("en-US")}៛` : `$${p.value}`}` : "");
// what the website shows (no ids of other businesses, no inactive or ended deals)
const publicPromo = (p, currency) => ({ _id: String(p._id), name: p.name, badge: badgeOf(p, currency), note: p.note || "", kind: p.kind, value: p.value, type_ids: (p.type_ids || []).map(String), from: p.from, to: p.to });

module.exports = { nightPrice, stayPrice, publicPromo, badgeOf, covers, DAY };
