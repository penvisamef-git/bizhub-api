// Bizi search (v3.0.0): one box that finds things in ALL the businesses a person can open — their own, and the ones
// shared with them as a team member (while the owner's Team add-on is on).
//
//   GET /api/user/search?q=<words>&limit=5
//   → { data: { q, results: [{ group, kind, business_id, business, category, title, sub, money, cur, at, tab, params }] } }
//
//   group   businesses | products | orders | people | other
//   tab     the ?tab= of that business's dashboard to open (web: /app/business/<id>?tab=<tab>&<params>)
//   params  extra query for a page that can open the record itself (debt ?c=, note ?note=, website ?page=, event ?event=)
//
// Matching: words anywhere in names (any case); phone numbers whatever the spaces (012 345 678 = 012345678 = +85512345678);
// "#12" or "12" finds order / card number 12. Only reads — a View only member can search too.
const Business = require("./business.model");
const License = require("../license/license.model");
const { TeamMember } = require("./team/team.model");
const { customer_auth } = require("../user/customer_auth");

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAX_Q = 80;

// what the words can match
function termsOf(raw) {
  const q = String(raw || "")
    .trim()
    .slice(0, MAX_Q);
  const digits = q.replace(/\D/g, "");
  const local = digits.startsWith("855") ? `0${digits.slice(3)}` : digits;
  const loose = (d) => new RegExp(d.split("").join("[\\s.\\-]*"));
  return {
    q,
    re: new RegExp(esc(q), "i"),
    // a phone: at least 4 digits and nothing but digits, spaces, + - . ( )
    phone: local.length >= 4 && /^[\d\s+\-.()]+$/.test(q) ? loose(local) : null,
    phoneIntl: local.length >= 4 && /^[\d\s+\-.()]+$/.test(q) ? loose(local.replace(/^0/, "")) : null, // stored +855…
    num: /^#?\s*\d{1,7}$/.test(q) ? Number(digits) : null,
  };
}

// the businesses this person can open: own + team-shared (team add-on on)
async function myBusinesses(customerId) {
  const own = await Business.find({ owner_id: customerId, deleted: false }).select("name category logo_url").lean();
  const rows = await TeamMember.find({ customer_id: customerId, status: "active" }).select("business_id role").lean();
  let shared = [];
  if (rows.length) {
    const ids = rows.map((r) => r.business_id);
    const lic = await License.find({ business_id: { $in: ids }, product: "team", item: "" }).select("business_id expires_at").lean();
    const on = new Set(lic.filter((l) => l.expires_at === null || new Date(l.expires_at) > new Date()).map((l) => String(l.business_id)));
    shared = await Business.find({ _id: { $in: ids.filter((id) => on.has(String(id))) }, deleted: false })
      .select("name category logo_url")
      .lean();
  }
  const seen = new Set();
  return [...own, ...shared].filter((b) => !seen.has(String(b._id)) && seen.add(String(b._id)));
}

// every place to look: [business type, group, find(ids, terms, limit) → rows, shape(row) → result]
const M = (file) => require(file);
const SEARCHERS = [
  // ---------------- products
  ["tg_store", "products", (ids, t, n) => M("./tgstore/tgstore.models").TgProduct.find({ business_id: { $in: ids }, deleted: false, $or: [{ name: t.re }, { name_km: t.re }] }).select("business_id name name_km price sold_out hidden").limit(n), (r) => ({ kind: "product", title: r.name, sub: r.name_km && r.name_km !== r.name ? r.name_km : "", money: r.price, tab: "products", flag: r.sold_out ? "sold_out" : r.hidden ? "hidden" : "" })],
  ["restaurant", "products", (ids, t, n) => M("./restaurant/restaurant.models").RestItem.find({ business_id: { $in: ids }, $or: [{ name_en: t.re }, { name_km: t.re }, { code: t.re }] }).select("business_id name_en name_km code price active").limit(n), (r) => ({ kind: "product", title: r.name_en || r.name_km, sub: [r.name_en && r.name_km ? r.name_km : "", r.code].filter(Boolean).join(" · "), money: r.price, tab: "menu", flag: r.active === false ? "hidden" : "" })],
  ["mart", "products", (ids, t, n) => M("./mart/mart.models").MartProduct.find({ business_id: { $in: ids }, $or: [{ name: t.re }, { barcode: t.re }, { plu: t.re }] }).select("business_id name barcode price active").limit(n), (r) => ({ kind: "product", title: r.name, sub: r.barcode || "", money: r.price, tab: "products", flag: r.active === false ? "hidden" : "" })],
  ["menu_qr", "products", (ids, t, n) => M("./menuqr/menuqr.models").MqItem.find({ business_id: { $in: ids }, $or: [{ name_en: t.re }, { name_km: t.re }] }).select("business_id name_en name_km price active").limit(n), (r) => ({ kind: "product", title: r.name_en || r.name_km, sub: r.name_en && r.name_km ? r.name_km : "", money: r.price, tab: "menu", flag: r.active === false ? "hidden" : "" })],

  // ---------------- orders, bills, bookings
  [
    "tg_store",
    "orders",
    (ids, t, n) => {
      const or = [{ "customer.name": t.re }];
      if (t.num !== null) or.push({ no: t.num });
      if (t.phone) or.push({ "customer.phone": t.phone });
      return M("./tgstore/tgstore.models").TgOrder.find({ business_id: { $in: ids }, $or: or }).select("business_id no customer status total currency created_date").sort({ created_date: -1 }).limit(n);
    },
    (r) => ({ kind: "order", title: `#${r.no}`, sub: [r.customer?.name, r.customer?.phone].filter(Boolean).join(" · "), money: r.total, cur: r.currency, status: r.status, at: r.created_date, tab: "orders" }),
  ],
  [
    "restaurant",
    "orders",
    (ids, t, n) => {
      const or = [{ number: t.re }, { "member.name": t.re }, { table_name: t.re }];
      if (t.phone) or.push({ "member.phone": t.phone });
      return M("./restaurant/restaurant.models").RestOrder.find({ business_id: { $in: ids }, $or: or }).select("business_id number table_name member status total opened_at").sort({ opened_at: -1 }).limit(n);
    },
    (r) => ({ kind: "order", title: r.number || "", sub: [r.table_name, r.member?.name].filter(Boolean).join(" · "), money: r.total, status: r.status, at: r.opened_at, tab: "reports" }),
  ],
  [
    "mart",
    "orders",
    (ids, t, n) => {
      const or = [{ no: t.re }, { member_name: t.re }, { debtor_name: t.re }];
      if (t.phone) or.push({ member_phone: t.phone });
      return M("./mart/mart.models").MartSale.find({ business_id: { $in: ids }, $or: or }).select("business_id no member_name debtor_name status total at").sort({ at: -1 }).limit(n);
    },
    (r) => ({ kind: "order", title: r.no || "", sub: r.member_name || r.debtor_name || "", money: r.total, status: r.status, at: r.at, tab: "sales" }),
  ],
  [
    "guest_house",
    "orders",
    (ids, t, n) => {
      const or = [{ no: t.re }, { "guest.name": t.re }, { "guest.id_number": t.re }];
      if (t.phone) or.push({ "guest.phone": t.phone });
      return M("./guesthouse/guesthouse.models").GhStay.find({ business_id: { $in: ids }, $or: or }).select("business_id no guest status from to").sort({ from: -1, created_date: -1 }).limit(n);
    },
    (r) => ({ kind: "stay", title: [r.no, r.guest?.name].filter(Boolean).join(" · "), sub: [r.guest?.phone, r.from && r.to ? `${String(r.from).slice(0, 10)} → ${String(r.to).slice(0, 10)}` : ""].filter(Boolean).join(" · "), status: r.status, at: r.from, tab: "bookings" }),
  ],
  [
    "event",
    "orders",
    (ids, t, n) => {
      const or = [{ "buyer.name": t.re }, { reference: t.re }];
      if (t.num !== null) or.push({ no: String(t.num).padStart(4, "0") });
      if (t.phone) or.push({ "buyer.phone": t.phone });
      return M("./event/event.models").EvOrder.find({ business_id: { $in: ids }, $or: or }).select("business_id no buyer status total created_date").sort({ created_date: -1 }).limit(n);
    },
    (r) => ({ kind: "order", title: `#${r.no}`, sub: [r.buyer?.name, r.buyer?.phone].filter(Boolean).join(" · "), money: r.total, status: r.status, at: r.created_date, tab: "orders" }),
  ],

  // ---------------- people
  [
    "tg_store",
    "people",
    (ids, t, n) => {
      const or = [{ name: t.re }, { username: t.re }];
      if (t.phone) or.push({ phone: t.phone });
      return M("./tgstore/tgstore.models").TgCustomer.find({ business_id: { $in: ids }, $or: or }).select("business_id name phone username").limit(n);
    },
    (r) => ({ kind: "person", title: r.name || (r.username ? `@${r.username}` : r.phone), sub: [r.phone, r.username ? `@${r.username}` : ""].filter(Boolean).join(" · "), tab: "customers" }),
  ],
  [
    "stamp_card",
    "people",
    (ids, t, n) => {
      const or = [{ name: t.re }];
      if (t.num !== null) or.push({ no: t.num });
      if (t.phone) or.push({ phone: t.phone });
      return M("./stamp/stamp.models").StampMember.find({ business_id: { $in: ids }, deleted: false, $or: or }).select("business_id no name phone").limit(n);
    },
    (r) => ({ kind: "person", title: r.name || r.phone, sub: [r.no ? `#${r.no}` : "", r.phone].filter(Boolean).join(" · "), tab: "customers" }),
  ],
  [
    "attendance",
    "people",
    (ids, t, n) => {
      const or = [{ name: t.re }, { position: t.re }];
      if (t.phoneIntl) or.push({ phone: t.phoneIntl });
      return M("./attendance/attendance.models").AttStaff.find({ business_id: { $in: ids }, $or: or }).select("business_id name phone position active").limit(n);
    },
    (r) => ({ kind: "person", title: r.name, sub: [r.position, r.phone].filter(Boolean).join(" · "), tab: "staff", flag: r.active === false ? "hidden" : "" }),
  ],
  [
    "debt_book",
    "people",
    (ids, t, n) => {
      const or = [{ name: t.re }];
      if (t.phone) or.push({ phone: t.phone });
      return M("./debt/debt.models").DebtCustomer.find({ business_id: { $in: ids }, deleted: false, $or: or }).select("business_id name phone").limit(n);
    },
    (r) => ({ kind: "person", title: r.name, sub: r.phone || "", tab: "customers", params: { c: String(r._id) } }),
  ],
  [
    "restaurant",
    "people",
    (ids, t, n) => {
      const or = [{ name: t.re }];
      if (t.phone) or.push({ phone: t.phone });
      return M("./restaurant/restaurant.models").RestMember.find({ business_id: { $in: ids }, $or: or }).select("business_id name phone").limit(n);
    },
    (r) => ({ kind: "person", title: r.name || r.phone, sub: r.phone || "", tab: "rewards" }),
  ],
  [
    "mart",
    "people",
    (ids, t, n) => {
      const or = [{ name: t.re }];
      if (t.phone) or.push({ phone: t.phone });
      return M("./mart/mart.models").MartMember.find({ business_id: { $in: ids }, $or: or }).select("business_id name phone").limit(n);
    },
    (r) => ({ kind: "person", title: r.name || r.phone, sub: r.phone || "", tab: "loyalty" }),
  ],

  // ---------------- events, notes, books, QR codes, web pages
  ["event", "other", (ids, t, n) => M("./event/event.models").EvEvent.find({ business_id: { $in: ids }, $or: [{ title: t.re }, { venue: t.re }] }).select("business_id title venue starts_at status").sort({ starts_at: -1 }).limit(n), (r) => ({ kind: "event", title: r.title, sub: r.venue || "", at: r.starts_at, status: r.status, tab: "events", params: { event: String(r._id) } })],
  ["digital_note", "other", (ids, t, n) => M("./note/note.models").Note.find({ business_id: { $in: ids }, deleted: false, $or: [{ title: t.re }, { tags: t.re }] }).select("business_id title tags updated_date").sort({ updated_date: -1 }).limit(n), (r) => ({ kind: "note", title: r.title || "—", sub: (r.tags || []).join(" · "), at: r.updated_date, tab: "notes", params: { note: String(r._id) } })],
  ["flipbook", "other", (ids, t, n) => M("./flipbook/flipbook.models").FbBook.find({ business_id: { $in: ids }, title: t.re }).select("business_id title").limit(n), (r) => ({ kind: "book", title: r.title, sub: "", tab: "books" })],
  ["qr_gen", "other", (ids, t, n) => M("./qrgen/qrgen.models").QgCode.find({ business_id: { $in: ids }, deleted_at: null, name: t.re }).select("business_id name type").limit(n), (r) => ({ kind: "qr", title: r.name, sub: r.type || "", tab: "codes" })],
  ["website", "other", (ids, t, n) => M("./website/website.models").WebPage.find({ business_id: { $in: ids }, $or: [{ "title.en": t.re }, { "title.km": t.re }] }).select("business_id title slug").limit(n), (r) => ({ kind: "page", title: r.title?.en || r.title?.km || r.slug, sub: r.title?.en && r.title?.km ? r.title.km : "", tab: "pages", params: { page: String(r._id) } })],
];

async function search(customerId, raw, limit = 5) {
  const t = termsOf(raw);
  if (t.q.length < 2 && t.num === null) return { q: t.q, results: [] };
  const n = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const biz = await myBusinesses(customerId);
  const byId = new Map(biz.map((b) => [String(b._id), b]));
  const idsOf = (type) => biz.filter((b) => b.category === type).map((b) => b._id);

  const results = biz
    .filter((b) => t.re.test(b.name))
    .slice(0, n)
    .map((b) => ({ group: "businesses", kind: "business", business_id: b._id, business: b.name, category: b.category, title: b.name, sub: "", tab: "", logo: b.logo_url || "" }));

  const jobs = SEARCHERS.filter(([type]) => idsOf(type).length).map(async ([type, group, find, shape]) => {
    const rows = await find(idsOf(type), t, n).maxTimeMS(4000).lean();
    return rows.map((r) => {
      const b = byId.get(String(r.business_id)) || {};
      return { group, business_id: r.business_id, business: b.name || "", category: b.category || type, ...shape(r), id: String(r._id) };
    });
  });
  for (const out of await Promise.allSettled(jobs)) {
    if (out.status === "fulfilled") results.push(...out.value);
    else console.error("[search]", out.reason?.message);
  }
  return { q: t.q, results };
}

module.exports = (prop) => {
  prop.app.get("/api/user/search", prop.api_auth, customer_auth, async (req, res) => {
    try {
      const t0 = Date.now();
      const data = await search(req.customer._id, req.query.q, req.query.limit);
      res.json({ success: true, data: { ...data, took: Date.now() - t0 } });
    } catch (err) {
      console.error("[search]", err);
      res.status(500).json({ success: false, message: "Internal Server Error" });
    }
  });
};
module.exports.search = search;
module.exports.termsOf = termsOf;
module.exports.myBusinesses = myBusinesses;
