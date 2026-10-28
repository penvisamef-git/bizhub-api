// Owner home screen: one call with everything the dashboard shows.
//   GET /api/user/dashboard[?fresh=1]
//     coins       { balance, wallet, spent_30d }
//     businesses  same rows as GET /api/user/businesses (photo / logo, license…)
//     sales       restaurants + guest houses (money received) — today, yesterday, this week (Mon→today) vs the same days last week,
//                 this month, bills, average bill, open bills now, last 14 days; totals in one currency
//                 (USD, or riel when every restaurant uses riel) + each restaurant in its own currency
//     top_items   best sellers this week across every business that sells (restaurants + mini marts), each with its business type
//     now         right now across all businesses: online orders / bookings waiting, guests in house, open bills,
//                 staff at work today, new messages, low / sold-out stock, renewals within 14 days, new customers this week
//     attention   (older screens) years / add-ons ending within 14 days or ended, low stock and sold out items
// Days are Cambodia days (UTC+7). Results are kept 30 seconds per owner (?fresh=1 skips that).
const mongoose = require("mongoose");
const { customer_auth } = require("../user/customer_auth");
const { listFor } = require("./business.route");
const License = require("../license/license.model");
const { PRODUCTS } = require("../license/license.products");
const coin = require("../coin/coin.service");
const CoinTransaction = require("../coin/coin_transaction.model");

const TZ = 7;
const DAY = 86400000;
const CACHE_MS = 30 * 1000;
const cache = new Map(); // ownerId → { at, data }

const localDay = (d) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - TZ * 3600000);
const round = (n, c) => (c === "KHR" ? Math.round(n) : Math.round(n * 100) / 100);

async function build(ownerId) {
  const M = require("./restaurant/restaurant.models");
  const now = new Date();
  const today = localDay(now);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const weekStart = addDays(today, -dow);
  const lastWeekStart = addDays(weekStart, -7);
  const lastWeekSameEnd = addDays(lastWeekStart, dow); // same weekday last week
  const monthStart = `${today.slice(0, 7)}-01`;
  const chartStart = addDays(today, -13);
  const from = [chartStart, lastWeekStart, monthStart].sort()[0];

  const [businesses, wallet] = await Promise.all([listFor(ownerId), coin.getCustomerWallet(ownerId)]);
  const spent = await CoinTransaction.aggregate([{ $match: { from_customer: new mongoose.Types.ObjectId(String(ownerId)), created_date: { $gte: new Date(now - 30 * DAY) } } }, { $group: { _id: null, n: { $sum: "$amount" } } }]);
  const coins = { balance: wallet?.balance || 0, wallet: String(wallet?._id || ""), spent_30d: spent[0]?.n || 0 };

  const rests = businesses.filter((b) => b.category === "restaurant");
  // guest houses: money received (payments on stays) counts as sales; "open" = guests in the rooms now
  const G = require("./guesthouse/guesthouse.models");
  const ghs = businesses.filter((b) => b.category === "guest_house");
  const ghIds = ghs.map((b) => b._id);
  const [ghSettings, ghByDay, ghIn] = ghIds.length
    ? await Promise.all([
        G.GhSettings.find({ business_id: { $in: ghIds } })
          .select("business_id currency khr_rate")
          .lean(),
        G.GhStay.aggregate([
          { $match: { business_id: { $in: ghIds }, "payments.at": { $gte: dayStart(from) } } },
          { $unwind: "$payments" },
          { $match: { "payments.at": { $gte: dayStart(from) } } },
          { $group: { _id: { b: "$business_id", d: { $dateToString: { format: "%Y-%m-%d", date: "$payments.at", timezone: "+07:00" } } }, sales: { $sum: "$payments.amount" }, bills: { $sum: 1 } } },
        ]),
        G.GhStay.aggregate([{ $match: { business_id: { $in: ghIds }, status: "in" } }, { $group: { _id: "$business_id", n: { $sum: 1 } } }]),
      ])
    : [[], [], []];
  const money = new Map(rests.map((b) => [String(b._id), { currency: b.restaurant?.currency || "USD", khr_rate: b.restaurant?.khr_rate || 4100 }]));
  for (const b of ghs) {
    const st = ghSettings.find((x) => String(x.business_id) === String(b._id));
    money.set(String(b._id), { currency: st?.currency || "USD", khr_rate: st?.khr_rate || 4100 });
  }
  // mini marts: paid sales (receipts not voided)
  const MM = require("./mart/mart.models");
  const marts = businesses.filter((b) => b.category === "mart");
  const martIds = marts.map((b) => b._id);
  const [martSettings, martByDay] = martIds.length
    ? await Promise.all([
        MM.MartSettings.find({ business_id: { $in: martIds } })
          .select("business_id currency khr_rate")
          .lean(),
        MM.MartSale.aggregate([
          { $match: { business_id: { $in: martIds }, status: "paid", at: { $gte: dayStart(from) } } },
          { $group: { _id: { b: "$business_id", d: { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: "+07:00" } } }, sales: { $sum: "$total" }, bills: { $sum: 1 } } },
        ]),
      ])
    : [[], []];
  for (const b of marts) {
    const st = martSettings.find((x) => String(x.business_id) === String(b._id));
    money.set(String(b._id), { currency: st?.currency || "USD", khr_rate: st?.khr_rate || 4100 });
  }
  const sellers = [...rests, ...ghs, ...marts];
  const ids = rests.map((b) => b._id);
  const allIds = businesses.map((b) => b._id);
  const soon = new Date(now.getTime() + 14 * DAY);
  const [byDay, openNow, top, stock, ending] = await Promise.all([
    ids.length
      ? M.RestOrder.aggregate([
          { $match: { business_id: { $in: ids }, status: "paid", paid_at: { $gte: dayStart(from) } } },
          { $group: { _id: { b: "$business_id", d: { $dateToString: { format: "%Y-%m-%d", date: "$paid_at", timezone: "+07:00" } } }, sales: { $sum: "$totals.total" }, bills: { $sum: 1 } } },
        ])
      : [],
    ids.length ? M.RestOrder.aggregate([{ $match: { business_id: { $in: ids }, status: "open" } }, { $group: { _id: "$business_id", n: { $sum: 1 } } }]) : [],
    ids.length
      ? M.RestOrder.aggregate([
          { $match: { business_id: { $in: ids }, status: "paid", paid_at: { $gte: dayStart(weekStart) } } },
          { $unwind: "$lines" },
          { $match: { "lines.status": { $ne: "void" } } },
          {
            $group: {
              _id: { b: "$business_id", i: { $cond: [{ $gt: ["$lines.item_id", ""] }, "$lines.item_id", "$lines.name_en"] } },
              name_en: { $first: "$lines.name_en" },
              name_km: { $first: "$lines.name_km" },
              qty: { $sum: "$lines.qty" },
              value: { $sum: { $multiply: ["$lines.qty", "$lines.unit_price"] } },
            },
          },
          { $sort: { qty: -1 } },
          { $limit: 40 },
        ])
      : [],
    ids.length
      ? M.RestItem.aggregate([
          { $match: { business_id: { $in: ids }, active: true, track_stock: true } },
          { $group: { _id: "$business_id", out: { $sum: { $cond: [{ $lte: ["$stock", 0] }, 1, 0] } }, low: { $sum: { $cond: [{ $and: [{ $gt: ["$stock", 0] }, { $lte: ["$stock", "$low_stock"] }] }, 1, 0] } } } },
        ])
      : [],
    allIds.length
      ? License.find({ business_id: { $in: allIds }, expires_at: { $ne: null, $lte: soon, $gte: new Date(now - 30 * DAY) } })
          .select("business_id product item expires_at")
          .lean()
      : [],
  ]);

  // one currency for the totals: riel only when every restaurant sells in riel
  const main = sellers.length && sellers.every((b) => money.get(String(b._id)).currency === "KHR") ? "KHR" : "USD";
  const toMain = (v, b) => {
    const c = money.get(String(b._id)).currency;
    const rate = money.get(String(b._id)).khr_rate;
    if (c === main) return v;
    return main === "USD" ? v / rate : v * rate;
  };
  const sum = (rows, a, z) => rows.filter((r) => r._id.d >= a && r._id.d <= z).reduce((x, r) => ({ sales: x.sales + r.sales, bills: x.bills + r.bills }), { sales: 0, bills: 0 });
  const days14 = Array.from({ length: 14 }, (_, i) => addDays(chartStart, i));
  const per = sellers.map((b) => {
    const gh = b.category === "guest_house";
    const mart = b.category === "mart";
    const rows = (gh ? ghByDay : mart ? martByDay : byDay).filter((r) => String(r._id.b) === String(b._id));
    const c = money.get(String(b._id)).currency;
    const t = sum(rows, today, today);
    const y = sum(rows, addDays(today, -1), addDays(today, -1));
    const w = sum(rows, weekStart, today);
    const lw = sum(rows, lastWeekStart, lastWeekSameEnd);
    const m = sum(rows, monthStart, today);
    return {
      id: b._id,
      name: b.name,
      kind: gh ? "guest_house" : mart ? "mart" : "restaurant",
      currency: c,
      today: round(t.sales, c),
      bills_today: t.bills,
      yesterday: round(y.sales, c),
      week: round(w.sales, c),
      bills_week: w.bills,
      last_week: round(lw.sales, c),
      month: round(m.sales, c),
      open_now: (gh ? ghIn : openNow).find((o) => String(o._id) === String(b._id))?.n || 0,
      days: days14.map((d) => round(rows.find((r) => r._id.d === d)?.sales || 0, c)),
      _raw: { t, y, w, lw, m, rows },
    };
  });
  const tot = (k) =>
    round(
      per.reduce(
        (n, p) =>
          n +
          toMain(
            p._raw[k].sales,
            sellers.find((b) => b._id === p.id),
          ),
        0,
      ),
      main,
    );
  const bills = (k) => per.reduce((n, p) => n + p._raw[k].bills, 0);
  const sales = sellers.length
    ? {
        currency: main,
        today: tot("t"),
        bills_today: bills("t"),
        avg_today: bills("t") ? round(tot("t") / bills("t"), main) : 0,
        yesterday: tot("y"),
        week: tot("w"),
        bills_week: bills("w"),
        last_week: tot("lw"),
        month: tot("m"),
        bills_month: bills("m"),
        open_now: per.reduce((n, p) => n + p.open_now, 0),
        days: days14.map((d, i) => ({
          day: d,
          sales: round(
            per.reduce(
              (n, p) =>
                n +
                toMain(
                  p.days[i],
                  sellers.find((b) => b._id === p.id),
                ),
              0,
            ),
            main,
          ),
        })),
        week_start: weekStart,
        by_business: per.map(({ _raw, ...p }) => p),
      }
    : null;

  // best sellers this week across every business that sells (same item in two businesses stays two rows)
  const martTop = martIds.length
    ? await MM.MartSale.aggregate([
        { $match: { business_id: { $in: martIds }, status: "paid", at: { $gte: dayStart(weekStart) } } },
        { $unwind: "$items" },
        { $group: { _id: { b: "$business_id", i: { $ifNull: ["$items.product_id", "$items.name"] } }, name: { $first: "$items.name" }, qty: { $sum: "$items.qty" }, value: { $sum: "$items.total" } } },
        { $sort: { qty: -1 } },
        { $limit: 40 },
      ])
    : [];
  const top_items = [
    ...top.map((x) => {
      const b = rests.find((r) => String(r._id) === String(x._id.b));
      return { name_en: x.name_en, name_km: x.name_km, qty: x.qty, value: round(toMain(x.value, b), main), business: b?.name || "", business_id: b?._id || null, kind: "restaurant" };
    }),
    ...martTop.map((x) => {
      const b = marts.find((r) => String(r._id) === String(x._id.b));
      return { name_en: x.name, name_km: x.name, qty: Math.round(x.qty * 1000) / 1000, value: round(toMain(x.value, b), main), business: b?.name || "", business_id: b?._id || null, kind: "mart" };
    }),
  ]
    .sort((a, b) => b.qty - a.qty || b.value - a.value)
    .slice(0, 8);

  const attention = [];
  for (const b of businesses) {
    if (b.license && (b.license.status === "expired" || b.license.status === "expiring")) attention.push({ kind: b.license.status === "expired" ? "year_ended" : "year_ending", business_id: b._id, business: b.name, at: b.license.expires_at });
  }
  for (const l of ending) {
    if (l.product === "restaurant" || l.product === "guest_house" || l.product === "mart") continue; // shown above
    const b = businesses.find((x) => String(x._id) === String(l.business_id));
    if (!b || !PRODUCTS[l.product]) continue;
    attention.push({ kind: l.expires_at < now ? "addon_ended" : "addon_ending", product: l.product, item: l.item || "", business_id: b._id, business: b.name, at: l.expires_at });
  }
  for (const s of stock) {
    const b = rests.find((x) => String(x._id) === String(s._id));
    if (s.out) attention.push({ kind: "sold_out", n: s.out, business_id: b._id, business: b.name });
    if (s.low) attention.push({ kind: "low_stock", n: s.low, business_id: b._id, business: b.name });
  }
  const now_ = await rightNow({ businesses, rests, ghs, marts, ending, stock, now, weekStart });
  return { at: now, coins, businesses, sales, top_items, attention, now: now_ };
}

// "right now" across all the owner's businesses: what is waiting, who is here, what runs out
async function rightNow({ businesses, rests, ghs, marts, ending, stock, now, weekStart }) {
  const G = require("./guesthouse/guesthouse.models");
  const MM = require("./mart/mart.models");
  const A = require("./attendance/attendance.models");
  const M = require("./restaurant/restaurant.models");
  const ids = (list) => list.map((b) => b._id);
  const atts = businesses.filter((b) => b.category === "attendance");
  const today = localDay(now);
  const weekFrom = dayStart(weekStart);
  const by = (rows) => new Map(rows.map((r) => [String(r._id), r.n]));
  const grp = (Model, match) => Model.aggregate([{ $match: match }, { $group: { _id: "$business_id", n: { $sum: 1 } } }]);
  const none = Promise.resolve([]);
  const [martNew, ghReq, ghSite, ghIn, restOpen, staffAll, staffIn, martMsg, martStock, martCust, ghCust] = await Promise.all([
    marts.length ? grp(MM.MartOrder, { business_id: { $in: ids(marts) }, status: "new" }) : none,
    ghs.length ? grp(G.GhCustBooking, { business_id: { $in: ids(ghs) }, status: "pending" }) : none,
    ghs.length ? grp(G.GhSiteRequest, { business_id: { $in: ids(ghs) }, status: "new" }) : none,
    ghs.length ? grp(G.GhStay, { business_id: { $in: ids(ghs) }, status: "in" }) : none,
    rests.length ? grp(M.RestOrder, { business_id: { $in: ids(rests) }, status: "open" }) : none,
    atts.length ? grp(A.AttStaff, { business_id: { $in: ids(atts) }, active: true }) : none,
    atts.length ? A.AttPunch.aggregate([{ $match: { business_id: { $in: ids(atts) }, day: today, kind: "in" } }, { $group: { _id: { b: "$business_id", s: "$staff_id" } } }, { $group: { _id: "$_id.b", n: { $sum: 1 } } }]) : none,
    marts.length ? grp(MM.MartMessage, { business_id: { $in: ids(marts) }, read: false }) : none,
    marts.length
      ? MM.MartProduct.aggregate([
          { $match: { business_id: { $in: ids(marts) }, active: true, track_stock: true } },
          { $group: { _id: "$business_id", out: { $sum: { $cond: [{ $lte: ["$stock", 0] }, 1, 0] } }, low: { $sum: { $cond: [{ $and: [{ $gt: ["$stock", 0] }, { $lte: ["$stock", "$low_stock"] }] }, 1, 0] } } } },
        ])
      : none,
    marts.length ? grp(MM.MartCustomer, { business_id: { $in: ids(marts) }, created_date: { $gte: weekFrom } }) : none,
    ghs.length ? grp(G.GhCustomer, { business_id: { $in: ids(ghs) }, created_date: { $gte: weekFrom } }) : none,
  ]);
  // a tile = a number + the businesses it comes from (the biggest first), so the owner can open the right one
  const tile = (key, maps, list, tab) => {
    const rows = list
      .map((b) => ({ id: b._id, name: b.name, kind: b.category, n: maps.reduce((a, m) => a + (m.get(String(b._id)) || 0), 0) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);
    return { key, n: rows.reduce((a, x) => a + x.n, 0), tab, by: rows.slice(0, 4) };
  };
  const stockMap = (rows, k) => new Map(rows.map((r) => [String(r._id), r[k]]));
  const allStock = [...stock, ...martStock];
  const tiles = [];
  if (marts.length || ghs.length) tiles.push(tile("waiting", [by(martNew), by(ghReq), by(ghSite)], [...marts, ...ghs], { mart: "orders", guest_house: "customers" }));
  if (ghs.length) tiles.push(tile("in_house", [by(ghIn)], ghs, { guest_house: "" }));
  if (rests.length) tiles.push(tile("open_bills", [by(restOpen)], rests, { restaurant: "" }));
  if (atts.length) {
    const t = tile("staff_in", [by(staffIn)], atts, { attendance: "" });
    t.of = staffAll.reduce((a, r) => a + r.n, 0);
    // who came late / whose shift started and is not in yet (the attendance rules: shifts, leave, holidays)
    t.late = 0;
    t.not_in = 0;
    try {
      const AR = require("./attendance/attendance.route");
      for (const b of atts.slice(0, 10)) {
        const staff = await A.AttStaff.find({ business_id: b._id, active: true }).lean();
        if (!staff.length) continue;
        const { out } = await AR.statusesOf(b._id, staff, [today], await AR.settingsOf(b._id));
        for (const st of staff) {
          const d = out[st._id]?.[today] || {};
          if (d.first_in && d.late_min > 0) t.late += 1;
          if (d.status === "not_yet" || d.status === "absent") t.not_in += 1;
        }
      }
    } catch (err) {
      console.error("dashboard staff", err.message);
    }
    tiles.push(t);
  }
  if (marts.length) tiles.push(tile("messages", [by(martMsg)], marts, { mart: "website" }));
  if (rests.length || marts.length) {
    const t = tile("stock", [stockMap(allStock, "out"), stockMap(allStock, "low")], [...rests, ...marts], { restaurant: "stock", mart: "stock" });
    t.out = allStock.reduce((a, r) => a + r.out, 0);
    t.low = allStock.reduce((a, r) => a + r.low, 0);
    tiles.push(t);
  }
  if (marts.length || ghs.length) tiles.push(tile("new_customers", [by(martCust), by(ghCust)], [...marts, ...ghs], { mart: "orders", guest_house: "customers" }));
  // renewals: the business year + add-ons ending within 14 days (or ended in the last 30)
  const renew = new Map();
  for (const b of businesses) if (b.license && (b.license.status === "expired" || b.license.status === "expiring")) renew.set(String(b._id), (renew.get(String(b._id)) || 0) + 1);
  for (const l of ending) if (!["restaurant", "guest_house", "mart"].includes(l.product) && PRODUCTS[l.product]) renew.set(String(l.business_id), (renew.get(String(l.business_id)) || 0) + 1);
  tiles.push({
    ...tile("renewals", [renew], businesses, {}),
    soonest:
      [...businesses.filter((b) => b.license?.expires_at && b.license.status !== "none").map((b) => b.license.expires_at), ...ending.map((l) => l.expires_at)].filter((d) => new Date(d) >= now).sort((a, b) => new Date(a) - new Date(b))[0] || null,
  });
  return tiles;
}

module.exports = (prop) => {
  prop.app.get("/api/user/dashboard", prop.api_auth, customer_auth, async (req, res) => {
    try {
      const key = String(req.customer._id);
      const hit = cache.get(key);
      if (hit && req.query.fresh !== "1" && Date.now() - hit.at < CACHE_MS) return res.json({ success: true, data: hit.data, cached: true });
      const data = await build(req.customer._id);
      if (cache.size > 5000) cache.clear();
      cache.set(key, { at: Date.now(), data });
      res.json({ success: true, data });
    } catch (err) {
      console.error("dashboard", err);
      res.status(500).json({ success: false, message: "មានបញ្ហាពីម៉ាស៊ីនមេ" });
    }
  });
};
// adding / changing a business should show at once
module.exports.forget = (ownerId) => cache.delete(String(ownerId));
// the same answer for Bizi's brief (src/biz/bizi.route.js), from the same 30 s cache
module.exports.dashboardOf = async (ownerId) => {
  const key = String(ownerId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await build(ownerId);
  if (cache.size > 5000) cache.clear();
  cache.set(key, { at: Date.now(), data });
  return data;
};
