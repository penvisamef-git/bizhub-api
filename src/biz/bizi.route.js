// Bizi brief (v3.0.0, layer 1 — no AI): what the helper tells the owner before they ask.
//   GET /api/user/bizi/brief
//   → { data: {
//        summary { currency, today, yesterday, week, last_week, change_pct, bills_today, orders_today } — money taken,
//                the dashboard's numbers (restaurants, mini marts, guest houses, Telegram Store); orders_today = Telegram orders
//        pulse   a number that goes up with every new bill / order / booking today (the web turns it into "happy")
//        alerts  [{ key, level: warn | info, n, business_id, business, category, tab, href, at }] — the worst first
//        mood    worried (something waits) | idle
//        tips    [{ key, business_id, business, category, tab, help }] — things not set up yet, with the how-to that fixes them
//        weekly  the report for last week (Mon → Sun): { week, total, bills, before, change_pct, best_day, top, up, down }
//        prefs   { mute, weekly, telegram } — what the owner chose (muted alerts / tips are not in the lists)
//      } }
//   GET  /api/user/bizi/prefs                     → { mute, weekly, tg: { connected, chat_name, morning, alerts, weekly } }
//   PUT  /api/user/bizi/prefs { mute?, weekly?, tg?: { morning?, alerts?, weekly? } }
//   POST /api/user/bizi/snooze { key, business_id }  → that tip hides for 14 days ("Not now")
//   alerts: tg_new (new Telegram orders; warn after 5 min) · waiting (other online orders / bookings) · ev_review (ticket
//   payments to check) · checkout_late (guests past their check-out) · arrivals (guests arriving today) · open_bills ·
//   sold_out · low_stock · renewals (a year / add-on ending within 7 days = warn) · staff_late
// Days are Cambodia days (UTC+7). Owner's own businesses (like the dashboard).
const { customer_auth } = require("../user/customer_auth");
const { dashboardOf, topItemsOf } = require("./dashboard.route");
const BiziPrefs = require("./bizi.model");

// the alert / tip keys an owner can mute (anything else is refused)
const ALERT_KEYS = ["tg_new", "waiting", "ev_review", "checkout_late", "arrivals", "open_bills", "sold_out", "low_stock", "renewals", "staff_late"];
const TIP_KEYS = ["tg_no_group", "tg_no_products", "rest_no_menu", "rest_no_tables", "rest_no_staff", "rest_no_device", "mart_no_products", "mart_no_device", "gh_no_rooms", "att_no_staff"];
const SNOOZE_DAYS = 14;
const prefsOf = async (ownerId) => (await BiziPrefs.findOne({ customer_id: ownerId }).lean()) || { mute: [], snooze: [], weekly: true, tg: {} };

const DAY = 864e5;
const TZ = 7 * 3600e3;
const dayStart = (offset = 0) => new Date(Math.floor((Date.now() + TZ) / DAY) * DAY - TZ + offset * DAY);

// things not set up yet in each business (each with the section that fixes it and its how-to)
async function tipsOf(businesses) {
  const ids = (type) => businesses.filter((b) => b.category === type).map((b) => b._id);
  const tips = [];
  // the businesses of a type that have none of something: [{ _id }] → a tip for each
  const none = async (Model, type, match, key, tab, help) => {
    const list = ids(type);
    if (!list.length) return;
    const have = new Set((await Model.distinct("business_id", { business_id: { $in: list }, ...match })).map(String));
    for (const id of list) if (!have.has(String(id))) tips.push({ key, business_id: id, tab, help });
  };
  const jobs = [];
  if (ids("tg_store").length) {
    const TS = require("./tgstore/tgstore.models");
    jobs.push(
      TS.TgStore.find({ business_id: { $in: ids("tg_store") } })
        .select("business_id tg.chat_id")
        .lean()
        .then((rows) => {
          const linked = new Set(rows.filter((r) => r.tg?.chat_id).map((r) => String(r.business_id)));
          for (const id of ids("tg_store")) if (!linked.has(String(id))) tips.push({ key: "tg_no_group", business_id: id, tab: "share", help: "tg_group" });
        }),
      none(TS.TgProduct, "tg_store", { deleted: { $ne: true } }, "tg_no_products", "products", "products_add"),
    );
  }
  if (ids("restaurant").length) {
    const M = require("./restaurant/restaurant.models");
    jobs.push(
      none(M.RestItem, "restaurant", { active: { $ne: false } }, "rest_no_menu", "menu", "products_add"),
      none(M.RestTable, "restaurant", { active: { $ne: false } }, "rest_no_tables", "tables", "tables_qr"),
      none(M.RestStaff, "restaurant", { active: { $ne: false } }, "rest_no_staff", "staff", "staff_pin"),
      none(M.RestDevice, "restaurant", { revoked: { $ne: true } }, "rest_no_device", "pos", "pos_pair"),
    );
  }
  if (ids("mart").length) {
    const MM = require("./mart/mart.models");
    jobs.push(none(MM.MartProduct, "mart", { active: { $ne: false } }, "mart_no_products", "products", "products_add"), none(MM.MartDevice, "mart", { revoked: { $ne: true } }, "mart_no_device", "pos", "pos_pair"));
  }
  if (ids("guest_house").length) {
    const GH = require("./guesthouse/guesthouse.models");
    jobs.push(none(GH.GhRoom, "guest_house", { active: { $ne: false } }, "gh_no_rooms", "rooms", "gh_rooms"));
  }
  if (ids("attendance").length) {
    const A = require("./attendance/attendance.models");
    jobs.push(none(A.AttStaff, "attendance", { active: { $ne: false } }, "att_no_staff", "staff", "att_clock"));
  }
  const out = await Promise.allSettled(jobs);
  for (const r of out) if (r.status === "rejected") console.error("[bizi tips]", r.reason?.message);
  // the first steps first (no menu before no tables, the order of TIP_KEYS), one per business before a second one
  tips.sort((a, b) => TIP_KEYS.indexOf(a.key) - TIP_KEYS.indexOf(b.key));
  const seen = new Map();
  for (const t of tips) seen.set(String(t.business_id), (t.round = (seen.get(String(t.business_id)) || 0) + 1));
  return tips.sort((a, b) => a.round - b.round || TIP_KEYS.indexOf(a.key) - TIP_KEYS.indexOf(b.key)).map(({ round, ...t }) => t);
}

// tips change slowly: kept 5 minutes per owner (a fix shows on the next look after that; "Not now" at once)
const tipCache = new Map();
async function cachedTips(ownerId, businesses) {
  const key = `${ownerId}:${businesses.map((b) => b._id).join(",")}`;
  const hit = tipCache.get(String(ownerId));
  if (hit && hit.key === key && Date.now() - hit.at < 5 * 60e3) return hit.tips;
  const tips = await tipsOf(businesses);
  if (tipCache.size > 5000) tipCache.clear();
  tipCache.set(String(ownerId), { key, at: Date.now(), tips });
  return tips;
}
// last week's report from the dashboard's numbers + last week's best sellers
async function weeklyOf(dash) {
  const w = dash.sales?.weekly;
  if (!w || !(w.total > 0 || w.before > 0)) return null;
  const change = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);
  const rows = (w.by_business || []).filter((b) => b.total > 0 || b.before > 0).map((b) => ({ ...b, change_pct: change(b.total, b.before) }));
  const moved = rows.filter((b) => b.change_pct !== null && Math.abs(b.change_pct) >= 10);
  let top = [];
  try {
    top = await topItemsOf(dash.businesses || [], w.from, w.to, 3);
  } catch (err) {
    console.error("[bizi weekly]", err.message);
  }
  return {
    week: w.from, // Monday of that week — the web / app show the report once per week
    from: w.from,
    to: w.to,
    currency: dash.sales.currency,
    total: w.total,
    bills: w.bills,
    before: w.before,
    change_pct: change(w.total, w.before),
    best_day: w.best_day,
    top,
    up: moved.filter((b) => b.change_pct > 0).sort((a, b) => b.change_pct - a.change_pct).slice(0, 2),
    down: moved.filter((b) => b.change_pct < 0).sort((a, b) => a.change_pct - b.change_pct).slice(0, 2),
  };
}

async function brief(ownerId) {
  const [dash, prefs] = await Promise.all([dashboardOf(ownerId), prefsOf(ownerId)]);
  const businesses = dash.businesses || [];
  const of = (type) => businesses.filter((b) => b.category === type);
  const ids = (list) => list.map((b) => b._id);
  const nameOf = new Map(businesses.map((b) => [String(b._id), b]));
  const today = dayStart(0);
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
  const ob = tile("open_bills");
  if (ob?.n) add({ key: "open_bills", n: ob.n, business_id: first(ob)?.id, tab: "" });
  const st = tile("stock");
  const stTab = st?.tab?.[first(st)?.kind] || "stock";
  if (st?.out) add({ key: "sold_out", n: st.out, business_id: first(st)?.id, tab: stTab, level: "warn" });
  if (st?.low) add({ key: "low_stock", n: st.low, business_id: first(st)?.id, tab: stTab });
  const staff = tile("staff_in");
  if (staff?.late) add({ key: "staff_late", n: staff.late, business_id: first(staff)?.id || of("attendance")[0]?._id, tab: "today" });
  const rn = tile("renewals");
  if (rn?.n) add({ key: "renewals", n: rn.n, href: "/app/licenses", at: rn.soonest, level: rn.soonest && new Date(rn.soonest) - Date.now() < 7 * DAY ? "warn" : "info" });

  // ---- what the dashboard has no tile for
  const jobs = [];
  const ts = of("tg_store");
  let tgNew = 0;
  let tgToday = 0;
  if (ts.length) {
    const TS = require("./tgstore/tgstore.models");
    jobs.push(
      TS.TgOrder.aggregate([{ $match: { business_id: { $in: ids(ts) }, status: "new" } }, { $group: { _id: "$business_id", n: { $sum: 1 }, oldest: { $min: "$created_date" } } }, { $sort: { n: -1 } }]).then((rows) => {
        const n = rows.reduce((a, r) => a + r.n, 0);
        tgNew = n;
        const oldest = rows.reduce((a, r) => (!a || r.oldest < a ? r.oldest : a), null);
        add({ key: "tg_new", n, business_id: rows[0]?._id, tab: "orders", at: oldest, level: oldest && Date.now() - new Date(oldest) > 5 * 60e3 ? "warn" : "info" });
      }),
      TS.TgOrder.countDocuments({ business_id: { $in: ids(ts) }, status: { $ne: "cancelled" }, created_date: { $gte: today } }).then((n) => (tgToday = n)),
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
  // the dashboard's "waiting" also counts the new Telegram orders — those are their own alert above
  const waitingRows = (w?.by || []).filter((x) => x.kind !== "tg_store");
  const waitingN = Math.max(0, (w?.n || 0) - tgNew);
  if (waitingN) add({ key: "waiting", n: waitingN, business_id: waitingRows[0]?.id, tab: w.tab?.[waitingRows[0]?.kind] || "", level: "warn" });

  // ---- the money: the dashboard's own numbers (one currency), so Bizi and the dashboard always say the same
  const s = dash.sales || null;
  const summary = {
    currency: s?.currency || "USD",
    today: s?.today || 0,
    yesterday: s?.yesterday || 0,
    week: s?.week || 0,
    last_week: s?.last_week || 0,
    change_pct: s && s.last_week > 0 ? Math.round(((s.week - s.last_week) / s.last_week) * 100) : null,
    bills_today: s?.bills_today || 0,
    orders_today: tgToday,
  };
  const order = { warn: 0, info: 1 };
  alerts.sort((a, b) => order[a.level] - order[b.level] || b.n - a.n);
  // what the owner muted stays out (the pulse still moves: a new sale is always good news)
  const mute = new Set(prefs.mute || []);
  const shown = alerts.filter((a) => !mute.has(a.key));
  const now = Date.now();
  const snoozed = new Set((prefs.snooze || []).filter((x) => x.until && new Date(x.until) > now).map((x) => `${x.key}:${x.business_id}`));
  const tips = mute.has("tips")
    ? []
    : (await cachedTips(ownerId, businesses))
        .filter((t) => !mute.has(t.key) && !snoozed.has(`${t.key}:${t.business_id}`))
        .slice(0, 5)
        .map((t) => ({ ...t, business: nameOf.get(String(t.business_id))?.name || "", category: nameOf.get(String(t.business_id))?.category || "" }));
  const weekly = prefs.weekly === false ? null : await weeklyOf(dash);
  return {
    at: new Date(),
    summary,
    pulse: summary.bills_today + (w?.n || 0),
    alerts: shown,
    mood: shown.some((a) => a.level === "warn") ? "worried" : "idle",
    tips,
    weekly,
    prefs: { mute: [...mute], weekly: prefs.weekly !== false, telegram: !!prefs.tg?.chat_id },
  };
}

// what the settings screen shows
const prefsView = (p) => ({
  mute: p.mute || [],
  weekly: p.weekly !== false,
  tg: { connected: !!p.tg?.chat_id, chat_name: p.tg?.chat_name || "", morning: p.tg?.morning !== false, alerts: p.tg?.alerts !== false, weekly: p.tg?.weekly !== false },
  keys: { alerts: ALERT_KEYS, tips: TIP_KEYS },
});

module.exports = (prop) => {
  const fail = (res, err) => {
    console.error("[bizi]", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  };
  prop.app.get("/api/user/bizi/brief", prop.api_auth, customer_auth, async (req, res) => {
    try {
      res.json({ success: true, data: await brief(req.customer._id) });
    } catch (err) {
      fail(res, err);
    }
  });
  prop.app.get("/api/user/bizi/prefs", prop.api_auth, customer_auth, async (req, res) => {
    try {
      res.json({ success: true, data: prefsView(await prefsOf(req.customer._id)) });
    } catch (err) {
      fail(res, err);
    }
  });
  prop.app.put("/api/user/bizi/prefs", prop.api_auth, customer_auth, async (req, res) => {
    try {
      const b = req.body || {};
      const set = {};
      if (b.mute !== undefined) {
        if (!Array.isArray(b.mute)) return res.status(400).json({ success: false, message: "mute must be a list" });
        const ok = new Set([...ALERT_KEYS, ...TIP_KEYS, "tips"]);
        set.mute = [...new Set(b.mute.map(String).filter((k) => ok.has(k)))];
      }
      if (b.weekly !== undefined) set.weekly = !!b.weekly;
      for (const k of ["morning", "alerts", "weekly"]) if (b.tg && b.tg[k] !== undefined) set[`tg.${k}`] = !!b.tg[k];
      const p = await BiziPrefs.findOneAndUpdate({ customer_id: req.customer._id }, { $set: set }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }).lean();
      res.json({ success: true, data: prefsView(p) });
    } catch (err) {
      fail(res, err);
    }
  });
  prop.app.post("/api/user/bizi/snooze", prop.api_auth, customer_auth, async (req, res) => {
    try {
      const key = String(req.body?.key || "");
      const businessId = String(req.body?.business_id || "");
      if (!TIP_KEYS.includes(key) || !/^[a-f0-9]{24}$/.test(businessId)) return res.status(400).json({ success: false, message: "Unknown tip" });
      const p = (await BiziPrefs.findOne({ customer_id: req.customer._id }).lean()) || {};
      const now = Date.now();
      const snooze = (p.snooze || []).filter((x) => x.until && new Date(x.until) > now && !(x.key === key && x.business_id === businessId));
      snooze.push({ key, business_id: businessId, until: new Date(now + SNOOZE_DAYS * DAY) });
      await BiziPrefs.updateOne({ customer_id: req.customer._id }, { $set: { snooze: snooze.slice(-100) } }, { upsert: true });
      res.json({ success: true, data: { key, business_id: businessId, days: SNOOZE_DAYS } });
    } catch (err) {
      fail(res, err);
    }
  });
};
module.exports.brief = brief;
module.exports.ALERT_KEYS = ALERT_KEYS;
module.exports.TIP_KEYS = TIP_KEYS;
module.exports.forgetTips = (ownerId) => tipCache.delete(String(ownerId));
