// Flip Book (35 coins once, forever): PDFs become books you flip like a magazine, each with its own link + QR,
// on a public shelf (/f/<slug>) with categories (/fc/<slug>). Books: /b/<slug>.
// Owner base: /api/user/businesses/:id/flipbook
//   GET  /                         everything the dashboard needs
//   PUT  /settings                 shelf title, about, contact, colour, sound, language, link
//   POST/DELETE /logo              (multipart "photo")
//   GET  /upload-sign              a signature to upload a PDF straight to Cloudinary from the browser
//   GET  /books   POST /books { public_id, title, about, category_ids, download, name }   PUT/DELETE /books/:bid
//   POST /books/:bid/replace { public_id, name }     a new edition, same link
//   PUT  /books-order { ids }
//   POST /books/:bid/password { password }   DELETE /books/:bid/password     (fb_password, per book)
//   POST /books/:bid/password-unlock          buy the password for this book (15)
//   GET/POST /categories   PUT/DELETE /categories/:cid       1 free, more with fb_categories (100 once)
//   POST /new-link { kind: library|book|category, id }   a new link; the old one stops working
//   POST /slots { kind: "book" | "big", n }    5 coins per extra book, 10 per big book (50 MB / 400 pages)
//   POST /shelf-themes/:key   POST /reader-themes/:key    buy (once) and use
//   GET  /stats?days=30&book=   (fb_stats)
// Public:
//   GET /api/public/fb/:slug  (shelf)   GET /api/public/fb-cat/:slug   GET /api/public/book/:slug?t=
//   POST /api/public/book/:slug/unlock { password } → { token }     POST /api/public/book/:slug/hit { page? }
const mongoose = require("mongoose");
const crypto = require("crypto");
const multer = require("multer");
const M = require("./flipbook.models");
const { SHELF_THEMES, READER_THEMES, QR_CARDS, LIVE_THEMES } = require("./flipbook.themes");
const ALL_SHELVES = [...SHELF_THEMES, ...LIVE_THEMES];
const Business = require("../business.model");
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const coin = require("../../coin/coin.service");
const { statusOf, buy, LicenseError, DAY } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");
const cloud = require("../../util/cloudinary");

const FREE = { books: 5, categories: 1 };
const LIMIT = { bytes: 20 * 1024 * 1024, pages: 150, big_bytes: 50 * 1024 * 1024, big_pages: 400 };
const MAX = { books: 2000, categories: 200, slots: 5000 };
const ADDONS = ["fb_categories", "fb_stats", "fb_qr_styles", "fb_leads", "fb_links"];
const TZ = 7;
const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  notFlip: "អាជីវកម្មនេះមិនមែនជាសៀវភៅត្រឡប់ទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  rowNotFound: "រកមិនឃើញទិន្នន័យ!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
  required: "សូមបំពេញ",
  tooLong: "អត្ថបទវែងពេក!",
  badValue: "តម្លៃមិនត្រឹមត្រូវ!",
  tooMany: "ច្រើនពេក!",
  bookLimit: "កន្លែងសៀវភៅពេញហើយ! សូមលុបសៀវភៅចាស់ ឬទិញកន្លែងបន្ថែម។",
  catLimit: "ប្រភេទឥតគិតថ្លៃមានតែ 1។ សូមដោះសោ “ប្រភេទគ្មានកំណត់”។",
  notPdf: "សូមដាក់ឯកសារ PDF!",
  noFile: "រកមិនឃើញឯកសារដែលបានផ្ទុកឡើង!",
  tooBig: `PDF ធំពេក! (អតិបរមា ${LIMIT.big_bytes / 1048576} MB / ${LIMIT.big_pages} ទំព័រ)`,
  needBig: `PDF លើស ${LIMIT.bytes / 1048576} MB ឬ ${LIMIT.pages} ទំព័រ — សូមទិញកន្លែង “សៀវភៅធំ”។`,
  needStats: "សូមដោះសោ “ស្ថិតិការអាន” ជាមុនសិន!",
  needLeads: "សូមដោះសោ “ទម្រង់ទំនាក់ទំនង” ជាមុនសិន!",
  needLinks: "សូមដោះសោ “ទំព័រចុចបាន” ជាមុនសិន!",
  badLink: "តំណមិនត្រឹមត្រូវ!",
  tooManyLinks: "តំណច្រើនពេក! (អតិបរមា 30 ក្នុងមួយទំព័រ 300 ក្នុងមួយក្បាល)",
  leadName: "សូមបញ្ចូលឈ្មោះ!",
  leadPhone: "សូមបញ្ចូលលេខទូរស័ព្ទឱ្យបានត្រឹមត្រូវ!",
  leadEmail: "អ៊ីមែលមិនត្រឹមត្រូវ!",
  leadOff: "ទម្រង់នេះបិទហើយ។",
  needPassword: "សូមដោះសោ “ពាក្យសម្ងាត់” សម្រាប់សៀវភៅនេះជាមុនសិន!",
  badPassword: "ពាក្យសម្ងាត់ត្រូវមាន 4 ទៅ 40 តួ!",
  wrongPassword: "ពាក្យសម្ងាត់មិនត្រឹមត្រូវ!",
  notOwned: "សូមទិញម៉ូដនេះជាមុនសិន!",
  badImage: "សូមដាក់រូបភាព JPG / PNG / WEBP (តិចជាង 4MB)!",
  slugTaken: "តំណនេះមានគេប្រើហើយ!",
  badSlug: "តំណប្រើបានតែអក្សរ a-z លេខ និង - (3 ទៅ 40)!",
  off: "សៀវភៅនេះមិនមាន ឬត្រូវបានផ្អាក។",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  already: "បានទិញរួចហើយ!",
  busy: "កំពុងដំណើរការ សូមព្យាយាមម្តងទៀត!",
  slow: "សូមរង់ចាំបន្តិច រួចព្យាយាមម្តងទៀត។",
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
const bool = (b, key) => (b[key] === undefined ? undefined : b[key] === true || b[key] === "true");
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const localDay = (d = new Date()) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const slugify = (s) =>
  String(s || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
async function uniqueSlug(Model, base, fallback) {
  const b = slugify(base) || fallback;
  for (let i = 0; i < 20; i++) {
    const s = `${b}-${crypto.randomBytes(2).toString("hex")}`;
    if (!(await Model.exists({ slug: s }))) return s;
  }
  return `${fallback}-${crypto.randomBytes(5).toString("hex")}`;
}
// passwords for books: scrypt "salt:hash"
const hashPass = (p) => {
  const salt = crypto.randomBytes(8).toString("hex");
  return `${salt}:${crypto.scryptSync(String(p), salt, 32).toString("hex")}`;
};
const checkPass = (p, stored) => {
  const [salt, h] = String(stored || "").split(":");
  if (!salt || !h) return false;
  const got = crypto.scryptSync(String(p), salt, 32);
  return crypto.timingSafeEqual(got, Buffer.from(h, "hex"));
};
const secret = () => process.env.JWT_SECRET || "bizhub";
const tokenFor = (book) => crypto.createHmac("sha256", secret()).update(`${book._id}:${book.password_hash}`).digest("hex").slice(0, 32);

// page pictures of a PDF (Cloudinary renders them): "{page}" is filled by the reader
const pageTpl = (public_id, width) => cloud.pdfPageUrl(public_id, 99999, width).replace("pg_99999", "pg_{page}");

async function licenseState(businessId) {
  const rows = await License.find({ business_id: businessId, product: { $in: [...ADDONS, "fb_password", "fb_shelf_theme", "fb_shelf_live", "fb_reader_theme"] } }).lean();
  const addons = {};
  for (const key of ADDONS) addons[key] = statusOf(rows.find((r) => r.product === key && !r.item));
  const live = (p) => rows.filter((r) => r.product === p && r.item && statusOf(r).active).map((r) => r.item);
  return { addons, passwords: live("fb_password"), shelfThemes: ["classic", ...live("fb_shelf_theme"), ...live("fb_shelf_live")], readerThemes: ["classic", ...live("fb_reader_theme")] };
}
async function settingsOf(business) {
  const found = await M.FbSettings.findOne({ business_id: business._id });
  if (found) return found;
  try {
    return await M.FbSettings.create({ business_id: business._id, slug: await uniqueSlug(M.FbSettings, business.name, "books"), title: business.name });
  } catch (err) {
    if (err.code === 11000) return M.FbSettings.findOne({ business_id: business._id });
    throw err;
  }
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});

module.exports = (prop) => {
  const base = "/api/user/businesses/:id/flipbook";
  const guard = [prop.api_auth, customer_auth];
  async function ctxOf(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    const [business, state] = await Promise.all([Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false }), licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== "flipbook") throw new Bad(MSG.notFlip);
    if (write && !business.status) throw new Bad(MSG.suspended, 403);
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
      if (err?.isCloudinary) return res.status(err.status).json({ success: false, message: err.message });
      console.error("[flipbook]", err);
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
  const need = (ctx, key, msg) => {
    if (!ctx.addons[key]?.active) throw new Bad(msg, 402, { product: key });
  };
  const room = async (ctx) => {
    const bid = ctx.business._id;
    const [books, big] = await Promise.all([M.FbBook.countDocuments({ business_id: bid }), M.FbBook.countDocuments({ business_id: bid, big: true })]);
    return { books, book_capacity: FREE.books + (ctx.settings.book_slots || 0), big, big_capacity: ctx.settings.big_slots || 0 };
  };
  const bookOut = (b) => ({ ...b, has_password: !!b.password_hash, password_hash: undefined, cover: cloud.pdfPageUrl(b.file.public_id, 1, 500), page_url: pageTpl(b.file.public_id, 900) });

  // ---------------------------------------- overview ----------------------------------------
  async function overview(ctx) {
    const keys = ["fb_book_slot", "fb_big_slot", "fb_categories", "fb_stats", "fb_qr_styles", "fb_leads", "fb_links", "fb_password", "fb_shelf_theme", "fb_shelf_live", "fb_reader_theme"];
    const [prices, r, cats] = await Promise.all([Promise.all(keys.map((k) => priceOf(k))), room(ctx), M.FbCategory.countDocuments({ business_id: ctx.business._id })]);
    const price = Object.fromEntries(keys.map((k, i) => [k, prices[i]]));
    return {
      business: { _id: ctx.business._id, name: ctx.business.name, status: ctx.business.status },
      settings: ctx.settings,
      addons: Object.fromEntries(ADDONS.map((k) => [k, { ...ctx.addons[k], price: price[k] }])),
      room: r,
      counts: { categories: cats },
      limits: { ...LIMIT, free_books: FREE.books, free_categories: FREE.categories, categories: ctx.addons.fb_categories.active ? MAX.categories : FREE.categories },
      prices: price,
      passwords: ctx.passwords,
      shelf_themes: ctx.shelfThemes,
      reader_themes: ctx.readerThemes,
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
      if (slug !== s.slug && (await M.FbSettings.exists({ slug }))) throw new Bad(MSG.slugTaken, 409, { code: "slug_taken" });
      s.slug = slug;
    }
    Object.assign(s, clean({ title: text(b, "title", 80), about: text(b, "about", 600), sound: bool(b, "sound"), lang: ["km", "en"].includes(b.lang) ? b.lang : undefined }));
    if (b.color !== undefined) {
      if (b.color !== "" && !/^#[0-9a-fA-F]{6}$/.test(String(b.color))) throw new Bad(MSG.badValue); // "" = the design's own colour
      s.color = b.color;
    }
    if (b.contact && typeof b.contact === "object") {
      for (const [k, max] of Object.entries({ phone: 30, telegram: 120, facebook: 200, website: 200, email: 120 })) {
        const v = text(b.contact, k, max);
        if (v !== undefined) s.contact[k] = v;
      }
    }
    if (b.lead_form !== undefined) {
      const f = b.lead_form || {};
      if (f.on === true) need(ctx, "fb_leads", MSG.needLeads);
      s.lead_form = { on: f.on === true, ask_email: f.ask_email === true, ask_telegram: f.ask_telegram === true, ask_note: f.ask_note === true, title: text(f, "title", 80) || "", message: text(f, "message", 300) || "" };
    }
    if (b.qr_style !== undefined) {
      if (!QR_CARDS.includes(b.qr_style)) throw new Bad(MSG.badValue);
      if (b.qr_style !== "classic" && !ctx.addons.fb_qr_styles?.active) throw new Bad(MSG.notOwned, 402, { code: "not_owned", product: "fb_qr_styles" });
      s.qr_style = b.qr_style;
    }
    for (const [field, list, owned] of [
      ["shelf_theme", ALL_SHELVES, ctx.shelfThemes],
      ["reader_theme", READER_THEMES, ctx.readerThemes],
    ]) {
      if (b[field] === undefined) continue;
      if (!list.includes(b[field])) throw new Bad(MSG.badValue);
      if (!owned.includes(b[field])) throw new Bad(MSG.notOwned, 402, { code: "not_owned", product: field === "shelf_theme" ? (LIVE_THEMES.includes(b[field]) ? "fb_shelf_live" : "fb_shelf_theme") : "fb_reader_theme", item: b[field] });
      s[field] = b[field];
    }
    await s.save();
    res.json({ success: true, data: s, message: MSG.saved });
  });
  own(
    "post",
    "/logo",
    true,
    async (ctx, req, res) => {
      if (!req.file) throw new Bad(MSG.noFile);
      const saved = await cloud.uploadBuffer(req.file, "flipbook");
      const old = ctx.settings.logo?.public_id;
      ctx.settings.logo = { url: saved.url, public_id: saved.public_id || "" };
      await ctx.settings.save();
      if (old) cloud.deleteFile(old).catch(() => {});
      require("../dashboard.route").forget(ctx.business.owner_id);
      res.json({ success: true, data: ctx.settings, message: MSG.saved });
    },
    [
      (req, res, next) =>
        upload.single("photo")(req, res, (err) => {
          if (err) return res.status(400).json({ success: false, message: MSG.badImage });
          next();
        }),
    ],
  );
  own("delete", "/logo", true, async (ctx, req, res) => {
    const old = ctx.settings.logo?.public_id;
    ctx.settings.logo = { url: "", public_id: "" };
    await ctx.settings.save();
    if (old) cloud.deleteFile(old).catch(() => {});
    require("../dashboard.route").forget(ctx.business.owner_id);
    res.json({ success: true, data: ctx.settings, message: MSG.deleted });
  });

  // ---------------------------------------- books ----------------------------------------
  own("get", "/upload-sign", true, async (ctx, req, res) => res.json({ success: true, data: cloud.signUpload(`flipbook/${ctx.business._id}`) }));

  // a PDF just uploaded to Cloudinary from the browser: check it belongs to this business + is a PDF + fits
  async function checkPdf(ctx, public_id, { replacing = null } = {}) {
    const id = String(public_id || "");
    if (!id.includes(`flipbook/${ctx.business._id}/`)) throw new Bad(MSG.noFile, 400, { code: "bad_file" });
    let info;
    try {
      info = await cloud.pdfInfo(id);
    } catch {
      throw new Bad(MSG.noFile, 400, { code: "bad_file" });
    }
    const drop = () => cloud.deleteFile(id).catch(() => {});
    if (String(info.format).toLowerCase() !== "pdf") {
      drop();
      throw new Bad(MSG.notPdf, 400, { code: "not_pdf" });
    }
    if (info.bytes > LIMIT.big_bytes || info.pages > LIMIT.big_pages) {
      drop();
      throw new Bad(MSG.tooBig, 400, { code: "too_big", bytes: info.bytes, pages: info.pages });
    }
    const big = info.bytes > LIMIT.bytes || info.pages > LIMIT.pages;
    if (big && !replacing?.big) {
      const r = await room(ctx);
      if (r.big >= r.big_capacity) {
        drop();
        throw new Bad(MSG.needBig, 402, { code: "need_big", bytes: info.bytes, pages: info.pages, ...r, price: await priceOf("fb_big_slot") });
      }
    }
    return { info, big };
  }
  async function readBook(ctx, b) {
    const set = clean({ title: text(b, "title", 120), about: text(b, "about", 600), download: bool(b, "download"), published: bool(b, "published") });
    if (b.category_ids !== undefined) {
      if (!Array.isArray(b.category_ids) || b.category_ids.length > 50 || !b.category_ids.every(validId)) throw new Bad(`${MSG.badValue} (category)`);
      const ids = [...new Set(b.category_ids.map(String))];
      if ((await M.FbCategory.countDocuments({ _id: { $in: ids }, business_id: ctx.business._id })) !== ids.length) throw new Bad(`${MSG.badValue} (category)`);
      set.category_ids = ids;
    }
    if (b.reader_theme !== undefined) {
      if (b.reader_theme !== "" && !READER_THEMES.includes(b.reader_theme)) throw new Bad(MSG.badValue);
      if (b.reader_theme && !ctx.readerThemes.includes(b.reader_theme)) throw new Bad(MSG.notOwned, 402, { code: "not_owned", product: "fb_reader_theme", item: b.reader_theme });
      set.reader_theme = b.reader_theme;
    }
    if (b.lead_form !== undefined) {
      const f = b.lead_form || {};
      const mode = ["off", "before", "after"].includes(f.mode) ? f.mode : "off";
      if (mode !== "off") need(ctx, "fb_leads", MSG.needLeads);
      const page = Math.round(Number(f.page) || 3);
      set.lead_form = {
        mode,
        page: Math.min(Math.max(1, page), 2000),
        ask_email: f.ask_email === true,
        ask_telegram: f.ask_telegram === true,
        ask_note: f.ask_note === true,
        skip: f.skip === true,
        title: text(f, "title", 80) || "",
        message: text(f, "message", 300) || "",
      };
    }
    if (b.slug !== undefined) {
      const slug = String(b.slug || "")
        .trim()
        .toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$/.test(slug)) throw new Bad(MSG.badSlug, 400, { code: "bad_slug" });
      set.slug = slug;
    }
    return set;
  }
  const loadBook = async (ctx, bid) => {
    if (!validId(bid)) throw new Bad(MSG.badId);
    const row = await M.FbBook.findOne({ _id: bid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  own("get", "/books", false, async (ctx, req, res) => {
    const rows = await M.FbBook.find({ business_id: ctx.business._id }).sort({ sort: 1, created_date: -1 }).lean();
    res.json({ success: true, data: rows.map(bookOut), room: await room(ctx) });
  });
  own("post", "/books", true, async (ctx, req, res) => {
    const b = req.body || {};
    const r = await room(ctx);
    if (r.books >= r.book_capacity) {
      if (b.public_id) cloud.deleteFile(String(b.public_id)).catch(() => {});
      throw new Bad(MSG.bookLimit, 402, { code: "book_full", ...r, price: await priceOf("fb_book_slot") });
    }
    const set = await readBook(ctx, b);
    const { info, big } = await checkPdf(ctx, b.public_id);
    const title =
      set.title ||
      String(b.name || "")
        .replace(/\.pdf$/i, "")
        .slice(0, 120) ||
      "Book";
    const row = await M.FbBook.create({
      business_id: ctx.business._id,
      ...set,
      title,
      slug: set.slug || (await uniqueSlug(M.FbBook, title, "book")),
      file: { public_id: info.public_id, url: info.url, bytes: info.bytes, pages: info.pages, width: info.width, height: info.height, name: String(b.name || "").slice(0, 160) },
      big,
      sort: -Date.now() / 1000,
    });
    res.status(201).json({ success: true, data: bookOut(row.toObject()), room: await room(ctx), message: MSG.saved });
  });
  own("put", "/books-order", true, async (ctx, req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(validId).slice(0, MAX.books);
    await M.FbBook.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id, business_id: ctx.business._id }, update: { $set: { sort: i } } } })));
    res.json({ success: true, message: MSG.saved });
  });
  own("put", "/books/:bid", true, async (ctx, req, res) => {
    const row = await loadBook(ctx, req.params.bid);
    const set = await readBook(ctx, req.body || {});
    if (set.slug && set.slug !== row.slug && (await M.FbBook.exists({ slug: set.slug }))) throw new Bad(MSG.slugTaken, 409, { code: "slug_taken" });
    Object.assign(row, set);
    await row.save();
    res.json({ success: true, data: bookOut(row.toObject()), message: MSG.saved });
  });
  own("post", "/books/:bid/replace", true, async (ctx, req, res) => {
    const row = await loadBook(ctx, req.params.bid);
    const { info, big } = await checkPdf(ctx, req.body?.public_id, { replacing: row });
    const old = row.file.public_id;
    row.file = { public_id: info.public_id, url: info.url, bytes: info.bytes, pages: info.pages, width: info.width, height: info.height, name: String(req.body?.name || "").slice(0, 160) };
    row.big = big;
    row.edition += 1;
    await row.save();
    if (old && old !== info.public_id) cloud.deleteFile(old).catch(() => {});
    res.json({ success: true, data: bookOut(row.toObject()), room: await room(ctx), message: MSG.saved });
  });
  own("delete", "/books/:bid", true, async (ctx, req, res) => {
    const row = await loadBook(ctx, req.params.bid);
    await row.deleteOne();
    await M.FbStat.deleteMany({ business_id: ctx.business._id, book_id: row._id });
    await M.FbLead.deleteMany({ business_id: ctx.business._id, book_id: row._id });
    cloud.deleteFile(row.file.public_id).catch(() => {});
    res.json({ success: true, room: await room(ctx), message: MSG.deleted });
  });
  // password (fb_password, bought per book)
  own("post", "/books/:bid/password-unlock", true, async (ctx, req, res) => {
    const row = await loadBook(ctx, req.params.bid);
    const r = await buy({ customer: req.customer, business: ctx.business, product: "fb_password", item: String(row._id), expect: null });
    res.json({ success: true, charged: r.charged, balance: r.balance, message: MSG.saved });
  });
  own("post", "/books/:bid/password", true, async (ctx, req, res) => {
    const row = await loadBook(ctx, req.params.bid);
    if (!ctx.passwords.includes(String(row._id))) throw new Bad(MSG.needPassword, 402, { code: "need_password", product: "fb_password", item: String(row._id) });
    const p = String(req.body?.password || "");
    if (p.length < 4 || p.length > 40) throw new Bad(MSG.badPassword, 400, { code: "bad_password" });
    row.password_hash = hashPass(p);
    await row.save();
    res.json({ success: true, data: bookOut(row.toObject()), message: MSG.saved });
  });
  own("delete", "/books/:bid/password", true, async (ctx, req, res) => {
    const row = await loadBook(ctx, req.params.bid);
    row.password_hash = "";
    await row.save();
    res.json({ success: true, data: bookOut(row.toObject()), message: MSG.saved });
  });

  // ---------------------------------------- clickable pages (fb_links) ----------------------------------------
  const LINK_KINDS = ["url", "phone", "telegram", "facebook", "map", "youtube", "email", "page"];
  const num01 = (v) => Math.min(1, Math.max(0, Math.round(Number(v) * 10000) / 10000));
  own("put", "/books/:bid/links", true, async (ctx, req, res) => {
    need(ctx, "fb_links", MSG.needLinks);
    const row = await loadBook(ctx, req.params.bid);
    const list = Array.isArray(req.body?.links) ? req.body.links : null;
    if (!list || list.length > 300) throw new Bad(MSG.tooManyLinks);
    const perPage = {};
    const clean = list.map((l) => {
      const page = Math.round(Number(l?.page));
      const kind = LINK_KINDS.includes(l?.kind) ? l.kind : null;
      const value = String(l?.value ?? "").trim();
      if (!Number.isInteger(page) || page < 1 || page > row.file.pages || !kind || !value || value.length > 500) throw new Bad(MSG.badLink, 400, { code: "bad_link" });
      if (kind === "page" && !(Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= row.file.pages)) throw new Bad(MSG.badLink, 400, { code: "bad_link" });
      if (["url", "facebook", "map", "youtube"].includes(kind) && !/^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/i.test(value)) throw new Bad(MSG.badLink, 400, { code: "bad_link" });
      perPage[page] = (perPage[page] || 0) + 1;
      if (perPage[page] > 30) throw new Bad(MSG.tooManyLinks);
      const x = num01(l.x);
      const y = num01(l.y);
      const w = Math.max(0.01, Math.min(num01(l.w), 1 - x));
      const h = Math.max(0.01, Math.min(num01(l.h), 1 - y));
      return {
        page,
        x,
        y,
        w,
        h,
        kind,
        value,
        label: String(l.label || "")
          .trim()
          .slice(0, 60),
      };
    });
    row.links = clean;
    await row.save();
    res.json({ success: true, data: bookOut(row.toObject()), message: MSG.saved });
  });

  // ---------------------------------------- contacts left by readers (fb_leads) ----------------------------------------
  // the list stays readable after the add-on ends (it is the owner's data); only the form stops showing
  own("get", "/leads", false, async (ctx, req, res) => {
    const filter = { business_id: ctx.business._id };
    if (req.query.book === "library") filter.book_id = null;
    else if (req.query.book && validId(req.query.book)) filter.book_id = req.query.book;
    if (req.query.category === "none") filter.category_ids = { $size: 0 };
    else if (req.query.category && validId(req.query.category)) filter.category_ids = new mongoose.Types.ObjectId(String(req.query.category));
    const q = String(req.query.q || "")
      .trim()
      .slice(0, 60);
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { phone: rx }, { email: rx }, { telegram: rx }, { note: rx }];
    }
    const all = req.query.all === "1";
    const limit = all ? 5000 : Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const page = all ? 1 : Math.max(1, Number(req.query.page) || 1);
    const [rows, total] = await Promise.all([
      M.FbLead.find(filter)
        .sort({ created_date: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.FbLead.countDocuments(filter),
    ]);
    // contacts per category (the index on top of the list)
    const bid = ctx.business._id;
    const [byCat, none, all2, library] = await Promise.all([
      M.FbLead.aggregate([{ $match: { business_id: bid } }, { $unwind: "$category_ids" }, { $group: { _id: "$category_ids", n: { $sum: 1 } } }]),
      M.FbLead.countDocuments({ business_id: bid, category_ids: { $size: 0 } }),
      M.FbLead.countDocuments({ business_id: bid }),
      M.FbLead.countDocuments({ business_id: bid, book_id: null }),
    ]);
    res.json({ success: true, data: rows, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }, counts: { all: all2, none, library, categories: Object.fromEntries(byCat.map((x) => [String(x._id), x.n])) } });
  });
  own("delete", "/leads/:lid", true, async (ctx, req, res) => {
    if (!validId(req.params.lid)) throw new Bad(MSG.badId);
    const row = await M.FbLead.findOneAndDelete({ _id: req.params.lid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    await M.FbBook.updateOne({ _id: row.book_id, leads: { $gt: 0 } }, { $inc: { leads: -1 } });
    res.json({ success: true, message: MSG.deleted });
  });

  // ---------------------------------------- categories ----------------------------------------
  own("get", "/categories", false, async (ctx, req, res) => res.json({ success: true, data: await M.FbCategory.find({ business_id: ctx.business._id }).sort({ sort: 1, created_date: 1 }).lean() }));
  own("post", "/categories", true, async (ctx, req, res) => {
    const n = await M.FbCategory.countDocuments({ business_id: ctx.business._id });
    const max = ctx.addons.fb_categories.active ? MAX.categories : FREE.categories;
    if (n >= max) throw new Bad(ctx.addons.fb_categories.active ? MSG.tooMany : MSG.catLimit, ctx.addons.fb_categories.active ? 400 : 402, { code: "category_limit", product: "fb_categories", limit: max });
    const name = text(req.body || {}, "name", 60, { required: true });
    const row = await M.FbCategory.create({ business_id: ctx.business._id, name, about: text(req.body || {}, "about", 600) || "", slug: await uniqueSlug(M.FbCategory, name, "shelf"), sort: n });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  own("put", "/categories/:cid", true, async (ctx, req, res) => {
    if (!validId(req.params.cid)) throw new Bad(MSG.badId);
    const set = clean({ name: text(req.body || {}, "name", 60), about: text(req.body || {}, "about", 600), active: bool(req.body || {}, "active") });
    if (set.name === "") throw new Bad(`${MSG.required}: name`);
    const row = await M.FbCategory.findOneAndUpdate({ _id: req.params.cid, business_id: ctx.business._id }, { $set: set }, { returnDocument: "after" });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, data: row, message: MSG.saved });
  });
  // a new link for the library, a book or a category — the old link (and its printed QR) stops working
  own("post", "/new-link", true, async (ctx, req, res) => {
    const { kind, id: rid } = req.body || {};
    const fresh = async (Model, base, fallback) => {
      const b = slugify(base) || fallback;
      for (let i = 0; i < 20; i++) {
        const s = `${b}-${crypto.randomBytes(3).toString("hex")}`;
        if (!(await Model.exists({ slug: s }))) return s;
      }
      return `${fallback}-${crypto.randomBytes(6).toString("hex")}`;
    };
    if (kind === "library") {
      ctx.settings.slug = await fresh(M.FbSettings, ctx.settings.title || ctx.business.name, "books");
      await ctx.settings.save();
      return res.json({ success: true, data: { kind, slug: ctx.settings.slug }, message: MSG.saved });
    }
    if (!validId(rid)) throw new Bad(MSG.badId);
    if (kind === "book") {
      const row = await loadBook(ctx, rid);
      row.slug = await fresh(M.FbBook, row.title, "book");
      await row.save();
      return res.json({ success: true, data: { kind, id: String(row._id), slug: row.slug }, message: MSG.saved });
    }
    if (kind === "category") {
      const row = await M.FbCategory.findOne({ _id: rid, business_id: ctx.business._id });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      row.slug = await fresh(M.FbCategory, row.name, "shelf");
      await row.save();
      return res.json({ success: true, data: { kind, id: String(row._id), slug: row.slug }, message: MSG.saved });
    }
    throw new Bad(MSG.badValue || "bad");
  });
  own("delete", "/categories/:cid", true, async (ctx, req, res) => {
    if (!validId(req.params.cid)) throw new Bad(MSG.badId);
    const row = await M.FbCategory.findOneAndDelete({ _id: req.params.cid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    await M.FbBook.updateMany({ business_id: ctx.business._id }, { $pull: { category_ids: row._id } }); // books stay
    res.json({ success: true, message: MSG.deleted });
  });

  // ---------------------------------------- places (book / big book) ----------------------------------------
  own("post", "/slots", true, async (ctx, req, res) => {
    const kind = req.body?.kind === "big" ? "big" : "book";
    const n = Number(req.body?.n);
    const field = kind === "big" ? "big_slots" : "book_slots";
    if (!Number.isInteger(n) || n < 1 || n > 500 || (ctx.settings[field] || 0) + n > MAX.slots) throw new Bad(MSG.badValue);
    const key = kind === "big" ? "fb_big_slot" : "fb_book_slot";
    const total = n * (await priceOf(key));
    let tx = null;
    if (total > 0) {
      try {
        tx = await coin.transfer({
          from: await coin.getCustomerWallet(req.customer._id),
          to: await coin.getTreasury(),
          amount: total,
          note: `${key} × ${n} · ${ctx.business.name}`,
          customerId: req.customer._id,
          type: "spend",
          businessId: ctx.business._id,
          service: key,
          max: 100000,
        });
      } catch (err) {
        if (err instanceof coin.CoinError) {
          const w = await coin.getCustomerWallet(req.customer._id);
          throw new Bad(MSG.noCoins, 402, { code: "no_coins", price: total, balance: w.balance });
        }
        throw err;
      }
    }
    await M.FbSettings.updateOne({ _id: ctx.settings._id }, { $inc: { [field]: n } });
    ctx.settings[field] = (ctx.settings[field] || 0) + n;
    res.json({ success: true, charged: total, balance: tx ? tx.from_balance_after : undefined, room: await room(ctx), message: MSG.saved });
  });

  // ---------------------------------------- looks ----------------------------------------
  for (const [path, list, product, field, ownedKey] of [
    ["shelf-themes", ALL_SHELVES, "fb_shelf_theme", "shelf_theme", "shelfThemes"],
    ["reader-themes", READER_THEMES, "fb_reader_theme", "reader_theme", "readerThemes"],
  ]) {
    own("post", `/${path}/:key`, true, async (ctx, req, res) => {
      const key = req.params.key;
      if (!list.includes(key) || key === "classic") throw new Bad(MSG.badValue);
      let charged = 0;
      let balance;
      if (!ctx[ownedKey].includes(key)) {
        const r = await buy({ customer: req.customer, business: ctx.business, product: LIVE_THEMES.includes(key) ? "fb_shelf_live" : product, item: key, expect: null });
        charged = r.charged;
        balance = r.balance;
      }
      ctx.settings[field] = key;
      await ctx.settings.save();
      res.json({ success: true, data: await overview(await ctxOf(req)), charged, balance, message: MSG.saved });
    });
  }

  // ---------------------------------------- stats (fb_stats) ----------------------------------------
  own("get", "/stats", false, async (ctx, req, res) => {
    need(ctx, "fb_stats", MSG.needStats);
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const today = localDay();
    const from = addDays(today, -(days - 1));
    const filter = { business_id: ctx.business._id, day: { $gte: from } };
    if (req.query.book && validId(req.query.book)) filter.book_id = new mongoose.Types.ObjectId(String(req.query.book));
    const [rows, books] = await Promise.all([M.FbStat.find(filter).lean(), M.FbBook.find({ business_id: ctx.business._id }).select("title views file.pages").lean()]);
    const byDay = new Map();
    const byBook = new Map();
    const pages = new Map();
    for (const r of rows) {
      byDay.set(r.day, (byDay.get(r.day) || 0) + r.views);
      byBook.set(String(r.book_id), (byBook.get(String(r.book_id)) || 0) + r.views);
      for (const [p, n] of Object.entries(r.pages || {})) pages.set(Number(p), (pages.get(Number(p)) || 0) + n);
    }
    const series = [];
    for (let d = from; d <= today; d = addDays(d, 1)) series.push({ day: d, views: byDay.get(d) || 0 });
    const total = series.reduce((a, x) => a + x.views, 0);
    res.json({
      success: true,
      data: {
        days,
        today: byDay.get(today) || 0,
        total,
        all_time: books.reduce((a, b) => a + (b.views || 0), 0),
        series,
        books: books.map((b) => ({ _id: b._id, title: b.title, views: byBook.get(String(b._id)) || 0, all_time: b.views || 0 })).sort((a, b) => b.views - a.views),
        pages: [...pages.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15)
          .map(([page, n]) => ({ page, views: n })),
      },
    });
  });

  // ---------------------------------------- public ----------------------------------------
  async function liveBusiness(bid) {
    const business = await Business.findOne({ _id: bid, deleted: false, category: "flipbook" }).lean();
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || !owner?.status) throw new Bad(MSG.off, 404, { code: "off" });
    return business;
  }
  const shelfLead = (s, st) =>
    s.lead_form?.on && st.addons.fb_leads?.active ? { title: s.lead_form.title || "", message: s.lead_form.message || "", ask_email: !!s.lead_form.ask_email, ask_telegram: !!s.lead_form.ask_telegram, ask_note: !!s.lead_form.ask_note } : null;
  const shelfOut = (s, business) => ({ name: business.name, title: s.title || business.name, about: s.about, logo: s.logo?.url || "", contact: s.contact, color: s.color, shelf_theme: s.shelf_theme, lang: s.lang, slug: s.slug });
  const cardOut = (b) => ({ _id: b._id, slug: b.slug, title: b.title, about: b.about, pages: b.file.pages, cover: cloud.pdfPageUrl(b.file.public_id, 1, 500), locked: !!b.password_hash, category_ids: b.category_ids });

  prop.app.get(
    "/api/public/fb/:slug",
    handle(async (req, res) => {
      const s = await M.FbSettings.findOne({ slug: String(req.params.slug || "").toLowerCase() }).lean();
      if (!s) throw new Bad(MSG.off, 404, { code: "not_found" });
      const business = await liveBusiness(s.business_id);
      const [cats, books] = await Promise.all([
        M.FbCategory.find({ business_id: s.business_id, active: true }).sort({ sort: 1, created_date: 1 }).lean(),
        M.FbBook.find({ business_id: s.business_id, published: true }).sort({ sort: 1, created_date: -1 }).lean(),
      ]);
      M.FbSettings.updateOne({ _id: s._id }, { $inc: { views: 1 } }).catch(() => {});
      const st = await licenseState(s.business_id);
      res.json({ success: true, data: { ...shelfOut(s, business), lead: shelfLead(s, st), categories: cats.map((c) => ({ _id: c._id, name: c.name, about: c.about, slug: c.slug })), books: books.map(cardOut) } });
    }),
  );
  prop.app.get(
    "/api/public/fb-cat/:slug",
    handle(async (req, res) => {
      const c = await M.FbCategory.findOne({ slug: String(req.params.slug || "").toLowerCase(), active: true }).lean();
      if (!c) throw new Bad(MSG.off, 404, { code: "not_found" });
      const business = await liveBusiness(c.business_id);
      const s = await M.FbSettings.findOne({ business_id: c.business_id }).lean();
      const books = await M.FbBook.find({ business_id: c.business_id, published: true, category_ids: c._id }).sort({ sort: 1, created_date: -1 }).lean();
      M.FbCategory.updateOne({ _id: c._id }, { $inc: { views: 1 } }).catch(() => {});
      const st = await licenseState(c.business_id);
      res.json({ success: true, data: { ...shelfOut(s, business), lead: shelfLead(s, st), category: { _id: c._id, name: c.name, about: c.about, slug: c.slug }, books: books.map(cardOut) } });
    }),
  );
  async function publicBook(slug) {
    const b = await M.FbBook.findOne({ slug: String(slug || "").toLowerCase(), published: true }).lean();
    if (!b) throw new Bad(MSG.off, 404, { code: "not_found" });
    const business = await liveBusiness(b.business_id);
    const s = await M.FbSettings.findOne({ business_id: b.business_id }).lean();
    return { b, business, s };
  }
  prop.app.get(
    "/api/public/book/:slug",
    handle(async (req, res) => {
      const { b, business, s } = await publicBook(req.params.slug);
      const st = await licenseState(b.business_id);
      const theme = b.reader_theme && st.readerThemes.includes(b.reader_theme) ? b.reader_theme : st.readerThemes.includes(s.reader_theme) ? s.reader_theme : "classic";
      const head = {
        slug: b.slug,
        title: b.title,
        about: b.about,
        pages: b.file.pages,
        width: b.file.width,
        height: b.file.height,
        cover: cloud.pdfPageUrl(b.file.public_id, 1, 500),
        shelf: shelfOut(s, business),
        reader_theme: theme,
        sound: s.sound,
        edition: b.edition,
      };
      const locked = !!b.password_hash && st.passwords.includes(String(b._id));
      if (locked && req.query.t !== tokenFor(b)) return res.json({ success: true, data: { ...head, locked: true } });
      const lf = b.lead_form || {};
      const lead =
        lf.mode && lf.mode !== "off" && st.addons.fb_leads?.active
          ? { mode: lf.mode, page: lf.page || 3, ask_email: !!lf.ask_email, ask_telegram: !!lf.ask_telegram, ask_note: !!lf.ask_note, skip: !!lf.skip, title: lf.title || "", message: lf.message || "" }
          : null;
      const links = st.addons.fb_links?.active ? (b.links || []).map((l) => ({ page: l.page, x: l.x, y: l.y, w: l.w, h: l.h, kind: l.kind, value: l.value, label: l.label })) : [];
      res.json({ success: true, data: { ...head, locked: false, page_url: pageTpl(b.file.public_id, 1400), page_hd: pageTpl(b.file.public_id, 2600), thumb_url: pageTpl(b.file.public_id, 220), pdf: b.download ? b.file.url : "", lead, links } });
    }),
  );
  const tries = new Map();
  prop.app.post(
    "/api/public/book/:slug/unlock",
    handle(async (req, res) => {
      const { b } = await publicBook(req.params.slug);
      const key = `${b._id}:${req.ip}`;
      const now = Date.now();
      const list = (tries.get(key) || []).filter((t) => now - t < 10 * 60000);
      if (list.length >= 10) throw new Bad(MSG.slow, 429, { code: "slow" });
      tries.set(key, [...list, now]);
      if (tries.size > 5000) tries.clear();
      if (!b.password_hash || !checkPass(String(req.body?.password || ""), b.password_hash)) throw new Bad(MSG.wrongPassword, 401, { code: "wrong_password" });
      res.json({ success: true, data: { token: tokenFor(b) } });
    }),
  );
  // one contact left by a reader (book form, or the "Contact us" button of the library / a category)
  const leadTries = new Map();
  async function saveLead(req, { business_id, book_id = null, category_ids = [], source, form, page = 0, pages = 0 }) {
    const key = `${business_id}:${source}:${req.ip}`;
    const now = Date.now();
    const list = (leadTries.get(key) || []).filter((t) => now - t < 10 * 60000);
    if (list.length >= 10) throw new Bad(MSG.slow, 429, { code: "slow" });
    leadTries.set(key, [...list, now]);
    if (leadTries.size > 5000) leadTries.clear();
    const body = req.body || {};
    const str = (v, max) =>
      String(v || "")
        .trim()
        .slice(0, max);
    const name = str(body.name, 80);
    const phone = str(body.phone, 30);
    const email = form.ask_email ? str(body.email, 120) : "";
    if (!name) throw new Bad(MSG.leadName, 400, { code: "lead_name" });
    if ((phone.match(/\d/g) || []).length < 6 || !/^[+\d\s().-]+$/.test(phone)) throw new Bad(MSG.leadPhone, 400, { code: "lead_phone" });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Bad(MSG.leadEmail, 400, { code: "lead_email" });
    const pg = Number(page);
    await M.FbLead.create({
      business_id,
      book_id,
      category_ids,
      source,
      name,
      phone,
      email,
      telegram: form.ask_telegram ? str(body.telegram, 60) : "",
      note: form.ask_note ? str(body.note, 500) : "",
      page: Number.isInteger(pg) && pg >= 1 && pg <= pages ? pg : 0,
    });
  }
  prop.app.post(
    "/api/public/book/:slug/lead",
    handle(async (req, res) => {
      const { b } = await publicBook(req.params.slug);
      const st = await licenseState(b.business_id);
      const lf = b.lead_form || {};
      if (!lf.mode || lf.mode === "off" || !st.addons.fb_leads?.active) throw new Bad(MSG.leadOff, 400, { code: "lead_off" });
      await saveLead(req, { business_id: b.business_id, book_id: b._id, category_ids: b.category_ids || [], source: "book", form: lf, page: req.body?.page, pages: b.file.pages });
      await M.FbBook.updateOne({ _id: b._id }, { $inc: { leads: 1 } });
      res.status(201).json({ success: true });
    }),
  );
  // "Contact us" on the library (or one category page: body.category = its slug)
  prop.app.post(
    "/api/public/fb/:slug/lead",
    handle(async (req, res) => {
      const s = await M.FbSettings.findOne({ slug: String(req.params.slug || "").toLowerCase() }).lean();
      if (!s) throw new Bad(MSG.off, 404, { code: "not_found" });
      await liveBusiness(s.business_id);
      const st = await licenseState(s.business_id);
      const lf = s.lead_form || {};
      if (!lf.on || !st.addons.fb_leads?.active) throw new Bad(MSG.leadOff, 400, { code: "lead_off" });
      let cats = [];
      let source = "library";
      if (req.body?.category) {
        const c = await M.FbCategory.findOne({ business_id: s.business_id, slug: String(req.body.category).toLowerCase() })
          .select("_id")
          .lean();
        if (c) {
          cats = [c._id];
          source = "category";
        }
      }
      await saveLead(req, { business_id: s.business_id, category_ids: cats, source, form: lf });
      res.status(201).json({ success: true });
    }),
  );
  prop.app.post(
    "/api/public/book/:slug/hit",
    handle(async (req, res) => {
      const { b } = await publicBook(req.params.slug);
      const day = localDay();
      const page = Number(req.body?.page);
      // two first hits of a day at once can both try to make the row: the loser just tries again
      const inc = (u) =>
        M.FbStat.updateOne({ business_id: b.business_id, book_id: b._id, day }, { $inc: u }, { upsert: true }).catch((e) =>
          e.code === 11000 ? M.FbStat.updateOne({ business_id: b.business_id, book_id: b._id, day }, { $inc: u }) : Promise.reject(e),
        );
      if (req.body?.page !== undefined) {
        if (Number.isInteger(page) && page >= 1 && page <= b.file.pages) await inc({ [`pages.${page}`]: 1 }); // a wrong page is ignored
      } else await Promise.all([inc({ views: 1 }), M.FbBook.updateOne({ _id: b._id }, { $inc: { views: 1 } })]);
      res.json({ success: true });
    }),
  );
};
module.exports.LIMIT = LIMIT;
module.exports.FREE = FREE;
