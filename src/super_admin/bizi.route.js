// Bizi for the BizHub team (v3.0.0, super admin, no AI): the same helper as the owners', with the team's own work.
//   GET /api/admin/bizi/search?q=   → { data: { q, results: [{ group, kind, id, title, sub, href, status, money, cur, at }] } }
//       customers (name, email, phone, BizHub ID), businesses (name, owner), coin orders (reference, the customer,
//       "#<last 6 of the id>"), conversations in Chat with BizHub (the customer), app crash reports (message, screen)
//       smart words: "pending" / "waiting" (coin orders to check), "unread" (chats to answer), "today" (new today)
//   GET /api/admin/bizi/brief       → { data: { summary, alerts, pulse, mood } }
//       alerts: coin_orders (waiting to be checked) · chats (customers waiting for an answer) · app_errors (new crash
//       reports in 24 h) · delete_requests (accounts to be erased within 7 days)
//       summary: new customers / businesses today, coins sold today ($ of approved orders), waiting orders
// Days are Cambodia days (UTC+7).
const Customer = require("../user/customer.model");
const Business = require("../biz/business.model");
const P = require("../platform/platform.model");
const AppError = require("../app_error/app_error.model");
const { only_super_admin } = require("../util/permission");
const { escapeRegex } = require("../util/helper");

const DAY = 864e5;
const TZ = 7 * 3600e3;
const dayStart = (offset = 0) => new Date(Math.floor((Date.now() + TZ) / DAY) * DAY - TZ + offset * DAY);
const LIMIT = 6;

// the words that mean something here (English · Khmer)
const SMART = [
  ["pending", /(^|\s)(pending|waiting|to check|approve|រង់ចាំ|ត្រូវពិនិត្យ)(?=\s|$)/i],
  ["unread", /(^|\s)(unread|not read|reply|answer|មិនទាន់អាន|ឆ្លើយ)(?=\s|$)/i],
  ["today", /(^|\s)(today|new|ថ្ងៃនេះ|ថ្មី)(?=\s|$)/i],
];
function termsOf(raw) {
  let rest = String(raw || "").trim();
  const smart = [];
  for (const [key, re] of SMART)
    if (re.test(rest)) {
      smart.push(key);
      rest = rest.replace(re, " ");
    }
  rest = rest.replace(/\s+/g, " ").trim();
  const words = rest.split(" ").filter(Boolean).slice(0, 5);
  return { smart, words, rest };
}
// every word in one of the fields; a phone typed the Cambodian way (012 555 402) also finds +85512555402
const wordRe = (w, f) => {
  const digits = w.replace(/[\s-]/g, "");
  if (f === "phone" && /^0\d{7,9}$/.test(digits)) return new RegExp(`(^0|855)${escapeRegex(digits.slice(1))}$`);
  return new RegExp(escapeRegex(w), "i");
};
const anyOf = (fields, words) => (words.length ? { $and: words.map((w) => ({ $or: fields.map((f) => ({ [f]: wordRe(w, f) })) })) } : {});
const idTail = (s) => {
  const m = String(s || "").match(/^#?([a-f0-9]{6,24})$/i);
  return m ? m[1].toLowerCase() : "";
};

async function search(raw) {
  const { smart, words, rest } = termsOf(raw);
  const today = smart.includes("today") ? { created_date: { $gte: dayStart(0) } } : {};
  const out = [];
  const people = words.length ? await Customer.find({ deleted: { $ne: true }, ...anyOf(["name", "email", "phone", "bizhub_id"], words) }).select("_id name email phone bizhub_id status created_date").limit(30).lean() : [];
  const peopleIds = people.map((c) => c._id);
  const nameOf = new Map(people.map((c) => [String(c._id), c]));
  const jobs = [];
  // customers
  if (!smart.includes("pending") && !smart.includes("unread") && (words.length || today.created_date))
    jobs.push(
      Customer.find({ deleted: { $ne: true }, ...anyOf(["name", "email", "phone", "bizhub_id"], words), ...today })
        .select("_id name email phone bizhub_id status created_date")
        .sort({ created_date: -1 })
        .limit(LIMIT)
        .lean()
        .then((rows) =>
          rows.forEach((c) => out.push({ group: "people", kind: "person", id: String(c._id), title: c.name, sub: [c.email, c.phone, c.bizhub_id].filter(Boolean).join(" · "), href: `/app/super-admin/customers?open=${c._id}`, flag: c.status === false ? "locked" : "", at: c.created_date })),
        ),
    );
  // businesses (by their name or their owner's)
  if (!smart.includes("pending") && !smart.includes("unread") && (words.length || today.created_date))
    jobs.push(
      Business.find({ deleted: false, ...today, ...(words.length ? { $or: [anyOf(["name"], words), { owner_id: { $in: peopleIds } }] } : {}) })
        .select("_id name category owner_id status created_date")
        .sort({ created_date: -1 })
        .limit(LIMIT)
        .populate("owner_id", "name")
        .lean()
        .then((rows) => rows.forEach((b) => out.push({ group: "businesses", kind: "business", id: String(b._id), title: b.name, sub: b.owner_id?.name || "", category: b.category, href: `/app/super-admin/businesses?open=${b._id}`, flag: b.status === false ? "locked" : "", at: b.created_date }))),
    );
  // coin orders: "pending" lists the waiting ones; a reference, a customer, or the end of the order id
  if (!smart.includes("unread")) {
    const tail = idTail(rest);
    const match = { ...(smart.includes("pending") ? { status: "pending" } : {}), ...today };
    const by = words.length ? { $or: [anyOf(["reference", "note"], words), { customer_id: { $in: peopleIds } }] } : {};
    if (words.length || smart.length)
      jobs.push(
        P.CoinOrder.find({ ...match, ...by })
          .select("_id customer_id status usd total_coins reference created_date")
          .sort({ created_date: -1 })
          .limit(LIMIT * 3)
          .populate("customer_id", "name")
          .lean()
          .then(async (rows) => {
            let list = rows;
            if (tail && !rows.length) list = (await P.CoinOrder.find(match).select("_id customer_id status usd total_coins reference created_date").sort({ created_date: -1 }).limit(300).populate("customer_id", "name").lean()).filter((o) => String(o._id).endsWith(tail));
            list.slice(0, LIMIT).forEach((o) =>
              out.push({ group: "orders", kind: "coin_order", id: String(o._id), title: `#${String(o._id).slice(-6)} · ${o.total_coins} coins`, sub: [o.customer_id?.name, o.reference].filter(Boolean).join(" · "), money: o.usd, cur: "USD", status: o.status, href: `/app/super-admin/coin-orders?status=${o.status}`, at: o.created_date, smart: smart.includes("pending") || undefined }),
            );
          }),
      );
  }
  // conversations in Chat with BizHub
  if (smart.includes("unread") || (words.length && peopleIds.length))
    jobs.push(
      P.SupportThread.find({ ...(smart.includes("unread") ? { unread_admin: { $gt: 0 } } : {}), ...(words.length ? { customer_id: { $in: peopleIds } } : {}) })
        .sort({ last_at: -1 })
        .limit(LIMIT)
        .lean()
        .then(async (rows) => {
          const missing = rows.filter((t) => !nameOf.has(String(t.customer_id))).map((t) => t.customer_id);
          if (missing.length) for (const c of await Customer.find({ _id: { $in: missing } }).select("name").lean()) nameOf.set(String(c._id), c);
          rows.forEach((t) =>
            out.push({ group: "other", kind: "chat", id: String(t._id), title: nameOf.get(String(t.customer_id))?.name || "—", sub: t.last_text?.slice(0, 80) || "", href: `/app/super-admin/inbox?t=${t._id}`, flag: t.unread_admin > 0 ? "unread_chat" : "", at: t.last_at, smart: smart.includes("unread") || undefined }),
          );
        }),
    );
  // app crash reports
  if (words.length && !smart.length)
    jobs.push(
      AppError.find({ resolved: false, ...anyOf(["message", "route", "context"], words) })
        .sort({ last_at: -1 })
        .limit(3)
        .lean()
        .then((rows) => rows.forEach((e) => out.push({ group: "other", kind: "app_error", id: String(e._id), title: e.message.slice(0, 90), sub: [e.route, e.version, `×${e.count}`].filter(Boolean).join(" · "), href: "/app/super-admin/dashboard", at: e.last_at }))),
    );
  const done = await Promise.allSettled(jobs);
  for (const r of done) if (r.status === "rejected") console.error("[admin bizi]", r.reason?.message);
  // one order for the groups (the answers come back in any order): what the smart words asked for first
  const ORDER = ["people", "businesses", "orders", "other"];
  out.sort((a, b) => (b.smart ? 1 : 0) - (a.smart ? 1 : 0) || ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
  return { q: String(raw || ""), smart, results: out };
}

async function brief() {
  const today = dayStart(0);
  const [orders, oldest, chats, errors, deletes, newCustomers, newBusinesses, sold] = await Promise.all([
    P.CoinOrder.countDocuments({ status: "pending" }),
    P.CoinOrder.findOne({ status: "pending" }).sort({ created_date: 1 }).select("created_date").lean(),
    P.SupportThread.countDocuments({ unread_admin: { $gt: 0 } }),
    AppError.countDocuments({ resolved: false, last_at: { $gte: new Date(Date.now() - DAY) } }),
    Customer.countDocuments({ delete_at: { $ne: null, $lte: new Date(Date.now() + 7 * DAY) }, deleted: { $ne: true } }),
    Customer.countDocuments({ created_date: { $gte: today }, deleted: { $ne: true } }),
    Business.countDocuments({ created_date: { $gte: today }, deleted: false }),
    P.CoinOrder.aggregate([{ $match: { status: "approved", done_at: { $gte: today } } }, { $group: { _id: null, usd: { $sum: "$usd" }, n: { $sum: 1 } } }]),
  ]);
  const alerts = [];
  if (orders) alerts.push({ key: "coin_orders", n: orders, level: "warn", href: "/app/super-admin/coin-orders?status=pending", at: oldest?.created_date || null });
  if (chats) alerts.push({ key: "chats", n: chats, level: "warn", href: "/app/super-admin/inbox" });
  if (errors) alerts.push({ key: "app_errors", n: errors, level: "info", href: "/app/super-admin/dashboard" });
  if (deletes) alerts.push({ key: "delete_requests", n: deletes, level: "info", href: "/app/super-admin/customers" });
  const summary = { new_customers: newCustomers, new_businesses: newBusinesses, sold_usd: Math.round((sold[0]?.usd || 0) * 100) / 100, sold_orders: sold[0]?.n || 0, waiting: orders };
  return { at: new Date(), summary, alerts, pulse: newCustomers + newBusinesses + (sold[0]?.n || 0) + orders + chats, mood: alerts.some((a) => a.level === "warn") ? "worried" : "idle", tips: [], weekly: null };
}

module.exports = (prop) => {
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin];
  const fail = (res, err) => {
    console.error("[admin bizi]", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  };
  prop.app.get(`/${prop.main_route}/bizi/search`, ...guard, async (req, res) => {
    try {
      res.json({ success: true, data: await search(String(req.query.q || "").slice(0, 80)) });
    } catch (err) {
      fail(res, err);
    }
  });
  prop.app.get(`/${prop.main_route}/bizi/brief`, ...guard, async (req, res) => {
    try {
      res.json({ success: true, data: await brief() });
    } catch (err) {
      fail(res, err);
    }
  });
};
module.exports.search = search;
module.exports.brief = brief;
