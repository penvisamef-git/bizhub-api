// Bizi search (v3.0.0): one box that finds things in ALL the businesses a person can open — their own, and the ones
// shared with them as a team member (while the owner's Team add-on is on).
//
//   GET /api/user/search?q=<words>&limit=5
//   → { data: { q, smart: [intent…], fuzzy, results: [{ group, kind, business_id, business, category, title, sub, money,
//       cur, at, status, flag, tab, params, smart }] } }
//
//   group   businesses | products | orders | people | other
//   tab     the ?tab= of that business's dashboard to open (web: /app/business/<id>?tab=<tab>&<params>)
//   params  extra query for a page that can open the record itself (debt ?c=, note ?note=, website ?page=, event ?event=)
//
// How it matches:
//   • every word on its own, in any of the names ("iced latte", "emma 012", "lotus kenji"), any case, EN or KM
//   • phone numbers whatever the spaces (012 345 678 = 012345678 = +855 12 345 678); "#12" / "12" = number 12
//   • smart words, alone or with others (EN / KM): new · unpaid · sold out · low stock · today · yesterday · staying,
//     and orders / customers → the latest ones: "unpaid orders today", "new", "sold out", "ការកម្ម៉ង់ថ្មី"
//   • nothing found? once more with a missing or doubled letter allowed ("cofee" → coffee) → fuzzy: true
// Only reads — a View only member can search too.
const Business = require("./business.model");
const License = require("../license/license.model");
const { TeamMember } = require("./team/team.model");
const { customer_auth } = require("../user/customer_auth");

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAX_Q = 80;
const DAY = 864e5;

// smart words: [key, English (whole words), Khmer (as written)]
const INTENTS = [
  ["sold_out", /\b(sold ?out|out of stock)\b/i, ["អស់ស្តុក", "លក់អស់"]],
  ["low_stock", /\blow( on)? stock\b/i, ["ស្តុកតិច", "ជិតអស់"]],
  ["unpaid", /\b(unpaid|not paid|owing)\b/i, ["មិនទាន់បង់", "មិនទាន់ទូទាត់"]],
  ["new", /\b(new|waiting)\b/i, ["ថ្មី", "រង់ចាំ"]],
  ["staying", /\b(in house|in-house|staying|checked in)\b/i, ["កំពុងស្នាក់"]],
  ["yesterday", /\byesterday\b/i, ["ម្សិលមិញ"]],
  ["today", /\b(today|tonight)\b/i, ["ថ្ងៃនេះ"]],
  ["orders", /\b(orders?|bills?|sales?|bookings?)\b/i, ["ការកម្ម៉ង់", "វិក្កយបត្រ", "ការកក់"]],
  ["people", /\b(customers?|people|guests?|members?)\b/i, ["អតិថិជន", "ភ្ញៀវ", "សមាជិក"]],
];

// what the words can match
function termsOf(raw, { fuzzy = false } = {}) {
  const q = String(raw || "")
    .trim()
    .slice(0, MAX_Q);
  const digits = q.replace(/\D/g, "");
  const local = digits.startsWith("855") ? `0${digits.slice(3)}` : digits;
  const loose = (d) => new RegExp(d.split("").join("[\\s.\\-]*"));
  const isPhone = local.length >= 4 && /^[\d\s+\-.()]+$/.test(q);
  // the smart words come out of the text; what is left is matched word by word
  let rest = q;
  const smart = [];
  for (const [key, en, km] of INTENTS) {
    if (en.test(rest)) {
      smart.push(key);
      rest = rest.replace(new RegExp(en.source, "gi"), " ");
    }
    for (const k of km)
      if (rest.includes(k)) {
        if (!smart.includes(key)) smart.push(key);
        rest = rest.split(k).join(" ");
      }
  }
  const words = (isPhone ? [] : rest.split(/\s+/))
    .map((w) => w.replace(/^#/, ""))
    .filter((w) => w && !(/^\d+$/.test(w) && smart.length === 0 && w === digits));
  // a missing or doubled letter: c.?o.?f.?e.?e finds "coffee" for "cofee"
  const reOf = (w) => (fuzzy && w.length >= 4 && /^[a-z]+$/i.test(w) ? new RegExp(w.split("").map(esc).join(".?"), "i") : new RegExp(esc(w), "i"));
  return {
    q,
    re: new RegExp(esc(q), "i"),
    words: words.map(reOf),
    allWords: q.split(/\s+/).filter(Boolean).map(reOf), // the whole text, word by word (smart words too: "New York")
    smart,
    phone: isPhone ? loose(local) : null,
    phoneIntl: isPhone ? loose(local.replace(/^0/, "")) : null, // stored +855…
    num: /^#?\s*\d{1,7}$/.test(q) ? Number(digits) : null,
    fuzzy,
  };
}

// every word in one of the fields
const allIn = (fields, words) => (words.length ? { $and: words.map((re) => ({ $or: fields.map((f) => ({ [f]: re })) })) } : null);

// a day in Cambodia (UTC+7): [start, end)
function dayOf(offsetDays = 0) {
  const start = Math.floor((Date.now() + 7 * 3600e3) / DAY) * DAY - 7 * 3600e3 + offsetDays * DAY;
  return { $gte: new Date(start), $lt: new Date(start + DAY) };
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

// every place to look
//   fields   text fields (each word must be in one of them) · phone / phoneIntl / num: other ways to find a row
//   smart    { key: filter } for the smart words it understands · date: its "when" field (today / yesterday)
//   latest   true = "orders" / "customers" alone lists the newest ones
const M = (file) => require(file);
const SEARCHERS = [
  // ---------------- products
  {
    type: "tg_store",
    group: "products",
    model: () => M("./tgstore/tgstore.models").TgProduct,
    base: { deleted: false },
    fields: ["name", "name_km", "about"],
    smart: { sold_out: { sold_out: true } },
    select: "business_id name name_km price sold_out hidden",
    shape: (r) => ({ kind: "product", title: r.name, sub: r.name_km && r.name_km !== r.name ? r.name_km : "", money: r.price, tab: "products", flag: r.sold_out ? "sold_out" : r.hidden ? "hidden" : "" }),
  },
  {
    type: "restaurant",
    group: "products",
    model: () => M("./restaurant/restaurant.models").RestItem,
    fields: ["name_en", "name_km", "code"],
    smart: { sold_out: { available: false } },
    select: "business_id name_en name_km code price active available",
    shape: (r) => ({ kind: "product", title: r.name_en || r.name_km, sub: [r.name_en && r.name_km ? r.name_km : "", r.code].filter(Boolean).join(" · "), money: r.price, tab: "menu", flag: r.available === false ? "sold_out" : r.active === false ? "hidden" : "" }),
  },
  {
    type: "mart",
    group: "products",
    model: () => M("./mart/mart.models").MartProduct,
    fields: ["name", "barcode", "plu"],
    smart: { sold_out: { track_stock: true, stock: { $lte: 0 } }, low_stock: { track_stock: true, $expr: { $lte: ["$stock", "$low_stock"] } } },
    select: "business_id name barcode price active stock track_stock low_stock",
    shape: (r) => ({ kind: "product", title: r.name, sub: [r.barcode, r.track_stock ? `${r.stock ?? 0} left` : ""].filter(Boolean).join(" · "), money: r.price, tab: r.track_stock && r.stock <= (r.low_stock ?? 5) ? "stock" : "products", flag: r.track_stock && r.stock <= 0 ? "sold_out" : r.track_stock && r.stock <= (r.low_stock ?? 5) ? "low_stock" : r.active === false ? "hidden" : "" }),
  },
  {
    type: "menu_qr",
    group: "products",
    model: () => M("./menuqr/menuqr.models").MqItem,
    fields: ["name_en", "name_km", "tags"],
    smart: { sold_out: { available: false } },
    select: "business_id name_en name_km price active available",
    shape: (r) => ({ kind: "product", title: r.name_en || r.name_km, sub: r.name_en && r.name_km ? r.name_km : "", money: r.price, tab: "menu", flag: r.available === false ? "sold_out" : r.active === false ? "hidden" : "" }),
  },

  // ---------------- orders, bills, bookings
  {
    type: "tg_store",
    group: "orders",
    model: () => M("./tgstore/tgstore.models").TgOrder,
    fields: ["customer.name", "customer.username", "address", "note"],
    phone: ["customer.phone"],
    num: (n) => ({ no: n }),
    smart: { new: { status: "new" }, unpaid: { "pay.status": { $ne: "paid" }, status: { $ne: "cancelled" } } },
    date: "created_date",
    latest: true,
    select: "business_id no customer status total currency pay created_date",
    sort: { created_date: -1 },
    shape: (r) => ({ kind: "order", title: `#${r.no}`, sub: [r.customer?.name, r.customer?.phone].filter(Boolean).join(" · "), money: r.total, cur: r.currency, status: r.status, flag: r.pay?.status === "paid" || r.status === "cancelled" ? "" : "unpaid", at: r.created_date, tab: "orders" }),
  },
  {
    type: "restaurant",
    group: "orders",
    model: () => M("./restaurant/restaurant.models").RestOrder,
    fields: ["number", "member.name", "table_name", "note"],
    phone: ["member.phone"],
    smart: { unpaid: { status: "open" }, new: { status: "open" } },
    date: "opened_at",
    latest: true,
    select: "business_id number table_name member status total opened_at",
    sort: { opened_at: -1 },
    shape: (r) => ({ kind: "order", title: r.number || "", sub: [r.table_name, r.member?.name].filter(Boolean).join(" · "), money: r.total, status: r.status, flag: r.status === "open" ? "unpaid" : "", at: r.opened_at, tab: "reports" }),
  },
  {
    type: "mart",
    group: "orders",
    model: () => M("./mart/mart.models").MartSale,
    fields: ["no", "member_name", "debtor_name", "order_no"],
    phone: ["member_phone"],
    date: "at",
    latest: true,
    select: "business_id no member_name debtor_name status total at",
    sort: { at: -1 },
    shape: (r) => ({ kind: "order", title: r.no || "", sub: r.member_name || r.debtor_name || "", money: r.total, status: r.status, at: r.at, tab: "sales" }),
  },
  {
    type: "guest_house",
    group: "orders",
    model: () => M("./guesthouse/guesthouse.models").GhStay,
    fields: ["no", "guest.name", "guest.id_number", "note"],
    phone: ["guest.phone"],
    smart: { staying: { status: "in" }, new: { status: "booked" } },
    date: "from",
    latest: true,
    select: "business_id no guest status from to",
    sort: { from: -1, created_date: -1 },
    shape: (r) => ({ kind: "stay", title: [r.no, r.guest?.name].filter(Boolean).join(" · "), sub: [r.guest?.phone, r.from && r.to ? `${new Date(r.from).toISOString().slice(0, 10)} → ${new Date(r.to).toISOString().slice(0, 10)}` : ""].filter(Boolean).join(" · "), status: r.status, at: r.from, tab: "bookings" }),
  },
  {
    type: "event",
    group: "orders",
    model: () => M("./event/event.models").EvOrder,
    fields: ["buyer.name", "reference", "no"],
    phone: ["buyer.phone"],
    num: (n) => ({ no: String(n).padStart(4, "0") }),
    smart: { new: { status: "review" }, unpaid: { status: { $in: ["pending", "review"] } } },
    date: "created_date",
    latest: true,
    select: "business_id no buyer status total created_date",
    sort: { created_date: -1 },
    shape: (r) => ({ kind: "order", title: `#${r.no}`, sub: [r.buyer?.name, r.buyer?.phone].filter(Boolean).join(" · "), money: r.total, status: r.status, at: r.created_date, tab: "orders" }),
  },

  // ---------------- people
  {
    type: "tg_store",
    group: "people",
    model: () => M("./tgstore/tgstore.models").TgCustomer,
    fields: ["name", "username", "note", "address"],
    phone: ["phone"],
    date: "created_date",
    latest: true,
    select: "business_id name phone username",
    sort: { last_order_at: -1, created_date: -1 },
    shape: (r) => ({ kind: "person", title: r.name || (r.username ? `@${r.username}` : r.phone), sub: [r.phone, r.username ? `@${r.username}` : ""].filter(Boolean).join(" · "), tab: "customers" }),
  },
  {
    type: "stamp_card",
    group: "people",
    model: () => M("./stamp/stamp.models").StampMember,
    base: { deleted: false },
    fields: ["name", "note"],
    phone: ["phone"],
    num: (n) => ({ no: n }),
    date: "created_date",
    latest: true,
    select: "business_id no name phone",
    sort: { last_visit_at: -1 },
    shape: (r) => ({ kind: "person", title: r.name || r.phone, sub: [r.no ? `#${r.no}` : "", r.phone].filter(Boolean).join(" · "), tab: "customers" }),
  },
  {
    type: "attendance",
    group: "people",
    model: () => M("./attendance/attendance.models").AttStaff,
    fields: ["name", "position", "id_number"],
    phoneIntl: ["phone"],
    select: "business_id name phone position active",
    shape: (r) => ({ kind: "person", title: r.name, sub: [r.position, r.phone].filter(Boolean).join(" · "), tab: "staff", flag: r.active === false ? "hidden" : "" }),
  },
  {
    type: "debt_book",
    group: "people",
    model: () => M("./debt/debt.models").DebtCustomer,
    base: { deleted: false },
    fields: ["name", "note", "address", "telegram"],
    phone: ["phone"],
    latest: true,
    select: "business_id name phone",
    sort: { last_at: -1 },
    shape: (r) => ({ kind: "person", title: r.name, sub: r.phone || "", tab: "customers", params: { c: String(r._id) } }),
  },
  {
    type: "restaurant",
    group: "people",
    model: () => M("./restaurant/restaurant.models").RestMember,
    fields: ["name", "note"],
    phone: ["phone"],
    select: "business_id name phone",
    shape: (r) => ({ kind: "person", title: r.name || r.phone, sub: r.phone || "", tab: "rewards" }),
  },
  {
    type: "mart",
    group: "people",
    model: () => M("./mart/mart.models").MartMember,
    fields: ["name", "note"],
    phone: ["phone"],
    select: "business_id name phone",
    shape: (r) => ({ kind: "person", title: r.name || r.phone, sub: r.phone || "", tab: "loyalty" }),
  },

  // ---------------- events, notes, books, QR codes, web pages
  {
    type: "event",
    group: "other",
    model: () => M("./event/event.models").EvEvent,
    fields: ["title", "venue", "city"],
    select: "business_id title venue starts_at status",
    sort: { starts_at: -1 },
    shape: (r) => ({ kind: "event", title: r.title, sub: r.venue || "", at: r.starts_at, status: r.status, tab: "events", params: { event: String(r._id) } }),
  },
  {
    type: "digital_note",
    group: "other",
    model: () => M("./note/note.models").Note,
    base: { deleted: false },
    fields: ["title", "tags"],
    select: "business_id title tags updated_date",
    sort: { updated_date: -1 },
    shape: (r) => ({ kind: "note", title: r.title || "—", sub: (r.tags || []).join(" · "), at: r.updated_date, tab: "notes", params: { note: String(r._id) } }),
  },
  { type: "flipbook", group: "other", model: () => M("./flipbook/flipbook.models").FbBook, fields: ["title", "about"], select: "business_id title", shape: (r) => ({ kind: "book", title: r.title, sub: "", tab: "books" }) },
  { type: "qr_gen", group: "other", model: () => M("./qrgen/qrgen.models").QgCode, base: { deleted_at: null }, fields: ["name"], select: "business_id name type", shape: (r) => ({ kind: "qr", title: r.name, sub: r.type || "", tab: "codes" }) },
  {
    type: "website",
    group: "other",
    model: () => M("./website/website.models").WebPage,
    fields: ["title.en", "title.km", "slug"],
    select: "business_id title slug",
    shape: (r) => ({ kind: "page", title: r.title?.en || r.title?.km || r.slug, sub: r.title?.en && r.title?.km ? r.title.km : "", tab: "pages", params: { page: String(r._id) } }),
  },
];

// the plain search: every word in a name, or the phone, or the number
function plainFilter(s, t) {
  const or = [];
  const words = allIn(s.fields, t.allWords);
  if (words && !(t.num !== null && s.num)) or.push(words); // a barcode or code is digits too
  if (t.phone && s.phone) for (const f of s.phone) or.push({ [f]: t.phone });
  if (t.phoneIntl && s.phoneIntl) for (const f of s.phoneIntl) or.push({ [f]: t.phoneIntl });
  if (t.num !== null && s.num) or.push(s.num(t.num));
  if (t.num !== null && !s.num && words) or.push(words); // "12" can still be part of a name / code
  return or.length ? { $or: or } : null;
}

// the smart search: the smart words this place understands + the other words in a name
function smartFilter(s, t) {
  const keys = t.smart.filter((k) => !["today", "yesterday", "orders", "people"].includes(k));
  if (keys.some((k) => !s.smart?.[k])) return null; // asks for something this place doesn't have
  if (t.smart.includes("orders") && s.group !== "orders") return null;
  if (t.smart.includes("people") && s.group !== "people") return null;
  const when = t.smart.includes("today") ? dayOf(0) : t.smart.includes("yesterday") ? dayOf(-1) : null;
  if (when && !s.date) return null;
  if (!keys.length && !when && !s.latest) return null; // "orders" alone: only places that can list their newest
  const and = keys.map((k) => s.smart[k]);
  if (when) and.push({ [s.date]: when });
  const words = allIn(s.fields, t.words);
  if (words) and.push(words);
  return and.length ? { $and: and } : {};
}

async function run(biz, t, n) {
  const byId = new Map(biz.map((b) => [String(b._id), b]));
  const idsOf = (type) => biz.filter((b) => b.category === type).map((b) => b._id);
  const out = [];
  const jobs = [];
  for (const s of SEARCHERS) {
    const ids = idsOf(s.type);
    if (!ids.length) continue;
    const base = { business_id: { $in: ids }, ...(s.base || {}) };
    const find = (filter, smart) =>
      s
        .model()
        .find({ ...base, ...filter })
        .select(s.select)
        .sort(s.sort || { created_date: -1 })
        .limit(smart ? Math.max(n, 8) : n)
        .maxTimeMS(4000)
        .lean()
        .then((rows) =>
          rows.map((r) => {
            const b = byId.get(String(r.business_id)) || {};
            return { group: s.group, business_id: r.business_id, business: b.name || "", category: b.category || s.type, ...s.shape(r), id: String(r._id), ...(smart ? { smart: true } : {}) };
          }),
        );
    if (t.smart.length) {
      const f = smartFilter(s, t);
      if (f) jobs.push(find(f, true));
    }
    const p = plainFilter(s, t);
    if (p) jobs.push(find(p, false));
  }
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === "fulfilled") out.push(...r.value);
    else console.error("[search]", r.reason?.message);
  }
  // smart answers first; one row per thing
  const seen = new Set();
  return out
    .sort((a, b) => (b.smart ? 1 : 0) - (a.smart ? 1 : 0))
    .filter((r) => {
      const k = `${r.group}:${r.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

async function search(customerId, raw, limit = 5) {
  let t = termsOf(raw);
  if (t.q.length < 2 && t.num === null) return { q: t.q, smart: [], results: [] };
  const n = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const biz = await myBusinesses(customerId);
  const nameHit = (re) => biz.filter((b) => t.allWords.every((w) => w.test(b.name)) || re.test(b.name));
  let results = [...nameHit(t.re).slice(0, n).map((b) => ({ group: "businesses", kind: "business", business_id: b._id, business: b.name, category: b.category, title: b.name, sub: "", tab: "", logo: b.logo_url || "", id: String(b._id) })), ...(await run(biz, t, n))];
  // nothing? allow a missing / doubled letter once
  if (!results.length && t.allWords.some((w) => w.source.length >= 4)) {
    t = termsOf(raw, { fuzzy: true });
    results = [...nameHit(t.re).slice(0, n).map((b) => ({ group: "businesses", kind: "business", business_id: b._id, business: b.name, category: b.category, title: b.name, sub: "", tab: "", logo: b.logo_url || "", id: String(b._id) })), ...(await run(biz, t, n))];
  }
  return { q: t.q, smart: t.smart, fuzzy: t.fuzzy && results.length > 0, results };
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
