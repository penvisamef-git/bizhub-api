// Bizi brief (v3.0.0, layer 1 — no AI): what the helper tells the owner before they ask.
//   GET /api/user/bizi/brief
//   → { data: {
//        summary { currency, today, yesterday, week, last_week, change_pct, bills_today, orders_today } — money taken
//                (restaurants, mini marts, guest houses from the dashboard + Telegram Store orders)
//        pulse   a number that goes up with every new bill / order / booking today (the web turns it into "happy")
//        alerts  [{ key, level: warn | info, n, business_id, business, category, tab, href, at }] — the worst first
//        mood    worried (something waits) | idle
//      } }
//   alerts: tg_new (new Telegram orders; warn after 5 min) · waiting (online orders / bookings) · ev_review (ticket
//   payments to check) · checkout_late (guests past their check-out) · arrivals (guests arriving today) · open_bills ·
//   sold_out · low_stock · renewals (a year / add-on ending within 7 days = warn) · staff_late
// Days are Cambodia days (UTC+7). Owner's own businesses (like the dashboard).
const { customer_auth } = require("../user/customer_auth");
const { dashboardOf } = require("./dashboard.route");

const DAY = 864e5;
const TZ = 7 * 3600e3;
const dayStart = (offset = 0) => new Date(Math.floor((Date.now() + TZ) / DAY) * DAY - TZ + offset * DAY);

async function brief(ownerId) {
  const dash = await dashboardOf(ownerId);
  const businesses = dash.businesses || [];
  const of = (type) => businesses.filter((b) => b.category === type);
  const ids = (list) => list.map((b) => b._id);
  const nameOf = new Map(businesses.map((b) => [String(b._id), b]));
  const today = dayStart(0);
  const yesterday = dayStart(-1);
  const alerts = [];
  const add = (a) => {
    if (!a.n) return;
    const b = a.business_id ? nameOf.get(String(a.business_id)) : null;
    alerts.push({ level: "info", ...a, business: a.business || b?.name || "", category: a.category || b?.category || "" });
  };

  // ---- the dashboard's "right now" tiles
  const tile = (k) => (dash.now || []).find((x) => x.key === k);
  const first = (t) => t?.by?.[0];
  const w = tile("waiting");
  if (w?.n) add({ key: "waiting", n: w.n, business_id: first(w)?.id, tab: w.tab?.[first(w)?.kind] || "", level: "warn" });
  const ob = tile("open_bills");
  if (ob?.n) add({ key: "open_bills", n: ob.n, business_id: first(ob)?.id, tab: "" });
  const st = tile("stock");
  if (st?.out) add({ key: "sold_out", n: st.out, business_id: first(st)?.id, tab: "stock", level: "warn" });
  if (st?.low) add({ key: "low_stock", n: st.low, business_id: first(st)?.id, tab: "stock" });
  const staff = tile("staff_in");
  if (staff?.late) add({ key: "staff_late", n: staff.late, business_id: first(staff)?.id || of("attendance")[0]?._id, tab: "today" });
  const rn = tile("renewals");
  if (rn?.n) add({ key: "renewals", n: rn.n, href: "/app/licenses", at: rn.soonest, level: rn.soonest && new Date(rn.soonest) - Date.now() < 7 * DAY ? "warn" : "info" });

  // ---- what the dashboard doesn't count yet
  const jobs = [];
  const ts = of("tg_store");
  let tgToday = { n: 0, total: 0 };
  let tgYesterday = { total: 0 };
  if (ts.length) {
    const TS = require("./tgstore/tgstore.models");
    jobs.push(
      TS.TgOrder.aggregate([{ $match: { business_id: { $in: ids(ts) }, status: "new" } }, { $group: { _id: "$business_id", n: { $sum: 1 }, oldest: { $min: "$created_date" } } }, { $sort: { n: -1 } }]).then((rows) => {
        const n = rows.reduce((a, r) => a + r.n, 0);
        const oldest = rows.reduce((a, r) => (!a || r.oldest < a ? r.oldest : a), null);
        add({ key: "tg_new", n, business_id: rows[0]?._id, tab: "orders", at: oldest, level: oldest && Date.now() - new Date(oldest) > 5 * 60e3 ? "warn" : "info" });
      }),
      TS.TgOrder.aggregate([{ $match: { business_id: { $in: ids(ts) }, status: { $ne: "cancelled" }, created_date: { $gte: yesterday } } }, { $group: { _id: { $gte: ["$created_date", today] }, n: { $sum: 1 }, total: { $sum: "$total" } } }]).then((rows) => {
        for (const r of rows) if (r._id) tgToday = { n: r.n, total: r.total };
        else tgYesterday = { total: r.total };
      }),
      TS.TgProduct.aggregate([{ $match: { business_id: { $in: ids(ts) }, deleted: false, sold_out: true } }, { $group: { _id: "$business_id", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).then((rows) => add({ key: "sold_out", n: rows.reduce((a, r) => a + r.n, 0), business_id: rows[0]?._id, tab: "products" })),
    );
  }
  const evs = of("event");
  if (evs.length) {
    const EV = require("./event/event.models");
    jobs.push(EV.EvOrder.aggregate([{ $match: { business_id: { $in: ids(evs) }, status: "review" } }, { $group: { _id: "$business_id", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).then((rows) => add({ key: "ev_review", n: rows.reduce((a, r) => a + r.n, 0), business_id: rows[0]?._id, tab: "orders", level: "warn" })));
  }
  const ghs = of("guest_house");
  if (ghs.length) {
    const GH = require("./guesthouse/guesthouse.models");
    const grp = (match) => GH.GhStay.aggregate([{ $match: { business_id: { $in: ids(ghs) }, ...match } }, { $group: { _id: "$business_id", n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
    jobs.push(
      grp({ status: "in", to: { $lt: today } }).then((rows) => add({ key: "checkout_late", n: rows.reduce((a, r) => a + r.n, 0), business_id: rows[0]?._id, tab: "today", level: "warn" })),
      grp({ status: "booked", from: { $gte: today, $lt: dayStart(1) } }).then((rows) => add({ key: "arrivals", n: rows.reduce((a, r) => a + r.n, 0), business_id: rows[0]?._id, tab: "today" })),
    );
  }
  const out = await Promise.allSettled(jobs);
  for (const r of out) if (r.status === "rejected") console.error("[bizi brief]", r.reason?.message);

  // ---- the money (one currency: the dashboard's; Telegram orders join it when it is dollars)
  const s = dash.sales || null;
  const cur = s?.currency || "USD";
  const addTg = cur === "USD";
  const r2 = (n) => Math.round(n * 100) / 100;
  const summary = {
    currency: cur,
    today: r2((s?.today || 0) + (addTg ? tgToday.total : 0)),
    yesterday: r2((s?.yesterday || 0) + (addTg ? tgYesterday.total : 0)),
    week: s?.week || 0,
    last_week: s?.last_week || 0,
    change_pct: s && s.last_week > 0 ? Math.round(((s.week - s.last_week) / s.last_week) * 100) : null,
    bills_today: s?.bills_today || 0,
    orders_today: tgToday.n,
  };
  const order = { warn: 0, info: 1 };
  alerts.sort((a, b) => order[a.level] - order[b.level] || b.n - a.n);
  return {
    at: new Date(),
    summary,
    pulse: summary.bills_today + summary.orders_today + (w?.n || 0),
    alerts,
    mood: alerts.some((a) => a.level === "warn") ? "worried" : "idle",
  };
}

module.exports = (prop) => {
  prop.app.get("/api/user/bizi/brief", prop.api_auth, customer_auth, async (req, res) => {
    try {
      res.json({ success: true, data: await brief(req.customer._id) });
    } catch (err) {
      console.error("[bizi brief]", err);
      res.status(500).json({ success: false, message: "Internal Server Error" });
    }
  });
};
module.exports.brief = brief;
