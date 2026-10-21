// Licenses: what customers bought for their businesses and when it ends.
// Customer:
//   POST /api/user/businesses/:id/licenses/:product   { expect: <end date you saw | null> }  buy (or renew) with coins → { data: status, charged, balance }
//   GET  /api/user/licenses                           all my licenses (+ unlocked card themes)
// Super admin:
//   GET  /api/admin/licenses?status=active|expiring|expired&kind=forever|renew&product=&q=&page=&limit=
const mongoose = require("mongoose");
const License = require("./license.model");
const { PRODUCTS, PRODUCT_KEYS, EXPIRING_DAYS } = require("./license.products");
const { buy, statusOf, LicenseError, DAY } = require("./license.service");
const Business = require("../biz/business.model");
const Customer = require("../user/customer.model");
const Namecard = require("../biz/namecard/namecard.model");
const Portfolio = require("../biz/namecard/portfolio.model");
const { priceOf } = require("../homepage/prices");
const { customer_auth } = require("../user/customer_auth");
const { only_super_admin } = require("../util/permission");

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  badProduct: "សេវាកម្មមិនត្រឹមត្រូវ!",
  needs: "សូមទិញមុខងារមូលដ្ឋានជាមុនសិន (ឧ. គេហទំព័រ)!",
  already: "បានទិញរួចហើយ!",
  busy: "កំពុងដំណើរការ សូមព្យាយាមម្តងទៀត!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  bought: "ទិញបានជោគជ័យ!",
  changed: "បានបន្តរួចហើយ! សូមផ្ទុកទំព័រឡើងវិញ។",
  soon: "សេវាកម្មនេះនឹងមានឆាប់ៗ!",
};

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const route = (prop) => {
  // ===================================== BUY / RENEW =====================================
  prop.app.post("/api/user/businesses/:id/licenses/:product", prop.api_auth, customer_auth, async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: MSG.badId });
      // products with items (website themes) are bought from their own screen
      //   … but a yearly item already bought can be renewed here (item in the body)
      const def = PRODUCT_KEYS.includes(req.params.product) ? PRODUCTS[req.params.product] : null;
      const item = def?.item && def.days && typeof req.body?.item === "string" ? req.body.item.slice(0, 64) : "";
      if (!def || def.retired || (def.item && !item)) return res.status(400).json({ success: false, message: MSG.badProduct });
      const business = await Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false });
      if (!business) return res.status(404).json({ success: false, message: MSG.notFound });
      if (!business.status) return res.status(403).json({ success: false, message: MSG.suspended });
      if (item && !(await License.exists({ business_id: business._id, product: req.params.product, item }))) return res.status(400).json({ success: false, message: MSG.badProduct });
      const r = await buy({ customer: req.customer, business, product: req.params.product, item, expect: req.body?.expect });
      res.json({ success: true, data: r.status, product: req.params.product, charged: r.charged, balance: r.balance, message: MSG.bought });
    } catch (err) {
      if (err instanceof LicenseError) return res.status(err.status).json({ success: false, message: MSG[err.message] || err.message, ...err.extra });
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== MY LICENSES =====================================
  prop.app.get("/api/user/licenses", prop.api_auth, customer_auth, async (req, res) => {
    try {
      const me = req.customer._id;
      const businesses = await Business.find({ owner_id: me, deleted: false }).select("name category status").lean();
      const byId = new Map(businesses.map((b) => [String(b._id), b]));
      const [licenses, cards, folios] = await Promise.all([
        License.find({ customer_id: me, business_id: { $in: businesses.map((b) => b._id) }, product: { $in: PRODUCT_KEYS.filter((k) => !PRODUCTS[k].retired) } }).lean(),
        Namecard.find({ owner_id: me, business_id: { $in: businesses.map((b) => b._id) }, "unlocked_themes.0": { $exists: true } })
          .select("business_id unlocked_themes created_date")
          .lean(),
        Portfolio.find({ owner_id: me, business_id: { $in: businesses.map((b) => b._id) }, "unlocked_themes.0": { $exists: true } })
          .select("business_id unlocked_themes")
          .lean(),
      ]);
      const prices = {};
      for (const [key, def] of Object.entries(PRODUCTS)) if (!def.retired) prices[key] = await priceOf(def.price_key);

      const rows = licenses.map((l) => ({
        _id: l._id,
        business: byId.get(String(l.business_id)),
        product: l.product,
        item: l.item,
        days: PRODUCTS[l.product]?.days ?? null,
        renew_price: PRODUCTS[l.product]?.days ? prices[l.product] : null,
        total_paid: l.total_paid,
        ...statusOf(l),
      }));
      for (const c of cards) {
        for (const theme of c.unlocked_themes) {
          rows.push({ _id: `${c._id}-${theme}`, business: byId.get(String(c.business_id)), product: "theme", item: theme, days: null, renew_price: null, ...statusOf({ expires_at: null, started_at: null }) });
        }
      }
      for (const f of folios) {
        for (const theme of f.unlocked_themes) {
          rows.push({ _id: `${f._id}-${theme}`, business: byId.get(String(f.business_id)), product: "portfolio_theme", item: theme, days: null, renew_price: null, ...statusOf({ expires_at: null, started_at: null }) });
        }
      }
      // timed ones first, soonest end first
      rows.sort((a, b) => (a.expires_at ? new Date(a.expires_at).getTime() : Infinity) - (b.expires_at ? new Date(b.expires_at).getTime() : Infinity));
      const count = (s) => rows.filter((r) => r.status === s).length;
      res.json({
        success: true,
        data: rows,
        summary: { total: rows.length, active: count("active") + count("forever"), expiring: count("expiring"), expired: count("expired") },
        prices,
        expiring_days: EXPIRING_DAYS,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== SUPER ADMIN: ALL LICENSES =====================================
  prop.app.get(`/${prop.main_route}/licenses`, prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin, async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const now = new Date();
      const soon = new Date(now.getTime() + EXPIRING_DAYS * DAY);
      const STATUS = {
        active: { $or: [{ expires_at: null }, { expires_at: { $gt: now } }] },
        expiring: { expires_at: { $gt: now, $lte: soon } },
        expired: { expires_at: { $ne: null, $lte: now } },
        forever: { expires_at: null },
      };
      const filter = {};
      if (STATUS[req.query.status]) Object.assign(filter, STATUS[req.query.status]);
      // kind: bought once (never ends) or one that has to be renewed (has an end date)
      const KIND = { forever: { expires_at: null }, renew: { expires_at: { $ne: null } } };
      if (KIND[req.query.kind]) filter.$and = [...(filter.$and || []), KIND[req.query.kind]];
      // business type: restaurant | attendance | guest_house | mart | namecard → that type's products
      const TYPES = [...new Set(PRODUCT_KEYS.map((k) => PRODUCTS[k].category))];
      const type = TYPES.includes(req.query.type) ? req.query.type : "";
      const ofType = (t) => PRODUCT_KEYS.filter((k) => PRODUCTS[k].category === t);
      if (type) filter.product = { $in: ofType(type) };
      if (PRODUCT_KEYS.includes(req.query.product)) filter.product = req.query.product;
      const q = String(req.query.q || "").trim();
      if (q) {
        const re = new RegExp(escapeRe(q), "i");
        const [cs, bs] = await Promise.all([
          Customer.find({ $or: [{ name: re }, { email: re }, { phone: re }] })
            .select("_id")
            .limit(500)
            .lean(),
          Business.find({ name: re }).select("_id").limit(500).lean(),
        ]);
        filter.$and = [...(filter.$and || []), { $or: [{ customer_id: { $in: cs.map((c) => c._id) } }, { business_id: { $in: bs.map((b) => b._id) } }] }];
      }
      const inType = type ? { product: { $in: ofType(type) } } : {};
      const [rows, total, active, expiring, expired, byType] = await Promise.all([
        License.find(filter)
          .sort({ expires_at: 1, created_date: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        License.countDocuments(filter),
        License.countDocuments({ ...STATUS.active, ...inType }),
        License.countDocuments({ ...STATUS.expiring, ...inType }),
        License.countDocuments({ ...STATUS.expired, ...inType }),
        License.aggregate([{ $group: { _id: "$product", n: { $sum: 1 } } }]),
      ]);
      const typeCount = {};
      for (const x of byType) {
        const t = PRODUCTS[x._id]?.category;
        if (t) typeCount[t] = (typeCount[t] || 0) + x.n;
      }
      const [customers, businesses] = await Promise.all([
        Customer.find({ _id: { $in: rows.map((r) => r.customer_id) } })
          .select("name email phone")
          .lean(),
        Business.find({ _id: { $in: rows.map((r) => r.business_id) } })
          .select("name category status deleted")
          .lean(),
      ]);
      const cMap = new Map(customers.map((c) => [String(c._id), c]));
      const bMap = new Map(businesses.map((b) => [String(b._id), b]));
      res.json({
        success: true,
        data: rows.map((l) => ({
          _id: l._id,
          customer: cMap.get(String(l.customer_id)) || null,
          business: bMap.get(String(l.business_id)) || null,
          product: l.product,
          item: l.item,
          renewals: l.renewals,
          total_paid: l.total_paid,
          last_paid_at: l.last_paid_at,
          ...statusOf(l),
        })),
        summary: { active, expiring, expired },
        products: PRODUCT_KEYS.filter((k) => !PRODUCTS[k].retired && (!type || PRODUCTS[k].category === type)),
        product_types: Object.fromEntries(PRODUCT_KEYS.map((k) => [k, PRODUCTS[k].category])),
        types: TYPES.map((t) => ({ key: t, count: typeCount[t] || 0 })),
        pagination: { total, totalPages: Math.ceil(total / limit) || 1, currentPage: page, pageSize: limit },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });
};

module.exports = route;
