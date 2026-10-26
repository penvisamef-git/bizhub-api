// QR Code Generator (25 coins once). Named QR codes that open a link, a text page, a file, a form, a contact card, a map,
// or join Wi-Fi / call / SMS. The printed code points at /x/<slug>, so the owner can change what it opens without reprinting.
// Owner base: /api/user/businesses/:id/qrgen
//   GET  ""                      overview (settings, add-ons, prices, designs owned, file room, folders, telegram, counts)
//   PUT  /settings { color }     POST/DELETE /logo
//   GET/POST /folders  PUT/DELETE /folders/:fid
//   GET  /codes?folder&q&type    POST /codes      GET/PUT/DELETE /codes/:cid
//   POST /codes/:cid/file (multipart "file": PDF / image ≤ 4 MB)   10 files free, +10 for 25 coins ("qr_file_pack")
//   POST /codes/:cid/password { password }   DELETE /codes/:cid/password      (qr_rules)
//   POST /bulk { folder_id, type: url|text, rows: [{ name, value }] }          (qr_bulk)
//   POST /designs/:key           buy one QR design (qr_design, 5 coins) and keep it
//   POST /file-packs { n }       n × 10 more files
//   GET  /replies?code&unread&page   PUT /replies/:rid { read }   PUT /replies-read-all { code }   DELETE /replies/:rid
//   GET  /stats?days&code        GET /scans?code&page          (qr_stats; device + city with qr_geo)
//   GET/DELETE /telegram   POST /telegram/link   POST /telegram/test      (qr_telegram)
// Public:
//   GET  /api/public/qr/:slug?t=&p=1      (p=1 = owner preview, not counted)
//   POST /api/public/qr/:slug/unlock { password } → { token }
//   POST /api/public/qr/:slug/reply { answers: { key: value } }
const mongoose = require("mongoose");
const crypto = require("crypto");
const multer = require("multer");
const { UAParser } = require("ua-parser-js");
const M = require("./qrgen.models");
const { DESIGNS, TEMPLATES, THEMES, PRINTS } = require("./qrgen.designs");
const Business = require("../business.model");
const { bizOwner, roleIn } = require("../team/team.access"); // team members (Admin / View only) open it too
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const coin = require("../../coin/coin.service");
const { statusOf, buy, LicenseError } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");
const cloud = require("../../util/cloudinary");
const telegram = require("../../telegram");

const FREE_FILES = 10;
const PACK = 10;
const ADDONS = ["qr_forms", "qr_telegram", "qr_stats", "qr_geo", "qr_bulk", "qr_rules", "qr_links", "qr_coupons", "qr_nobrand", "qr_form_pro", "qr_smart"];
const TYPES = ["url", "text", "file", "form", "vcard", "map", "wifi", "phone", "sms", "links", "coupon"];
const FIELD_KINDS = ["text", "textarea", "select", "checkbox", "radio", "phone", "email", "number", "date", "photo", "rating", "signature"];
const PRO_KINDS = ["photo", "rating", "signature"]; // form extras (qr_form_pro)
const LINK_KINDS = ["web", "facebook", "tiktok", "telegram", "instagram", "youtube", "x", "whatsapp", "messenger", "line", "linkedin", "phone", "email", "map", "shop"];
const TRASH_DAYS = 30;
const RESERVED = new Set(["admin", "api", "app", "login", "bizhub", "help", "www", "static", "assets", "new", "edit", "r"]);
const UPLOAD_URL = { test: (v) => /^https:\/\/res\.cloudinary\.com\//.test(v) || (process.env.NODE_ENV === "test" && /^http:\/\/127\.0\.0\.1:\d+\//.test(v)) }; // our own uploads only
const TZ = 7;
const MAX = { codes: 5000, folders: 200, fields: 30, options: 20, bulk: 500 };
const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  notQr: "អាជីវកម្មនេះមិនមែនជា QR Code Generator ទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  rowNotFound: "រកមិនឃើញទិន្នន័យ!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
  required: "សូមបំពេញ",
  tooLong: "អត្ថបទវែងពេក!",
  badValue: "តម្លៃមិនត្រឹមត្រូវ!",
  tooMany: "ច្រើនពេក!",
  needForms: "សូមដោះសោ “Form QR” ជាមុនសិន!",
  needRules: "សូមដោះសោ “ច្បាប់ QR” ជាមុនសិន!",
  needBulk: "សូមដោះសោ “បង្កើត QR ច្រើន” ជាមុនសិន!",
  needStats: "សូមដោះសោ “ស្ថិតិការស្កេន” ជាមុនសិន!",
  needTelegram: "សូមដោះសោ “ការជូនដំណឹង Telegram” ជាមុនសិន!",
  notOwned: "សូមទិញម៉ូដនេះជាមុនសិន!",
  filesFull: "កន្លែងឯកសារពេញហើយ! សូមលុបឯកសារចាស់ ឬទិញបន្ថែម 10 ឯកសារ។",
  badFile: "សូមដាក់ PDF ឬរូបភាព JPG / PNG / WEBP (តិចជាង 4MB)!",
  badImage: "សូមដាក់រូបភាព JPG / PNG / WEBP (តិចជាង 4MB)!",
  noFile: "រកមិនឃើញឯកសារដែលបានផ្ទុកឡើង!",
  badUrl: "តំណមិនត្រឹមត្រូវ!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  off: "QR នេះមិនមាន ឬត្រូវបានផ្អាក។",
  wrongPassword: "ពាក្យសម្ងាត់មិនត្រឹមត្រូវ!",
  badPassword: "ពាក្យសម្ងាត់ត្រូវមាន 4 ទៅ 40 តួ!",
  slow: "សូមរង់ចាំបន្តិច រួចព្យាយាមម្តងទៀត។",
  formOff: "ទម្រង់នេះបិទហើយ។",
  fieldRequired: "សូមបំពេញ៖",
  tgNotConfigured: "ក្រុមការងារ BizHub មិនទាន់រៀបចំ Telegram bot ទេ។ សូមព្យាយាមពេលក្រោយ។",
  tgNotConnected: "មិនទាន់ភ្ជាប់ Telegram ទេ!",
  tgBlocked: "Telegram នេះបានបិទ bot ហើយ។ សូមភ្ជាប់ម្តងទៀត។",
  tgUnreachable: "មិនអាចទាក់ទង Telegram បានទេ សូមព្យាយាមម្តងទៀត។",
  tgSent: "បានផ្ញើសារសាកល្បង!",
  needLinks: "សូមដោះសោ “ទំព័រតំណ” ជាមុនសិន!",
  needCoupons: "សូមដោះសោ “QR គូប៉ុង” ជាមុនសិន!",
  needFormPro: "សូមដោះសោ “ទម្រង់ពិសេស” ជាមុនសិន (រូបថត ហត្ថលេខា ផ្កាយ សំណួរតាមលក្ខខណ្ឌ)!",
  needSmart: "សូមដោះសោ “តំណឆ្លាតវៃ” ជាមុនសិន!",
  badSlug: "ឈ្មោះតំណត្រូវមាន 3 ទៅ 30 តួ (a-z, 0-9, -)!",
  slugTaken: "ឈ្មោះតំណនេះមានគេប្រើហើយ!",
  couponGone: "គូប៉ុងអស់ហើយ!",
  couponEnded: "គូប៉ុងនេះផុតកំណត់ហើយ!",
  couponNotFound: "រកមិនឃើញលេខគូប៉ុងនេះទេ!",
  couponUsed: "គូប៉ុងនេះបានប្រើរួចហើយ!",
  wrongPin: "លេខ PIN មិនត្រឹមត្រូវ!",
  badPin: "លេខ PIN ត្រូវមាន 4 ទៅ 6 ខ្ទង់!",
  noPin: "សូមដាក់លេខ PIN សម្រាប់បុគ្គលិកជាមុនសិន!",
  badTime: "ម៉ោងមិនត្រឹមត្រូវ (HH:MM)!",
};
class Bad extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const validId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && String(v).length === 24;
const str = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
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
const color = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? String(v) : undefined);
const colorOrEmpty = (v) => (v === "" ? "" : color(v));
const localDay = (d = new Date()) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const URL_RE = /^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/i;
const fullUrl = (v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`);
const SLUG_ABC = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
async function newSlug() {
  for (let i = 0; i < 20; i++) {
    const b = crypto.randomBytes(7);
    const s = [...b].map((x) => SLUG_ABC[x % SLUG_ABC.length]).join("");
    if (!(await M.QgCode.exists({ slug: s }))) return s;
  }
  return crypto.randomBytes(6).toString("hex");
}
const hashPass = (p) => {
  const salt = crypto.randomBytes(8).toString("hex");
  return `${salt}:${crypto.scryptSync(String(p), salt, 32).toString("hex")}`;
};
const checkPass = (p, stored) => {
  const [salt, h] = String(stored || "").split(":");
  if (!salt || !h) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(String(p), salt, 32), Buffer.from(h, "hex"));
};
const secret = () => process.env.JWT_SECRET || "bizhub";
const tokenFor = (code) => crypto.createHmac("sha256", secret()).update(`${code._id}:${code.rules?.password_hash}`).digest("hex").slice(0, 32);

// midnight today in Cambodia (UTC+7)
const startOfToday = () => {
  const d = new Date(Date.now() + 7 * 3600000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 7 * 3600000);
};

async function licenseState(businessId) {
  const rows = await License.find({ business_id: businessId, product: { $in: [...ADDONS, "qr_design", "qr_theme", "qr_slug", "qr_print"] } }).lean();
  const addons = {};
  for (const key of ADDONS) addons[key] = statusOf(rows.find((r) => r.product === key && !r.item));
  const designs = ["plain", ...rows.filter((r) => r.product === "qr_design" && r.item && statusOf(r).active).map((r) => r.item)];
  const themes = rows.filter((r) => r.product === "qr_theme" && r.item && statusOf(r).active).map((r) => r.item);
  const items = (product) => rows.filter((r) => r.product === product && r.item && statusOf(r).active).map((r) => String(r.item));
  return { addons, designs, themes, slugs: items("qr_slug"), prints: items("qr_print") };
}
async function settingsOf(business) {
  const found = await M.QgSettings.findOne({ business_id: business._id });
  if (found) return found;
  try {
    return await M.QgSettings.create({ business_id: business._id });
  } catch (err) {
    if (err.code === 11000) return M.QgSettings.findOne({ business_id: business._id });
    throw err;
  }
}
const uploadImg = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});
const uploadAny = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});

// ---------- Telegram messages ----------
const esc = telegram.escape;
const when = (d) => new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Phnom_Penh" });
async function tgSend(bid, html) {
  try {
    if (!telegram.ready()) return false;
    const s = await M.QgSettings.findOne({ business_id: bid }).lean();
    if (!s?.tg?.chat_id) return false;
    const st = await licenseState(bid);
    if (!st.addons.qr_telegram?.active) return false;
    await telegram.send(s.tg.chat_id, html);
    return true;
  } catch (err) {
    if (err instanceof telegram.TelegramError && err.message === "blocked") await M.QgSettings.updateOne({ business_id: bid }, { $set: { "tg.chat_id": "" } }).catch(() => {});
    return false;
  }
}

module.exports = (prop) => {
  const base = "/api/user/businesses/:id/qrgen";
  const guard = [prop.api_auth, customer_auth];
  async function ctxOf(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    const [business, state] = await Promise.all([Business.findOne({ _id: req.params.id, ...bizOwner(req), deleted: false }), licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== "qr_gen") throw new Bad(MSG.notQr);
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
      if (err?.name === "ValidationError" || err?.name === "CastError") return res.status(400).json({ success: false, message: MSG.badValue });
      if (err?.isCloudinary) return res.status(err.status).json({ success: false, message: err.message });
      console.error("[qrgen]", err);
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
    if (!ctx.addons[key]?.active) throw new Bad(msg, 402, { code: "need_addon", product: key });
  };
  const files = async (ctx) => ({ count: await M.QgCode.countDocuments({ business_id: ctx.business._id, "file.public_id": { $gt: "" } }), capacity: FREE_FILES + (ctx.settings.file_packs || 0) * PACK, free: FREE_FILES, pack: PACK });
  const tgOut = (s, addons) => ({ configured: telegram.ready(), active: !!addons.qr_telegram?.active, connected: !!s.tg?.chat_id, chat_name: s.tg?.chat_name || "", connected_at: s.tg?.connected_at || null });
  const settingsOut = (s) => ({ _id: s._id, logo: s.logo, color: s.color, file_packs: s.file_packs, weekly: s.tg?.weekly !== false });
  const codeOut = (c) => {
    const { pin_hash, ...coupon } = c.coupon || {};
    return { ...c, coupon: { ...coupon, has_pin: !!pin_hash }, has_password: !!c.rules?.password_hash, rules: { expires_at: c.rules?.expires_at || null, max_scans: c.rules?.max_scans || 0 } };
  };

  // ---------------------------------------- overview + settings ----------------------------------------
  async function overview(ctx) {
    const bid = ctx.business._id;
    const keys = [...ADDONS, "qr_design", "qr_theme", "qr_file_pack", "qr_slug", "qr_print"];
    const [prices, f, codes, unread, folders] = await Promise.all([
      Promise.all(keys.map((k) => priceOf(k))),
      files(ctx),
      M.QgCode.countDocuments({ business_id: bid, deleted_at: null }),
      M.QgReply.countDocuments({ business_id: bid, read: false }),
      M.QgFolder.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }).lean(),
    ]);
    const price = Object.fromEntries(keys.map((k, i) => [k, prices[i]]));
    return {
      business: { _id: bid, name: ctx.business.name, status: ctx.business.status },
      settings: settingsOut(ctx.settings),
      addons: Object.fromEntries(ADDONS.map((k) => [k, { ...ctx.addons[k], price: price[k], days: require("../../license/license.products").PRODUCTS[k]?.days || null }])),
      prices: price,
      designs: ctx.designs,
      themes: ctx.themes,
      prints: ctx.prints,
      slugs: ctx.slugs,
      files: f,
      folders,
      counts: { codes, unread, trash: await M.QgCode.countDocuments({ business_id: bid, deleted_at: { $ne: null } }) },
      telegram: tgOut(ctx.settings, ctx.addons),
    };
  }
  own("get", "", false, async (ctx, req, res) => res.json({ success: true, data: await overview(ctx) }));
  own("put", "/settings", true, async (ctx, req, res) => {
    const c = color(req.body?.color);
    if (req.body?.color !== undefined && !c) throw new Bad(MSG.badValue);
    if (c) ctx.settings.color = c;
    if (req.body?.weekly !== undefined) ctx.settings.set("tg.weekly", req.body.weekly !== false);
    await ctx.settings.save();
    res.json({ success: true, data: settingsOut(ctx.settings), message: MSG.saved });
  });
  const imgMw = (req, res, next) =>
    uploadImg.single("photo")(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: MSG.badImage });
      next();
    });
  own(
    "post",
    "/logo",
    true,
    async (ctx, req, res) => {
      if (!req.file) throw new Bad(MSG.noFile);
      const saved = await cloud.uploadBuffer(req.file, "qrgen");
      const old = ctx.settings.logo?.public_id;
      ctx.settings.logo = { url: saved.url, public_id: saved.public_id || "" };
      await ctx.settings.save();
      if (old) cloud.deleteFile(old).catch(() => {});
      require("../dashboard.route").forget(ctx.business.owner_id);
      res.json({ success: true, data: settingsOut(ctx.settings), message: MSG.saved });
    },
    [imgMw],
  );
  own("delete", "/logo", true, async (ctx, req, res) => {
    const old = ctx.settings.logo?.public_id;
    ctx.settings.logo = { url: "", public_id: "" };
    await ctx.settings.save();
    if (old) cloud.deleteFile(old).catch(() => {});
    require("../dashboard.route").forget(ctx.business.owner_id);
    res.json({ success: true, data: settingsOut(ctx.settings), message: MSG.deleted });
  });

  // ---------------------------------------- folders ----------------------------------------
  own("get", "/folders", false, async (ctx, req, res) => res.json({ success: true, data: await M.QgFolder.find({ business_id: ctx.business._id }).sort({ sort: 1, created_date: 1 }).lean() }));
  own("post", "/folders", true, async (ctx, req, res) => {
    const n = await M.QgFolder.countDocuments({ business_id: ctx.business._id });
    if (n >= MAX.folders) throw new Bad(MSG.tooMany);
    const row = await M.QgFolder.create({ business_id: ctx.business._id, name: text(req.body || {}, "name", 60, { required: true }), sort: n });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  own("put", "/folders/:fid", true, async (ctx, req, res) => {
    if (!validId(req.params.fid)) throw new Bad(MSG.badId);
    const row = await M.QgFolder.findOneAndUpdate({ _id: req.params.fid, business_id: ctx.business._id }, { $set: { name: text(req.body || {}, "name", 60, { required: true }) } }, { returnDocument: "after" });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, data: row, message: MSG.saved });
  });
  own("delete", "/folders/:fid", true, async (ctx, req, res) => {
    if (!validId(req.params.fid)) throw new Bad(MSG.badId);
    const row = await M.QgFolder.findOneAndDelete({ _id: req.params.fid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    await M.QgCode.updateMany({ business_id: ctx.business._id, folder_id: row._id }, { $set: { folder_id: null } });
    res.json({ success: true, message: MSG.deleted });
  });

  // ---------------------------------------- codes ----------------------------------------
  // read what the owner sent for one code (only the parts of its type)
  async function readCode(ctx, b, current) {
    const set = {};
    if (b.name !== undefined) set.name = text(b, "name", 80, { required: true });
    const type = b.type !== undefined ? b.type : current?.type;
    if (!TYPES.includes(type)) throw new Bad(`${MSG.badValue} (type)`);
    if (b.type !== undefined) set.type = type;
    if (type === "form") need(ctx, "qr_forms", MSG.needForms);
    if (type === "links" && b.type !== undefined) need(ctx, "qr_links", MSG.needLinks);
    if (type === "coupon" && b.type !== undefined) need(ctx, "qr_coupons", MSG.needCoupons);
    if (b.folder_id !== undefined) {
      if (b.folder_id && !(validId(b.folder_id) && (await M.QgFolder.exists({ _id: b.folder_id, business_id: ctx.business._id })))) throw new Bad(`${MSG.badValue} (folder)`);
      set.folder_id = b.folder_id || null;
    }
    if (b.active !== undefined) set.active = b.active === true;
    if (b.notify_scan !== undefined) {
      if (b.notify_scan === true) need(ctx, "qr_telegram", MSG.needTelegram);
      set.notify_scan = b.notify_scan === true;
    }
    if (b.url !== undefined) {
      const u = str(b.url, 2000);
      if (u && !URL_RE.test(u)) throw new Bad(MSG.badUrl, 400, { code: "bad_url" });
      set.url = u ? fullUrl(u) : "";
    }
    if (b.smart) {
      const sm = b.smart;
      const has = sm.ios || sm.android || (Array.isArray(sm.times) && sm.times.some((t) => t?.url));
      if (has) need(ctx, "qr_smart", MSG.needSmart);
      const link = (v) => {
        const u = str(v, 2000);
        if (u && !URL_RE.test(u)) throw new Bad(MSG.badUrl, 400, { code: "bad_url" });
        return u ? fullUrl(u) : "";
      };
      const hm = (v) => {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""))) throw new Bad(MSG.badTime, 400, { code: "bad_time" });
        return v;
      };
      set.smart = {
        ios: link(sm.ios),
        android: link(sm.android),
        times: (Array.isArray(sm.times) ? sm.times : [])
          .slice(0, 6)
          .filter((t) => t?.url)
          .map((t) => ({ from: hm(t.from), to: hm(t.to), url: link(t.url) })),
      };
    }
    if (b.links) {
      set.links = (Array.isArray(b.links) ? b.links : [])
        .slice(0, 20)
        .map((l) => {
          const kind = LINK_KINDS.includes(l?.kind) ? l.kind : "web";
          let url = str(l?.url, 600);
          if (!url) return null;
          if (kind === "phone") url = url.replace(/[^+\d]/g, "");
          else if (kind === "email") {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url)) throw new Bad(MSG.badUrl, 400, { code: "bad_url" });
          } else if (kind === "telegram" && /^@?[a-z0-9_]{4,}$/i.test(url)) url = `https://t.me/${url.replace(/^@/, "")}`;
          else {
            if (!URL_RE.test(url)) throw new Bad(MSG.badUrl, 400, { code: "bad_url" });
            url = fullUrl(url);
          }
          return { kind, label: str(l?.label, 60), url };
        })
        .filter(Boolean);
    }
    if (b.coupon) {
      const cp = b.coupon;
      const ends = cp.ends_at ? new Date(cp.ends_at) : null;
      if (ends && Number.isNaN(ends.getTime())) throw new Bad(`${MSG.badValue} (ends_at)`);
      set["coupon.title"] = str(cp.title, 120);
      set["coupon.offer"] = str(cp.offer, 60);
      set["coupon.terms"] = str(cp.terms, 1000);
      set["coupon.ends_at"] = ends;
      set["coupon.limit"] = Math.max(0, Math.min(1000000, Math.round(Number(cp.limit) || 0)));
      if (cp.pin !== undefined && cp.pin !== "") {
        if (!/^\d{4,6}$/.test(String(cp.pin))) throw new Bad(MSG.badPin, 400, { code: "bad_pin" });
        set["coupon.pin_hash"] = hashPass(String(cp.pin));
      }
    }
    if (b.text) set.text = { title: str(b.text.title, 160), body: String(b.text.body ?? "").slice(0, 8000) };
    if (b.vcard) set.vcard = Object.fromEntries(Object.entries({ name: 80, org: 80, job: 80, phone: 40, phone2: 40, email: 120, website: 200, address: 300 }).map(([k, max]) => [k, str(b.vcard[k], max)]));
    if (b.map) {
      const link = str(b.map.link, 600);
      if (link && !URL_RE.test(link)) throw new Bad(MSG.badUrl, 400, { code: "bad_url" });
      set.map = { place: str(b.map.place, 160), link: link ? fullUrl(link) : "", note: str(b.map.note, 300) };
    }
    if (b.wifi) set.wifi = { ssid: String(b.wifi.ssid ?? "").slice(0, 64), password: String(b.wifi.password ?? "").slice(0, 64), security: ["WPA", "WEP", "nopass"].includes(b.wifi.security) ? b.wifi.security : "WPA", hidden: b.wifi.hidden === true };
    if (b.phone) set.phone = { number: str(b.phone.number, 40), body: String(b.phone.body ?? "").slice(0, 300) };
    if (b.form) {
      const f = b.form;
      const fields = Array.isArray(f.fields) ? f.fields.slice(0, MAX.fields) : [];
      const used = new Set();
      set.form = {
        title: str(f.title, 160),
        intro: str(f.intro, 1000),
        button: str(f.button, 40),
        thanks: str(f.thanks, 300),
        fields: fields.map((x, i) => {
          let key = /^[a-z0-9_]{1,20}$/.test(String(x?.key || "")) ? x.key : `f${i + 1}`;
          while (used.has(key)) key = `${key.slice(0, 16)}_${i}`;
          used.add(key);
          const kind = FIELD_KINDS.includes(x?.kind) ? x.kind : "text";
          const label = str(x?.label, 120);
          if (!label) throw new Bad(`${MSG.required}: label`);
          const options = ["select", "checkbox", "radio"].includes(kind)
            ? (Array.isArray(x.options) ? x.options : [])
                .map((o) => str(o, 80))
                .filter(Boolean)
                .slice(0, MAX.options)
            : [];
          if (["select", "radio"].includes(kind) && !options.length) throw new Bad(`${MSG.required}: options (${label})`);
          const show = x?.show_if?.key ? { key: str(x.show_if.key, 20), value: str(x.show_if.value, 80) } : { key: "", value: "" };
          return { key, label, kind, options, required: x?.required === true, placeholder: str(x?.placeholder, 120), show_if: show };
        }),
      };
      // field keys that a condition points at must exist (earlier in the form)
      for (const [i, x] of set.form.fields.entries()) if (x.show_if.key && !set.form.fields.slice(0, i).some((y) => y.key === x.show_if.key)) x.show_if = { key: "", value: "" };
      if (set.form.fields.some((x) => PRO_KINDS.includes(x.kind) || x.show_if.key)) need(ctx, "qr_form_pro", MSG.needFormPro);
    }
    if (b.page) {
      const p = b.page;
      set.page = {
        template: TEMPLATES.includes(p.template) || THEMES.includes(p.template) ? p.template : "card",
        color: color(p.color) || ctx.settings.color || "#E0581A",
        header: str(p.header, 120),
        footer: str(p.footer, 200),
        rows: (Array.isArray(p.rows) ? p.rows : [])
          .slice(0, 20)
          .map((r) => ({ label: str(r?.label, 60), value: str(r?.value, 300) }))
          .filter((r) => r.label || r.value),
        logo: p.logo !== false,
      };
    }
    if (set.page && THEMES.includes(set.page.template) && !ctx.themes.includes(set.page.template)) throw new Bad(MSG.notOwned, 402, { code: "not_owned", product: "qr_theme", item: set.page.template });
    if (b.design) {
      const d = b.design;
      const key = d.key === "plain" || DESIGNS.includes(d.key) ? d.key : "plain";
      if (!ctx.designs.includes(key)) throw new Bad(MSG.notOwned, 402, { code: "not_owned", product: "qr_design", item: key });
      set.design = { key, color: colorOrEmpty(d.color) ?? "", bg: colorOrEmpty(d.bg) ?? "", accent: colorOrEmpty(d.accent) ?? "", label: str(d.label, 40), logo: d.logo === true };
    }
    if (b.rules) {
      need(ctx, "qr_rules", MSG.needRules);
      const exp = b.rules.expires_at ? new Date(b.rules.expires_at) : null;
      if (exp && Number.isNaN(exp.getTime())) throw new Bad(`${MSG.badValue} (expires_at)`);
      const max = Math.max(0, Math.min(10000000, Math.round(Number(b.rules.max_scans) || 0)));
      set["rules.expires_at"] = exp;
      set["rules.max_scans"] = max;
    }
    return set;
  }
  const loadCode = async (ctx, cid, trashed = false) => {
    if (!validId(cid)) throw new Bad(MSG.badId);
    const row = await M.QgCode.findOne({ _id: cid, business_id: ctx.business._id, deleted_at: trashed ? { $ne: null } : null });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  // gone for good: the code, its scans, answers, coupons and file
  async function purge(row) {
    await M.QgCode.deleteOne({ _id: row._id });
    await Promise.all([M.QgScan.deleteMany({ code_id: row._id }), M.QgReply.deleteMany({ code_id: row._id }), M.QgCoupon.deleteMany({ code_id: row._id })]);
    if (row.file?.public_id) cloud.deleteFile(row.file.public_id, row.file.kind === "pdf" ? "raw" : "image").catch(() => {});
  }
  const purgeOld = async (bid) => {
    const old = await M.QgCode.find({ business_id: bid, deleted_at: { $ne: null, $lt: new Date(Date.now() - TRASH_DAYS * 86400000) } }).limit(200);
    for (const row of old) await purge(row);
  };
  own("get", "/codes", false, async (ctx, req, res) => {
    const filter = { business_id: ctx.business._id, deleted_at: null };
    if (req.query.folder === "none") filter.folder_id = null;
    else if (validId(req.query.folder)) filter.folder_id = req.query.folder;
    if (TYPES.includes(req.query.type)) filter.type = req.query.type;
    const q = str(req.query.q, 60);
    if (q) filter.name = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const rows = await M.QgCode.find(filter).sort({ created_date: -1 }).limit(MAX.codes).lean();
    res.json({ success: true, data: rows.map(codeOut) });
  });
  own("post", "/codes", true, async (ctx, req, res) => {
    const n = await M.QgCode.countDocuments({ business_id: ctx.business._id, deleted_at: null });
    if (n >= MAX.codes) throw new Bad(MSG.tooMany);
    const b = req.body || {};
    const set = await readCode(ctx, { ...b, name: b.name ?? "" }, null);
    const row = await M.QgCode.create({ business_id: ctx.business._id, slug: await newSlug(), page: { color: ctx.settings.color }, ...set });
    res.status(201).json({ success: true, data: codeOut(row.toObject()), message: MSG.saved });
  });
  own("get", "/codes/:cid", false, async (ctx, req, res) => res.json({ success: true, data: codeOut((await loadCode(ctx, req.params.cid)).toObject()) }));
  own("put", "/codes/:cid", true, async (ctx, req, res) => {
    const row = await loadCode(ctx, req.params.cid);
    const set = await readCode(ctx, req.body || {}, row);
    const out = await M.QgCode.findOneAndUpdate({ _id: row._id }, { $set: set }, { returnDocument: "after", runValidators: true }).lean();
    res.json({ success: true, data: codeOut(out), message: MSG.saved });
  });
  // delete = move to the trash (the link stops working; restore within 30 days)
  own("delete", "/codes/:cid", true, async (ctx, req, res) => {
    const row = await loadCode(ctx, req.params.cid);
    row.deleted_at = new Date();
    await row.save();
    res.json({ success: true, files: await files(ctx), message: MSG.deleted });
  });
  own("get", "/trash", false, async (ctx, req, res) => {
    await purgeOld(ctx.business._id);
    const rows = await M.QgCode.find({ business_id: ctx.business._id, deleted_at: { $ne: null } })
      .sort({ deleted_at: -1 })
      .limit(500)
      .lean();
    res.json({ success: true, data: rows.map(codeOut), days: TRASH_DAYS });
  });
  own("post", "/codes/:cid/restore", true, async (ctx, req, res) => {
    const row = await loadCode(ctx, req.params.cid, true);
    row.deleted_at = null;
    await row.save();
    res.json({ success: true, data: codeOut(row.toObject()), message: MSG.saved });
  });
  own("delete", "/trash/:cid", true, async (ctx, req, res) => {
    const row = await loadCode(ctx, req.params.cid, true);
    await purge(row);
    res.json({ success: true, files: await files(ctx), message: MSG.deleted });
  });
  own("delete", "/trash", true, async (ctx, req, res) => {
    const rows = await M.QgCode.find({ business_id: ctx.business._id, deleted_at: { $ne: null } }).limit(1000);
    for (const row of rows) await purge(row);
    res.json({ success: true, files: await files(ctx), message: MSG.deleted });
  });
  // a copy of a code (new link; no scans, answers, coupons, file or password)
  own("post", "/codes/:cid/copy", true, async (ctx, req, res) => {
    const row = await loadCode(ctx, req.params.cid);
    const n = await M.QgCode.countDocuments({ business_id: ctx.business._id, deleted_at: null });
    if (n >= MAX.codes) throw new Bad(MSG.tooMany);
    const o = row.toObject();
    for (const k of ["_id", "slug", "old_slugs", "scans", "last_scan", "replies", "unread", "created_date", "updated_date", "__v", "file"]) delete o[k];
    o.name = `${row.name} (copy)`.slice(0, 80);
    o.rules = { expires_at: o.rules?.expires_at || null, max_scans: o.rules?.max_scans || 0, password_hash: "" };
    if (o.coupon) Object.assign(o.coupon, { issued: 0, used: 0 });
    const copy = await M.QgCode.create({ ...o, slug: await newSlug() });
    res.status(201).json({ success: true, data: codeOut(copy.toObject()), message: MSG.saved });
  });
  // custom link name: /x/lucky-menu (qr_slug, one-time per QR). The old link keeps working.
  own("post", "/codes/:cid/slug", true, async (ctx, req, res) => {
    const row = await loadCode(ctx, req.params.cid);
    const slug = String(req.body?.slug || "")
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/.test(slug) || slug.includes("--") || RESERVED.has(slug)) throw new Bad(MSG.badSlug, 400, { code: "bad_slug" });
    if (slug === row.slug) return res.json({ success: true, data: codeOut(row.toObject()), charged: 0 });
    const taken = await M.QgCode.exists({ _id: { $ne: row._id }, $or: [{ slug }, { old_slugs: slug }] });
    if (taken) throw new Bad(MSG.slugTaken, 409, { code: "slug_taken" });
    let charged = 0;
    let balance;
    if (!ctx.slugs.includes(String(row._id))) {
      const r = await buy({ customer: req.customer, business: ctx.business, product: "qr_slug", item: String(row._id), expect: null });
      charged = r.charged;
      balance = r.balance;
    }
    const olds = [...new Set([...(row.old_slugs || []), row.slug])].filter((x) => x !== slug).slice(-10);
    const out = await M.QgCode.findOneAndUpdate({ _id: row._id }, { $set: { slug, old_slugs: olds } }, { returnDocument: "after" }).lean();
    res.json({ success: true, data: codeOut(out), charged, balance, message: MSG.saved });
  });
  // coupons given from a Coupon QR
  own("get", "/codes/:cid/coupons", false, async (ctx, req, res) => {
    const row = await loadCode(ctx, req.params.cid);
    const filter = { code_id: row._id };
    if (req.query.used === "1") filter.used_at = { $ne: null };
    if (req.query.used === "0") filter.used_at = null;
    const q = str(req.query.q, 20).toUpperCase();
    if (q) filter.code = new RegExp(q.replace(/[^A-Z0-9-]/g, ""));
    const page = Math.max(1, Number(req.query.page) || 1);
    const [rows, total] = await Promise.all([
      M.QgCoupon.find(filter)
        .sort({ created_date: -1 })
        .skip((page - 1) * 30)
        .limit(30)
        .lean(),
      M.QgCoupon.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data: rows.map((x) => ({ _id: x._id, code: x.code, used_at: x.used_at, created_date: x.created_date })),
      counts: { issued: row.coupon?.issued || 0, used: row.coupon?.used || 0, limit: row.coupon?.limit || 0 },
      pagination: { page, total, pages: Math.max(1, Math.ceil(total / 30)) },
    });
  });
  own("post", "/codes/:cid/coupons/redeem", true, async (ctx, req, res) => {
    const row = await loadCode(ctx, req.params.cid);
    const out = await redeem(row, req.body?.code);
    res.json({ success: true, data: out, message: MSG.saved });
  });
  // the file of a File QR (replaces the old one; counts toward the file room)
  own(
    "post",
    "/codes/:cid/file",
    true,
    async (ctx, req, res) => {
      const row = await loadCode(ctx, req.params.cid);
      if (!req.file) throw new Bad(MSG.noFile);
      if (!row.file?.public_id) {
        const f = await files(ctx);
        if (f.count >= f.capacity) throw new Bad(MSG.filesFull, 402, { code: "files_full", ...f, price: await priceOf("qr_file_pack") });
      }
      const pdf = req.file.mimetype === "application/pdf";
      const saved = await cloud.uploadBuffer(req.file, `qrgen/${ctx.business._id}`, pdf ? "raw" : "image");
      const old = row.file?.public_id ? { id: row.file.public_id, raw: row.file.kind === "pdf" } : null;
      row.file = { url: saved.url, public_id: saved.public_id || "", name: str(saved.original_name || req.file.originalname, 160), bytes: req.file.size, kind: pdf ? "pdf" : "image" };
      await row.save();
      if (old) cloud.deleteFile(old.id, old.raw ? "raw" : "image").catch(() => {});
      res.json({ success: true, data: codeOut(row.toObject()), files: await files(ctx), message: MSG.saved });
    },
    [
      (req, res, next) =>
        uploadAny.single("file")(req, res, (err) => {
          if (err) return res.status(400).json({ success: false, message: MSG.badFile });
          next();
        }),
    ],
  );
  own("post", "/codes/:cid/password", true, async (ctx, req, res) => {
    need(ctx, "qr_rules", MSG.needRules);
    const row = await loadCode(ctx, req.params.cid);
    const p = String(req.body?.password || "");
    if (p.length < 4 || p.length > 40) throw new Bad(MSG.badPassword, 400, { code: "bad_password" });
    row.rules.password_hash = hashPass(p);
    await row.save();
    res.json({ success: true, data: codeOut(row.toObject()), message: MSG.saved });
  });
  own("delete", "/codes/:cid/password", true, async (ctx, req, res) => {
    const row = await loadCode(ctx, req.params.cid);
    row.rules.password_hash = "";
    await row.save();
    res.json({ success: true, data: codeOut(row.toObject()), message: MSG.saved });
  });
  // many codes at once from an Excel list (qr_bulk)
  own("post", "/bulk", true, async (ctx, req, res) => {
    need(ctx, "qr_bulk", MSG.needBulk);
    const b = req.body || {};
    const type = b.type === "text" ? "text" : "url";
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, MAX.bulk) : [];
    if (!rows.length) throw new Bad(`${MSG.required}: rows`);
    const n = await M.QgCode.countDocuments({ business_id: ctx.business._id, deleted_at: null });
    if (n + rows.length > MAX.codes) throw new Bad(MSG.tooMany);
    let folder = null;
    if (b.folder_id) {
      if (!(validId(b.folder_id) && (await M.QgFolder.exists({ _id: b.folder_id, business_id: ctx.business._id })))) throw new Bad(`${MSG.badValue} (folder)`);
      folder = b.folder_id;
    }
    const bad = [];
    const docs = [];
    for (const [i, r] of rows.entries()) {
      const name = str(r?.name, 80);
      const value = String(r?.value ?? "").trim();
      if (!name || !value || (type === "url" && !URL_RE.test(value))) {
        bad.push(i + 1);
        continue;
      }
      docs.push({
        business_id: ctx.business._id,
        name,
        type,
        slug: await newSlug(),
        folder_id: folder,
        url: type === "url" ? fullUrl(value.slice(0, 2000)) : "",
        text: type === "text" ? { title: name, body: value.slice(0, 8000) } : undefined,
        page: { color: ctx.settings.color },
        design:
          b.design && ctx.designs.includes(b.design.key) ? { key: b.design.key, color: colorOrEmpty(b.design.color) ?? "", bg: colorOrEmpty(b.design.bg) ?? "", accent: colorOrEmpty(b.design.accent) ?? "", label: str(b.design.label, 40) } : undefined,
      });
    }
    const made = docs.length ? await M.QgCode.insertMany(docs) : [];
    res.status(201).json({ success: true, data: made.map((x) => codeOut(x.toObject())), skipped: bad, message: MSG.saved });
  });

  // ---------------------------------------- designs + file room ----------------------------------------
  own("post", "/designs/:key", true, async (ctx, req, res) => {
    const key = req.params.key;
    if (!DESIGNS.includes(key)) throw new Bad(MSG.badValue);
    let charged = 0;
    let balance;
    if (!ctx.designs.includes(key)) {
      const r = await buy({ customer: req.customer, business: ctx.business, product: "qr_design", item: key, expect: null });
      charged = r.charged;
      balance = r.balance;
    }
    res.json({ success: true, data: await overview(await ctxOf(req)), charged, balance, message: MSG.saved });
  });
  own("post", "/themes/:key", true, async (ctx, req, res) => {
    const key = req.params.key;
    if (!THEMES.includes(key)) throw new Bad(MSG.badValue);
    let charged = 0;
    let balance;
    if (!ctx.themes.includes(key)) {
      const r = await buy({ customer: req.customer, business: ctx.business, product: "qr_theme", item: key, expect: null });
      charged = r.charged;
      balance = r.balance;
    }
    res.json({ success: true, data: await overview(await ctxOf(req)), charged, balance, message: MSG.saved });
  });
  own("post", "/print/:key", true, async (ctx, req, res) => {
    const key = req.params.key;
    if (!PRINTS.includes(key)) throw new Bad(MSG.badValue);
    let charged = 0;
    let balance;
    if (!ctx.prints.includes(key)) {
      const r = await buy({ customer: req.customer, business: ctx.business, product: "qr_print", item: key, expect: null });
      charged = r.charged;
      balance = r.balance;
    }
    res.json({ success: true, data: await overview(await ctxOf(req)), charged, balance, message: MSG.saved });
  });
  own("post", "/file-packs", true, async (ctx, req, res) => {
    const n = Number(req.body?.n);
    if (!Number.isInteger(n) || n < 1 || n > 100 || (ctx.settings.file_packs || 0) + n > 1000) throw new Bad(MSG.badValue);
    const total = n * (await priceOf("qr_file_pack"));
    let tx = null;
    if (total > 0) {
      try {
        tx = await coin.transfer({
          from: await coin.getCustomerWallet(req.customer._id),
          to: await coin.getTreasury(),
          amount: total,
          note: `qr_file_pack × ${n} · ${ctx.business.name}`,
          customerId: req.customer._id,
          type: "spend",
          businessId: ctx.business._id,
          service: "qr_file_pack",
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
    await M.QgSettings.updateOne({ _id: ctx.settings._id }, { $inc: { file_packs: n } });
    ctx.settings.file_packs = (ctx.settings.file_packs || 0) + n;
    res.json({ success: true, charged: total, balance: tx ? tx.from_balance_after : undefined, files: await files(ctx), message: MSG.saved });
  });

  // ---------------------------------------- inbox (Form QR replies) ----------------------------------------
  own("get", "/replies", false, async (ctx, req, res) => {
    const filter = { business_id: ctx.business._id };
    if (validId(req.query.code)) filter.code_id = req.query.code;
    if (req.query.unread === "1") filter.read = false;
    const days = Number(req.query.days);
    if ([1, 7, 30].includes(days)) filter.created_date = { $gte: days === 1 ? startOfToday() : new Date(Date.now() - days * 86400000) };
    // a date range (Cambodia days, YYYY-MM-DD)
    const dayAt = (d, end) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) ? new Date(Date.parse(`${d}T00:00:00Z`) - TZ * 3600000 + (end ? 86400000 : 0)) : null);
    const from = dayAt(req.query.from);
    const to = dayAt(req.query.to, true);
    if (from || to) filter.created_date = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
    const q = str(req.query.q, 60);
    if (q) filter["answers.value"] = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const all = req.query.all === "1";
    const limit = all ? 5000 : Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const page = all ? 1 : Math.max(1, Number(req.query.page) || 1);
    const [rows, total, perCode] = await Promise.all([
      M.QgReply.find(filter)
        .sort({ created_date: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.QgReply.countDocuments(filter),
      M.QgReply.aggregate([{ $match: { business_id: ctx.business._id } }, { $group: { _id: "$code_id", n: { $sum: 1 }, unread: { $sum: { $cond: ["$read", 0, 1] } } } }]),
    ]);
    // the numbers on top of the Inbox (for the chosen form, or all forms)
    const base = { business_id: ctx.business._id, ...(filter.code_id ? { code_id: filter.code_id } : {}) };
    const [sTotal, sUnread, sToday, sWeek] = all
      ? [0, 0, 0, 0]
      : await Promise.all([
          M.QgReply.countDocuments(base),
          M.QgReply.countDocuments({ ...base, read: false }),
          M.QgReply.countDocuments({ ...base, created_date: { $gte: startOfToday() } }),
          M.QgReply.countDocuments({ ...base, created_date: { $gte: new Date(Date.now() - 7 * 86400000) } }),
        ]);
    res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      per_code: perCode.map((x) => ({ code_id: x._id, n: x.n, unread: x.unread })),
      summary: { total: sTotal, unread: sUnread, today: sToday, week: sWeek },
    });
  });
  const recount = async (bid, codeId) => {
    const [n, u] = await Promise.all([M.QgReply.countDocuments({ business_id: bid, code_id: codeId }), M.QgReply.countDocuments({ business_id: bid, code_id: codeId, read: false })]);
    await M.QgCode.updateOne({ _id: codeId }, { $set: { replies: n, unread: u } });
  };
  own("put", "/replies/:rid", true, async (ctx, req, res) => {
    if (!validId(req.params.rid)) throw new Bad(MSG.badId);
    const row = await M.QgReply.findOneAndUpdate({ _id: req.params.rid, business_id: ctx.business._id }, { $set: { read: req.body?.read !== false } }, { returnDocument: "after" });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    await recount(ctx.business._id, row.code_id);
    res.json({ success: true, data: row });
  });
  own("put", "/replies-read-all", true, async (ctx, req, res) => {
    const filter = { business_id: ctx.business._id, read: false };
    if (validId(req.body?.code)) filter.code_id = req.body.code;
    const ids = await M.QgReply.distinct("code_id", filter);
    await M.QgReply.updateMany(filter, { $set: { read: true } });
    await Promise.all(ids.map((c) => recount(ctx.business._id, c)));
    res.json({ success: true, message: MSG.saved });
  });
  own("delete", "/replies/:rid", true, async (ctx, req, res) => {
    if (!validId(req.params.rid)) throw new Bad(MSG.badId);
    const row = await M.QgReply.findOneAndDelete({ _id: req.params.rid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    await recount(ctx.business._id, row.code_id);
    res.json({ success: true, message: MSG.deleted });
  });

  // ---------------------------------------- scan stats (qr_stats) + device / city (qr_geo) ----------------------------------------
  own("get", "/stats", false, async (ctx, req, res) => {
    need(ctx, "qr_stats", MSG.needStats);
    const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const today = localDay();
    const from = addDays(today, -(days - 1));
    // "at" too: it uses the (business_id, at) index, so only the scans of these days are read
    const match = { business_id: ctx.business._id, at: { $gte: new Date(`${from}T00:00:00+07:00`) }, day: { $gte: from } };
    if (validId(req.query.code)) match.code_id = new mongoose.Types.ObjectId(String(req.query.code));
    const geo = !!ctx.addons.qr_geo?.active;
    const group = (field) => [{ $match: { [field]: { $gt: "" } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 12 }];
    // one pass over the scans for every number (was one pass each)
    const [[facets], codes] = await Promise.all([
      M.QgScan.aggregate([
        { $match: match },
        { $project: { day: 1, code_id: 1, at: 1, ...(geo ? { device: 1, os: 1, browser: 1, country: 1, city: 1 } : {}) } },
        {
          $facet: {
            byDay: [{ $group: { _id: "$day", n: { $sum: 1 } } }],
            byCode: [{ $group: { _id: "$code_id", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 20 }],
            byHour: [{ $group: { _id: { $hour: { date: "$at", timezone: "+07:00" } }, n: { $sum: 1 } } }],
            ...(geo ? { device: group("device"), os: group("os"), browser: group("browser"), country: group("country"), city: group("city") } : {}),
          },
        },
      ]),
      M.QgCode.find({ business_id: ctx.business._id }).select("name type scans").lean(),
    ]);
    const { byDay, byCode, byHour, device = [], os = [], browser = [], country = [], city = [] } = facets;
    const dayMap = new Map(byDay.map((x) => [x._id, x.n]));
    const series = [];
    for (let d = from; d <= today; d = addDays(d, 1)) series.push({ day: d, scans: dayMap.get(d) || 0 });
    const hours = Array.from({ length: 24 }, (_, h) => byHour.find((x) => x._id === h)?.n || 0);
    const nameOf = new Map(codes.map((c) => [String(c._id), c]));
    res.json({
      success: true,
      data: {
        days,
        today: dayMap.get(today) || 0,
        total: series.reduce((a, x) => a + x.scans, 0),
        all_time: validId(req.query.code) ? nameOf.get(String(req.query.code))?.scans || 0 : codes.reduce((a, c) => a + (c.scans || 0), 0),
        series,
        hours,
        top: byCode.map((x) => ({ _id: x._id, name: nameOf.get(String(x._id))?.name || "—", type: nameOf.get(String(x._id))?.type || "", scans: x.n })),
        geo,
        device: device.map((x) => ({ key: x._id, n: x.n })),
        os: os.map((x) => ({ key: x._id, n: x.n })),
        browser: browser.map((x) => ({ key: x._id, n: x.n })),
        country: country.map((x) => ({ key: x._id, n: x.n })),
        city: city.map((x) => ({ key: x._id, n: x.n })),
      },
    });
  });
  // every scan, newest first (the full history)
  own("get", "/scans", false, async (ctx, req, res) => {
    need(ctx, "qr_stats", MSG.needStats);
    const filter = { business_id: ctx.business._id };
    if (validId(req.query.code)) filter.code_id = req.query.code;
    const all = req.query.all === "1";
    const limit = all ? 10000 : Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const page = all ? 1 : Math.max(1, Number(req.query.page) || 1);
    const geo = !!ctx.addons.qr_geo?.active;
    const [rows, total] = await Promise.all([
      M.QgScan.find(filter)
        .sort({ at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.QgScan.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data: rows.map((r) => ({ _id: r._id, code_id: r.code_id, at: r.at, ...(geo ? { device: r.device, os: r.os, browser: r.browser, country: r.country, city: r.city } : {}) })),
      geo,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  });

  // ---------------------------------------- Telegram (qr_telegram) ----------------------------------------
  telegram.onStart(async (code, chat) => {
    if (!/^qg_[A-Za-z0-9]{12,40}$/.test(code)) return null;
    const s = await M.QgSettings.findOne({ "tg.link_code": code });
    if (!s || !s.tg.link_expires || s.tg.link_expires < new Date()) return "⌛️ This link has expired. Open BizHub → QR Code Generator → Telegram → Connect again.\nតំណនេះផុតកំណត់ហើយ។ សូមចុច “ភ្ជាប់” ម្តងទៀត។";
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "Telegram");
    s.tg = { chat_id: String(chat.id), chat_name: name.slice(0, 80), chat_type: chat.type || "private", connected_at: new Date(), link_code: "", link_expires: null };
    await s.save();
    const biz = await Business.findById(s.business_id).select("name").lean();
    return `✅ <b>${esc(biz?.name || "QR Code Generator")}</b> is connected to this chat.\nបានភ្ជាប់ជាមួយ BizHub ហើយ។\n\n📝 Form replies · 📷 scans (for the QR codes you choose)`;
  });
  const tgFail = (err) => {
    if (err instanceof telegram.TelegramError) throw new Bad(err.message === "not_configured" ? MSG.tgNotConfigured : err.message === "blocked" ? MSG.tgBlocked : MSG.tgUnreachable, err.status);
    throw err;
  };
  own("get", "/telegram", false, async (ctx, req, res) => res.json({ success: true, data: tgOut(ctx.settings, ctx.addons) }));
  own("post", "/telegram/link", true, async (ctx, req, res) => {
    need(ctx, "qr_telegram", MSG.needTelegram);
    if (!telegram.ready()) throw new Bad(MSG.tgNotConfigured, 503);
    const bot = await telegram.botUsername().catch(tgFail);
    const code = `qg_${crypto.randomBytes(24).toString("base64url").replace(/[-_]/g, "").slice(0, 24)}`;
    const expires = new Date(Date.now() + 15 * 60000);
    ctx.settings.tg.link_code = code;
    ctx.settings.tg.link_expires = expires;
    await ctx.settings.save();
    res.json({ success: true, data: { url: `https://t.me/${bot}?start=${code}`, group_url: `https://t.me/${bot}?startgroup=${code}`, bot, expires_at: expires } });
  });
  own("post", "/telegram/test", true, async (ctx, req, res) => {
    need(ctx, "qr_telegram", MSG.needTelegram);
    const chat = ctx.settings.tg?.chat_id;
    if (!chat) throw new Bad(MSG.tgNotConnected);
    try {
      await telegram.send(chat, `🔔 <b>${esc(ctx.business.name)}</b>\nTest message from BizHub — everything works.\nសារសាកល្បងពី BizHub — ដំណើរការល្អ។`);
    } catch (err) {
      if (err instanceof telegram.TelegramError && err.message === "blocked") {
        ctx.settings.tg.chat_id = "";
        await ctx.settings.save();
      }
      tgFail(err);
    }
    res.json({ success: true, message: MSG.tgSent });
  });
  own("delete", "/telegram", true, async (ctx, req, res) => {
    const chat = ctx.settings.tg?.chat_id;
    ctx.settings.tg = { chat_id: "", chat_name: "", chat_type: "", connected_at: null, link_code: "", link_expires: null };
    await ctx.settings.save();
    if (chat) telegram.send(chat, "🔌 BizHub disconnected from this chat.\nបានផ្តាច់ពី BizHub ហើយ។").catch(() => {});
    res.json({ success: true, data: tgOut(ctx.settings, ctx.addons), message: MSG.saved });
  });

  // ---------------------------------------- public ----------------------------------------
  async function publicCode(slug) {
    const sl = String(slug || "").slice(0, 40);
    const low = sl.toLowerCase();
    const find = (q) => M.QgCode.findOne({ ...q, deleted_at: null }).lean();
    // exact link first (generated links mix upper / lower case), then a custom name typed in capitals, then an old link
    const c = (await find({ slug: sl })) || (low !== sl ? await find({ slug: low }) : null) || (await find({ old_slugs: sl })) || (low !== sl ? await find({ old_slugs: low }) : null);
    if (!c || !c.active) throw new Bad(MSG.off, 404, { code: "off" });
    const business = await Business.findOne({ _id: c.business_id, deleted: false, category: "qr_gen" }).lean();
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || !owner?.status) throw new Bad(MSG.off, 404, { code: "off" });
    return { c, business };
  }
  // which link a URL QR opens now (smart redirect: phone type, then time of day in Cambodia)
  const smartUrl = (c, st, req) => {
    const sm = c.smart || {};
    if (!st.addons.qr_smart?.active) return c.url;
    const ua = String(req.headers["user-agent"] || "");
    if (sm.ios && /iPhone|iPad|iPod/i.test(ua)) return sm.ios;
    if (sm.android && /Android/i.test(ua)) return sm.android;
    const hm = new Date(Date.now() + TZ * 3600000).toISOString().slice(11, 16);
    const t = (sm.times || []).find((x) => (x.from <= x.to ? hm >= x.from && hm <= x.to : hm >= x.from || hm <= x.to));
    return t?.url || c.url;
  };
  const couponOut = (c) => {
    const cp = c.coupon || {};
    const ended = !!(cp.ends_at && new Date(cp.ends_at) < new Date());
    const gone = !!(cp.limit && (cp.issued || 0) >= cp.limit);
    return { title: cp.title || "", offer: cp.offer || "", terms: cp.terms || "", ends_at: cp.ends_at || null, left: cp.limit ? Math.max(0, cp.limit - (cp.issued || 0)) : null, ended, gone };
  };
  const content = (c, st, req) => {
    switch (c.type) {
      case "url":
        return { url: smartUrl(c, st, req) };
      case "links":
        return st.addons.qr_links?.active ? { links: c.links || [] } : { links: [] };
      case "coupon":
        return st.addons.qr_coupons?.active ? { coupon: couponOut(c) } : { coupon: { ...couponOut(c), ended: true } };
      case "text":
        return { text: c.text };
      case "file":
        // PDFs are opened through /file (the Cloudinary account may block direct PDF links)
        return { file: { url: c.file?.kind === "image" ? c.file?.url || "" : "", has: !!c.file?.public_id, name: c.file?.name || "", kind: c.file?.kind || "", bytes: c.file?.bytes || 0 } };
      case "form":
        return st.addons.qr_forms?.active ? { form: { ...c.form, fields: (c.form?.fields || []).filter((f) => st.addons.qr_form_pro?.active || (!PRO_KINDS.includes(f.kind) && !f.show_if?.key)) } } : { form_off: true };
      case "vcard":
        return { vcard: c.vcard };
      case "map":
        return { map: c.map };
      case "wifi":
        return { wifi: c.wifi };
      default:
        return { phone: c.phone };
    }
  };
  async function recordScan(req, c, st) {
    const ua = new UAParser(req.headers["user-agent"] || "").getResult();
    const geo = !!st.addons.qr_geo?.active;
    const head = (k) => {
      try {
        return decodeURIComponent(String(req.headers[k] || "")).slice(0, 60);
      } catch {
        return "";
      }
    };
    const now = new Date();
    await Promise.all([
      M.QgScan.create({
        business_id: c.business_id,
        code_id: c._id,
        at: now,
        day: localDay(now),
        device: ua.device?.type === "mobile" || ua.device?.type === "tablet" ? ua.device.type : "desktop",
        os: str(ua.os?.name, 30),
        browser: str(ua.browser?.name, 30),
        country: geo ? head("x-vercel-ip-country") || head("cf-ipcountry") : "",
        city: geo ? head("x-vercel-ip-city") : "",
      }),
      M.QgCode.updateOne({ _id: c._id }, { $inc: { scans: 1 }, $set: { last_scan: now } }),
    ]);
    if (c.notify_scan) {
      const place = geo ? [head("x-vercel-ip-city"), head("x-vercel-ip-country")].filter(Boolean).join(", ") : "";
      tgSend(
        c.business_id,
        `📷 <b>${esc(c.name)}</b> was scanned · បានស្កេន\n🕐 ${when(now)}${ua.os?.name ? `\n📱 ${esc([ua.device?.vendor, ua.os.name, ua.browser?.name].filter(Boolean).join(" · "))}` : ""}${place ? `\n📍 ${esc(place)}` : ""}\n🔢 ${(c.scans || 0) + 1} scans in total`,
      ).catch(() => {});
    }
  }
  // open / download the file of a File QR: a short signed Cloudinary link (works even when PDF delivery is blocked)
  prop.app.get(
    "/api/public/qr/:slug/file",
    handle(async (req, res) => {
      const { c } = await publicCode(req.params.slug);
      const r = c.rules || {};
      if (c.type !== "file" || !c.file?.public_id) throw new Bad(MSG.noFile, 404);
      if (r.expires_at && new Date(r.expires_at) < new Date()) throw new Bad(MSG.off, 410, { code: "expired" });
      if (r.password_hash && req.query.t !== tokenFor(c)) throw new Bad(MSG.off, 403, { code: "locked" });
      const url = cloud.cloudinary.utils.private_download_url(c.file.public_id, c.file.kind === "image" ? c.file.url.split(".").pop() || "" : "", {
        resource_type: c.file.kind === "pdf" ? "raw" : "image",
        type: "upload",
        attachment: req.query.dl === "1",
        expires_at: Math.floor(Date.now() / 1000) + 600,
      });
      res.set("Cache-Control", "no-store");
      res.redirect(302, url);
    }),
  );
  prop.app.get(
    "/api/public/qr/:slug",
    handle(async (req, res) => {
      const { c, business } = await publicCode(req.params.slug);
      const [st, s] = await Promise.all([licenseState(c.business_id), M.QgSettings.findOne({ business_id: c.business_id }).lean()]);
      const head = {
        name: c.name,
        type: c.type,
        business: business.name,
        logo: c.page?.logo !== false ? s?.logo?.url || "" : "",
        brand: !st.addons.qr_nobrand?.active, // "Made with BizHub" (hidden with qr_nobrand)
        page: { template: c.page?.template || "card", color: c.page?.color || s?.color || "#E0581A", header: c.page?.header || "", footer: c.page?.footer || "", rows: c.page?.rows || [] },
      };
      const r = c.rules || {};
      if (r.expires_at && new Date(r.expires_at) < new Date()) return res.json({ success: true, data: { ...head, blocked: "expired" } });
      if (r.max_scans && (c.scans || 0) >= r.max_scans) return res.json({ success: true, data: { ...head, blocked: "limit" } });
      if (r.password_hash && req.query.t !== tokenFor(c)) return res.json({ success: true, data: { ...head, locked: true } });
      if (req.query.p !== "1") await recordScan(req, c, st);
      res.json({ success: true, data: { ...head, ...content(c, st, req) } });
    }),
  );
  const tries = new Map();
  const slowDown = (key, max = 10) => {
    const now = Date.now();
    const list = (tries.get(key) || []).filter((t) => now - t < 10 * 60000);
    if (list.length >= max) throw new Bad(MSG.slow, 429, { code: "slow" });
    tries.set(key, [...list, now]);
    if (tries.size > 5000) tries.clear();
  };
  // ---------- coupons ----------
  const COUPON_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const newCouponCode = () => {
    const b = crypto.randomBytes(6);
    const c = [...b].map((x) => COUPON_ABC[x % COUPON_ABC.length]).join("");
    return `${c.slice(0, 3)}-${c.slice(3)}`;
  };
  const cleanCode = (v) => {
    const x = String(v || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    return x.length === 6 ? `${x.slice(0, 3)}-${x.slice(3)}` : "";
  };
  async function redeem(c, code) {
    const k = cleanCode(code);
    const row = k && (await M.QgCoupon.findOne({ code_id: c._id, code: k }));
    if (!row) throw new Bad(MSG.couponNotFound, 404, { code: "coupon_not_found" });
    if (row.used_at) throw new Bad(MSG.couponUsed, 409, { code: "coupon_used", used_at: row.used_at });
    const done = await M.QgCoupon.findOneAndUpdate({ _id: row._id, used_at: null }, { $set: { used_at: new Date() } }, { returnDocument: "after" });
    if (!done) throw new Bad(MSG.couponUsed, 409, { code: "coupon_used" });
    await M.QgCode.updateOne({ _id: c._id }, { $inc: { "coupon.used": 1 } });
    return { code: done.code, used_at: done.used_at, issued_at: done.created_date };
  }
  const couponReady = async (slug, req) => {
    const { c } = await publicCode(slug);
    if (c.type !== "coupon") throw new Bad(MSG.off, 404, { code: "off" });
    const st = await licenseState(c.business_id);
    if (!st.addons.qr_coupons?.active) throw new Bad(MSG.couponEnded, 410, { code: "coupon_ended" });
    if (c.rules?.password_hash && (req.body?.t || req.query.t) !== tokenFor(c)) throw new Bad(MSG.wrongPassword, 401, { code: "locked" });
    return c;
  };
  // a person asks for their coupon (one per phone)
  prop.app.post(
    "/api/public/qr/:slug/coupon",
    handle(async (req, res) => {
      const c = await couponReady(req.params.slug, req);
      const device = /^[a-zA-Z0-9_-]{8,64}$/.test(String(req.body?.device || "")) ? req.body.device : "";
      if (device) {
        const had = await M.QgCoupon.findOne({ code_id: c._id, device }).lean();
        if (had) return res.json({ success: true, data: { code: had.code, used_at: had.used_at, issued_at: had.created_date } });
      }
      const info = couponOut(c);
      if (info.ended) throw new Bad(MSG.couponEnded, 410, { code: "coupon_ended" });
      slowDown(`coupon:${c._id}:${req.ip}`, 20);
      // count first so the limit holds when many people press at once
      const cond = { _id: c._id, ...(c.coupon?.limit ? { "coupon.issued": { $lt: c.coupon.limit } } : {}) };
      const ok = await M.QgCode.findOneAndUpdate(cond, { $inc: { "coupon.issued": 1 } });
      if (!ok) throw new Bad(MSG.couponGone, 410, { code: "coupon_gone" });
      let row;
      for (let i = 0; i < 6 && !row; i++) row = await M.QgCoupon.create({ business_id: c.business_id, code_id: c._id, code: newCouponCode(), device }).catch((e) => (e.code === 11000 ? null : Promise.reject(e)));
      res.status(201).json({ success: true, data: { code: row.code, used_at: null, issued_at: row.created_date } });
    }),
  );
  // is this coupon still good? (the staff page after scanning the customer's coupon)
  prop.app.get(
    "/api/public/qr/:slug/coupon/:code",
    handle(async (req, res) => {
      const { c } = await publicCode(req.params.slug);
      if (c.type !== "coupon") throw new Bad(MSG.off, 404, { code: "off" });
      const row = await M.QgCoupon.findOne({ code_id: c._id, code: cleanCode(req.params.code) }).lean();
      if (!row) throw new Bad(MSG.couponNotFound, 404, { code: "coupon_not_found" });
      res.json({ success: true, data: { code: row.code, used_at: row.used_at, issued_at: row.created_date, offer: c.coupon?.offer || "", title: c.coupon?.title || "", name: c.name, has_pin: !!c.coupon?.pin_hash } });
    }),
  );
  // staff mark a coupon used with the shop PIN
  prop.app.post(
    "/api/public/qr/:slug/redeem",
    handle(async (req, res) => {
      const { c } = await publicCode(req.params.slug);
      if (c.type !== "coupon") throw new Bad(MSG.off, 404, { code: "off" });
      slowDown(`pin:${c._id}:${req.ip}`, 12);
      if (!c.coupon?.pin_hash) throw new Bad(MSG.noPin, 400, { code: "no_pin" });
      if (!checkPass(String(req.body?.pin || ""), c.coupon.pin_hash)) throw new Bad(MSG.wrongPin, 401, { code: "wrong_pin" });
      res.json({ success: true, data: await redeem(c, req.body?.code) });
    }),
  );
  // a photo or a signature for a form answer (form extras)
  prop.app.post(
    "/api/public/qr/:slug/upload",
    (req, res, next) =>
      uploadImg.single("photo")(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: MSG.badImage });
        next();
      }),
    handle(async (req, res) => {
      const { c } = await publicCode(req.params.slug);
      const st = await licenseState(c.business_id);
      if (c.type !== "form" || !st.addons.qr_forms?.active || !st.addons.qr_form_pro?.active || !(c.form?.fields || []).some((f) => f.kind === "photo" || f.kind === "signature")) throw new Bad(MSG.formOff, 400, { code: "form_off" });
      if (c.rules?.password_hash && req.body?.t !== tokenFor(c)) throw new Bad(MSG.wrongPassword, 401, { code: "locked" });
      if (!req.file) throw new Bad(MSG.noFile);
      slowDown(`up:${c._id}:${req.ip}`, 20);
      const saved = await cloud.uploadBuffer(req.file, `qrgen/${c.business_id}/answers`);
      res.status(201).json({ success: true, data: { url: saved.url } });
    }),
  );
  prop.app.post(
    "/api/public/qr/:slug/unlock",
    handle(async (req, res) => {
      const { c } = await publicCode(req.params.slug);
      slowDown(`pw:${c._id}:${req.ip}`);
      if (!c.rules?.password_hash || !checkPass(String(req.body?.password || ""), c.rules.password_hash)) throw new Bad(MSG.wrongPassword, 401, { code: "wrong_password" });
      res.json({ success: true, data: { token: tokenFor(c) } });
    }),
  );
  prop.app.post(
    "/api/public/qr/:slug/reply",
    handle(async (req, res) => {
      const { c } = await publicCode(req.params.slug);
      const st = await licenseState(c.business_id);
      if (c.type !== "form" || !st.addons.qr_forms?.active) throw new Bad(MSG.formOff, 400, { code: "form_off" });
      if (c.rules?.password_hash && req.body?.t !== tokenFor(c)) throw new Bad(MSG.wrongPassword, 401, { code: "locked" });
      slowDown(`reply:${c._id}:${req.ip}`, 15);
      const given = req.body?.answers && typeof req.body.answers === "object" ? req.body.answers : {};
      const answers = [];
      const pro = !!st.addons.qr_form_pro?.active;
      const got = {};
      for (const f of c.form?.fields || []) {
        if (!pro && (PRO_KINDS.includes(f.kind) || f.show_if?.key)) continue;
        // a field shown only for some answers: skip it when hidden
        if (f.show_if?.key) {
          const other = got[f.show_if.key];
          const on = Array.isArray(other) ? other.includes(f.show_if.value) : f.show_if.value ? other === f.show_if.value : !!other;
          if (!on) continue;
        }
        let v = given[f.key];
        if (f.kind === "checkbox") v = (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x)).filter((x) => f.options.includes(x));
        else v = String(v ?? "").trim();
        got[f.key] = v;
        const empty = Array.isArray(v) ? !v.length : !v;
        if (f.required && empty) throw new Bad(`${MSG.fieldRequired} ${f.label}`, 400, { code: "required", field: f.key });
        if (!empty && ["select", "radio"].includes(f.kind) && !f.options.includes(v)) throw new Bad(`${MSG.badValue} (${f.label})`, 400, { code: "bad_value", field: f.key });
        if (!empty && f.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Bad(`${MSG.badValue} (${f.label})`, 400, { code: "bad_value", field: f.key });
        if (!empty && f.kind === "phone" && (v.match(/\d/g) || []).length < 6) throw new Bad(`${MSG.badValue} (${f.label})`, 400, { code: "bad_value", field: f.key });
        if (!empty && f.kind === "number" && Number.isNaN(Number(v))) throw new Bad(`${MSG.badValue} (${f.label})`, 400, { code: "bad_value", field: f.key });
        if (!empty && f.kind === "rating" && !/^[1-5]$/.test(v)) throw new Bad(`${MSG.badValue} (${f.label})`, 400, { code: "bad_value", field: f.key });
        if (!empty && (f.kind === "photo" || f.kind === "signature") && !UPLOAD_URL.test(v)) throw new Bad(`${MSG.badValue} (${f.label})`, 400, { code: "bad_value", field: f.key });
        answers.push({ key: f.key, label: f.label, kind: f.kind, value: (Array.isArray(v) ? v.join(", ") : v).slice(0, f.kind === "textarea" ? 3000 : f.kind === "photo" || f.kind === "signature" ? 600 : 500) });
      }
      if (!answers.some((a) => a.value)) throw new Bad(`${MSG.fieldRequired} …`, 400, { code: "empty" });
      const row = await M.QgReply.create({ business_id: c.business_id, code_id: c._id, answers });
      await M.QgCode.updateOne({ _id: c._id }, { $inc: { replies: 1, unread: 1 } });
      tgSend(
        c.business_id,
        [
          `📝 <b>New form reply · ${esc(c.name)}</b>`,
          "ទម្រង់ថ្មី",
          "",
          ...answers.filter((a) => a.value).map((a) => `• <b>${esc(a.label)}:</b> ${a.kind === "rating" ? "⭐".repeat(Number(a.value)) : esc(a.value.slice(0, 600))}`),
          "",
          `🕐 ${when(row.created_date)}`,
          "➡️ BizHub → QR Code Generator → Inbox",
        ].join("\n"),
      ).catch(() => {});
      res.status(201).json({ success: true, data: { thanks: c.form?.thanks || "" } });
    }),
  );
};
module.exports.FREE_FILES = FREE_FILES;

// Monday after 08:00 (Cambodia): last week's scans + answers to each connected Telegram (run by /api/cron/daily-report)
module.exports.weeklyReports = async function weeklyReports(now = new Date()) {
  const local = new Date(now.getTime() + TZ * 3600000);
  const dow = (local.getUTCDay() + 6) % 7; // 0 = Monday
  if (local.toISOString().slice(11, 16) < "08:00" && dow === 0) return { skipped: "early" };
  const weekStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow) - TZ * 3600000);
  const lastWeek = new Date(weekStart.getTime() - 7 * 86400000);
  const list = await M.QgSettings.find({ "tg.chat_id": { $gt: "" }, "tg.weekly": { $ne: false }, $or: [{ "tg.last_weekly_at": null }, { "tg.last_weekly_at": { $lt: weekStart } }] }).limit(200);
  let sent = 0;
  for (const s of list) {
    const st = await licenseState(s.business_id);
    const business = await Business.findOne({ _id: s.business_id, deleted: false, status: true }).lean();
    s.set("tg.last_weekly_at", now);
    await s.save();
    if (!st.addons.qr_telegram?.active || !business) continue;
    const range = { $gte: lastWeek, $lt: weekStart };
    const [scans, answers, top] = await Promise.all([
      M.QgScan.countDocuments({ business_id: s.business_id, at: range }),
      M.QgReply.countDocuments({ business_id: s.business_id, created_date: range }),
      M.QgScan.aggregate([{ $match: { business_id: s.business_id, at: range } }, { $group: { _id: "$code_id", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 3 }]),
    ]);
    const names = await M.QgCode.find({ _id: { $in: top.map((x) => x._id) } })
      .select("name")
      .lean();
    const day = (d) => new Date(d.getTime() + TZ * 3600000).toISOString().slice(0, 10);
    const lines = [
      `📊 <b>${telegram.escape(business.name)}</b> · weekly QR report`,
      "របាយការណ៍ QR ប្រចាំសប្តាហ៍",
      `🗓 ${day(lastWeek)} → ${day(new Date(weekStart.getTime() - 1))}`,
      "",
      `📷 Scans · ការស្កេន: <b>${scans}</b>`,
      `📝 Form answers · ចម្លើយ: <b>${answers}</b>`,
      ...(top.length ? ["", "🔥 Most scanned", ...top.map((x, i) => `${i + 1}. ${telegram.escape(names.find((n) => String(n._id) === String(x._id))?.name || "—")} × ${x.n}`)] : []),
    ];
    if (
      await telegram
        .send(s.tg.chat_id, lines.join("\n"))
        .then(() => true)
        .catch(() => false)
    )
      sent += 1;
  }
  return { checked: list.length, sent };
};
