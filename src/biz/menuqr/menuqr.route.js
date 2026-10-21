// Menu QR (yearly license "menu_qr", 50 coins): a menu to look at behind a QR code — no orders, no sales.
// Owner base: /api/user/businesses/:id/menuqr
//   GET  /                                  everything the dashboard needs
//   POST /link/refresh                      a new random link (old QR codes stop working)
//   PUT  /settings                          name line, contact, hours, currency, language, look, QR card text…
//   POST/DELETE /logo  /cover               { media_id } (or multipart "photo" → into the media library)
//   GET/POST /media  DELETE /media/:mid  POST /media/slots { n }   media library: 35 free, 1 coin per extra picture (menuqr.media.js)
//   GET  /categories  POST  PUT/DELETE /:cid   PUT /categories-order { ids }      5 free (mq_categories = no limit)
//   GET  /items       POST  PUT/DELETE /:iid   PUT /items-order { ids }           20 free (mq_items = no limit)
//   POST /items/:iid/photos { media_id } (or a file, up to 5)   DELETE /items/:iid/photos/:pid   PUT /items/:iid/photos-order { ids }
//   GET  /promos  POST  PUT/DELETE /:pid    (mq_promos) — and the sale price on items
//   GET  /feedback?page   PUT /feedback/:fid { read }   PUT /feedback-read-all   DELETE /feedback/:fid   (mq_feedback)
//   GET  /stats?days=30                      (mq_stats)
//   POST /themes/:key     buy a look (20 basic / 35 pro, forever) and use it
//   POST /qr-styles/:key  buy a QR style (10, forever) and use it
// Public (the page after the scan, /q/<slug>):
//   GET  /api/public/q/:slug          POST /api/public/q/:slug/hit { item_id? }      POST /api/public/q/:slug/feedback { stars, text, name, phone }
const mongoose = require("mongoose");
const crypto = require("crypto");
const multer = require("multer");
const M = require("./menuqr.models");
const { THEMES, THEME_PRODUCT, QR_STYLES, FREE_THEME, FREE_QR } = require("./menuqr.themes");
const Business = require("../business.model");
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const { statusOf, buy, LicenseError, DAY } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");

const GRACE_DAYS = 7;
const FREE = { categories: 5, items: 20 };
const MAX = { categories: 200, items: 3000, photos: 5, promos: 60 };
const ADDONS = ["mq_categories", "mq_items", "mq_promos", "mq_feedback", "mq_stats"];
const ITEM_PRODUCTS = ["mq_theme", "mq_theme_pro", "mq_qr_style"];
const TZ = 7;
const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  notMenu: "អាជីវកម្មនេះមិនមែនជាម៉ឺនុយ QR ទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  locked: "ម៉ឺនុយ QR ផុតកំណត់ហើយ! សូមបន្តដើម្បីប្រើប្រាស់។",
  rowNotFound: "រកមិនឃើញទិន្នន័យ!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
  required: "សូមបំពេញ",
  tooLong: "អត្ថបទវែងពេក!",
  badValue: "តម្លៃមិនត្រឹមត្រូវ!",
  tooMany: "ច្រើនពេក!",
  catLimit: "ប្រភេទឥតគិតថ្លៃមានតែ 5។ សូមដោះសោ “ប្រភេទគ្មានកំណត់”។",
  itemLimit: "មុខម្ហូបឥតគិតថ្លៃមានតែ 20។ សូមដោះសោ “មុខម្ហូបគ្មានកំណត់”។",
  photoLimit: "រូបភាពច្រើនបំផុត 5 ក្នុងមួយមុខ!",
  needPromos: "សូមដោះសោ “តម្លៃពិសេស និងប្រូម៉ូសិន” ជាមុនសិន!",
  needFeedback: "សូមដោះសោ “មតិអតិថិជន” ជាមុនសិន!",
  needStats: "សូមដោះសោ “ស្ថិតិការស្កេន” ជាមុនសិន!",
  notOwned: "សូមទិញម៉ូដនេះជាមុនសិន!",
  badImage: "សូមដាក់រូបភាព JPG / PNG / WEBP (តិចជាង 4MB)!",
  noFile: "សូមជ្រើសរើសរូបភាព!",
  slugTaken: "តំណនេះមានគេប្រើហើយ!",
  badSlug: "តំណប្រើបានតែអក្សរ a-z លេខ និង - (3 ទៅ 40)!",
  menuOff: "ម៉ឺនុយនេះមិនទាន់បើក ឬត្រូវបានផ្អាក។",
  thanks: "អរគុណសម្រាប់មតិរបស់អ្នក!",
  slow: "សូមរង់ចាំបន្តិច រួចព្យាយាមម្តងទៀត។",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  already: "បានទិញរួចហើយ!",
  busy: "កំពុងដំណើរការ សូមព្យាយាមម្តងទៀត!",
};
class Bad extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const validId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && String(v).length === 24;
function text(b, key, max, { required = false } = {}) {
  if (b[key] === undefined) {
    if (required) throw new Bad(`${MSG.required}: ${key}`);
    return undefined;
  }
  const v = String(b[key] ?? "").trim();
  if (required && !v) throw new Bad(`${MSG.required}: ${key}`);
  if (v.length > max) throw new Bad(`${MSG.tooLong} (${key} ≤ ${max})`);
  return v;
}
function num(b, key, min, max, { nullable = false } = {}) {
  if (b[key] === undefined) return undefined;
  if (nullable && (b[key] === null || b[key] === "")) return null;
  const v = Number(b[key]);
  if (!Number.isFinite(v) || v < min || v > max) throw new Bad(`${MSG.badValue} (${key})`);
  return v;
}
const bool = (b, key) => (b[key] === undefined ? undefined : b[key] === true || b[key] === "true");
const oneOf = (b, key, list) => {
  if (b[key] === undefined) return undefined;
  if (!list.includes(b[key])) throw new Bad(`${MSG.badValue} (${key})`);
  return b[key];
};
const color = (b, key, allowEmpty) => {
  if (b[key] === undefined) return undefined;
  const v = String(b[key] || "");
  if (allowEmpty && !v) return "";
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new Bad(`${MSG.badValue} (${key})`);
  return v;
};
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const localDay = (d = new Date()) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 10);
const localHour = (d = new Date()) => new Date(new Date(d).getTime() + TZ * 3600000).getUTCHours();
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const roundOf = (cur) => (v) => (cur === "KHR" ? Math.round(v / 100) * 100 : Math.round(v * 100) / 100);

async function licenseState(businessId) {
  const rows = await License.find({ business_id: businessId, product: { $in: ["menu_qr", ...ADDONS, ...ITEM_PRODUCTS] } }).lean();
  const main = rows.find((r) => r.product === "menu_qr");
  const license = statusOf(main);
  const endedAt = license.expires_at ? new Date(license.expires_at).getTime() : null;
  license.grace_until = endedAt ? new Date(endedAt + GRACE_DAYS * DAY) : null;
  license.locked = !main || (!license.active && endedAt !== null && Date.now() > endedAt + GRACE_DAYS * DAY);
  license.in_grace = !!main && !license.active && !license.locked;
  const addons = {};
  for (const key of ADDONS) addons[key] = statusOf(rows.find((r) => r.product === key && !r.item));
  const themes = [FREE_THEME, ...rows.filter((r) => (r.product === "mq_theme" || r.product === "mq_theme_pro") && r.item && statusOf(r).active).map((r) => r.item)];
  const qrStyles = [FREE_QR, ...rows.filter((r) => r.product === "mq_qr_style" && r.item && statusOf(r).active).map((r) => r.item)];
  const limits = { categories: addons.mq_categories.active ? MAX.categories : FREE.categories, items: addons.mq_items.active ? MAX.items : FREE.items, photos: MAX.photos };
  return { license, addons, themes, qrStyles, limits };
}

// a link name from the business name ("Sokha Coffee" → sokha-coffee), unique
const slugBase = (name) =>
  String(name || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
async function freeSlug(name) {
  const base =
    String(name || "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "menu";
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 && base.length >= 3 ? base : `${base}-${crypto.randomBytes(2).toString("hex")}`;
    if (!(await M.MqSettings.exists({ slug }))) return slug;
  }
  return `menu-${crypto.randomBytes(5).toString("hex")}`;
}
async function settingsOf(business) {
  const found = await M.MqSettings.findOne({ business_id: business._id });
  if (found) return found;
  try {
    return await M.MqSettings.create({ business_id: business._id, slug: await freeSlug(business.name) });
  } catch (err) {
    if (err.code === 11000) {
      const again = await M.MqSettings.findOne({ business_id: business._id });
      if (again) return again;
      return M.MqSettings.create({ business_id: business._id, slug: `menu-${crypto.randomBytes(5).toString("hex")}` });
    }
    throw err;
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});

// promotions running now (Cambodia time)
function liveNow(promos, now = new Date()) {
  const day = localDay(now);
  const shifted = new Date(now.getTime() + TZ * 3600000);
  const dow = shifted.getUTCDay();
  const hm = shifted.toISOString().slice(11, 16);
  return promos.filter((p) => {
    if (!p.active) return false;
    if (p.start_date && day < p.start_date) return false;
    if (p.end_date && day > p.end_date) return false;
    if (p.days?.length && !p.days.includes(dow)) return false;
    if (p.from && p.to) {
      if (p.from <= p.to ? hm < p.from || hm >= p.to : hm < p.from && hm >= p.to) return false;
    }
    return true;
  });
}
// the categories an item shows in (old items: just category_id)
const catsOf = (i) => (i.category_ids?.length ? i.category_ids : [i.category_id]).map(String);
// the best price for one item: its sale price, or a running promotion (whichever is lower)
function priceNow(item, promos, cur) {
  const r = roundOf(cur);
  let best = item.sale_price !== null && item.sale_price !== undefined && item.sale_price < item.price ? item.sale_price : null;
  let promo = null;
  for (const p of promos) {
    if (p.kind === "banner") continue;
    const covers = p.all_items || (p.item_ids || []).some((x) => String(x) === String(item._id)) || (p.category_ids || []).some((x) => catsOf(item).includes(String(x)));
    if (!covers) continue;
    const v = p.kind === "percent" ? r(item.price * (1 - Math.min(100, p.value) / 100)) : Math.max(0, r(item.price - p.value));
    if (v < item.price && (best === null || v < best)) {
      best = v;
      promo = p;
    }
  }
  return { now: best, promo_id: promo ? String(promo._id) : null };
}

module.exports = (prop) => {
  const base = "/api/user/businesses/:id/menuqr";
  const guard = [prop.api_auth, customer_auth];

  async function ctxOf(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    const [business, state] = await Promise.all([Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false }), licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== "menu_qr") throw new Bad(MSG.notMenu);
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (state.license.locked) throw new Bad(MSG.locked, 402, { product: "menu_qr" });
    }
    const settings = await settingsOf(business);
    return { business, settings, ...state };
  }
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
      if (err instanceof LicenseError) return res.status(err.status).json({ success: false, message: MSG[err.message] || err.message, code: err.message, ...err.extra });
      if (err?.code === 11000) return res.status(409).json({ success: false, message: MSG.slugTaken, code: "slug_taken" });
      if (err?.name === "ValidationError" || err?.name === "CastError") return res.status(400).json({ success: false, message: MSG.badValue });
      console.error("[menuqr]", err);
      res.status(500).json({ success: false, message: MSG.server });
    }
  };
  const own = (method, path, write, fn, mw = []) =>
    prop.app[method](
      `${base}${path}`,
      ...guard,
      ...mw,
      handle(async (req, res) => fn(await ctxOf(req, write), req, res)),
    );
  const withFile = (req, res, next) =>
    upload.single("photo")(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? MSG.badImage : err.message });
      next();
    });
  const need = (ctx, key, msg) => {
    if (!ctx.addons[key]?.active) throw new Bad(msg, 402, { product: key });
  };
  // the media library (35 free pictures, more bought per picture) — every picture field links to it
  const media = require("./menuqr.media")({ own, Bad, MSG, validId });

  // ---------------------------------------- overview ----------------------------------------
  async function overview(ctx) {
    const bid = ctx.business._id;
    const keys = [...ADDONS, "menu_qr", "mq_theme", "mq_theme_pro", "mq_qr_style"];
    const [prices, cats, items, unread, promos, room, slotPrice] = await Promise.all([
      Promise.all(keys.map((k) => priceOf(k))),
      M.MqCategory.countDocuments({ business_id: bid }),
      M.MqItem.countDocuments({ business_id: bid }),
      M.MqFeedback.countDocuments({ business_id: bid, read: false }),
      M.MqPromo.countDocuments({ business_id: bid }),
      media.room(ctx),
      priceOf("mq_media_slot"),
    ]);
    const price = Object.fromEntries(keys.map((k, i) => [k, prices[i]]));
    return {
      business: { _id: ctx.business._id, name: ctx.business.name, status: ctx.business.status },
      settings: ctx.settings,
      license: ctx.license,
      addons: Object.fromEntries(ADDONS.map((k) => [k, { ...ctx.addons[k], price: price[k] }])),
      limits: ctx.limits,
      counts: { categories: cats, items, feedback_unread: unread, promos },
      media: { ...room, slot_price: slotPrice },
      themes: { owned: ctx.themes, price: { basic: price.mq_theme, pro: price.mq_theme_pro } },
      qr: { owned: ctx.qrStyles, price: price.mq_qr_style },
      renew_price: price.menu_qr,
    };
  }
  own("get", "", false, async (ctx, req, res) => res.json({ success: true, data: await overview(ctx) }));

  own("put", "/settings", true, async (ctx, req, res) => {
    const b = req.body || {};
    const s = ctx.settings;
    if (b.slug !== undefined) {
      const slug = String(b.slug || "")
        .trim()
        .toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/.test(slug)) throw new Bad(MSG.badSlug, 400, { code: "bad_slug" });
      if (slug !== s.slug && (await M.MqSettings.exists({ slug }))) throw new Bad(MSG.slugTaken, 409, { code: "slug_taken" });
      s.slug = slug;
    }
    Object.assign(
      s,
      clean({
        tagline: text(b, "tagline", 120),
        about: text(b, "about", 600),
        hours: text(b, "hours", 160),
        currency: oneOf(b, "currency", ["USD", "KHR"]),
        khr_rate: num(b, "khr_rate", 1000, 10000),
        show_both: bool(b, "show_both"),
        lang: oneOf(b, "lang", ["km", "en"]),
        color: color(b, "color", true),
        feedback_on: bool(b, "feedback_on"),
      }),
    );
    if (b.contact && typeof b.contact === "object") {
      const c = b.contact;
      const lim = { phone: 30, phone2: 30, telegram: 120, facebook: 200, instagram: 200, tiktok: 200, website: 200, email: 120, address: 300, map_url: 400, wifi_name: 60, wifi_pass: 60 };
      for (const [k, max] of Object.entries(lim)) {
        const v = text(c, k, max);
        if (v !== undefined) s.contact[k] = v;
      }
    }
    if (b.theme !== undefined) {
      if (!THEMES[b.theme]) throw new Bad(MSG.badValue);
      if (!ctx.themes.includes(b.theme)) throw new Bad(MSG.notOwned, 402, { code: "not_owned", product: THEME_PRODUCT[THEMES[b.theme]], item: b.theme });
      s.theme = b.theme;
    }
    if (b.qr && typeof b.qr === "object") {
      const q = b.qr;
      if (q.style !== undefined) {
        if (!QR_STYLES.includes(q.style)) throw new Bad(MSG.badValue);
        if (!ctx.qrStyles.includes(q.style)) throw new Bad(MSG.notOwned, 402, { code: "not_owned", product: "mq_qr_style", item: q.style });
        s.qr.style = q.style;
      }
      Object.assign(s.qr, clean({ color: color(q, "color"), bg: color(q, "bg"), accent: color(q, "accent"), header: text(q, "header", 60), footer: text(q, "footer", 80), info: text(q, "info", 120), logo: bool(q, "logo") }));
    }
    await s.save();
    res.json({ success: true, data: s, message: MSG.saved });
  });

  // a new link for the menu (the old QR codes stop working) — the dashboard asks before calling this
  own("post", "/link/refresh", true, async (ctx, req, res) => {
    const old = ctx.settings.slug;
    const base = slugBase(ctx.business.name) || "menu";
    let slug = "";
    for (let i = 0; i < 20 && !slug; i++) {
      const next = `${base}-${crypto.randomBytes(3).toString("hex")}`;
      if (next !== old && !(await M.MqSettings.exists({ slug: next }))) slug = next;
    }
    if (!slug) throw new Bad(MSG.server, 500);
    ctx.settings.slug = slug;
    await ctx.settings.save();
    res.json({ success: true, data: ctx.settings, old, message: MSG.saved });
  });

  for (const field of ["logo", "cover"]) {
    own(
      "post",
      `/${field}`,
      true,
      async (ctx, req, res) => {
        ctx.settings[field] = await media.pictureFrom(ctx, req); // a library picture (or a file, which goes into the library)
        await ctx.settings.save();
        require("../dashboard.route").forget(ctx.business.owner_id); // the home screen shows the new logo at once
        res.json({ success: true, data: ctx.settings, message: MSG.saved });
      },
      [withFile],
    );
    own("delete", `/${field}`, true, async (ctx, req, res) => {
      ctx.settings[field] = { url: "", public_id: "", media_id: null }; // the picture stays in the library
      await ctx.settings.save();
      require("../dashboard.route").forget(ctx.business.owner_id);
      res.json({ success: true, data: ctx.settings, message: MSG.deleted });
    });
  }

  // ---------------------------------------- categories ----------------------------------------
  const readCat = (b, partial) => {
    const set = clean({ name_km: text(b, "name_km", 60), name_en: text(b, "name_en", 60), icon: text(b, "icon", 8), active: bool(b, "active") });
    if (!partial && !set.name_km && !set.name_en) throw new Bad(`${MSG.required}: name`);
    return set;
  };
  own("get", "/categories", false, async (ctx, req, res) => res.json({ success: true, data: await M.MqCategory.find({ business_id: ctx.business._id }).sort({ sort: 1, created_date: 1 }).lean() }));
  own("post", "/categories", true, async (ctx, req, res) => {
    const n = await M.MqCategory.countDocuments({ business_id: ctx.business._id });
    if (n >= ctx.limits.categories) throw new Bad(ctx.addons.mq_categories.active ? MSG.tooMany : MSG.catLimit, ctx.addons.mq_categories.active ? 400 : 402, { code: "category_limit", product: "mq_categories", limit: ctx.limits.categories });
    const row = await M.MqCategory.create({ business_id: ctx.business._id, ...readCat(req.body || {}), sort: n });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  own("put", "/categories-order", true, async (ctx, req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(validId).slice(0, MAX.categories);
    await Promise.all(ids.map((id, i) => M.MqCategory.updateOne({ _id: id, business_id: ctx.business._id }, { $set: { sort: i } })));
    res.json({ success: true, message: MSG.saved });
  });
  own("put", "/categories/:cid", true, async (ctx, req, res) => {
    if (!validId(req.params.cid)) throw new Bad(MSG.badId);
    const row = await M.MqCategory.findOneAndUpdate({ _id: req.params.cid, business_id: ctx.business._id }, { $set: readCat(req.body || {}, true) }, { returnDocument: "after" });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, data: row, message: MSG.saved });
  });
  own("delete", "/categories/:cid", true, async (ctx, req, res) => {
    if (!validId(req.params.cid)) throw new Bad(MSG.badId);
    const row = await M.MqCategory.findOneAndDelete({ _id: req.params.cid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    // items only in this category go with it; items also in other categories just leave it (pictures stay in the library)
    const bid = ctx.business._id;
    const list = await M.MqItem.find({ business_id: bid, $or: [{ category_id: row._id }, { category_ids: row._id }] }).select("category_id category_ids");
    let gone = 0;
    for (const it of list) {
      const rest = catsOf(it).filter((x) => x !== String(row._id));
      if (!rest.length) {
        await it.deleteOne();
        gone += 1;
      } else {
        it.category_ids = rest;
        it.category_id = rest[0];
        await it.save();
      }
    }
    res.json({ success: true, data: { items: gone, moved: list.length - gone }, message: MSG.deleted });
  });

  // ---------------------------------------- items ----------------------------------------
  async function readItem(ctx, b, partial) {
    const set = clean({
      name_km: text(b, "name_km", 80),
      name_en: text(b, "name_en", 80),
      desc_km: text(b, "desc_km", 400),
      desc_en: text(b, "desc_en", 400),
      price: num(b, "price", 0, 100000000),
      sale_price: num(b, "sale_price", 0, 100000000, { nullable: true }),
      available: bool(b, "available"),
      active: bool(b, "active"),
    });
    // several categories: category_ids (the first one is the main one); or just category_id
    let cats = b.category_ids !== undefined ? b.category_ids : b.category_id !== undefined ? [b.category_id] : undefined;
    if (cats !== undefined) {
      if (!Array.isArray(cats)) throw new Bad(`${MSG.badValue} (category)`);
      cats = [...new Set(cats.map(String))];
      if (!cats.length || cats.length > 30 || !cats.every(validId) || (await M.MqCategory.countDocuments({ _id: { $in: cats }, business_id: ctx.business._id })) !== cats.length) throw new Bad(`${MSG.badValue} (category)`);
      set.category_ids = cats;
      set.category_id = cats[0];
    }
    if (b.tags !== undefined) {
      if (!Array.isArray(b.tags) || b.tags.some((t) => !M.TAGS.includes(t))) throw new Bad(`${MSG.badValue} (tags)`);
      set.tags = [...new Set(b.tags)];
    }
    if (set.sale_price !== undefined && set.sale_price !== null) need(ctx, "mq_promos", MSG.needPromos);
    if (!partial) {
      if (!set.name_km && !set.name_en) throw new Bad(`${MSG.required}: name`);
      if (!set.category_id) throw new Bad(`${MSG.required}: category`);
    }
    return set;
  }
  const loadItem = async (ctx, iid) => {
    if (!validId(iid)) throw new Bad(MSG.badId);
    const row = await M.MqItem.findOne({ _id: iid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  own("get", "/items", false, async (ctx, req, res) => res.json({ success: true, data: await M.MqItem.find({ business_id: ctx.business._id }).sort({ sort: 1, created_date: 1 }).lean(), limit: ctx.limits.items }));
  own("post", "/items", true, async (ctx, req, res) => {
    const n = await M.MqItem.countDocuments({ business_id: ctx.business._id });
    if (n >= ctx.limits.items) throw new Bad(ctx.addons.mq_items.active ? MSG.tooMany : MSG.itemLimit, ctx.addons.mq_items.active ? 400 : 402, { code: "item_limit", product: "mq_items", limit: ctx.limits.items });
    const set = await readItem(ctx, req.body || {});
    const row = await M.MqItem.create({ business_id: ctx.business._id, ...set, sort: n });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  own("put", "/items-order", true, async (ctx, req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(validId).slice(0, MAX.items);
    await M.MqItem.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id, business_id: ctx.business._id }, update: { $set: { sort: i } } } })));
    res.json({ success: true, message: MSG.saved });
  });
  own("put", "/items/:iid", true, async (ctx, req, res) => {
    const row = await loadItem(ctx, req.params.iid);
    Object.assign(row, await readItem(ctx, req.body || {}, true));
    await row.save();
    res.json({ success: true, data: row, message: MSG.saved });
  });
  own("delete", "/items/:iid", true, async (ctx, req, res) => {
    const row = await loadItem(ctx, req.params.iid);
    await row.deleteOne(); // its pictures stay in the library
    res.json({ success: true, message: MSG.deleted });
  });
  own(
    "post",
    "/items/:iid/photos",
    true,
    async (ctx, req, res) => {
      const row = await loadItem(ctx, req.params.iid);
      if ((row.photos || []).length >= MAX.photos) throw new Bad(MSG.photoLimit, 400, { code: "photo_limit" });
      const pic = await media.pictureFrom(ctx, req); // { media_id } from the library, or a new file (goes into the library)
      if (!row.photos.some((p) => String(p.media_id || "") === String(pic.media_id))) row.photos.push(pic);
      await row.save();
      res.json({ success: true, data: row, message: MSG.saved });
    },
    [withFile],
  );
  own("delete", "/items/:iid/photos/:pid", true, async (ctx, req, res) => {
    const row = await loadItem(ctx, req.params.iid);
    const p = row.photos.id(req.params.pid);
    if (!p) throw new Bad(MSG.rowNotFound, 404);
    p.deleteOne(); // only unlinked: the picture stays in the library
    await row.save();
    res.json({ success: true, data: row, message: MSG.deleted });
  });
  own("put", "/items/:iid/photos-order", true, async (ctx, req, res) => {
    const row = await loadItem(ctx, req.params.iid);
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String);
    row.photos = [...row.photos].sort((a, b) => (ids.indexOf(String(a._id)) + 1 || 99) - (ids.indexOf(String(b._id)) + 1 || 99));
    await row.save();
    res.json({ success: true, data: row, message: MSG.saved });
  });

  // ---------------------------------------- promotions (mq_promos) ----------------------------------------
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  function readPromo(b, partial) {
    const ids = (k, max) => (b[k] === undefined ? undefined : Array.isArray(b[k]) && b[k].every(validId) && b[k].length <= max ? b[k] : (() => { throw new Bad(`${MSG.badValue} (${k})`); })()); // prettier-ignore
    const day = (k) => (b[k] === undefined ? undefined : b[k] === "" || DAY_RE.test(b[k]) ? b[k] : (() => { throw new Bad(`${MSG.badValue} (${k})`); })()); // prettier-ignore
    const hhmm = (k) => (b[k] === undefined ? undefined : b[k] === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(b[k]) ? b[k] : (() => { throw new Bad(`${MSG.badValue} (${k})`); })()); // prettier-ignore
    const set = clean({
      title_km: text(b, "title_km", 80),
      title_en: text(b, "title_en", 80),
      note: text(b, "note", 200),
      kind: oneOf(b, "kind", ["percent", "amount", "banner"]),
      value: num(b, "value", 0, 100000000),
      all_items: bool(b, "all_items"),
      category_ids: ids("category_ids", 200),
      item_ids: ids("item_ids", 1000),
      start_date: day("start_date"),
      end_date: day("end_date"),
      days: b.days === undefined ? undefined : Array.isArray(b.days) && b.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ? [...new Set(b.days)].sort() : (() => { throw new Bad(`${MSG.badValue} (days)`); })(), // prettier-ignore
      from: hhmm("from"),
      to: hhmm("to"),
      active: bool(b, "active"),
    });
    if (!partial && !set.title_km && !set.title_en) throw new Bad(`${MSG.required}: title`);
    if (set.kind === "percent" && set.value !== undefined && set.value > 100) throw new Bad(`${MSG.badValue} (value ≤ 100)`);
    if (set.start_date && set.end_date && set.start_date > set.end_date) throw new Bad(`${MSG.badValue} (dates)`);
    return set;
  }
  own("get", "/promos", false, async (ctx, req, res) => res.json({ success: true, data: await M.MqPromo.find({ business_id: ctx.business._id }).sort({ created_date: -1 }).lean() }));
  own("post", "/promos", true, async (ctx, req, res) => {
    need(ctx, "mq_promos", MSG.needPromos);
    if ((await M.MqPromo.countDocuments({ business_id: ctx.business._id })) >= MAX.promos) throw new Bad(MSG.tooMany);
    const row = await M.MqPromo.create({ business_id: ctx.business._id, ...readPromo(req.body || {}) });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  own("put", "/promos/:pid", true, async (ctx, req, res) => {
    need(ctx, "mq_promos", MSG.needPromos);
    if (!validId(req.params.pid)) throw new Bad(MSG.badId);
    const row = await M.MqPromo.findOneAndUpdate({ _id: req.params.pid, business_id: ctx.business._id }, { $set: readPromo(req.body || {}, true) }, { returnDocument: "after", runValidators: true });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, data: row, message: MSG.saved });
  });
  own("delete", "/promos/:pid", true, async (ctx, req, res) => {
    if (!validId(req.params.pid)) throw new Bad(MSG.badId);
    const row = await M.MqPromo.findOneAndDelete({ _id: req.params.pid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, message: MSG.deleted });
  });
  own(
    "post",
    "/promos/:pid/photo",
    true,
    async (ctx, req, res) => {
      need(ctx, "mq_promos", MSG.needPromos);
      if (!validId(req.params.pid)) throw new Bad(MSG.badId);
      const row = await M.MqPromo.findOne({ _id: req.params.pid, business_id: ctx.business._id });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      row.photo = await media.pictureFrom(ctx, req);
      await row.save();
      res.json({ success: true, data: row, message: MSG.saved });
    },
    [withFile],
  );

  // ---------------------------------------- feedback (mq_feedback) ----------------------------------------
  own("get", "/feedback", false, async (ctx, req, res) => {
    const page = Math.max(1, Math.min(500, Number(req.query.page) || 1));
    const filter = { business_id: ctx.business._id };
    const [rows, total, agg] = await Promise.all([
      M.MqFeedback.find(filter)
        .sort({ created_date: -1 })
        .skip((page - 1) * 30)
        .limit(30)
        .lean(),
      M.MqFeedback.countDocuments(filter),
      M.MqFeedback.aggregate([{ $match: filter }, { $group: { _id: "$stars", n: { $sum: 1 } } }]),
    ]);
    const stars = [1, 2, 3, 4, 5].map((s) => agg.find((a) => a._id === s)?.n || 0);
    const avg = total ? Math.round((stars.reduce((a, n, i) => a + n * (i + 1), 0) / total) * 10) / 10 : 0;
    res.json({ success: true, data: rows, total, page, pages: Math.max(1, Math.ceil(total / 30)), stars, avg, active: !!ctx.addons.mq_feedback.active });
  });
  own("put", "/feedback-read-all", true, async (ctx, req, res) => {
    await M.MqFeedback.updateMany({ business_id: ctx.business._id, read: false }, { $set: { read: true } });
    res.json({ success: true, message: MSG.saved });
  });
  own("put", "/feedback/:fid", true, async (ctx, req, res) => {
    if (!validId(req.params.fid)) throw new Bad(MSG.badId);
    await M.MqFeedback.updateOne({ _id: req.params.fid, business_id: ctx.business._id }, { $set: { read: req.body?.read !== false } });
    res.json({ success: true, message: MSG.saved });
  });
  own("delete", "/feedback/:fid", true, async (ctx, req, res) => {
    if (!validId(req.params.fid)) throw new Bad(MSG.badId);
    await M.MqFeedback.deleteOne({ _id: req.params.fid, business_id: ctx.business._id });
    res.json({ success: true, message: MSG.deleted });
  });

  // ---------------------------------------- stats (mq_stats) ----------------------------------------
  own("get", "/stats", false, async (ctx, req, res) => {
    need(ctx, "mq_stats", MSG.needStats);
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const today = localDay();
    const from = addDays(today, -(days - 1));
    const rows = await M.MqStat.find({ business_id: ctx.business._id, day: { $gte: from } }).lean();
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const series = [];
    for (let d = from; d <= today; d = addDays(d, 1)) series.push({ day: d, scans: byDay.get(d)?.scans || 0 });
    const hours = Array(24).fill(0);
    const items = new Map();
    for (const r of rows) {
      (r.hours || []).forEach((n, i) => (hours[i] += n || 0));
      for (const [k, n] of Object.entries(r.items || {})) items.set(k, (items.get(k) || 0) + n);
    }
    const topIds = [...items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const names = await M.MqItem.find({ _id: { $in: topIds.map(([k]) => k).filter(validId) }, business_id: ctx.business._id })
      .select("name_km name_en photos")
      .lean();
    const top = topIds.map(([k, n]) => ({ ...(names.find((x) => String(x._id) === k) || { _id: k, name_en: "—" }), opened: n })).map((x) => ({ _id: x._id, name_km: x.name_km, name_en: x.name_en, photo: x.photos?.[0]?.url || "", opened: x.opened }));
    const total = series.reduce((a, x) => a + x.scans, 0);
    res.json({ success: true, data: { days, today: byDay.get(today)?.scans || 0, total, avg: Math.round((total / days) * 10) / 10, all_time: ctx.settings.views || 0, series, hours, top } });
  });

  // ---------------------------------------- looks + QR styles ----------------------------------------
  own("post", "/themes/:key", true, async (ctx, req, res) => {
    const tier = THEMES[req.params.key];
    if (!tier || tier === "free") throw new Bad(MSG.badValue);
    let charged = 0;
    let balance;
    if (!ctx.themes.includes(req.params.key)) {
      const r = await buy({ customer: req.customer, business: ctx.business, product: THEME_PRODUCT[tier], item: req.params.key, expect: null });
      charged = r.charged;
      balance = r.balance;
    }
    ctx.settings.theme = req.params.key;
    await ctx.settings.save();
    res.json({ success: true, data: await overview(await ctxOf(req)), charged, balance, message: MSG.saved });
  });
  own("post", "/qr-styles/:key", true, async (ctx, req, res) => {
    const key = req.params.key;
    if (!QR_STYLES.includes(key) || key === FREE_QR) throw new Bad(MSG.badValue);
    let charged = 0;
    let balance;
    if (!ctx.qrStyles.includes(key)) {
      const r = await buy({ customer: req.customer, business: ctx.business, product: "mq_qr_style", item: key, expect: null });
      charged = r.charged;
      balance = r.balance;
    }
    ctx.settings.qr.style = key;
    await ctx.settings.save();
    res.json({ success: true, data: await overview(await ctxOf(req)), charged, balance, message: MSG.saved });
  });

  // ---------------------------------------- public: the page after the scan ----------------------------------------
  async function publicCtx(slug) {
    const s = await M.MqSettings.findOne({ slug: String(slug || "").toLowerCase() });
    if (!s) throw new Bad(MSG.menuOff, 404, { code: "not_found" });
    const business = await Business.findOne({ _id: s.business_id, deleted: false, category: "menu_qr" }).lean();
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    const state = await licenseState(s.business_id);
    if (!business?.status || !owner?.status || state.license.locked) throw new Bad(MSG.menuOff, 404, { code: "off" });
    return { s, business, state };
  }
  prop.app.get(
    "/api/public/q/:slug",
    handle(async (req, res) => {
      const { s, business, state } = await publicCtx(req.params.slug);
      const bid = business._id;
      const promoOn = !!state.addons.mq_promos.active;
      const [cats, items, promos] = await Promise.all([
        M.MqCategory.find({ business_id: bid, active: true }).sort({ sort: 1, created_date: 1 }).lean(),
        M.MqItem.find({ business_id: bid, active: true }).sort({ sort: 1, created_date: 1 }).lean(),
        promoOn ? M.MqPromo.find({ business_id: bid, active: true }).lean() : [],
      ]);
      const live = liveNow(promos);
      const catIds = new Set(cats.map((c) => String(c._id)));
      const out = items
        .map((i) => ({ ...i, cats: catsOf(i).filter((c) => catIds.has(c)) }))
        .filter((i) => i.cats.length)
        .map((i) => {
          const p = promoOn ? priceNow(i, live, s.currency) : { now: null, promo_id: null };
          return {
            _id: i._id,
            category_id: i.cats[0],
            category_ids: i.cats,
            name_km: i.name_km,
            name_en: i.name_en,
            desc_km: i.desc_km,
            desc_en: i.desc_en,
            price: i.price,
            price_now: p.now,
            promo_id: p.promo_id,
            photos: (i.photos || []).map((x) => ({ _id: x._id, url: x.url })),
            tags: i.tags,
            available: i.available,
          };
        });
      const theme = state.themes.includes(s.theme) ? s.theme : FREE_THEME;
      res.json({
        success: true,
        data: {
          name: business.name,
          slug: s.slug,
          tagline: s.tagline,
          about: s.about,
          logo: s.logo?.url || "",
          cover: s.cover?.url || "",
          contact: s.contact,
          hours: s.hours,
          currency: s.currency,
          khr_rate: s.khr_rate,
          show_both: s.show_both,
          lang: s.lang,
          theme,
          color: s.color,
          categories: cats.map((c) => ({ _id: c._id, name_km: c.name_km, name_en: c.name_en, icon: c.icon })),
          items: out,
          promos: live.map((p) => ({ _id: p._id, title_km: p.title_km, title_en: p.title_en, note: p.note, kind: p.kind, value: p.value, photo: p.photo?.url || "", to: p.to, end_date: p.end_date })),
          feedback: !!state.addons.mq_feedback.active && s.feedback_on,
        },
      });
    }),
  );
  prop.app.post(
    "/api/public/q/:slug/hit",
    handle(async (req, res) => {
      const { s, business } = await publicCtx(req.params.slug);
      const item = req.body?.item_id;
      const day = localDay();
      if (item) {
        if (!validId(item) || !(await M.MqItem.exists({ _id: item, business_id: business._id }))) throw new Bad(MSG.badId);
        await Promise.all([M.MqStat.updateOne({ business_id: business._id, day }, { $inc: { [`items.${item}`]: 1 }, $setOnInsert: { hours: Array(24).fill(0) } }, { upsert: true }), M.MqItem.updateOne({ _id: item }, { $inc: { views: 1 } })]);
      } else {
        // (a fresh day row needs its 24 hours first, then the hour can count)
        await M.MqStat.updateOne({ business_id: business._id, day }, { $setOnInsert: { hours: Array(24).fill(0), scans: 0 } }, { upsert: true }).catch((e) => (e.code === 11000 ? null : Promise.reject(e)));
        await Promise.all([M.MqStat.updateOne({ business_id: business._id, day }, { $inc: { scans: 1, [`hours.${localHour()}`]: 1 } }), M.MqSettings.updateOne({ _id: s._id }, { $inc: { views: 1 } })]);
      }
      res.json({ success: true });
    }),
  );
  // feedback: at most 5 an hour from one address for one menu
  const recent = new Map();
  prop.app.post(
    "/api/public/q/:slug/feedback",
    handle(async (req, res) => {
      const { s, business, state } = await publicCtx(req.params.slug);
      if (!state.addons.mq_feedback.active || !s.feedback_on) throw new Bad(MSG.needFeedback, 403, { code: "feedback_off" });
      const key = `${s._id}:${req.ip}`;
      const now = Date.now();
      const list = (recent.get(key) || []).filter((t) => now - t < 3600000);
      if (list.length >= 5) throw new Bad(MSG.slow, 429, { code: "slow" });
      const b = req.body || {};
      const stars = Number(b.stars);
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Bad(`${MSG.badValue} (stars)`);
      const row = await M.MqFeedback.create({ business_id: business._id, stars, text: text(b, "text", 600) || "", name: text(b, "name", 60) || "", phone: text(b, "phone", 30) || "" });
      recent.set(key, [...list, now]);
      if (recent.size > 5000) recent.clear();
      res.status(201).json({ success: true, data: { _id: row._id }, message: MSG.thanks });
    }),
  );
};
module.exports.FREE = FREE;
module.exports.liveNow = liveNow;
module.exports.priceNow = priceNow;
