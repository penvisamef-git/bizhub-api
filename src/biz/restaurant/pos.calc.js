// POS money rules — ONE copy of the logic, used by the POS (browser), the API and later the Shop Hub.
// The web app has the same file at bizhub/src/pos/calc.js (keep them identical; a test compares them).
//   settings = { currency: "USD"|"KHR", khr_rate, khr_rounding, vat: {enabled, rate, included}, service_charge: {enabled, rate} }

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const roundStep = (n, step) => Math.round(Number(n) / (step || 1)) * (step || 1);

// money in the main currency, rounded the way that currency is paid
function money(n, s) {
  return s.currency === "KHR" ? roundStep(n, s.khr_rounding || 100) : round2(n);
}

// one line: qty × (price + add-ons); a cancelled line counts 0
function lineTotal(line) {
  if (!line || line.status === "void") return 0;
  const addons = (line.addons || []).reduce((a, x) => a + (Number(x.price) || 0), 0);
  return (Number(line.qty) || 0) * ((Number(line.unit_price) || 0) + addons);
}

// a payment's worth in the main currency
function paymentValue(p, s) {
  const amount = Number(p.amount) || 0;
  const rate = s.khr_rate || 4100;
  if (p.currency === s.currency) return amount;
  return s.currency === "USD" ? round2(amount / rate) : roundStep(amount * rate, s.khr_rounding || 100);
}

// the other currency, shown beside a total (USD → riel rounded to the shop's step; riel → USD)
function otherCurrency(n, s) {
  const rate = s.khr_rate || 4100;
  return s.currency === "USD" ? roundStep(n * rate, s.khr_rounding || 100) : round2(n / rate);
}

// money off one line: the cashier's discount, else the promotion's (never more than the line)
function lineOff(line) {
  const t = lineTotal(line);
  if (!t) return 0;
  const d = line.discount || {};
  let off = 0;
  if (d.kind === "percent") off = (t * Math.min(100, Math.max(0, Number(d.value) || 0))) / 100;
  else if (d.kind === "amount") off = Math.max(0, Number(d.value) || 0);
  else off = Math.max(0, Number(line.promo?.off) || 0);
  return Math.min(t, round2(off));
}

function calcOrder(order, s) {
  const lines = order.lines || [];
  const subtotal = money(lines.reduce((a, l) => a + lineTotal(l), 0), s);
  // item discounts first (by hand or promotions), then the bill discount on what's left
  const itemDiscount = money(lines.reduce((a, l) => a + lineOff(l), 0), s);
  // a reward the member paid for with points ($ or % off), then the cashier's bill discount on what's left
  const rw = order.reward_discount || {};
  let rewardDiscount = 0;
  if (rw.kind === "percent") rewardDiscount = money(((subtotal - itemDiscount) * Math.min(100, Math.max(0, Number(rw.value) || 0))) / 100, s);
  else if (rw.kind === "amount") rewardDiscount = money(Math.min(subtotal - itemDiscount, Math.max(0, Number(rw.value) || 0)), s);
  const afterItems = subtotal - itemDiscount - rewardDiscount;
  const d = order.discount || {};
  let billDiscount = 0;
  if (d.kind === "percent") billDiscount = money((afterItems * Math.min(100, Math.max(0, Number(d.value) || 0))) / 100, s);
  else if (d.kind === "amount") billDiscount = money(Math.min(afterItems, Math.max(0, Number(d.value) || 0)), s);
  const discount = itemDiscount + rewardDiscount + billDiscount;
  const afterDiscount = subtotal - discount;
  const svc = s.service_charge || {};
  const service = svc.enabled && order.type !== "takeaway" ? money((afterDiscount * (Number(svc.rate) || 0)) / 100, s) : 0;
  const base = afterDiscount + service;
  const vatS = s.vat || {};
  const rate = Number(vatS.rate) || 0;
  let vat = 0;
  let total = base;
  if (vatS.enabled && rate > 0) {
    if (vatS.included) vat = money((base * rate) / (100 + rate), s);
    else {
      vat = money((base * rate) / 100, s);
      total = base + vat;
    }
  }
  total = money(total, s);
  const paid = money((order.payments || []).reduce((a, p) => a + paymentValue(p, s), 0), s);
  const rawDue = total - paid;
  // paid in full when what's left can't be paid any more (less than one riel step / one cent)
  const step = s.khr_rounding || 100;
  const settled = rawDue <= 0 || (s.currency === "USD" ? otherCurrency(rawDue, s) === 0 : rawDue < step / 2);
  const due = settled ? 0 : money(rawDue, s);
  const change = rawDue < 0 ? money(-rawDue, s) : 0;
  const count = lines.filter((l) => l.status !== "void").reduce((a, l) => a + (Number(l.qty) || 0), 0);
  return { subtotal, discount, item_discount: itemDiscount, reward_discount: rewardDiscount, bill_discount: billDiscount, service, vat, vat_included: !!(vatS.enabled && vatS.included), total, other: otherCurrency(total, s), paid, due, change, change_other: otherCurrency(change, s), settled, items: count };
}

// ---------- promotions ----------
// is a promotion on at this moment? (dates "YYYY-MM-DD", days 0–6, hours "HH:MM", Cambodia time)
function promoOn(p, at, tzHours = 7) {
  const local = new Date(new Date(at).getTime() + tzHours * 3600000);
  const day = local.toISOString().slice(0, 10);
  const hm = local.toISOString().slice(11, 16);
  if (p.start_date && day < p.start_date) return false;
  if (p.end_date && day > p.end_date) return false;
  if (p.days?.length && !p.days.includes(local.getUTCDay())) return false;
  if (p.from && p.to) {
    if (p.from <= p.to ? hm < p.from || hm >= p.to : hm < p.from && hm >= p.to) return false; // "22:00–02:00" works too
  }
  return true;
}
const promoHits = (p, line, catOf) => p.all_items || (p.item_ids || []).includes(String(line.item_id)) || (p.category_ids || []).includes(String(catOf(line.item_id) || ""));

// money off each line for one promotion, over the lines given
function promoOffs(p, lines) {
  const offs = {};
  if (p.kind === "percent") for (const l of lines) offs[l.id] = (lineTotal(l) * Math.min(100, Number(p.value) || 0)) / 100;
  else if (p.kind === "amount") for (const l of lines) offs[l.id] = Math.min(lineTotal(l), (Number(p.value) || 0) * (Number(l.qty) || 0));
  else if (p.kind === "bxgy") {
    // every unit, most expensive first; in each group of (buy + get) the cheapest "get" ones are cheaper
    const units = [];
    for (const l of lines) for (let i = 0; i < (Number(l.qty) || 0); i++) units.push({ id: l.id, price: lineTotal(l) / (Number(l.qty) || 1) });
    units.sort((a, b) => b.price - a.price);
    const size = (Number(p.buy) || 1) + (Number(p.get_qty) || 1);
    const pct = Math.min(100, Number(p.get_percent) || 100) / 100;
    for (let g = 0; g + size <= units.length; g += size) for (let k = g + size - (Number(p.get_qty) || 1); k < g + size; k++) offs[units[k].id] = (offs[units[k].id] || 0) + units[k].price * pct;
  }
  for (const k of Object.keys(offs)) offs[k] = round2(offs[k]);
  return offs;
}

// give an open order's lines their promotion (the one that saves the guest most). Lines with a cashier's discount keep it.
function applyPromos(order, promos, catOf = () => "", tzHours = 7) {
  const live = (order.lines || []).filter((l) => l.status !== "void" && !l.discount?.kind && l.item_id);
  const on = (promos || []).filter((p) => p);
  // 1) what each promotion would give each line
  const best = {};
  for (const p of on) {
    const hits = live.filter((l) => promoHits(p, l, catOf) && promoOn(p, l.created_at || Date.now(), tzHours));
    if (!hits.length) continue;
    const offs = promoOffs(p, hits);
    for (const l of hits) if ((offs[l.id] || 0) > (best[l.id]?.off || 0) || (p.kind === "bxgy" && !best[l.id])) best[l.id] = { p, off: offs[l.id] || 0 };
  }
  // 2) each promotion again, over only the lines it won (so buy-X-get-Y groups are counted right)
  const byPromo = new Map();
  for (const [id, b] of Object.entries(best)) {
    if (!byPromo.has(b.p)) byPromo.set(b.p, []);
    byPromo.get(b.p).push(id);
  }
  const result = {};
  for (const [p, ids] of byPromo) {
    const offs = promoOffs(p, live.filter((l) => ids.includes(l.id)));
    for (const id of ids) result[id] = { id: String(p._id), name: p.name, off: offs[id] || 0 };
  }
  return {
    ...order,
    lines: (order.lines || []).map((l) => {
      if (l.discount?.kind || l.status === "void") return l.promo?.off ? { ...l, promo: { id: "", name: "", off: 0 } } : l;
      const r = result[l.id];
      const promo = r && (r.off > 0 || r.id) ? r : { id: "", name: "", off: 0 };
      return promo.off > 0 ? { ...l, promo } : l.promo?.id ? { ...l, promo: { id: "", name: "", off: 0 } } : l;
    }),
  };
}

// what a closed shift adds up to: sales, bills, by payment method, cash expected in the drawer (per currency)
function shiftSummary(shift, orders, s) {
  const mine = orders.filter((o) => o.shift_id === shift._id);
  const paid = mine.filter((o) => o.status === "paid");
  const byMethod = {};
  const cash = { usd: Number(shift.opening?.usd) || 0, khr: Number(shift.opening?.khr) || 0 };
  let sales = 0;
  let discounts = 0;
  let guests = 0;
  let voidLines = 0;
  for (const o of paid) {
    const t = calcOrder(o, s);
    sales += t.total;
    discounts += t.discount;
    guests += Number(o.guests) || 0;
    for (const p of o.payments || []) {
      byMethod[p.method || p.kind] = (byMethod[p.method || p.kind] || 0) + paymentValue(p, s);
      if (p.kind === "cash") cash[p.currency === "KHR" ? "khr" : "usd"] += Number(p.amount) || 0;
    }
    cash.usd -= Number(o.change?.usd) || 0;
    cash.khr -= Number(o.change?.khr) || 0;
    // change handed back comes out of the cash method (so the methods add up to the sales)
    const back = Math.max(0, t.paid - t.total);
    if (back > 0) {
      const p = (o.payments || []).find((x) => x.kind === "cash") || (o.payments || [])[0];
      if (p) byMethod[p.method || p.kind] = (byMethod[p.method || p.kind] || 0) - back;
    }
  }
  for (const o of mine) voidLines += (o.lines || []).filter((l) => l.status === "void" && l.void_reason !== "removed").length;
  for (const k of Object.keys(byMethod)) byMethod[k] = money(byMethod[k], s);
  return {
    bills: paid.length,
    sales: money(sales, s),
    discounts: money(discounts, s),
    guests,
    void_orders: mine.filter((o) => o.status === "void").length,
    void_lines: voidLines,
    open_orders: mine.filter((o) => o.status === "open").length,
    by_method: byMethod,
    expected: { usd: round2(cash.usd), khr: roundStep(cash.khr, 1) },
  };
}

// the local day of a date ("YYYY-MM-DD", Cambodia = UTC+7 by default) and its hour
function localDay(d, tzHours = 7) {
  const x = new Date(new Date(d).getTime() + tzHours * 3600000);
  return { day: x.toISOString().slice(0, 10), hour: x.getUTCHours() };
}

// sales report from a list of orders: totals, by day / hour / payment method / item / category / staff / order type.
// opts: { catOf(item_id) → category id, tzHours }   (paid bills count as sales; cancelled ones are counted apart)
function salesReport(orders, s, opts = {}) {
  const tz = opts.tzHours ?? 7;
  const catOf = opts.catOf || (() => "");
  const paid = orders.filter((o) => o.status === "paid");
  const r = { sales: 0, bills: paid.length, avg: 0, discounts: 0, service: 0, vat: 0, guests: 0, items: 0, cost: 0, void_orders: 0, void_value: 0, void_lines: 0, open_orders: 0 };
  const days = {};
  const hours = Array.from({ length: 24 }, () => 0);
  const methods = {};
  const items = {};
  const cats = {};
  const staff = {};
  const types = { dine_in: { bills: 0, sales: 0 }, takeaway: { bills: 0, sales: 0 } };
  const promos = {};
  for (const o of orders) {
    if (o.status === "open") r.open_orders += 1;
    r.void_lines += (o.lines || []).filter((l) => l.status === "void" && l.void_reason !== "removed" && o.status !== "void").length;
    if (o.status !== "void") continue;
    r.void_orders += 1;
    r.void_value += (o.lines || []).filter((l) => l.void_reason !== "removed").reduce((a, l) => a + lineTotal({ ...l, status: "" }), 0);
  }
  for (const o of paid) {
    const t = calcOrder(o, s);
    r.sales += t.total;
    r.discounts += t.discount;
    r.service += t.service;
    r.vat += t.vat;
    r.guests += Number(o.guests) || 0;
    r.items += t.items;
    const { day, hour } = localDay(o.paid_at || o.opened_at, tz);
    days[day] = days[day] || { day, sales: 0, bills: 0 };
    days[day].sales += t.total;
    days[day].bills += 1;
    hours[hour] += t.total;
    const type = o.type === "takeaway" ? "takeaway" : "dine_in";
    types[type].bills += 1;
    types[type].sales += t.total;
    const who = o.closed_by?.name || o.opened_by?.name || "—";
    staff[who] = staff[who] || { name: who, bills: 0, sales: 0 };
    staff[who].bills += 1;
    staff[who].sales += t.total;
    for (const p of o.payments || []) {
      const k = p.method || p.kind || "—";
      methods[k] = methods[k] || { name: k, kind: p.kind || "", value: 0, count: 0 };
      methods[k].value += paymentValue(p, s);
      methods[k].count += 1;
    }
    const back = Math.max(0, t.paid - t.total);
    if (back > 0) {
      const p = (o.payments || []).find((x) => x.kind === "cash") || (o.payments || [])[0];
      if (p) methods[p.method || p.kind || "—"].value -= back;
    }
    for (const l of o.lines || []) {
      if (l.status === "void") continue;
      const key = `${l.item_id || l.name_en || l.name_km}|${l.size || ""}`;
      const off = lineOff(l);
      const v = lineTotal(l) - off;
      const lc = (Number(l.cost) || 0) * (Number(l.qty) || 0);
      if (off > 0) {
        const pk = l.discount?.kind ? "manual" : l.promo?.id || "promo";
        promos[pk] = promos[pk] || { id: pk, name: l.discount?.kind ? "" : l.promo?.name || "", off: 0, qty: 0, lines: 0 };
        promos[pk].off += off;
        promos[pk].qty += Number(l.qty) || 0;
        promos[pk].lines += 1;
      }
      r.cost += lc;
      items[key] = items[key] || { key, item_id: l.item_id || "", name_km: l.name_km || "", name_en: l.name_en || "", size: l.size || "", qty: 0, sales: 0, cost: 0 };
      items[key].qty += Number(l.qty) || 0;
      items[key].sales += v;
      items[key].cost += lc;
      const c = String(catOf(l.item_id) || "");
      cats[c] = cats[c] || { category_id: c, qty: 0, sales: 0 };
      cats[c].qty += Number(l.qty) || 0;
      cats[c].sales += v;
    }
  }
  const m = (v) => money(v, s);
  const bySales = (a, b) => b.sales - a.sales;
  return {
    ...r,
    sales: m(r.sales),
    avg: r.bills ? m(r.sales / r.bills) : 0,
    discounts: m(r.discounts),
    service: m(r.service),
    vat: m(r.vat),
    void_value: m(r.void_value),
    // cost of what was sold, and gross profit = sales without VAT − cost
    cost: round2(r.cost),
    profit: round2(r.sales - r.vat - r.cost),
    by_day: Object.values(days)
      .map((d) => ({ ...d, sales: m(d.sales) }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
    by_hour: hours.map(m),
    by_method: Object.values(methods)
      .map((x) => ({ ...x, value: m(x.value) }))
      .sort((a, b) => b.value - a.value),
    by_item: Object.values(items)
      .map((x) => ({ ...x, sales: m(x.sales), cost: round2(x.cost), profit: round2(x.sales - x.cost) }))
      .sort((a, b) => b.qty - a.qty || b.sales - a.sales),
    by_category: Object.values(cats)
      .map((x) => ({ ...x, sales: m(x.sales) }))
      .sort(bySales),
    by_staff: Object.values(staff)
      .map((x) => ({ ...x, sales: m(x.sales) }))
      .sort(bySales),
    by_promo: Object.values(promos)
      .map((x) => ({ ...x, off: m(x.off) }))
      .sort((a, b) => b.off - a.off),
    by_type: { dine_in: { ...types.dine_in, sales: m(types.dine_in.sales) }, takeaway: { ...types.takeaway, sales: m(types.takeaway.sales) } },
  };
}

module.exports = { round2, roundStep, money, lineTotal, paymentValue, otherCurrency, calcOrder, shiftSummary, localDay, salesReport, lineOff, promoOn, promoOffs, applyPromos };
