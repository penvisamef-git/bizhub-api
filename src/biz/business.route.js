// Businesses
// Customer (owner):
//   GET    /api/user/businesses
//   POST   /api/user/businesses            { name, category, phone, address }   category = type: namecard | restaurant
//                                          costs coins (price per type, set in Website settings → prices)
//                                          restaurant = 1 year (a "restaurant" license, renewed on the Licenses page)
//   GET    /api/user/businesses-prices     coins per type, e.g. { namecard: 5, restaurant: 100 } + days: { restaurant: 365 }
//   PUT    /api/user/businesses/:id        name, phone, address (the type cannot change: it was paid for)
//   DELETE /api/user/businesses/:id
// Super admin:
//   GET /api/admin/businesses?page&limit&q&status=active|suspended&category=namecard|restaurant
//   GET /api/admin/businesses/:id
//   PUT /api/admin/businesses/:id/status   { status: true|false, admin_note? }
const mongoose = require("mongoose");
const Business = require("./business.model");
const Namecard = require("./namecard/namecard.model");
const { BUSINESS_CATEGORIES } = require("./business.model");
const Customer = require("../user/customer.model");
const { customer_auth } = require("../user/customer_auth");
const { only_super_admin } = require("../util/permission");
const { logActivity } = require("../util/log");
const coin = require("../coin/coin.service");
const Homepage = require("../homepage/homepage.model");
const { DEFAULT_HOMEPAGE } = require("../homepage/homepage.defaults");
const License = require("../license/license.model");
const { PRODUCTS, YEARLY_TYPES } = require("../license/license.products");
const { statusOf, DAY } = require("../license/license.service");

// Coins to add one business of this type (set by the super admin in Website settings)
async function priceOf(type) {
  const doc = await Homepage.findOne({ key: "main" }).select("prices").lean();
  const value = doc?.prices?.[type];
  return Number.isInteger(value) ? value : (DEFAULT_HOMEPAGE.prices[type] ?? 0);
}
const { escapeRegex } = require("../util/helper");

// no limit on how many businesses one customer can add (each one is paid with coins)
const PHONE_RE = /^\+?[0-9 ]{8,20}$/;

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badName: "ឈ្មោះអាជីវកម្មត្រូវមាន 2 ដល់ 100 តួអក្សរ!",
  badCategory: "ប្រភេទអាជីវកម្មមិនត្រឹមត្រូវ! (namecard | restaurant | attendance | guest_house | mart)",
  badPhone: "លេខទូរស័ព្ទមិនត្រឹមត្រូវ!",
  badAddress: "អាសយដ្ឋានវែងពេក!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  saved: "បានរក្សាទុក!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  typeLocked: "មិនអាចប្តូរប្រភេទអាជីវកម្មបានទេ។ សូមបង្កើតអាជីវកម្មថ្មី។",
  deleted: "បានលុប!",
};

// Check the fields a customer may set. Returns { set } or { error }.
function readBusiness(body = {}, isCreate) {
  const set = {};
  if (isCreate || body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (name.length < 2 || name.length > 100) return { error: MSG.badName };
    set.name = name;
  }
  if (isCreate || body.category !== undefined) {
    if (!BUSINESS_CATEGORIES.includes(body.category)) return { error: MSG.badCategory };
    set.category = body.category;
  }
  if (body.phone !== undefined) {
    const phone = String(body.phone || "").trim();
    if (phone && !PHONE_RE.test(phone)) return { error: MSG.badPhone };
    set.phone = phone;
  }
  if (body.address !== undefined) {
    const address = String(body.address || "").trim();
    if (address.length > 300) return { error: MSG.badAddress };
    set.address = address;
  }
  return { set };
}

// the owner's businesses with what the list shows: name card link / views / photo,
// restaurant logo + currency, and when a yearly type's year ends
async function listFor(ownerId) {
  const rows = (await Business.find({ owner_id: ownerId, deleted: false }).sort({ created_date: 1 }).lean()).sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || new Date(a.created_date) - new Date(b.created_date));
  const ids = rows.map((b) => b._id);
  const restIds = rows.filter((b) => b.category === "restaurant").map((b) => b._id);
  const mqIds = rows.filter((b) => b.category === "menu_qr").map((b) => b._id);
  const fbIds = rows.filter((b) => b.category === "flipbook").map((b) => b._id);
  const qgIds = rows.filter((b) => b.category === "qr_gen").map((b) => b._id);
  const wsIds = rows.filter((b) => b.category === "website").map((b) => b._id);
  const scIds = rows.filter((b) => b.category === "stamp_card").map((b) => b._id);
  const [cards, licenses, rest, menus, shelves, qrs, sites, stamps] = await Promise.all([
    Namecard.find({ business_id: { $in: ids } })
      .select("business_id slug views published photo")
      .lean(),
    License.find({ business_id: { $in: rows.filter((b) => YEARLY_TYPES.includes(b.category)).map((b) => b._id) }, product: { $in: YEARLY_TYPES } }).lean(),
    restIds.length
      ? RestSettings()
          .find({ business_id: { $in: restIds } })
          .select("business_id logo name_km name_en currency khr_rate")
          .lean()
      : [],
    mqIds.length
      ? require("./menuqr/menuqr.models")
          .MqSettings.find({ business_id: { $in: mqIds } })
          .select("business_id logo")
          .lean()
      : [],
    fbIds.length
      ? require("./flipbook/flipbook.models")
          .FbSettings.find({ business_id: { $in: fbIds } })
          .select("business_id logo")
          .lean()
      : [],
    qgIds.length
      ? require("./qrgen/qrgen.models")
          .QgSettings.find({ business_id: { $in: qgIds } })
          .select("business_id logo")
          .lean()
      : [],
    wsIds.length
      ? require("./website/website.models")
          .WebSite.find({ business_id: { $in: wsIds } })
          .select("business_id logo slug published")
          .lean()
      : [],
    scIds.length
      ? require("./stamp/stamp.models")
          .StampProgram.find({ business_id: { $in: scIds } })
          .select("business_id logo")
          .lean()
      : [],
  ]);
  return rows.map((b) => {
    const card = cards.find((c) => String(c.business_id) === String(b._id));
    const out = card ? { ...b, namecard: { slug: card.slug, views: card.views, published: card.published, photo: card.photo?.url || "" } } : { ...b };
    const r = rest.find((x) => String(x.business_id) === String(b._id));
    if (r) out.restaurant = { logo: r.logo?.url || "", name_km: r.name_km || "", name_en: r.name_en || "", currency: r.currency || "USD", khr_rate: r.khr_rate || 4100 };
    const mq = menus.find((x) => String(x.business_id) === String(b._id));
    const fb = shelves.find((x) => String(x.business_id) === String(b._id)) || qrs.find((x) => String(x.business_id) === String(b._id));
    const ws = sites.find((x) => String(x.business_id) === String(b._id));
    if (ws) out.website = { slug: ws.slug, published: !!ws.published };
    const sc = stamps.find((x) => String(x.business_id) === String(b._id));
    out.photo = card?.photo?.url || r?.logo?.url || mq?.logo?.url || fb?.logo?.url || ws?.logo || sc?.logo || b.logo_url || ""; // one picture for any type
    if (YEARLY_TYPES.includes(b.category)) out.license = statusOf(licenses.find((l) => String(l.business_id) === String(b._id) && l.product === b.category));
    return out;
  });
}
// loaded late: restaurant models require this folder too
const RestSettings = () => require("./restaurant/restaurant.models").RestSettings;

const route = (prop) => {
  const userUrl = "/api/user/businesses";
  const adminUrl = `/${prop.main_route}/businesses`;
  const userGuard = [prop.api_auth, customer_auth];
  // a change to the owner's businesses → their dashboard is worked out again on the next visit
  const forgetDash = (req, res, next) => {
    res.on("finish", () => req.customer && require("./dashboard.route").forget(req.customer._id));
    next();
  };
  const writeGuard = [...userGuard, forgetDash];
  const adminGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin];
  const validId = (id) => mongoose.Types.ObjectId.isValid(id);

  // ===================================== CUSTOMER =====================================
  prop.app.get(userUrl, ...userGuard, async (req, res) => {
    try {
      res.json({ success: true, data: await listFor(req.customer._id), categories: BUSINESS_CATEGORIES });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // Adding a business costs coins (price per type). Coins go back to the BizHub treasury.
  prop.app.post(userUrl, ...writeGuard, async (req, res) => {
    try {
      const { set, error } = readBusiness(req.body, true);
      if (error) return res.status(400).json({ success: false, message: error });

      const price = await priceOf(set.category);
      const _id = new mongoose.Types.ObjectId();
      let tx = null;

      // 1) pay first (fails if the wallet has fewer coins than the price)
      if (price > 0) {
        try {
          tx = await coin.transfer({
            from: await coin.getCustomerWallet(req.customer._id),
            to: await coin.getTreasury(),
            amount: price,
            note: `New business: ${set.name}`,
            customerId: req.customer._id,
            type: "spend",
            businessId: _id,
            service: set.category,
            max: 100000,
          });
        } catch (err) {
          if (err instanceof coin.CoinError) {
            const wallet = await coin.getCustomerWallet(req.customer._id);
            return res.status(402).json({ success: false, message: MSG.noCoins, price, balance: wallet.balance });
          }
          throw err;
        }
      }

      // 2) create the business (give the coins back if this fails)
      let data;
      try {
        data = await Business.create({ _id, ...set, owner_id: req.customer._id });
      } catch (err) {
        if (tx) {
          await coin.transfer({
            from: await coin.getTreasury(),
            to: await coin.getCustomerWallet(req.customer._id),
            amount: price,
            note: `Refund: ${set.name}`,
            customerId: req.customer._id,
            businessId: _id,
            max: 100000,
          });
        }
        throw err;
      }

      // 3) yearly types (restaurant): the payment covers the first year
      let license;
      if (YEARLY_TYPES.includes(set.category)) {
        const now = new Date();
        const lic = await License.create({
          customer_id: req.customer._id,
          business_id: _id,
          product: set.category,
          started_at: now,
          expires_at: new Date(now.getTime() + PRODUCTS[set.category].days * DAY),
          total_paid: price,
          last_paid_at: price ? now : null,
        });
        license = statusOf(lic.toObject());
      }

      res.status(201).json({ success: true, data: license ? { ...data.toObject(), license } : data, charged: price, balance: tx ? tx.from_balance_after : undefined, message: MSG.saved });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // Coins each type costs (for the "Add business" screen)
  prop.app.get(`${userUrl}-prices`, ...userGuard, async (req, res) => {
    try {
      const doc = await Homepage.findOne({ key: "main" }).select("prices").lean();
      const days = Object.fromEntries(YEARLY_TYPES.map((k) => [k, PRODUCTS[k].days]));
      res.json({ success: true, data: { ...DEFAULT_HOMEPAGE.prices, ...(doc?.prices || {}) }, days });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // the owner's own order: ids top → bottom (any missing keep their place after these)
  prop.app.put(`${userUrl}-order`, ...writeGuard, async (req, res) => {
    try {
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter(validId).slice(0, 500);
      if (!ids.length) return res.status(400).json({ success: false, message: MSG.badId });
      const mine = new Set((await Business.find({ owner_id: req.customer._id, deleted: false, _id: { $in: ids } }).select("_id").lean()).map((b) => String(b._id)));
      const ops = ids.filter((id) => mine.has(id)).map((id, i) => ({ updateOne: { filter: { _id: id, owner_id: req.customer._id }, update: { $set: { position: i } } } }));
      if (ops.length) await Business.bulkWrite(ops, { ordered: false });
      res.json({ success: true, data: await listFor(req.customer._id), message: MSG.saved });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  prop.app.put(`${userUrl}/:id`, ...writeGuard, async (req, res) => {
    try {
      if (!validId(req.params.id)) return res.status(400).json({ success: false, message: MSG.badId });
      const business = await Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false });
      if (!business) return res.status(404).json({ success: false, message: MSG.notFound });
      if (!business.status) return res.status(403).json({ success: false, message: MSG.suspended });

      const { set, error } = readBusiness(req.body, false);
      if (error) return res.status(400).json({ success: false, message: error });
      // the type was paid for: it can't be changed later
      if (set.category && set.category !== business.category) return res.status(400).json({ success: false, message: MSG.typeLocked });
      business.set(set);
      await business.save();
      res.json({ success: true, data: business, message: MSG.saved });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  prop.app.delete(`${userUrl}/:id`, ...writeGuard, async (req, res) => {
    try {
      if (!validId(req.params.id)) return res.status(400).json({ success: false, message: MSG.badId });
      const found = await Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false }).select("_id name category").lean();
      if (!found) return res.status(404).json({ success: false, message: MSG.notFound });
      // gone for good: its files on Cloudinary and all its records (not just hidden)
      const purged = await require("./business.purge").purgeBusiness(found._id);
      res.json({ success: true, message: MSG.deleted, data: purged });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== SUPER ADMIN =====================================
  prop.app.get(adminUrl, ...adminGuard, async (req, res) => {
    try {
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      const filter = { deleted: false };
      if (req.query.status === "active") filter.status = true;
      if (req.query.status === "suspended") filter.status = false;
      if (BUSINESS_CATEGORIES.includes(req.query.category)) filter.category = req.query.category;
      if (validId(req.query.owner_id)) filter.owner_id = req.query.owner_id;

      const q = String(req.query.q || "").trim();
      if (q) {
        // search business name/phone, or the owner's name/email
        const re = { $regex: escapeRegex(q), $options: "i" };
        const owners = await Customer.find({ $or: [{ name: re }, { email: re }] })
          .select("_id")
          .limit(200)
          .lean();
        filter.$or = [{ name: re }, { phone: re }, { owner_id: { $in: owners.map((o) => o._id) } }];
      }

      const [data, total] = await Promise.all([
        Business.find(filter)
          .sort({ created_date: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .populate("owner_id", "name email phone status")
          .lean(),
        Business.countDocuments(filter),
      ]);
      res.json({
        success: true,
        data,
        categories: BUSINESS_CATEGORIES,
        pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page, pageSize: limit },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  prop.app.get(`${adminUrl}/:id`, ...adminGuard, async (req, res) => {
    try {
      if (!validId(req.params.id)) return res.status(400).json({ success: false, message: MSG.badId });
      const data = await Business.findOne({ _id: req.params.id, deleted: false }).populate("owner_id", "name email phone status").lean();
      if (!data) return res.status(404).json({ success: false, message: MSG.notFound });
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  prop.app.put(`${adminUrl}/:id/status`, ...adminGuard, async (req, res) => {
    try {
      if (!validId(req.params.id)) return res.status(400).json({ success: false, message: MSG.badId });
      if (typeof req.body?.status !== "boolean") return res.status(400).json({ success: false, message: "status: true | false" });
      const set = { status: req.body.status };
      if (req.body.admin_note !== undefined) set.admin_note = String(req.body.admin_note).slice(0, 500);

      const data = await Business.findOneAndUpdate({ _id: req.params.id, deleted: false }, { $set: set }, { returnDocument: "after" });
      if (!data) return res.status(404).json({ success: false, message: MSG.notFound });

      await logActivity({
        title: `អាជីវកម្ម ${data.name} ${data.status ? "ត្រូវបានបើកវិញ" : "ត្រូវបានផ្អាក"}`,
        description: `គណនី: ${req.user.email}${set.admin_note ? ` · ${set.admin_note}` : ""}`,
        categoryTitle: "business",
        createdBy: req.session.user_id,
        req,
      });
      res.json({ success: true, data, message: MSG.saved });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });
};

module.exports = route;
module.exports.listFor = listFor;
