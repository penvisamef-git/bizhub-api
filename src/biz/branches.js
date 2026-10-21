// Several places (rest_branches / gh_branches, yearly, bought on the main business) — owner dashboard only.
// A group = the main restaurant (or guest house) + the owner's other ones of the same type linked to it.
// Each place keeps its own license, menu / rooms, staff, POS and money; the group adds one report for all.
// (Mini Mart has its own, richer version in mart/mart.branches.js.)
//   GET    /api/user/businesses/:id/branches                  the group + the owner's places that can join
//   POST   /api/user/businesses/:id/branches { business_id }  link one (main only, add-on needed)
//   DELETE /api/user/businesses/:id/branches/:bid             unlink (main only)
//   GET    /api/user/businesses/:id/branches/report?day=YYYY-MM-DD | month=YYYY-MM
const mongoose = require("mongoose");
const Business = require("./business.model");
const License = require("../license/license.model");
const { statusOf } = require("../license/license.service");
const { customer_auth } = require("../user/customer_auth");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
// business_id = the main place (so deleting the main business removes its group too)
const BizGroup =
  mongoose.models.BizGroup ||
  mongoose.model(
    "BizGroup",
    new Schema(
      {
        business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
        category: { type: String, required: true },
        branches: { type: [ObjectId], default: [] },
      },
      { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
    ).index({ branches: 1 }),
  );

const ADDON = { restaurant: "rest_branches", guest_house: "gh_branches" };
const MAX_BRANCHES = 20;
const TZ = 7;
const DAY = 86400000;
const T = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  badType: "មុខងារនេះសម្រាប់តែភោជនីយដ្ឋាន និងផ្ទះសំណាក់!",
  need: "សូមដោះសោ “សាខាច្រើន” ជាមុនសិន!",
  notYours: "អាជីវកម្មនេះមិនមែនជារបស់អ្នក ឬមិនមែនប្រភេទដូចគ្នាទេ!",
  inGroup: "អាជីវកម្មនេះនៅក្នុងក្រុមមួយផ្សេងរួចហើយ!",
  isBranch: "នេះជាសាខារបស់អាជីវកម្មផ្សេង។ សូមបើកពីអាជីវកម្មមេ។",
  tooMany: `សាខាច្រើនបំផុត ${MAX_BRANCHES}!`,
  badDate: "កាលបរិច្ឆេទមិនត្រឹមត្រូវ!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
};
class Bad extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const localDay = (d) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 10);
const dayStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - TZ * 3600000);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const roundOf = (cur) => (cur === "KHR" ? (v) => Math.round(v) : r2);

async function addonActive(businessId, product) {
  const row = await License.findOne({ business_id: businessId, product }).lean();
  return !!statusOf(row).active;
}

// the group this place is in (main + branches, only the owner's live places of this type)
async function groupOf(biz) {
  const bid = String(biz._id);
  let doc = await BizGroup.findOne({ business_id: biz._id }).lean();
  let role = doc && doc.branches.length ? "main" : "none";
  if (role === "none") {
    const up = await BizGroup.findOne({ branches: biz._id }).lean();
    if (up) {
      doc = up;
      role = "branch";
    }
  }
  const mainId = role === "branch" ? String(doc.business_id) : bid;
  const ids = [mainId, ...(role === "none" ? [] : doc.branches.map(String))];
  const places = await Business.find({ _id: { $in: ids }, owner_id: biz.owner_id, deleted: false, category: biz.category })
    .select("name logo_url status")
    .lean();
  const order = new Map(ids.map((x, i) => [x, i]));
  places.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
  const active = await addonActive(mainId, ADDON[biz.category]);
  return {
    role,
    main_id: mainId,
    addon: ADDON[biz.category],
    active,
    shops: places.map((s) => ({ _id: s._id, name: s.name, logo: s.logo_url || "", status: s.status, is_main: String(s._id) === mainId, here: String(s._id) === bid })),
  };
}

// ?day=YYYY-MM-DD (default today) or ?month=YYYY-MM → [from, to) as Cambodia days
function rangeOf(q) {
  const today = localDay(new Date());
  if (q.month !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(q.month))) throw new Bad(T.badDate);
    const from = `${q.month}-01`;
    const [y, m] = q.month.split("-").map(Number);
    const to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    return { kind: "month", from, to, today };
  }
  const day = q.day === undefined || q.day === "" ? today : String(q.day);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw new Bad(T.badDate);
  return { kind: "day", from: day, to: addDays(day, 1), today };
}

// one restaurant: money taken, bills, guests, voids + what sold (by name)
async function restaurantOf(shop, range) {
  const M = require("./restaurant/restaurant.models");
  const st = await M.RestSettings.findOne({ business_id: shop._id }).select("currency khr_rate").lean();
  const start = dayStart(range.from);
  const end = dayStart(range.to);
  const [paid, voids] = await Promise.all([
    M.RestOrder.find({ business_id: shop._id, status: "paid", paid_at: { $gte: start, $lt: end } })
      .select("totals guests lines.name_en lines.name_km lines.qty lines.status")
      .limit(20000)
      .lean(),
    M.RestOrder.countDocuments({ business_id: shop._id, status: "void", opened_at: { $gte: start, $lt: end } }),
  ]);
  const cur = st?.currency || "USD";
  const r = roundOf(cur);
  const sales = r(paid.reduce((a, o) => a + (Number(o.totals?.total) || 0), 0));
  const items = new Map();
  for (const o of paid)
    for (const l of o.lines || []) {
      if (l.status === "void") continue;
      const name = (l.name_en || l.name_km || "").trim();
      if (name) items.set(name, (items.get(name) || 0) + (Number(l.qty) || 0));
    }
  return {
    currency: cur,
    khr_rate: st?.khr_rate || 4100,
    sales,
    count: paid.length,
    avg: paid.length ? r(sales / paid.length) : 0,
    guests: paid.reduce((a, o) => a + (Number(o.guests) || 0), 0),
    voids,
    items,
  };
}

// one guest house: money received, check-ins, nights sold, occupancy, who is in now
async function guestHouseOf(shop, range) {
  const G = require("./guesthouse/guesthouse.models");
  const st = await G.GhSettings.findOne({ business_id: shop._id }).select("currency khr_rate").lean();
  const cur = st?.currency || "USD";
  const r = roundOf(cur);
  const start = dayStart(range.from);
  const end = dayStart(range.to);
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / DAY);
  const [money, rooms, stays, inHouse, arrivals, departures] = await Promise.all([
    G.GhStay.aggregate([
      { $match: { business_id: shop._id, "payments.at": { $gte: start, $lt: end } } },
      { $unwind: "$payments" },
      { $match: { "payments.at": { $gte: start, $lt: end } } },
      { $group: { _id: null, sum: { $sum: "$payments.amount" }, n: { $sum: 1 } } },
    ]),
    G.GhRoom.countDocuments({ business_id: shop._id, active: true }),
    G.GhStay.find({ business_id: shop._id, status: { $in: ["booked", "in", "out"] }, from: { $lt: range.to }, to: { $gt: range.from } })
      .select("from to")
      .lean(),
    G.GhStay.countDocuments({ business_id: shop._id, status: "in" }),
    G.GhStay.countDocuments({ business_id: shop._id, status: "booked", from: range.today }),
    G.GhStay.countDocuments({ business_id: shop._id, status: "in", to: range.today }),
  ]);
  let nights = 0;
  let checkins = 0;
  for (const s of stays) {
    const a = s.from > range.from ? s.from : range.from;
    const b = s.to < range.to ? s.to : range.to;
    nights += Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / DAY));
    if (s.from >= range.from && s.from < range.to) checkins += 1;
  }
  const revenue = r(money[0]?.sum || 0);
  return {
    currency: cur,
    khr_rate: st?.khr_rate || 4100,
    sales: revenue,
    count: money[0]?.n || 0,
    checkins,
    nights,
    rooms,
    occupancy: rooms && days ? Math.round((nights / (rooms * days)) * 1000) / 10 : 0,
    in_house: inHouse,
    arrivals,
    departures,
  };
}

const route = (prop) => {
  const base = "/api/user/businesses/:id/branches";
  const guard = [prop.api_auth, customer_auth];
  const handle = (fn) => async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new Bad(T.badId);
      const biz = await Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false }).lean();
      if (!biz) throw new Bad(T.notFound, 404);
      if (!ADDON[biz.category]) throw new Bad(T.badType, 400, { code: "bad_type" });
      await fn(biz, req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
      console.error("[branches]", err);
      res.status(500).json({ success: false, message: T.server });
    }
  };
  // places of this type the owner has that are not in any group yet
  async function candidatesOf(biz) {
    const mine = await Business.find({ owner_id: biz.owner_id, deleted: false, category: biz.category, _id: { $ne: biz._id } })
      .select("name")
      .lean();
    const ids = mine.map((x) => x._id);
    const groups = await BizGroup.find({ $or: [{ business_id: { $in: ids }, "branches.0": { $exists: true } }, { branches: { $in: ids } }] })
      .select("business_id branches")
      .lean();
    const taken = new Set(groups.flatMap((g) => [...(g.branches.length ? [String(g.business_id)] : []), ...g.branches.map(String)]));
    return mine.filter((x) => !taken.has(String(x._id))).map((x) => ({ _id: x._id, name: x.name }));
  }

  prop.app.get(
    base,
    ...guard,
    handle(async (biz, req, res) => {
      const g = await groupOf(biz);
      const candidates = g.role === "branch" ? [] : await candidatesOf(biz);
      res.json({ success: true, data: { ...g, candidates, main: g.shops.find((s) => s.is_main) || null } });
    }),
  );

  prop.app.post(
    base,
    ...guard,
    handle(async (biz, req, res) => {
      const g = await groupOf(biz);
      if (g.role === "branch") throw new Bad(T.isBranch, 409, { code: "is_branch" });
      if (!g.active) throw new Bad(T.need, 402, { product: ADDON[biz.category] });
      const id = String(req.body?.business_id || "");
      if (!mongoose.Types.ObjectId.isValid(id) || id === String(biz._id)) throw new Bad(T.notYours, 400, { code: "not_yours" });
      const other = await Business.findOne({ _id: id, owner_id: biz.owner_id, deleted: false, category: biz.category }).lean();
      if (!other) throw new Bad(T.notYours, 404, { code: "not_yours" });
      if ((await BizGroup.exists({ business_id: other._id, "branches.0": { $exists: true } })) || (await BizGroup.exists({ branches: other._id }))) throw new Bad(T.inGroup, 409, { code: "in_group" });
      const doc = await BizGroup.findOneAndUpdate({ business_id: biz._id }, { $setOnInsert: { category: biz.category } }, { upsert: true, returnDocument: "after" });
      if (doc.branches.length >= MAX_BRANCHES) throw new Bad(T.tooMany, 400, { code: "too_many" });
      await BizGroup.updateOne({ _id: doc._id }, { $addToSet: { branches: other._id } });
      res.json({ success: true, data: await groupOf(biz), message: T.saved });
    }),
  );

  prop.app.delete(
    `${base}/:bid`,
    ...guard,
    handle(async (biz, req, res) => {
      const g = await groupOf(biz);
      if (g.role === "branch") throw new Bad(T.isBranch, 409, { code: "is_branch" });
      if (!mongoose.Types.ObjectId.isValid(req.params.bid)) throw new Bad(T.badId);
      await BizGroup.updateOne({ business_id: biz._id }, { $pull: { branches: new mongoose.Types.ObjectId(req.params.bid) } });
      res.json({ success: true, data: await groupOf(biz), message: T.deleted });
    }),
  );

  prop.app.get(
    `${base}/report`,
    ...guard,
    handle(async (biz, req, res) => {
      const g = await groupOf(biz);
      if (!g.active) throw new Bad(T.need, 402, { product: ADDON[biz.category] });
      const range = rangeOf(req.query);
      const rest = biz.category === "restaurant";
      const rows = await Promise.all(g.shops.map(async (s) => ({ ...s, ...(rest ? await restaurantOf(s, range) : await guestHouseOf(s, range)) })));
      // all together, in the currency of the place that asks
      const here = rows.find((s) => s.here) || rows[0];
      const cur = here.currency;
      const conv = (v, s) => (s.currency === cur ? v : cur === "USD" ? v / (s.khr_rate || 4100) : v * (s.khr_rate || 4100));
      const r = roundOf(cur);
      const sum = (k) => rows.reduce((a, s) => a + (s[k] || 0), 0);
      const total = { sales: r(rows.reduce((a, s) => a + conv(s.sales, s), 0)), count: sum("count") };
      let best = [];
      if (rest) {
        Object.assign(total, { guests: sum("guests"), voids: sum("voids") });
        total.avg = total.count ? r(total.sales / total.count) : 0;
        const all = new Map();
        for (const s of rows) for (const [name, qty] of s.items) all.set(name, (all.get(name) || 0) + qty);
        best = [...all.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 8)
          .map(([name, qty]) => ({ name, qty: Math.round(qty * 1000) / 1000 }));
        rows.forEach((s) => delete s.items);
      } else {
        Object.assign(total, { checkins: sum("checkins"), nights: sum("nights"), rooms: sum("rooms"), in_house: sum("in_house"), arrivals: sum("arrivals"), departures: sum("departures") });
        const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / DAY);
        total.occupancy = total.rooms && days ? Math.round((total.nights / (total.rooms * days)) * 1000) / 10 : 0;
      }
      res.json({ success: true, data: { category: biz.category, kind: range.kind, from: range.from, to: range.to, currency: cur, shops: rows, total, best } });
    }),
  );
};

module.exports = route;
module.exports.BizGroup = BizGroup;
module.exports.ADDON = ADDON;
