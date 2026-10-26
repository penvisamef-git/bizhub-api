// Website Builder (yearly license "website", 100 coins): pages made of blocks, a draft + Publish, contact form inbox,
// visit counts, blog (web_blog), Telegram alerts (web_telegram), brand style (web_brand), more pages (web_pages),
// no BizHub footer (web_nobrand), own link name (web_slug), paid looks (web_theme, one each). Add-ons: 35 coins, forever.
// Owner base: /api/user/businesses/:id/website
//   GET  ""                         everything the dashboard needs (site, pages + their draft blocks, add-ons, prices…)
//   PUT  /settings                  name, tagline, logo, languages, look (theme + style), contact, footer, SEO, slug (web_slug)
//   POST /template { key }          start from a starter (replaces every page)
//   POST /pages  PUT/DELETE /pages/:pid  POST /pages/:pid/duplicate  POST /pages/:pid/home  PUT /pages-order { ids }
//   POST /publish   POST /unpublish
//   GET/POST /media  DELETE /media/:mid                    the site's pictures (150)
//   GET /messages?page  PUT /messages/:mid { read }  PUT /messages-read-all  DELETE /messages/:mid
//   GET /stats?days=7|30|90
//   GET/POST /posts  PUT/DELETE /posts/:pid                 (web_blog)
//   POST /themes/:key                                      buy a look (once) and use it
//   GET/DELETE /telegram  POST /telegram/link  POST /telegram/test   (web_telegram)
// Public (/site/<slug>): GET /api/public/website/:slug   POST …/hit { page }   POST …/message
//   GET …/posts?page   GET …/posts/:post
const mongoose = require("mongoose");
const crypto = require("crypto");
const multer = require("multer");
const M = require("./website.models");
const { cleanBlocks, url: cleanUrl } = require("./website.blocks");
const { FREE_THEMES, THEMES, themeKey, FREE_FONTS, ALL_FONTS, THEME_FONT, PRESET_COLORS } = require("./website.themes");
const { TEMPLATE_KEYS, KINDS, templatePages } = require("./website.templates");
const Business = require("../business.model");
const { bizOwner, roleIn } = require("../team/team.access"); // team members (Admin / View only) open it too
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const { statusOf, buy, LicenseError, DAY } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");
const cloud = require("../../util/cloudinary");
const telegram = require("../../telegram");
const { UAParser } = require("ua-parser-js");

// a visitor's IP without its last part: 203.0.113.57 → 203.0.113.x · 2001:db8:85a3:… → 2001:db8:85a3::x
function maskIp(raw) {
  const ip = String(raw || "")
    .split(",")[0]
    .trim()
    .replace(/^::ffff:/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.replace(/\.\d{1,3}$/, ".x");
  if (ip.includes(":")) return `${ip.split(":").slice(0, 3).join(":")}::x`;
  return "";
}
// where a visitor came from (the page that linked here)
function sourceOf(ref, ownHost) {
  let host = "";
  try {
    host = new URL(String(ref || "")).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
  if (!host || host === ownHost) return "";
  const known = [
    [/(^|\.)facebook\.com$|^fb\.|^m\.me$|messenger\.com$/, "Facebook"],
    [/(^|\.)instagram\.com$/, "Instagram"],
    [/^t\.me$|telegram\.(org|me)$/, "Telegram"],
    [/(^|\.)tiktok\.com$/, "TikTok"],
    [/(^|\.)youtube\.com$|^youtu\.be$/, "YouTube"],
    [/(^|\.)google\./, "Google"],
    [/(^|\.)bing\.com$/, "Bing"],
    [/(^|\.)(x|twitter)\.com$|^t\.co$/, "X"],
    [/(^|\.)linkedin\.com$/, "LinkedIn"],
  ];
  for (const [re, name] of known) if (re.test(host)) return name;
  return host.slice(0, 80);
}

const GRACE_DAYS = 7;
const ADDONS = ["web_telegram", "web_brand", "web_pages", "web_blog", "web_nobrand", "web_slug", "web_stats"];
const LIMITS = { pages: 5, pages_more: 30, media: 150, posts: 500 };
const LANGS = ["km", "en"];
const RESERVED = ["blog", "api", "admin", "app"];
const TZ = 7;
const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  notSite: "អាជីវកម្មនេះមិនមែនជាគេហទំព័រទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  locked: "គេហទំព័រផុតកំណត់ហើយ! សូមបន្តដើម្បីប្រើប្រាស់។",
  rowNotFound: "រកមិនឃើញទិន្នន័យ!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
  published: "បានផ្សព្វផ្សាយ! អ្នកទស្សនាឃើញកំណែថ្មីហើយ។",
  unpublished: "គេហទំព័រត្រូវបានបិទ។",
  badValue: "តម្លៃមិនត្រឹមត្រូវ!",
  tooLong: "អត្ថបទវែងពេក!",
  pageLimit: "ទំព័រឥតគិតថ្លៃមានតែ 5។ សូមដោះសោ “ទំព័រគ្មានកំណត់”។",
  pageMax: "ទំព័រច្រើនពេក!",
  homeKeep: "មិនអាចលុបទំព័រដើមបានទេ។ សូមកំណត់ទំព័រផ្សេងជាទំព័រដើមជាមុនសិន។",
  badSlug: "តំណប្រើបានតែអក្សរ a-z លេខ និង - (3 ទៅ 40)!",
  pageSlugTaken: "ទំព័រមួយទៀតប្រើតំណនេះហើយ!",
  slugTaken: "តំណនេះមានគេប្រើហើយ!",
  needSlug: "សូមដោះសោ “ឈ្មោះតំណផ្ទាល់ខ្លួន” ជាមុនសិន!",
  needBrand: "សូមដោះសោ “ស្ទីលម៉ាក” ដើម្បីប្រើពណ៌ និងពុម្ពអក្សរនេះ!",
  needBlog: "សូមដោះសោ “ប្លុក / ព័ត៌មាន” ជាមុនសិន!",
  needTelegram: "សូមដោះសោ “ភ្ជាប់ Telegram” ជាមុនសិន!",
  notOwned: "សូមទិញម៉ូដនេះជាមុនសិន!",
  noPages: "សូមជ្រើសរើសគំរូ ឬបង្កើតទំព័រជាមុនសិន!",
  badImage: "សូមដាក់រូបភាព JPG / PNG / WEBP / GIF (តិចជាង 5MB)!",
  noFile: "សូមជ្រើសរើសរូបភាព!",
  mediaFull: "កន្លែងរូបភាពពេញហើយ (150)។ សូមលុបរូបចាស់ៗ។",
  postLimit: "អត្ថបទច្រើនពេក!",
  siteOff: "គេហទំព័រនេះមិនទាន់បើក ឬត្រូវបានផ្អាក។",
  msgEmpty: "សូមសរសេរសាររបស់អ្នក!",
  msgThanks: "បានផ្ញើ! យើងនឹងឆ្លើយតបឆាប់ៗ។",
  slow: "សូមរង់ចាំបន្តិច រួចព្យាយាមម្តងទៀត។",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  already: "បានទិញរួចហើយ!",
  busy: "កំពុងដំណើរការ សូមព្យាយាមម្តងទៀត!",
  tgNotConfigured: "Telegram មិនទាន់រៀបចំនៅលើម៉ាសុីនមេ។",
  tgBlocked: "Telegram៖ បុតត្រូវបានបិទ ឬដកចេញពីក្រុម។ សូមភ្ជាប់ម្តងទៀត។",
  tgUnreachable: "មិនអាចទាក់ទង Telegram បាន។ សូមព្យាយាមម្តងទៀត។",
  tgNotConnected: "មិនទាន់ភ្ជាប់ Telegram ទេ។",
  tgSent: "បានផ្ញើសារសាកល្បង!",
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
const trText = (v, max) => {
  if (v === undefined) return undefined;
  const o = v && typeof v === "object" ? v : { en: v };
  for (const k of LANGS) if (String(o[k] ?? "").length > max) throw new Bad(`${MSG.tooLong} (≤ ${max})`);
  return { km: str(o.km, max), en: str(o.en, max) };
};
const hex = (v) => /^#[0-9a-fA-F]{6}$/.test(String(v || ""));
const localDay = (d = new Date()) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const slugOf = (s, max = 40) =>
  String(s || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

async function licenseState(businessId) {
  const rows = await License.find({ business_id: businessId, product: { $in: ["website", ...ADDONS, "web_theme"] } }).lean();
  const main = rows.find((r) => r.product === "website");
  const license = statusOf(main);
  const endedAt = license.expires_at ? new Date(license.expires_at).getTime() : null;
  license.grace_until = endedAt ? new Date(endedAt + GRACE_DAYS * DAY) : null;
  license.locked = !main || (!license.active && endedAt !== null && Date.now() > endedAt + GRACE_DAYS * DAY);
  license.in_grace = !!main && !license.active && !license.locked;
  const addons = {};
  for (const key of ADDONS) addons[key] = statusOf(rows.find((r) => r.product === key && !r.item));
  const themes = [...FREE_THEMES, ...rows.filter((r) => r.product === "web_theme" && r.item && statusOf(r).active).map((r) => themeKey(r.item))];
  return { license, addons, themes: [...new Set(themes)], maxPages: addons.web_pages.active ? LIMITS.pages_more : LIMITS.pages };
}

// a free /site/<slug>: the business name + 4 random letters (choosing your own needs web_slug)
async function freeSlug(name) {
  const base = slugOf(name, 30) || "site";
  for (let i = 0; i < 20; i++) {
    const slug = `${base}-${crypto.randomBytes(2).toString("hex")}`;
    if (!(await M.WebSite.exists({ slug }))) return slug;
  }
  return `site-${crypto.randomBytes(5).toString("hex")}`;
}
async function siteOf(business) {
  const found = await M.WebSite.findOne({ business_id: business._id });
  if (found) {
    if (found.theme && themeKey(found.theme) !== found.theme) found.theme = themeKey(found.theme); // a removed look → its replacement (saved with the next change)
    return found;
  }
  try {
    return await M.WebSite.create({ business_id: business._id, slug: await freeSlug(business.name), name: { km: "", en: business.name } });
  } catch (err) {
    if (err.code === 11000) {
      const again = await M.WebSite.findOne({ business_id: business._id });
      if (again) return again;
    }
    throw err;
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});

// the parts of the site visitors may see (also kept in site.live when published)
function publicSite(site, business) {
  return {
    slug: site.slug,
    name: site.name?.km || site.name?.en ? site.name : { km: "", en: business?.name || "" },
    tagline: site.tagline,
    logo: site.logo,
    langs: site.langs?.length ? site.langs : LANGS,
    theme: themeKey(site.theme),
    style: site.style,
    contact: site.contact,
    footer: site.footer,
    seo: site.seo,
  };
}
const pageOut = (p) => ({ _id: p._id, slug: p.slug, title: p.title, home: p.home, menu: p.menu, sort: p.sort, blocks: p.blocks || [], updated_date: p.updated_date });
const postOut = (p, full = true) => ({ _id: p._id, slug: p.slug, title: p.title, excerpt: p.excerpt, ...(full ? { body: p.body } : {}), cover: p.cover, category: p.category, published: p.published, date: p.date, views: p.views || 0 });

module.exports = (prop) => {
  const base = "/api/user/businesses/:id/website";
  const guard = [prop.api_auth, customer_auth];

  async function ctxOf(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    const [business, state] = await Promise.all([Business.findOne({ _id: req.params.id, ...bizOwner(req), deleted: false }), licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== "website") throw new Bad(MSG.notSite);
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (state.license.locked) throw new Bad(MSG.locked, 402, { product: "website" });
    }
    const site = await siteOf(business);
    return { business, site, ...state };
  }
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
      if (err instanceof LicenseError) return res.status(err.status).json({ success: false, message: MSG[err.message] || err.message, code: err.message, ...err.extra });
      if (err?.code === 11000) return res.status(409).json({ success: false, message: MSG.slugTaken, code: "slug_taken" });
      if (err?.name === "ValidationError" || err?.name === "CastError") return res.status(400).json({ success: false, message: MSG.badValue });
      console.error("[website]", err);
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
  const touch = (site) => {
    site.changed_at = new Date();
  };
  const tgOut = (s, addons) => ({ configured: telegram.ready(), active: !!addons.web_telegram?.active, connected: !!s.tg?.chat_id, chat_name: s.tg?.chat_name || "", connected_at: s.tg?.connected_at || null });
  const siteOut = (s) => {
    const o = s.toObject ? s.toObject() : { ...s };
    delete o.live;
    if (o.tg) o.tg = { connected: !!o.tg.chat_id, chat_name: o.tg.chat_name || "" };
    return { ...o, has_live: !!s.live, live_at: s.live?.at || null };
  };
  const pagesOf = (bid) => M.WebPage.find({ business_id: bid }).sort({ home: -1, sort: 1, created_date: 1 }).lean();

  // ---------------------------------------- overview ----------------------------------------
  async function overview(ctx) {
    const bid = ctx.business._id;
    const keys = ["website", ...ADDONS, "web_theme"];
    const [prices, pages, unread, posts, media] = await Promise.all([
      Promise.all(keys.map((k) => priceOf(k))),
      pagesOf(bid),
      M.WebMessage.countDocuments({ business_id: bid, read: false }),
      M.WebPost.countDocuments({ business_id: bid }),
      M.WebMedia.countDocuments({ business_id: bid }),
    ]);
    const price = Object.fromEntries(keys.map((k, i) => [k, prices[i]]));
    return {
      business: { _id: bid, name: ctx.business.name, status: ctx.business.status },
      site: siteOut(ctx.site),
      pages: pages.map(pageOut),
      license: ctx.license,
      addons: Object.fromEntries(ADDONS.map((k) => [k, { ...ctx.addons[k], price: price[k], days: k === "web_stats" ? 365 : null }])),
      themes: { owned: ctx.themes, price: price.web_theme },
      limits: { pages: ctx.maxPages, media: LIMITS.media },
      counts: { unread, posts, media },
      telegram: tgOut(ctx.site, ctx.addons),
      templates: TEMPLATE_KEYS.map((k) => ({ key: k, en: KINDS[k].en, km: KINDS[k].km, theme: KINDS[k].theme })),
      renew_price: price.website,
      fonts: { free: FREE_FONTS, all: ALL_FONTS, theme: THEME_FONT },
      colors: PRESET_COLORS,
    };
  }
  own("get", "", false, async (ctx, req, res) => res.json({ success: true, data: await overview(ctx) }));

  // ---------------------------------------- settings + look ----------------------------------------
  own("put", "/settings", true, async (ctx, req, res) => {
    const b = req.body || {};
    const s = ctx.site;
    const brand = !!ctx.addons.web_brand?.active;
    if (b.slug !== undefined) {
      const slug = str(b.slug, 40).toLowerCase();
      if (slug !== s.slug) {
        need(ctx, "web_slug", MSG.needSlug);
        if (!SLUG_RE.test(slug)) throw new Bad(MSG.badSlug, 400, { code: "bad_slug" });
        if (await M.WebSite.exists({ slug })) throw new Bad(MSG.slugTaken, 409, { code: "slug_taken" });
        s.slug = slug;
      }
    }
    for (const [key, max] of [
      ["name", 80],
      ["tagline", 160],
      ["footer", 300],
    ]) {
      const v = trText(b[key], max);
      if (v) s[key] = v;
    }
    if (b.logo !== undefined) s.logo = b.logo ? cleanUrl(b.logo) : "";
    if (b.langs !== undefined) {
      const langs = (Array.isArray(b.langs) ? b.langs : []).filter((l, i, a) => LANGS.includes(l) && a.indexOf(l) === i);
      if (!langs.length) throw new Bad(MSG.badValue);
      s.langs = langs;
    }
    if (b.theme !== undefined) {
      if (!THEMES.includes(b.theme)) throw new Bad(MSG.badValue);
      if (!ctx.themes.includes(b.theme)) throw new Bad(MSG.notOwned, 402, { code: "not_owned", product: "web_theme", item: b.theme });
      s.theme = b.theme;
    }
    if (b.style && typeof b.style === "object") {
      const st = b.style;
      const theme = b.theme || s.theme;
      if (st.color !== undefined) {
        const c = String(st.color || "");
        if (c && !hex(c)) throw new Bad(MSG.badValue);
        if (c && !brand && !PRESET_COLORS.includes(c.toUpperCase())) throw new Bad(MSG.needBrand, 402, { product: "web_brand" });
        s.style.color = c;
      }
      for (const key of ["accent", "bg"]) {
        if (st[key] === undefined) continue;
        const c = String(st[key] || "");
        if (c && !hex(c)) throw new Bad(MSG.badValue);
        if (c && !brand) throw new Bad(MSG.needBrand, 402, { product: "web_brand" });
        s.style[key] = c;
      }
      if (st.font !== undefined) {
        const f = String(st.font || "");
        if (f && !ALL_FONTS.includes(f)) throw new Bad(MSG.badValue);
        if (f && !brand && !FREE_FONTS.includes(f) && THEME_FONT[theme] !== f) throw new Bad(MSG.needBrand, 402, { product: "web_brand" });
        s.style.font = f;
      }
      if (st.buttons !== undefined) {
        if (!["", "round", "pill", "square"].includes(st.buttons)) throw new Bad(MSG.badValue);
        s.style.buttons = st.buttons;
      }
      if (st.mode !== undefined) {
        if (!["", "light", "dark"].includes(st.mode)) throw new Bad(MSG.badValue);
        s.style.mode = st.mode;
      }
    }
    if (b.contact && typeof b.contact === "object") {
      const c = b.contact;
      const lim = { phone: 40, telegram: 120, facebook: 300, instagram: 300, tiktok: 300, youtube: 300, email: 120, map_url: 800 };
      for (const [k, max] of Object.entries(lim)) if (c[k] !== undefined) s.contact[k] = str(c[k], max);
      const addr = trText(c.address, 300);
      if (addr) s.contact.address = addr;
    }
    if (b.seo && typeof b.seo === "object") {
      const t = trText(b.seo.title, 80);
      const d = trText(b.seo.description, 300);
      if (t) s.seo.title = t;
      if (d) s.seo.description = d;
      if (b.seo.image !== undefined) s.seo.image = b.seo.image ? cleanUrl(b.seo.image) : "";
    }
    touch(s);
    await s.save();
    if (b.logo !== undefined) require("../dashboard.route").forget(ctx.business.owner_id);
    res.json({ success: true, data: siteOut(s), message: MSG.saved });
  });

  // ---------------------------------------- starters + pages ----------------------------------------
  own("post", "/template", true, async (ctx, req, res) => {
    const key = String(req.body?.key || "");
    if (!TEMPLATE_KEYS.includes(key)) throw new Bad(MSG.badValue);
    const bid = ctx.business._id;
    await M.WebPage.deleteMany({ business_id: bid });
    await M.WebPage.insertMany(templatePages(key).map((p, i) => ({ business_id: bid, slug: p.slug, title: p.title, home: !!p.home, menu: true, sort: i, blocks: cleanBlocks(p.blocks) })));
    ctx.site.template = key;
    // the starter's look, when it's one the owner has
    if (ctx.themes.includes(KINDS[key].theme) && !req.body?.keep_look) ctx.site.theme = KINDS[key].theme;
    touch(ctx.site);
    await ctx.site.save();
    res.json({ success: true, data: await overview(await ctxOf(req)), message: MSG.saved });
  });

  async function freePageSlug(bid, want, exceptId) {
    let slug = slugOf(want) || "page";
    if (slug.length < 2) slug = `page-${slug}`;
    if (RESERVED.includes(slug)) slug = `${slug}-page`;
    for (let i = 0; i < 30; i++) {
      const s = i ? `${slug.slice(0, 36)}-${i + 1}` : slug;
      if (!(await M.WebPage.exists({ business_id: bid, slug: s, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }))) return s;
    }
    return `page-${crypto.randomBytes(3).toString("hex")}`;
  }
  const pageOfCtx = async (ctx, pid) => {
    if (!validId(pid)) throw new Bad(MSG.badId);
    const p = await M.WebPage.findOne({ _id: pid, business_id: ctx.business._id });
    if (!p) throw new Bad(MSG.rowNotFound, 404);
    return p;
  };
  own("post", "/pages", true, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const count = await M.WebPage.countDocuments({ business_id: bid });
    if (count >= ctx.maxPages) throw new Bad(ctx.addons.web_pages.active ? MSG.pageMax : MSG.pageLimit, 402, ctx.addons.web_pages.active ? {} : { product: "web_pages" });
    const title = trText(req.body?.title, 60) || { km: "", en: "New page" };
    const slug = await freePageSlug(bid, req.body?.slug || title.en || title.km || "page");
    const last = await M.WebPage.findOne({ business_id: bid }).sort({ sort: -1 }).select("sort").lean();
    const p = await M.WebPage.create({ business_id: bid, slug, title, home: count === 0, menu: true, sort: (last?.sort ?? -1) + 1, blocks: cleanBlocks(req.body?.blocks || []) });
    touch(ctx.site);
    await ctx.site.save();
    res.status(201).json({ success: true, data: pageOut(p.toObject()), message: MSG.saved });
  });
  own("put", "/pages/:pid", true, async (ctx, req, res) => {
    const p = await pageOfCtx(ctx, req.params.pid);
    const b = req.body || {};
    const title = trText(b.title, 60);
    if (title) p.title = title;
    if (b.slug !== undefined && !p.home) {
      const slug = str(b.slug, 40).toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug) || slug.length < 2 || RESERVED.includes(slug)) throw new Bad(MSG.badSlug, 400, { code: "bad_slug" });
      if (await M.WebPage.exists({ business_id: ctx.business._id, slug, _id: { $ne: p._id } })) throw new Bad(MSG.pageSlugTaken, 409, { code: "page_slug_taken" });
      p.slug = slug;
    }
    if (b.menu !== undefined) p.menu = b.menu === true;
    if (b.blocks !== undefined) {
      const blocks = cleanBlocks(b.blocks);
      if (JSON.stringify(blocks).length > 400000) throw new Bad(MSG.tooLong);
      p.blocks = blocks;
      p.markModified("blocks");
    }
    await p.save();
    touch(ctx.site);
    await ctx.site.save();
    res.json({ success: true, data: pageOut(p.toObject()), changed_at: ctx.site.changed_at, message: MSG.saved });
  });
  own("post", "/pages/:pid/duplicate", true, async (ctx, req, res) => {
    const p = await pageOfCtx(ctx, req.params.pid);
    const count = await M.WebPage.countDocuments({ business_id: ctx.business._id });
    if (count >= ctx.maxPages) throw new Bad(ctx.addons.web_pages.active ? MSG.pageMax : MSG.pageLimit, 402, ctx.addons.web_pages.active ? {} : { product: "web_pages" });
    const copy = await M.WebPage.create({
      business_id: ctx.business._id,
      slug: await freePageSlug(ctx.business._id, `${p.slug}-copy`),
      title: { km: p.title.km ? `${p.title.km} (ចម្លង)` : "", en: p.title.en ? `${p.title.en} (copy)` : "" },
      home: false,
      menu: false,
      sort: p.sort + 0.5,
      blocks: cleanBlocks(p.blocks.map((x) => ({ ...(x.toObject ? x.toObject() : x), id: Math.random().toString(36).slice(2, 10) }))),
    });
    touch(ctx.site);
    await ctx.site.save();
    res.status(201).json({ success: true, data: pageOut(copy.toObject()), message: MSG.saved });
  });
  own("post", "/pages/:pid/home", true, async (ctx, req, res) => {
    const p = await pageOfCtx(ctx, req.params.pid);
    await M.WebPage.updateMany({ business_id: ctx.business._id, _id: { $ne: p._id } }, { $set: { home: false } });
    p.home = true;
    p.menu = true;
    await p.save();
    touch(ctx.site);
    await ctx.site.save();
    res.json({ success: true, data: (await pagesOf(ctx.business._id)).map(pageOut), message: MSG.saved });
  });
  own("delete", "/pages/:pid", true, async (ctx, req, res) => {
    const p = await pageOfCtx(ctx, req.params.pid);
    if (p.home) throw new Bad(MSG.homeKeep, 400, { code: "home" });
    await p.deleteOne();
    touch(ctx.site);
    await ctx.site.save();
    res.json({ success: true, message: MSG.deleted });
  });
  own("put", "/pages-order", true, async (ctx, req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(validId).slice(0, 100);
    await Promise.all(ids.map((pid, i) => M.WebPage.updateOne({ _id: pid, business_id: ctx.business._id }, { $set: { sort: i } })));
    touch(ctx.site);
    await ctx.site.save();
    res.json({ success: true, data: (await pagesOf(ctx.business._id)).map(pageOut), message: MSG.saved });
  });

  // ---------------------------------------- publish ----------------------------------------
  own("post", "/publish", true, async (ctx, req, res) => {
    const pages = await pagesOf(ctx.business._id);
    if (!pages.length) throw new Bad(MSG.noPages, 400, { code: "no_pages" });
    const s = ctx.site;
    s.live = {
      at: new Date(),
      site: publicSite(s, ctx.business),
      pages: pages.map((p) => ({ slug: p.slug, title: p.title, home: p.home, menu: p.menu, blocks: (p.blocks || []).filter((x) => !x.hidden) })),
    };
    s.markModified("live");
    s.published = true;
    s.published_at = s.live.at;
    s.changed_at = null;
    await s.save();
    res.json({ success: true, data: siteOut(s), message: MSG.published });
  });
  own("post", "/unpublish", true, async (ctx, req, res) => {
    ctx.site.published = false;
    await ctx.site.save();
    res.json({ success: true, data: siteOut(ctx.site), message: MSG.unpublished });
  });

  // ---------------------------------------- pictures ----------------------------------------
  own("get", "/media", false, async (ctx, req, res) => {
    const rows = await M.WebMedia.find({ business_id: ctx.business._id }).sort({ created_date: -1 }).limit(LIMITS.media).lean();
    res.json({ success: true, data: rows, limit: LIMITS.media });
  });
  own(
    "post",
    "/media",
    true,
    async (ctx, req, res) => {
      if (!req.file) throw new Bad(MSG.noFile);
      if ((await M.WebMedia.countDocuments({ business_id: ctx.business._id })) >= LIMITS.media) throw new Bad(MSG.mediaFull, 400, { code: "media_full" });
      const saved = await cloud.uploadBuffer(req.file, `website/${ctx.business._id}`);
      const row = await M.WebMedia.create({ business_id: ctx.business._id, url: saved.url, public_id: saved.public_id || "", name: str(req.file.originalname, 120), bytes: req.file.size });
      res.status(201).json({ success: true, data: row.toObject(), message: MSG.saved });
    },
    [
      (req, res, next) =>
        upload.single("photo")(req, res, (err) => {
          if (err) return res.status(400).json({ success: false, message: MSG.badImage });
          next();
        }),
    ],
  );
  own("delete", "/media/:mid", true, async (ctx, req, res) => {
    if (!validId(req.params.mid)) throw new Bad(MSG.badId);
    const row = await M.WebMedia.findOneAndDelete({ _id: req.params.mid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    if (row.public_id) cloud.deleteFile(row.public_id).catch(() => {});
    res.json({ success: true, message: MSG.deleted });
  });

  // ---------------------------------------- contact form inbox ----------------------------------------
  own("get", "/messages", false, async (ctx, req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 30;
    const filter = { business_id: ctx.business._id, ...(req.query.unread === "1" ? { read: false } : {}) };
    const [rows, total, unread] = await Promise.all([
      M.WebMessage.find(filter)
        .sort({ created_date: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.WebMessage.countDocuments(filter),
      M.WebMessage.countDocuments({ business_id: ctx.business._id, read: false }),
    ]);
    res.json({ success: true, data: rows, unread, pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page } });
  });
  own("put", "/messages/:mid", true, async (ctx, req, res) => {
    if (!validId(req.params.mid)) throw new Bad(MSG.badId);
    const row = await M.WebMessage.findOneAndUpdate({ _id: req.params.mid, business_id: ctx.business._id }, { $set: { read: req.body?.read !== false } }, { returnDocument: "after" }).lean();
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, data: row });
  });
  own("put", "/messages-read-all", true, async (ctx, req, res) => {
    await M.WebMessage.updateMany({ business_id: ctx.business._id, read: false }, { $set: { read: true } });
    res.json({ success: true, message: MSG.saved });
  });
  own("delete", "/messages/:mid", true, async (ctx, req, res) => {
    if (!validId(req.params.mid)) throw new Bad(MSG.badId);
    await M.WebMessage.deleteOne({ _id: req.params.mid, business_id: ctx.business._id });
    res.json({ success: true, message: MSG.deleted });
  });

  // ---------------------------------------- visits ----------------------------------------
  own("get", "/stats", false, async (ctx, req, res) => {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const today = localDay();
    const from = addDays(today, -(days - 1));
    const rows = await M.WebStat.find({ business_id: ctx.business._id, day: { $gte: from } }).lean();
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const series = [];
    for (let d = from; d <= today; d = addDays(d, 1)) series.push({ day: d, views: byDay.get(d)?.views || 0 });
    const pages = {};
    for (const r of rows) for (const [k, v] of Object.entries(r.pages || {})) pages[k] = (pages[k] || 0) + v;
    const total = series.reduce((a, x) => a + x.views, 0);
    // Visits Pro: who, where from, which device (one pass over the visits of these days)
    let pro = null;
    if (ctx.addons.web_stats?.active) {
      const since = new Date(`${from}T00:00:00+07:00`);
      const top = (field, n = 12) => [{ $match: { [field]: { $gt: "" } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: n }];
      const [f] = await M.WebVisit.aggregate([
        { $match: { business_id: ctx.business._id, at: { $gte: since } } },
        {
          $facet: {
            unique: [{ $group: { _id: "$visitor" } }, { $count: "n" }],
            countries: top("country", 15),
            cities: top("city", 15),
            devices: top("device", 3),
            os: top("os", 8),
            browsers: top("browser", 8),
            sources: [{ $group: { _id: "$source", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 12 }],
            hours: [{ $group: { _id: { $hour: { date: "$at", timezone: "+07:00" } }, n: { $sum: 1 } } }],
            recent: [{ $sort: { at: -1 } }, { $limit: 60 }, { $project: { _id: 0, business_id: 0, visitor: 0, day: 0 } }],
          },
        },
      ]);
      const kv = (rows) => rows.map((x) => ({ key: x._id, n: x.n }));
      pro = {
        unique: f.unique[0]?.n || 0,
        countries: kv(f.countries),
        cities: kv(f.cities),
        devices: kv(f.devices),
        os: kv(f.os),
        browsers: kv(f.browsers),
        sources: kv(f.sources),
        hours: Array.from({ length: 24 }, (_, hr) => f.hours.find((x) => x._id === hr)?.n || 0),
        recent: f.recent.map((v) => ({ ...v, page: String(v.page || "").replace(/_/g, "/") })),
      };
    }
    res.json({
      success: true,
      data: {
        days,
        today: byDay.get(today)?.views || 0,
        total,
        avg: Math.round((total / days) * 10) / 10,
        all_time: ctx.site.views || 0,
        series,
        pro,
        top: Object.entries(pages)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([page, views]) => ({ page: page.replace(/_/g, "/"), views })),
      },
    });
  });

  // ---------------------------------------- blog (web_blog) ----------------------------------------
  const postFields = async (ctx, b, row) => {
    const out = {};
    for (const [key, max] of [
      ["title", 160],
      ["excerpt", 400],
      ["body", 20000],
    ]) {
      const v = trText(b[key], max);
      if (v) out[key] = v;
    }
    if (b.cover !== undefined) out.cover = b.cover ? cleanUrl(b.cover) : "";
    if (b.category !== undefined) out.category = str(b.category, 40);
    if (b.published !== undefined) out.published = b.published === true;
    if (b.date !== undefined && !Number.isNaN(Date.parse(b.date))) out.date = new Date(b.date);
    if (b.slug !== undefined || !row) {
      const want = slugOf(b.slug || out.title?.en || out.title?.km || "", 60) || `post-${crypto.randomBytes(3).toString("hex")}`;
      let slug = want.length < 2 ? `post-${want}` : want;
      for (let i = 2; await M.WebPost.exists({ business_id: ctx.business._id, slug, ...(row ? { _id: { $ne: row._id } } : {}) }); i++) slug = `${want.slice(0, 54)}-${i}`;
      out.slug = slug;
    }
    return out;
  };
  own("get", "/posts", false, async (ctx, req, res) => {
    const rows = await M.WebPost.find({ business_id: ctx.business._id }).sort({ date: -1 }).limit(LIMITS.posts).lean();
    res.json({ success: true, data: rows.map((p) => postOut(p)) });
  });
  own("post", "/posts", true, async (ctx, req, res) => {
    need(ctx, "web_blog", MSG.needBlog);
    if ((await M.WebPost.countDocuments({ business_id: ctx.business._id })) >= LIMITS.posts) throw new Bad(MSG.postLimit);
    const set = await postFields(ctx, req.body || {}, null);
    if (!set.title?.km && !set.title?.en) throw new Bad(MSG.badValue);
    const row = await M.WebPost.create({ business_id: ctx.business._id, ...set });
    res.status(201).json({ success: true, data: postOut(row.toObject()), message: MSG.saved });
  });
  own("put", "/posts/:pid", true, async (ctx, req, res) => {
    need(ctx, "web_blog", MSG.needBlog);
    if (!validId(req.params.pid)) throw new Bad(MSG.badId);
    const row = await M.WebPost.findOne({ _id: req.params.pid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    Object.assign(row, await postFields(ctx, req.body || {}, row));
    await row.save();
    res.json({ success: true, data: postOut(row.toObject()), message: MSG.saved });
  });
  own("delete", "/posts/:pid", true, async (ctx, req, res) => {
    if (!validId(req.params.pid)) throw new Bad(MSG.badId);
    await M.WebPost.deleteOne({ _id: req.params.pid, business_id: ctx.business._id });
    res.json({ success: true, message: MSG.deleted });
  });

  // ---------------------------------------- looks ----------------------------------------
  own("post", "/themes/:key", true, async (ctx, req, res) => {
    const key = req.params.key;
    if (!THEMES.includes(key)) throw new Bad(MSG.badValue);
    let charged = 0;
    let balance;
    if (!ctx.themes.includes(key)) {
      const r = await buy({ customer: req.customer, business: ctx.business, product: "web_theme", item: key, expect: null });
      charged = r.charged;
      balance = r.balance;
    }
    // the look as designed (what the preview showed): colour / font / button / light-dark changes start again
    if (ctx.site.theme !== key) ctx.site.style = { color: "", accent: "", bg: "", font: "", buttons: "", mode: "" };
    ctx.site.theme = key;
    touch(ctx.site);
    await ctx.site.save();
    res.json({ success: true, data: await overview(await ctxOf(req)), charged, balance, message: MSG.saved });
  });

  // ---------------------------------------- Telegram (web_telegram) ----------------------------------------
  const esc = telegram.escape;
  telegram.onStart(async (code, chat) => {
    if (!/^ws_[A-Za-z0-9]{12,40}$/.test(code)) return null;
    const s = await M.WebSite.findOne({ "tg.link_code": code });
    if (!s || !s.tg.link_expires || s.tg.link_expires < new Date()) return "⌛️ This link has expired. Open BizHub → Website → Telegram → Connect again.\nតំណនេះផុតកំណត់ហើយ។ សូមចុច “ភ្ជាប់” ម្តងទៀត។";
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "Telegram");
    s.tg = { chat_id: String(chat.id), chat_name: name.slice(0, 80), chat_type: chat.type || "private", connected_at: new Date(), link_code: "", link_expires: null };
    await s.save();
    const biz = await Business.findById(s.business_id).select("name").lean();
    return `✅ <b>${esc(biz?.name || "Website")}</b> is connected to this chat.\nបានភ្ជាប់ជាមួយ BizHub ហើយ។\n\n✉️ Messages from your website's contact form arrive here.`;
  });
  const tgFail = (err) => {
    if (err instanceof telegram.TelegramError) throw new Bad(err.message === "not_configured" ? MSG.tgNotConfigured : err.message === "blocked" ? MSG.tgBlocked : MSG.tgUnreachable, err.status);
    throw err;
  };
  own("get", "/telegram", false, async (ctx, req, res) => res.json({ success: true, data: tgOut(ctx.site, ctx.addons) }));
  own("post", "/telegram/link", true, async (ctx, req, res) => {
    need(ctx, "web_telegram", MSG.needTelegram);
    if (!telegram.ready()) throw new Bad(MSG.tgNotConfigured, 503);
    const bot = await telegram.botUsername().catch(tgFail);
    const code = `ws_${crypto.randomBytes(24).toString("base64url").replace(/[-_]/g, "").slice(0, 24)}`;
    const expires = new Date(Date.now() + 15 * 60000);
    ctx.site.tg.link_code = code;
    ctx.site.tg.link_expires = expires;
    await ctx.site.save();
    res.json({ success: true, data: { url: `https://t.me/${bot}?start=${code}`, group_url: `https://t.me/${bot}?startgroup=${code}`, bot, expires_at: expires } });
  });
  own("post", "/telegram/test", true, async (ctx, req, res) => {
    need(ctx, "web_telegram", MSG.needTelegram);
    const chat = ctx.site.tg?.chat_id;
    if (!chat) throw new Bad(MSG.tgNotConnected);
    try {
      await telegram.send(chat, `🔔 <b>${esc(ctx.business.name)}</b>\nTest message from BizHub — everything works.\nសារសាកល្បងពី BizHub — ដំណើរការល្អ។`);
    } catch (err) {
      if (err instanceof telegram.TelegramError && err.message === "blocked") {
        ctx.site.tg.chat_id = "";
        await ctx.site.save();
      }
      tgFail(err);
    }
    res.json({ success: true, message: MSG.tgSent });
  });
  own("delete", "/telegram", true, async (ctx, req, res) => {
    const chat = ctx.site.tg?.chat_id;
    ctx.site.tg = { chat_id: "", chat_name: "", chat_type: "", connected_at: null, link_code: "", link_expires: null };
    await ctx.site.save();
    if (chat) telegram.send(chat, "🔌 BizHub disconnected from this chat.\nបានផ្តាច់ពី BizHub ហើយ។").catch(() => {});
    res.json({ success: true, data: tgOut(ctx.site, ctx.addons), message: MSG.saved });
  });

  // ---------------------------------------- public: /site/<slug> ----------------------------------------
  async function publicCtx(slug) {
    const s = await M.WebSite.findOne({
      slug: String(slug || "")
        .toLowerCase()
        .slice(0, 40),
    });
    if (!s || !s.published || !s.live) throw new Bad(MSG.siteOff, 404, { code: "not_found" });
    const [business, state] = await Promise.all([Business.findOne({ _id: s.business_id, deleted: false, category: "website" }).lean(), licenseState(s.business_id)]);
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || !owner?.status || state.license.locked) throw new Bad(MSG.siteOff, 404, { code: "off" });
    return { s, business, state };
  }
  const tries = new Map();
  const slowDown = (key, max = 10) => {
    const now = Date.now();
    const list = (tries.get(key) || []).filter((t) => now - t < 10 * 60000);
    if (list.length >= max) throw new Bad(MSG.slow, 429, { code: "slow" });
    tries.set(key, [...list, now]);
    if (tries.size > 5000) tries.clear();
  };
  const latestPosts = (bid, n = 6) =>
    M.WebPost.find({ business_id: bid, published: true, date: { $lte: new Date() } })
      .sort({ date: -1 })
      .limit(n)
      .lean();

  prop.app.get(
    "/api/public/website/:slug",
    handle(async (req, res) => {
      const { s, state } = await publicCtx(req.params.slug);
      const blog = !!state.addons.web_blog?.active;
      const posts = blog ? await latestPosts(s.business_id) : [];
      res.set("Cache-Control", "public, max-age=30");
      res.json({
        success: true,
        data: {
          site: { ...s.live.site, slug: s.slug },
          pages: s.live.pages,
          blog,
          branding: !state.addons.web_nobrand?.active,
          posts: posts.map((p) => postOut(p, false)),
          at: s.live.at,
        },
      });
    }),
  );
  prop.app.post(
    "/api/public/website/:slug/hit",
    handle(async (req, res) => {
      const { s } = await publicCtx(req.params.slug);
      const page = slugOf(String(req.body?.page || "home"), 60) || "home";
      const key = page.replace(/[.$]/g, "_");
      const day = localDay();
      const h = (n) => String(req.headers[n] || "");
      const ipRaw = h("x-forwarded-for") || h("x-real-ip") || req.ip || "";
      const ua = new UAParser(h("user-agent")).getResult();
      let city = h("x-vercel-ip-city");
      try {
        city = decodeURIComponent(city);
      } catch {
        /* keep as sent */
      }
      const ownHost = (() => {
        try {
          return new URL(h("origin") || h("referer")).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      })();
      await Promise.all([
        M.WebSite.updateOne({ _id: s._id }, { $inc: { views: 1 } }),
        M.WebStat.updateOne({ business_id: s.business_id, day }, { $inc: { views: 1, [`pages.${key}`]: 1 } }, { upsert: true }),
        M.WebVisit.create({
          business_id: s.business_id,
          day,
          page: key,
          visitor: crypto
            .createHash("sha256")
            .update(`${s.business_id}|${day}|${ipRaw.split(",")[0].trim()}|${h("user-agent")}`)
            .digest("hex")
            .slice(0, 16),
          ip: maskIp(ipRaw),
          country: (h("x-vercel-ip-country") || h("cf-ipcountry"))
            .slice(0, 2)
            .toUpperCase()
            .replace(/[^A-Z]/g, ""),
          city: city.slice(0, 80),
          device: ua.device?.type === "mobile" || ua.device?.type === "tablet" ? ua.device.type : "desktop",
          os: String(ua.os?.name || "").slice(0, 30),
          browser: String(ua.browser?.name || "").slice(0, 30),
          source: sourceOf(req.body?.ref, ownHost),
        }).catch(() => {}),
      ]);
      res.json({ success: true });
    }),
  );
  prop.app.post(
    "/api/public/website/:slug/message",
    handle(async (req, res) => {
      const { s, business, state } = await publicCtx(req.params.slug);
      const b = req.body || {};
      const text = str(b.text, 2000);
      if (text.length < 2) throw new Bad(MSG.msgEmpty, 400, { code: "empty" });
      slowDown(`msg:${s._id}:${req.ip}`, 8);
      const row = await M.WebMessage.create({ business_id: s.business_id, page: str(b.page, 60), name: str(b.name, 80), phone: str(b.phone, 30), email: str(b.email, 120), text });
      if (state.addons.web_telegram?.active && s.tg?.chat_id && telegram.ready()) {
        const lines = [`✉️ <b>${esc(business.name)}</b> · website message`, row.name && `👤 ${esc(row.name)}`, row.phone && `📞 ${esc(row.phone)}`, row.email && `📧 ${esc(row.email)}`, "", esc(row.text)].filter(
          (x) => x !== "" && x !== false && x !== undefined,
        );
        telegram.send(s.tg.chat_id, lines.join("\n")).catch(async (err) => {
          if (err instanceof telegram.TelegramError && err.message === "blocked") await M.WebSite.updateOne({ _id: s._id }, { $set: { "tg.chat_id": "" } }).catch(() => {});
        });
      }
      res.status(201).json({ success: true, message: MSG.msgThanks });
    }),
  );
  prop.app.get(
    "/api/public/website/:slug/posts",
    handle(async (req, res) => {
      const { s, state } = await publicCtx(req.params.slug);
      if (!state.addons.web_blog?.active) throw new Bad(MSG.siteOff, 404, { code: "no_blog" });
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = 12;
      const filter = { business_id: s.business_id, published: true, date: { $lte: new Date() } };
      const [rows, total] = await Promise.all([
        M.WebPost.find(filter)
          .sort({ date: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        M.WebPost.countDocuments(filter),
      ]);
      res.json({ success: true, data: rows.map((p) => postOut(p, false)), pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page } });
    }),
  );
  prop.app.get(
    "/api/public/website/:slug/posts/:post",
    handle(async (req, res) => {
      const { s, state } = await publicCtx(req.params.slug);
      if (!state.addons.web_blog?.active) throw new Bad(MSG.siteOff, 404, { code: "no_blog" });
      const row = await M.WebPost.findOneAndUpdate({ business_id: s.business_id, slug: String(req.params.post || "").slice(0, 60), published: true }, { $inc: { views: 1 } }, { returnDocument: "after" }).lean();
      if (!row) throw new Bad(MSG.rowNotFound, 404, { code: "not_found" });
      res.json({ success: true, data: postOut(row) });
    }),
  );
};
module.exports.licenseState = licenseState;
