// Mini Mart (yearly license, 150 coins): products with barcodes, a fast sale screen (POS, works offline), sales + reports.
// Owner base: /api/user/businesses/:id/mart        POS (paired device + cashier PIN): /api/martpos
//   GET  /                         everything the dashboard needs (license, limits, settings, categories, counts)
//   PUT  /settings                 { currency, khr_rate, khr_round, methods, receipt_note, pay_qr_label }
//   CRUD /categories               (owner + POS manager)
//   GET  /products                 POST /products   PUT/DELETE /products/:pid   (POS: managers add / change)
//   POST /products/import { rows } (owner) many at once, from Excel (CSV); same barcode = update
//   POST/DELETE /products/:pid/photo
// Sales, reports: mart.sales.js — cashiers, devices, PINs: mart.pos.js
// Products: no limit (20,000 safety ceiling). 2 cashiers free. The license: 7 days after it ends, everything is read-only (402).
const mongoose = require("mongoose");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const M = require("./mart.models");
const Business = require("../business.model");
const License = require("../../license/license.model");
const { statusOf, LicenseError, DAY } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");

const GRACE_DAYS = 7;
const FREE = { staff: 2, methods: 3, history_days: 30 };
// add-ons: mart_staff (unlimited cashiers, yearly), mart_payments (more than 3 payment methods, forever),
//   mart_stock (stock control, yearly), mart_printer (printing, forever); receipt templates = mart_print_theme (each, forever)
// mart_website: the shop website, yearly (looks = mart_site_theme, each forever) · mart_shop: online orders + customer accounts, yearly (looks = mart_portal_theme)
// mart_history: old sales + reports, yearly · mart_debt: debt book, yearly · mart_shifts: cash drawer, forever · mart_labels: barcode labels, forever
const ADDONS = [
  "mart_staff",
  "mart_payments",
  "mart_stock",
  "mart_printer",
  "mart_history",
  "mart_debt",
  "mart_shifts",
  "mart_labels",
  "mart_suppliers",
  "mart_website",
  "mart_shop",
  "mart_telegram",
  "mart_expiry",
  "mart_loyalty",
  "mart_promos",
  "mart_profit",
  "mart_purchase",
  "mart_display",
  "mart_scale",
  "mart_delivery",
  "mart_branches",
];
const MAX = { categories: 100, import: 2000, products: 20000, units: 60 };
const BARCODE_RE = /^[0-9A-Za-z._\-]{1,40}$/;

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  notMart: "អាជីវកម្មនេះមិនមែនជាម៉ាតទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  locked: "ប្រព័ន្ធម៉ាតផុតកំណត់ហើយ! សូមបន្តដើម្បីប្រើប្រាស់។",
  rowNotFound: "រកមិនឃើញទិន្នន័យ!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
  tooLong: "អត្ថបទវែងពេក!",
  required: "សូមបំពេញ",
  badValue: "តម្លៃមិនត្រឹមត្រូវ!",
  tooMany: "ច្រើនពេក!",
  nameTaken: "ឈ្មោះនេះមានរួចហើយ!",
  barcodeTaken: "បាកូដនេះមានទំនិញផ្សេងប្រើហើយ!",
  badBarcode: "បាកូដមិនត្រឹមត្រូវ!",
  needLabels: "សូមដោះសោ “ស្លាកបាកូដ” ជាមុនសិន!",
  hasBarcode: "ទំនិញនេះមានបាកូដរួចហើយ!",
  productLimit: "ទំនិញច្រើនបំផុត 20,000។",
  badImage: "សូមដាក់រូបភាព JPG / PNG / WEBP (តិចជាង 4MB)!",
  noFile: "សូមជ្រើសរើសរូបភាព!",
  posLogin: "ឧបករណ៍នេះមិនទាន់ភ្ជាប់ទេ។ សូមភ្ជាប់ម្តងទៀត។",
  posLocked: "សូមវាយ PIN របស់អ្នក។",
  managerOnly: "សម្រាប់តែអ្នកគ្រប់គ្រង ឬម្ចាស់ប៉ុណ្ណោះ។",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  methodLimit: "វិធីបង់ប្រាក់ឥតគិតថ្លៃមានតែ Cash, ABA, KHQR។ សូមដោះសោ “វិធីបង់ប្រាក់បន្ថែម” ដើម្បីបង្កើតវិធីផ្ទាល់ខ្លួន។",
  unitInUse: "ឯកតានេះកំពុងប្រើលើទំនិញ មិនអាចលុបបានទេ!",
  lastUnit: "ត្រូវមានឯកតាយ៉ាងហោចណាស់មួយ!",
  needUnitName: "សូមបំពេញឈ្មោះឯកតា (ខ្មែរ ឬ អង់គ្លេស)!",
  badUnit: "សូមជ្រើសរើសឯកតា!",
};

class Bad extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const validId = (id) => mongoose.Types.ObjectId.isValid(id) && String(id).length === 24;
const localDay = (t = Date.now()) => new Date(t + 7 * 3600000).toISOString().slice(0, 10);
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

function text(body, key, max, { required = false } = {}) {
  if (body[key] === undefined) {
    if (required) throw new Bad(`${MSG.required}: ${key}`);
    return undefined;
  }
  const v = String(body[key] ?? "").trim();
  if (required && !v) throw new Bad(`${MSG.required}: ${key}`);
  if (v.length > max) throw new Bad(`${MSG.tooLong} (${key} ≤ ${max})`);
  return v;
}
function num(body, key, min, max, { required = false, int = false } = {}) {
  if (body[key] === undefined || body[key] === "" || body[key] === null) {
    if (required) throw new Bad(`${MSG.required}: ${key}`);
    return undefined;
  }
  const v = Number(body[key]);
  if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) throw new Bad(`${MSG.badValue} (${key})`);
  return v;
}
const bool = (body, key) => (body[key] === undefined ? undefined : body[key] === true || body[key] === "true");
function oneOf(body, key, list) {
  if (body[key] === undefined) return undefined;
  if (!list.includes(body[key])) throw new Bad(`${MSG.badValue} (${key})`);
  return body[key];
}
// every method key this shop can use: built-in + the shop's own (mart_payments)
const methodKeys = (s) => [...M.METHODS, ...(s.custom_methods || []).map((x) => x.key)];
const methodName = (s, key) => (s.custom_methods || []).find((x) => x.key === key)?.name || "";
const roundOf = (cur) => (v) => (cur === "KHR" ? Math.round(v) : Math.round(v * 100) / 100);

async function licenseState(businessId) {
  const rows = await License.find({ business_id: businessId, product: { $in: ["mart", ...ADDONS] } }).lean();
  const main = rows.find((r) => r.product === "mart");
  const license = statusOf(main);
  const endedAt = license.expires_at ? new Date(license.expires_at).getTime() : null;
  license.grace_until = endedAt ? new Date(endedAt + GRACE_DAYS * DAY) : null;
  // an old "mart" business from before (no license yet) must buy the year first
  license.locked = !main || (!license.active && endedAt !== null && Date.now() > endedAt + GRACE_DAYS * DAY);
  license.in_grace = !!main && !license.active && !license.locked;
  const addons = {};
  for (const key of ADDONS) addons[key] = statusOf(rows.find((r) => r.product === key && !r.item));
  const limits = { products: MAX.products, staff: addons.mart_staff.active ? 100 : FREE.staff, methods: addons.mart_payments.active ? 50 : FREE.methods, history_days: addons.mart_history.active ? null : FREE.history_days };
  return { license, addons, limits };
}

async function settingsOf(bid) {
  const found = await M.MartSettings.findOne({ business_id: bid });
  if (found) return found;
  try {
    return await M.MartSettings.create({ business_id: bid });
  } catch (err) {
    if (err.code === 11000) return M.MartSettings.findOne({ business_id: bid });
    throw err;
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});

module.exports = (prop) => {
  const base = "/api/user/businesses/:id/mart";
  const guard = [prop.api_auth, customer_auth];

  async function ctxOf(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    const [business, state] = await Promise.all([Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false }), licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== "mart") throw new Bad(MSG.notMart);
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (state.license.locked) throw new Bad(MSG.locked, 402, { product: "mart" });
    }
    const settings = await settingsOf(business._id);
    return { business, settings, ...state, role: "owner", by: req.customer?.name || "owner" };
  }
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
      if (err instanceof LicenseError) return res.status(err.status).json({ success: false, message: MSG[err.message] || err.message, code: err.message, ...err.extra });
      if (err?.code === 11000) {
        const barcode = JSON.stringify(err.keyPattern || err.keyValue || {}).includes("barcode");
        return res.status(409).json({ success: false, message: barcode ? MSG.barcodeTaken : MSG.nameTaken, code: barcode ? "barcode_taken" : "name_taken" });
      }
      if (err?.name === "ValidationError" || err?.name === "CastError") return res.status(400).json({ success: false, message: MSG.badValue });
      console.error("[mart]", err);
      res.status(500).json({ success: false, message: MSG.server });
    }
  };

  // the POS: a paired device (x-mart-device) + a cashier PIN session (x-mart-session)
  async function posCtx(req, write) {
    const raw = String(req.headers["x-mart-device"] || "");
    if (!raw) throw new Bad(MSG.posLogin, 401, { code: "no_device" });
    const device = await M.MartDevice.findOne({ token_hash: sha(raw), revoked: false });
    if (!device) throw new Bad(MSG.posLogin, 401, { code: "no_device" });
    let p;
    try {
      p = jwt.verify(String(req.headers["x-mart-session"] || ""), process.env.JWT_SECRET);
    } catch {
      throw new Bad(MSG.posLocked, 401, { code: "locked" });
    }
    if (p.type !== "mart_staff" || p.did !== String(device._id)) throw new Bad(MSG.posLocked, 401, { code: "locked" });
    const [staff, business, state] = await Promise.all([M.MartStaff.findOne({ _id: p.sid, business_id: device.business_id, active: true }).lean(), Business.findOne({ _id: device.business_id, deleted: false }), licenseState(device.business_id)]);
    if (!staff || (staff.pin_v || 0) !== (p.v || 0)) throw new Bad(MSG.posLocked, 401, { code: "locked" });
    if (!business || business.category !== "mart") throw new Bad(MSG.posLogin, 401, { code: "no_device" });
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (state.license.locked) throw new Bad(MSG.locked, 402, { product: "mart" });
    }
    if (Date.now() - new Date(device.last_seen || 0).getTime() > 60000) M.MartDevice.updateOne({ _id: device._id }, { $set: { last_seen: new Date() } }).catch(() => {});
    const settings = await settingsOf(business._id);
    return { business, settings, ...state, device, staff, role: staff.role, by: staff.name };
  }
  // one handler, two doors: the owner dashboard and the POS
  function dual(method, path, write, fn) {
    prop.app[method](
      `${base}${path}`,
      ...guard,
      handle(async (req, res) => fn(await ctxOf(req, write), req, res)),
    );
    prop.app[method](
      `/api/martpos${path}`,
      prop.api_auth,
      handle(async (req, res) => fn(await posCtx(req, write), req, res)),
    );
  }
  const managerOnly = (ctx) => {
    if (ctx.role === "cashier") throw new Bad(MSG.managerOnly, 403, { code: "manager_only" });
  };
  const withFile = (field) => (req, res, next) =>
    upload.single(field)(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? MSG.badImage : err.message });
      next();
    });
  const productCount = (bid) => M.MartProduct.countDocuments({ business_id: bid, active: true });
  // every product has a unit: a new shop starts with "Piece / ដុំ" (change or delete it, add your own)
  async function unitsOf(bid) {
    const list = () => M.MartUnit.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }).lean();
    let rows = await list();
    if (!rows.length) {
      // only one request makes the first unit (the dashboard loads several screens at once)
      const won = await M.MartSettings.findOneAndUpdate({ business_id: bid, units_seeded: { $ne: true } }, { $set: { units_seeded: true } });
      if (!won) for (let i = 0; i < 10 && !rows.length; i++) rows = await new Promise((r) => setTimeout(r, 100)).then(list);
      if (!rows.length) {
        const first = await M.MartUnit.create({ business_id: bid, name_en: "Piece", name_km: "ដុំ" });
        await M.MartProduct.updateMany({ business_id: bid, unit_id: null }, { $set: { unit_id: first._id } });
        rows = [first.toObject()];
      }
    }
    // the same unit made twice (from before): keep the first, move its products, remove the copy
    const seen = new Map();
    const copies = [];
    for (const u of rows) {
      const k = `${(u.name_en || "").trim().toLowerCase()}|${(u.name_km || "").trim()}`;
      if (seen.has(k)) copies.push([u, seen.get(k)]);
      else seen.set(k, u);
    }
    if (copies.length) {
      for (const [copy, keep] of copies) {
        await M.MartProduct.updateMany({ business_id: bid, unit_id: copy._id }, { $set: { unit_id: keep._id } });
        await M.MartUnit.deleteOne({ _id: copy._id });
      }
      rows = rows.filter((u) => !copies.some(([c]) => c._id === u._id));
    }
    return rows;
  }

  // ===================================== OVERVIEW =====================================
  prop.app.get(
    base,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const [categories, products, staff, renewPrice, prices, units, themePrice, siteThemePrice, portalThemePrice, posThemePrice, unread] = await Promise.all([
        M.MartCategory.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }).lean(),
        productCount(bid),
        M.MartStaff.countDocuments({ business_id: bid }),
        priceOf("mart"),
        Promise.all(ADDONS.map((k) => priceOf(k))),
        unitsOf(bid),
        priceOf("mart_print_theme"),
        priceOf("mart_site_theme"),
        priceOf("mart_portal_theme"),
        priceOf("mart_pos_theme"),
        M.MartMessage.countDocuments({ business_id: bid, read: false }),
      ]);
      res.json({
        success: true,
        data: {
          business: ctx.business,
          license: ctx.license,
          limits: ctx.limits,
          free: FREE,
          addons: {
            ...Object.fromEntries(ADDONS.map((k, i) => [k, { price: prices[i], ...ctx.addons[k] }])),
            mart_print_theme: { price: themePrice },
            mart_site_theme: { price: siteThemePrice },
            mart_portal_theme: { price: portalThemePrice },
            mart_pos_theme: { price: posThemePrice },
          },
          renew_price: renewPrice,
          settings: ctx.settings,
          categories,
          units,
          counts: { products, staff, unread },
          lists: { methods: M.FREE_METHODS, all_methods: M.METHODS },
        },
      });
    }),
  );

  prop.app.put(
    `${base}/settings`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      const s = ctx.settings;
      const cur = oneOf(b, "currency", ["USD", "KHR"]);
      if (cur) s.currency = cur;
      const rate = num(b, "khr_rate", 1000, 10000);
      if (rate !== undefined) s.khr_rate = rate;
      const kr = b.khr_round === undefined ? undefined : Number(b.khr_round);
      if (kr !== undefined) {
        if (![100, 500, 1000].includes(kr)) throw new Bad(`${MSG.badValue} (khr_round)`);
        s.khr_round = kr;
      }
      if (b.methods !== undefined) {
        const known = methodKeys(s);
        if (!Array.isArray(b.methods) || !b.methods.length || !b.methods.every((m) => known.includes(m))) throw new Bad(`${MSG.badValue} (methods)`);
        const list = [...new Set(b.methods)];
        // free: Cash, ABA, KHQR (a method an older shop already had stays allowed); the shop's own methods need mart_payments
        const paidOnly = list.filter((k) => !M.FREE_METHODS.includes(k) && !s.methods.includes(k));
        if (!ctx.addons.mart_payments?.active && (paidOnly.length || list.some((k) => M.CUSTOM_RE.test(k)) || list.length > ctx.limits.methods))
          throw new Bad(MSG.methodLimit, 402, { code: "method_limit", product: "mart_payments", limit: ctx.limits.methods });
        s.methods = list;
      }
      const note = text(b, "receipt_note", 300);
      if (note !== undefined) s.receipt_note = note;
      const qrLabel = text(b, "pay_qr_label", 60);
      if (qrLabel !== undefined) s.pay_qr_label = qrLabel;
      await s.save();
      res.json({ success: true, data: s, message: MSG.saved });
    }),
  );

  // ===================================== CATEGORIES =====================================
  const readCategory = (b, partial) => {
    const out = {};
    const name = text(b, "name", 60, { required: !partial });
    if (name !== undefined) out.name = name;
    if (b.color !== undefined) {
      if (b.color && !/^#[0-9A-Fa-f]{6}$/.test(String(b.color))) throw new Bad(`${MSG.badValue} (color)`);
      out.color = String(b.color || "").toUpperCase();
    }
    const sort = num(b, "sort", 0, 100000, { int: true });
    if (sort !== undefined) out.sort = sort;
    return out;
  };
  dual("get", "/categories", false, async (ctx, req, res) => {
    res.json({ success: true, data: await M.MartCategory.find({ business_id: ctx.business._id }).sort({ sort: 1, created_date: 1 }).lean() });
  });
  dual("post", "/categories", true, async (ctx, req, res) => {
    managerOnly(ctx);
    if ((await M.MartCategory.countDocuments({ business_id: ctx.business._id })) >= MAX.categories) throw new Bad(MSG.tooMany);
    const row = await M.MartCategory.create({ business_id: ctx.business._id, ...readCategory(req.body || {}, false) });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  dual("put", "/categories/:cid", true, async (ctx, req, res) => {
    managerOnly(ctx);
    if (!validId(req.params.cid)) throw new Bad(MSG.badId);
    const row = await M.MartCategory.findOneAndUpdate({ _id: req.params.cid, business_id: ctx.business._id }, { $set: readCategory(req.body || {}, true) }, { returnDocument: "after", runValidators: true });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, data: row, message: MSG.saved });
  });
  dual("delete", "/categories/:cid", true, async (ctx, req, res) => {
    managerOnly(ctx);
    if (!validId(req.params.cid)) throw new Bad(MSG.badId);
    const r = await M.MartCategory.deleteOne({ _id: req.params.cid, business_id: ctx.business._id });
    if (!r.deletedCount) throw new Bad(MSG.rowNotFound, 404);
    await M.MartProduct.updateMany({ business_id: ctx.business._id, category_id: req.params.cid }, { $set: { category_id: null } });
    res.json({ success: true, message: MSG.deleted });
  });

  // ===================================== UNITS (made by the shop, Khmer + English) =====================================
  const readUnit = (b, cur) => {
    const en = text(b, "name_en", 30);
    const km = text(b, "name_km", 30);
    const out = {};
    if (en !== undefined) out.name_en = en;
    if (km !== undefined) out.name_km = km;
    const sort = num(b, "sort", 0, 100000, { int: true });
    if (sort !== undefined) out.sort = sort;
    const nameEn = out.name_en ?? cur?.name_en ?? "";
    const nameKm = out.name_km ?? cur?.name_km ?? "";
    if (!nameEn && !nameKm) throw new Bad(MSG.needUnitName, 400, { code: "unit_name" });
    return out;
  };
  dual("get", "/units", false, async (ctx, req, res) => {
    res.json({ success: true, data: await unitsOf(ctx.business._id) });
  });
  dual("post", "/units", true, async (ctx, req, res) => {
    managerOnly(ctx);
    const bid = ctx.business._id;
    const n = (await unitsOf(bid)).length;
    if (n >= MAX.units) throw new Bad(MSG.tooMany);
    const row = await M.MartUnit.create({ business_id: bid, sort: n, ...readUnit(req.body || {}) });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  dual("put", "/units/:uid", true, async (ctx, req, res) => {
    managerOnly(ctx);
    if (!validId(req.params.uid)) throw new Bad(MSG.badId);
    const row = await M.MartUnit.findOne({ _id: req.params.uid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    row.set(readUnit(req.body || {}, row));
    await row.save();
    res.json({ success: true, data: row, message: MSG.saved });
  });
  dual("delete", "/units/:uid", true, async (ctx, req, res) => {
    managerOnly(ctx);
    const bid = ctx.business._id;
    if (!validId(req.params.uid)) throw new Bad(MSG.badId);
    if (await M.MartProduct.exists({ business_id: bid, unit_id: req.params.uid })) throw new Bad(MSG.unitInUse, 409, { code: "unit_in_use" });
    if ((await M.MartUnit.countDocuments({ business_id: bid })) <= 1) throw new Bad(MSG.lastUnit, 409, { code: "last_unit" });
    const r = await M.MartUnit.deleteOne({ _id: req.params.uid, business_id: bid });
    if (!r.deletedCount) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, message: MSG.deleted });
  });

  // ===================================== PRODUCTS =====================================
  const barcodeOf = (b) => {
    if (b.barcode === undefined) return undefined;
    const v = String(b.barcode ?? "").trim();
    if (v && !BARCODE_RE.test(v)) throw new Bad(MSG.badBarcode, 400, { code: "bad_barcode" });
    return v;
  };
  const readProduct = async (ctx, b, partial) => {
    const out = {};
    const name = text(b, "name", 120, { required: !partial });
    if (name !== undefined) out.name = name;
    const barcode = barcodeOf(b);
    if (barcode !== undefined) out.barcode = barcode;
    const price = num(b, "price", 0, 1000000000, { required: !partial });
    if (price !== undefined) out.price = roundOf(ctx.settings.currency)(price);
    const cost = num(b, "cost", 0, 1000000000);
    if (cost !== undefined) out.cost = cost;
    if (b.unit_id !== undefined) {
      if (!validId(b.unit_id) || !(await M.MartUnit.exists({ _id: b.unit_id, business_id: ctx.business._id }))) throw new Bad(MSG.badUnit, 400, { code: "bad_unit" });
      out.unit_id = b.unit_id;
    } else if (!partial) out.unit_id = (await unitsOf(ctx.business._id))[0]._id; // no unit chosen: the first one
    const track = bool(b, "track_stock");
    if (track !== undefined) out.track_stock = track;
    const low = num(b, "low_stock", 0, 1000000);
    if (low !== undefined) out.low_stock = low;
    if (b.category_id !== undefined) {
      if (b.category_id === null || b.category_id === "") out.category_id = null;
      else {
        if (!validId(b.category_id) || !(await M.MartCategory.exists({ _id: b.category_id, business_id: ctx.business._id }))) throw new Bad(`${MSG.badValue} (category_id)`);
        out.category_id = b.category_id;
      }
    }
    for (const k of ["fav", "active"]) {
      const v = bool(b, k);
      if (v !== undefined) out[k] = v;
    }
    // scale item code (mart_scale): digits only, unique in the shop
    if (b.plu !== undefined) {
      const plu = String(b.plu ?? "").trim();
      if (plu && !/^\d{1,6}$/.test(plu)) throw new Bad(`${MSG.badValue} (plu)`, 400, { code: "bad_plu" });
      out.plu = plu;
    }
    if (b.supplier_id !== undefined) {
      if (!b.supplier_id) out.supplier_id = null;
      else {
        if (!validId(b.supplier_id) || !(await M.MartSupplier.exists({ _id: b.supplier_id, business_id: ctx.business._id }))) throw new Bad(`${MSG.badValue} (supplier_id)`);
        out.supplier_id = b.supplier_id;
      }
    }
    const rq = num(b, "reorder_qty", 0, 1000000);
    if (rq !== undefined) out.reorder_qty = rq;
    return out;
  };
  dual("get", "/products", false, async (ctx, req, res) => {
    const rows = await M.MartProduct.find({ business_id: ctx.business._id }).sort({ fav: -1, sort: 1, name: 1 }).limit(MAX.products).lean();
    res.json({ success: true, data: rows, limit: ctx.limits.products });
  });
  dual("post", "/products", true, async (ctx, req, res) => {
    managerOnly(ctx);
    const set = await readProduct(ctx, req.body || {}, false);
    if (set.active !== false && (await productCount(ctx.business._id)) >= ctx.limits.products) throw new Bad(MSG.productLimit, 402, { code: "product_limit", limit: ctx.limits.products });
    // stock control: the stock you have now (a first "in" in the history)
    const start = ctx.addons.mart_stock?.active ? num(req.body || {}, "stock", -1000000, 1000000) : undefined;
    const row = await M.MartProduct.create({ business_id: ctx.business._id, ...set, ...(start ? { stock: start } : {}) });
    if (start) await M.MartStockMove.create({ business_id: ctx.business._id, product_id: row._id, kind: "in", qty: start, stock_after: start, cost: row.cost || 0, note: "start", by: ctx.by });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  const loadProduct = async (ctx, pid) => {
    if (!validId(pid)) throw new Bad(MSG.badId);
    const row = await M.MartProduct.findOne({ _id: pid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  dual("put", "/products/:pid", true, async (ctx, req, res) => {
    managerOnly(ctx);
    const row = await loadProduct(ctx, req.params.pid);
    const set = await readProduct(ctx, req.body || {}, true);
    if (set.active === true && !row.active && (await productCount(ctx.business._id)) >= ctx.limits.products) throw new Bad(MSG.productLimit, 402, { code: "product_limit", limit: ctx.limits.products });
    // stock control: the stock can be set here too — saved as a count in the history
    const b = req.body || {};
    const newStock = ctx.addons.mart_stock?.active && b.stock !== undefined && b.stock !== "" ? Math.round(num(b, "stock", -1000000, 1000000) * 1000) / 1000 : undefined;
    const diff = newStock === undefined ? 0 : Math.round((newStock - (row.stock || 0)) * 1000) / 1000;
    if (diff !== 0) row.stock = newStock;
    row.set(set);
    await row.save();
    if (diff !== 0) await M.MartStockMove.create({ business_id: ctx.business._id, product_id: row._id, kind: "adjust", qty: diff, stock_after: newStock, note: text(b, "stock_note", 200) || "", by: ctx.by });
    res.json({ success: true, data: row, message: MSG.saved });
  });
  dual("delete", "/products/:pid", true, async (ctx, req, res) => {
    managerOnly(ctx);
    const row = await loadProduct(ctx, req.params.pid);
    await row.deleteOne();
    if (row.photo?.public_id) deleteFile(row.photo.public_id).catch(() => {});
    res.json({ success: true, message: MSG.deleted });
  });

  // many products at once (the dashboard reads the Excel / CSV file and sends rows):
  // { rows: [{ name, barcode, price, cost, unit, category }] } — a row whose barcode is already there updates that product
  prop.app.post(
    `${base}/products/import`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const bid = ctx.business._id;
      const rows = req.body?.rows;
      if (!Array.isArray(rows) || !rows.length) throw new Bad(`${MSG.required}: rows`);
      if (rows.length > MAX.import) throw new Bad(`${MSG.tooMany} (≤ ${MAX.import})`);
      const cats = await M.MartCategory.find({ business_id: bid }).lean();
      const catId = new Map(cats.map((c) => [c.name.toLowerCase(), c._id]));
      const units = await unitsOf(bid);
      let count = await productCount(bid);
      const out = { added: 0, updated: 0, skipped: 0, errors: [] };
      const seen = new Set();
      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i] || {};
        try {
          const b = { name: raw.name, price: raw.price, barcode: raw.barcode ?? "", cost: raw.cost === "" ? undefined : raw.cost };
          // the unit by its Khmer or English name; a new name makes a new unit
          const unitName = String(raw.unit || "")
            .trim()
            .slice(0, 30);
          if (unitName) {
            let u = units.find((x) => x.name_en.toLowerCase() === unitName.toLowerCase() || x.name_km === unitName);
            if (!u && units.length < MAX.units) {
              const khmer = /[\u1780-\u17FF]/.test(unitName);
              u = (await M.MartUnit.create({ business_id: bid, name_en: khmer ? "" : unitName, name_km: khmer ? unitName : "", sort: units.length })).toObject();
              units.push(u);
            }
            if (u) b.unit_id = String(u._id);
          }
          const set = await readProduct(ctx, b, false);
          if (set.barcode && seen.has(set.barcode)) throw new Bad(MSG.barcodeTaken);
          if (set.barcode) seen.add(set.barcode);
          const catName = String(raw.category || "")
            .trim()
            .slice(0, 60);
          if (catName) {
            let id = catId.get(catName.toLowerCase());
            if (!id && catId.size < MAX.categories) {
              id = (await M.MartCategory.create({ business_id: bid, name: catName, sort: catId.size }))._id;
              catId.set(catName.toLowerCase(), id);
            }
            if (id) set.category_id = id;
          }
          const existing = set.barcode ? await M.MartProduct.findOne({ business_id: bid, barcode: set.barcode }) : null;
          if (existing) {
            if (!raw.unit) delete set.unit_id; // keep its unit
            existing.set(set);
            await existing.save();
            out.updated += 1;
          } else {
            if (count >= ctx.limits.products) {
              out.skipped += 1;
              continue;
            }
            await M.MartProduct.create({ business_id: bid, ...set });
            count += 1;
            out.added += 1;
          }
        } catch (err) {
          if (out.errors.length < 50) out.errors.push({ row: i + 1, message: err instanceof Bad ? err.message : err?.code === 11000 ? MSG.barcodeTaken : MSG.badValue });
        }
      }
      res.json({ success: true, data: { ...out, limit: ctx.limits.products }, message: MSG.saved });
    }),
  );

  // make an in-store barcode (EAN-13 starting with 2) for a product without one — needs "Barcode labels"
  const ean13check = (d12) => {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 ? 3 : 1);
    return String((10 - (sum % 10)) % 10);
  };
  dual("post", "/products/:pid/barcode", true, async (ctx, req, res) => {
    if (!ctx.addons.mart_labels?.active) throw new Bad(MSG.needLabels, 402, { product: "mart_labels" });
    managerOnly(ctx);
    const row = await loadProduct(ctx, req.params.pid);
    if (row.barcode) throw new Bad(MSG.hasBarcode, 409, { code: "has_barcode" });
    for (let tries = 0; tries < 20; tries++) {
      const d12 = `2${String(crypto.randomInt(0, 1e11)).padStart(11, "0")}`;
      const code = d12 + ean13check(d12);
      if (await M.MartProduct.exists({ business_id: ctx.business._id, barcode: code })) continue;
      row.barcode = code;
      try {
        await row.save();
        return res.json({ success: true, data: row, message: MSG.saved });
      } catch (err) {
        if (err.code !== 11000) throw err;
        row.barcode = "";
      }
    }
    throw new Bad(MSG.server, 500);
  });

  // product photo (owner + POS manager)
  const photoUp = async (ctx, req, res) => {
    managerOnly(ctx);
    const row = await loadProduct(ctx, req.params.pid);
    if (!req.file) throw new Bad(MSG.noFile);
    const saved = await uploadBuffer(req.file, "mart");
    const old = row.photo?.public_id;
    row.photo = { url: saved.url, public_id: saved.public_id || "" };
    await row.save();
    if (old) deleteFile(old).catch(() => {});
    res.json({ success: true, data: row, message: MSG.saved });
  };
  prop.app.post(
    `${base}/products/:pid/photo`,
    ...guard,
    withFile("photo"),
    handle(async (req, res) => photoUp(await ctxOf(req, true), req, res)),
  );
  prop.app.post(
    "/api/martpos/products/:pid/photo",
    prop.api_auth,
    withFile("photo"),
    handle(async (req, res) => photoUp(await posCtx(req, true), req, res)),
  );
  dual("delete", "/products/:pid/photo", true, async (ctx, req, res) => {
    managerOnly(ctx);
    const row = await loadProduct(ctx, req.params.pid);
    const old = row.photo?.public_id;
    row.photo = { url: "", public_id: "" };
    await row.save();
    if (old) deleteFile(old).catch(() => {});
    res.json({ success: true, data: row, message: MSG.deleted });
  });

  // owner only (the dashboard)
  function own(method, path, write, fn) {
    prop.app[method](
      `${base}${path}`,
      ...guard,
      handle(async (req, res) => fn(await ctxOf(req, write), req, res)),
    );
  }
  const phoneKey = (v) => {
    let d = String(v || "").replace(/[^\d+]/g, "");
    if (d.startsWith("+855")) d = `0${d.slice(4)}`;
    else if (d.startsWith("855") && d.length >= 11) d = `0${d.slice(3)}`;
    return d.replace(/\+/g, "");
  };
  const phoneOk = (v) => /^\d{8,15}$/.test(v);
  const kit = {
    base,
    guard,
    handle,
    ctxOf,
    posCtx,
    dual,
    own,
    managerOnly,
    withFile,
    Bad,
    MSG,
    text,
    num,
    bool,
    oneOf,
    validId,
    localDay,
    roundOf,
    sha,
    jwt,
    licenseState,
    settingsOf,
    productCount,
    unitsOf,
    methodKeys,
    methodName,
    phoneKey,
    phoneOk,
    M,
    Business,
  };
  kit.tg = require("./mart.telegram")(prop, kit); // Telegram alerts (mart_telegram): website orders, shift closed, low stock, messages
  kit.stock = require("./mart.stock")(prop, kit); // stock control (mart_stock): stock list, receive, count, history; sales take stock
  kit.debt = require("./mart.debt")(prop, kit); // debt book (mart_debt): debtors, repayments; "debt" sales write here
  require("./mart.suppliers")(prop, kit); // suppliers (mart_suppliers): who you buy from, their deliveries
  require("./mart.shifts")(prop, kit); // shifts & cash drawer (mart_shifts): open / cash in-out / count / close
  kit.site = require("./mart.site")(prop, kit); // the shop website (mart_website): /m/<slug>, looks, show / hide parts
  require("./mart.shop")(prop, kit); // online orders + customer accounts (mart_shop)
  kit.methods = require("./mart.methods")(prop, kit); // payment methods the shop makes (mart_payments) + POS looks (mart_pos_theme)
  require("./mart.pos")(prop, kit); // cashiers, devices, pairing, PIN login, boot / sync, payment QR, logo, profile, printing + receipt templates
  kit.range = require("./mart.sales")(prop, kit); // sales (offline-safe), void, reports
  kit.expiry = require("./mart.expiry")(prop, kit); // expiry dates (mart_expiry): batches, near-expiry, sell first, waste
  kit.loyalty = require("./mart.loyalty")(prop, kit); // loyalty points (mart_loyalty): members by phone, earn + redeem (POS + website)
  kit.promos = require("./mart.promos")(prop, kit); // promotions (mart_promos): buy X get Y, % off, happy hour, coupons
  require("./mart.profit")(prop, kit); // profit report (mart_profit): cost vs price, margins
  require("./mart.purchase")(prop, kit); // reorder list + purchase orders (mart_purchase)
  kit.delivery = require("./mart.delivery")(prop, kit); // delivery zones + drivers (mart_delivery)
  require("./mart.branches")(prop, kit); // several shops (mart_branches): transfers, stock everywhere, combined report
  kit.scale = require("./mart.scale")(prop, kit); // weighing-scale barcodes (mart_scale) + customer screen (mart_display) settings
};
module.exports.licenseState = licenseState;
