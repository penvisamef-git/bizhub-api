// Mini Mart website (mart_website, 110 coins a year): the shop's own page at /m/<slug>
// 36 looks: classic free, the others bought one by one (mart_site_theme, 35 coins, forever).
// Owner (/api/user/businesses/:id/mart):
//   GET    /site                 the site + add-on + looks + categories
//   PUT    /site                 { slug, published, theme, color, tagline, about, hours, map_url, facebook, telegram, show: {...}, hidden_categories }
//   GET    /site/slug?value=x    is this address free?
//   POST   /site/cover (multipart "file")      DELETE /site/cover
//   POST   /site-themes/:theme/buy
// Public (no key):
//   GET  /api/public/shop/:slug  the published website: business info, the parts that are on, products (needs mart_website active)
const License = require("../../license/license.model");
const Customer = require("../../user/customer.model");
const { buy } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");
const { rate_limit } = require("../../util/rate_limit");

const RESERVED = new Set(["admin", "api", "app", "www", "bizhub", "login", "sign-up", "public", "help", "support", "site", "static", "assets", "test", "account"]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
const SHOW_KEYS = ["products", "prices", "stock", "about", "hours", "contact", "map", "contact_form"];
const MAX_PAGES = 8;
const FREE = "classic";
const T = {
  needWebsite: "សូមដោះសោ “គេហទំព័រហាង” ជាមុនសិន!",
  badSlug: "អាសយដ្ឋានត្រូវមាន 3–40 តួ (a-z, 0-9, -)",
  slugTaken: "អាសយដ្ឋាននេះមានគេប្រើហើយ!",
  needSlug: "សូមដាក់អាសយដ្ឋានគេហទំព័រជាមុនសិន!",
  themeLocked: "សូមទិញរចនានេះជាមុនសិន!",
  badTheme: "រចនាមិនត្រឹមត្រូវ!",
  badUrl: "តំណភ្ជាប់មិនត្រឹមត្រូវ!",
  tooManyPages: `ទំព័របានត្រឹម ${MAX_PAGES}។`,
  sent: "បានផ្ញើសាររួចហើយ។ ហាងនឹងឆ្លើយតបឆាប់ៗ។",
  noForm: "ទម្រង់ទំនាក់ទំនងត្រូវបានបិទ។",
  siteOff: "រកមិនឃើញគេហទំព័រនេះទេ។",
};
const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
const slugOk = (s) => SLUG_RE.test(s) && !RESERVED.has(s) && !s.includes("--");

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, withFile, settingsOf, licenseState, unitsOf, Bad, MSG, text, bool, validId, M, Business } = kit;
  const PAID = M.SITE_THEMES.filter((t) => t !== FREE);
  const ownedThemes = async (bid) => (await License.find({ business_id: bid, product: "mart_site_theme", expires_at: null }).select("item").lean()).map((r) => r.item).filter((t) => PAID.includes(t));
  const needAddon = (ctx) => {
    if (!ctx.addons.mart_website?.active) throw new Bad(T.needWebsite, 402, { product: "mart_website" });
  };
  async function siteOf(bid) {
    const found = await M.MartSite.findOne({ business_id: bid });
    if (found) return found;
    try {
      return await M.MartSite.create({ business_id: bid });
    } catch (err) {
      if (err.code === 11000) return M.MartSite.findOne({ business_id: bid });
      throw err;
    }
  }
  async function suggestSlug(name) {
    const b = slugify(name) || "my-shop";
    const start = b.length >= 3 ? b : `${b}-mart`;
    for (let i = 0; i < 20; i++) {
      const s = i ? `${start.slice(0, 36)}-${i + 1}` : start;
      if (slugOk(s) && !(await M.MartSite.exists({ slug: s }))) return s;
    }
    return "";
  }

  // ---------- owner ----------
  const info = async (ctx, site) => {
    const bid = ctx.business._id;
    const [price, themePrice, owned, categories, suggested, shopPrice, unread] = await Promise.all([
      priceOf("mart_website"),
      priceOf("mart_site_theme"),
      ownedThemes(bid),
      M.MartCategory.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }).select("name color").lean(),
      site.slug ? site.slug : suggestSlug(ctx.business.name),
      priceOf("mart_shop"),
      M.MartMessage.countDocuments({ business_id: bid, read: false }),
    ]);
    return {
      addon: { ...ctx.addons.mart_website, price },
      shop: { ...ctx.addons.mart_shop, price: shopPrice },
      stock_on: !!ctx.addons.mart_stock?.active,
      site,
      suggested_slug: suggested,
      themes: { list: M.SITE_THEMES, free: [FREE], owned, price: themePrice },
      categories,
      unread,
      business: { name: ctx.business.name, logo_url: ctx.business.logo_url || "", phone: ctx.business.phone || "", address: ctx.business.address || "" },
    };
  };
  prop.app.get(
    `${base}/site`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      res.json({ success: true, data: await info(ctx, await siteOf(ctx.business._id)) });
    }),
  );
  prop.app.get(
    `${base}/site/slug`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const value = String(req.query.value || "")
        .trim()
        .toLowerCase();
      if (!slugOk(value)) return res.json({ success: true, data: { value, available: false, reason: "format" } });
      const other = await M.MartSite.findOne({ slug: value }).select("business_id").lean();
      res.json({ success: true, data: { value, available: !other || String(other.business_id) === String(ctx.business._id) } });
    }),
  );
  const urlOf = (b, key, max) => {
    const v = text(b, key, max);
    if (v === undefined || v === "") return v;
    if (!/^https?:\/\/\S+$/i.test(v)) throw new Bad(`${T.badUrl} (${key})`);
    return v;
  };
  prop.app.put(
    `${base}/site`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      const bid = ctx.business._id;
      const site = await siteOf(bid);
      if (b.slug !== undefined) {
        const slug = String(b.slug || "")
          .trim()
          .toLowerCase();
        if (slug && !slugOk(slug)) throw new Bad(T.badSlug, 400, { code: "bad_slug" });
        if (slug && (await M.MartSite.exists({ slug, business_id: { $ne: bid } }))) throw new Bad(T.slugTaken, 409, { code: "slug_taken" });
        site.slug = slug || undefined;
      }
      if (b.theme !== undefined) {
        if (!M.SITE_THEMES.includes(b.theme)) throw new Bad(T.badTheme);
        if (b.theme !== FREE && !(await ownedThemes(bid)).includes(b.theme)) throw new Bad(T.themeLocked, 402, { product: "mart_site_theme", item: b.theme });
        site.theme = b.theme;
      }
      if (b.color !== undefined) {
        if (b.color && !/^#[0-9A-Fa-f]{6}$/.test(String(b.color))) throw new Bad(`${MSG.badValue} (color)`);
        site.color = String(b.color || "").toUpperCase();
      }
      for (const [k, max] of [
        ["tagline", 140],
        ["about", 2000],
        ["hours", 300],
        ["telegram", 100],
      ]) {
        const v = text(b, k, max);
        if (v !== undefined) site[k] = v;
      }
      for (const [k, max] of [
        ["map_url", 500],
        ["facebook", 200],
      ]) {
        const v = urlOf(b, k, max);
        if (v !== undefined) site[k] = v;
      }
      if (b.show && typeof b.show === "object") for (const k of SHOW_KEYS) if (b.show[k] !== undefined) site.set(`show.${k}`, b.show[k] === true);
      if (b.hidden_categories !== undefined) {
        if (!Array.isArray(b.hidden_categories) || b.hidden_categories.length > 100 || !b.hidden_categories.every(validId)) throw new Bad(`${MSG.badValue} (hidden_categories)`);
        site.hidden_categories = [...new Set(b.hidden_categories.map(String))];
      }
      const pub = bool(b, "published");
      if (pub !== undefined) {
        if (pub) needAddon(ctx);
        site.published = pub;
      }
      if (site.published && !site.slug) throw new Bad(T.needSlug, 400, { code: "need_slug" });
      try {
        await site.save();
      } catch (err) {
        if (err.code === 11000) throw new Bad(T.slugTaken, 409, { code: "slug_taken" });
        throw err;
      }
      res.json({ success: true, data: await info(ctx, site), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${base}/site/cover`,
    ...guard,
    withFile("file"),
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      if (!req.file) throw new Bad(MSG.noFile);
      const site = await siteOf(ctx.business._id);
      const saved = await uploadBuffer(req.file, "mart/site");
      const old = site.cover?.public_id;
      site.cover = { url: saved.url, public_id: saved.public_id };
      await site.save();
      if (old) deleteFile(old).catch(() => {});
      res.status(201).json({ success: true, data: await info(ctx, site), message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/site/cover`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const site = await siteOf(ctx.business._id);
      const old = site.cover?.public_id;
      site.cover = { url: "", public_id: "" };
      await site.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: await info(ctx, site), message: MSG.deleted });
    }),
  );
  prop.app.post(
    `${base}/site-themes/:theme/buy`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const theme = req.params.theme;
      if (!PAID.includes(theme)) throw new Bad(T.badTheme);
      const r = await buy({ customer: req.customer, business: ctx.business, product: "mart_site_theme", item: theme, expect: null });
      const site = await siteOf(ctx.business._id);
      site.theme = theme;
      await site.save();
      res.json({ success: true, data: await info(ctx, site), charged: r.charged, balance: r.balance, message: MSG.saved });
    }),
  );

  // ---------- public ----------
  // the live website of a slug: published, the website add-on on, the business + its owner not stopped
  async function liveSite(slug) {
    const s = String(slug || "").toLowerCase();
    const site = slugOk(s) ? await M.MartSite.findOne({ slug: s, published: true }).lean() : null;
    if (!site) return null;
    const bid = site.business_id;
    const [business, state, settings] = await Promise.all([Business.findOne({ _id: bid, deleted: false }).select("owner_id status name logo_url phone address category").lean(), licenseState(bid), settingsOf(bid)]);
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || business.category !== "mart" || !owner?.status || state.license.locked || !state.addons.mart_website?.active) return null;
    const shopOpen = !!state.addons.mart_shop?.active && settings.shop_on !== false;
    return { site, bid, business, state, settings, shopOpen };
  }
  // the products shown online (hidden categories left out); full = the shop (prices always on)
  async function catalogOf(live, { full = false } = {}) {
    const { site, bid, state } = live;
    const show = site.show || {};
    if (!full && show.products === false) return { categories: [], products: [], units: [] };
    const hidden = new Set((site.hidden_categories || []).map(String));
    const [cats, prods, units] = await Promise.all([
      M.MartCategory.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }).select("name color").lean(),
      M.MartProduct.find({ business_id: bid, active: true }).sort({ fav: -1, sort: 1, name: 1 }).limit(3000).select("name category_id price unit_id photo.url stock low_stock track_stock fav").lean(),
      unitsOf(bid),
    ]);
    const stockOn = !!state.addons.mart_stock?.active;
    const showStock = stockOn && (full || show.stock === true);
    const prices = full || show.prices !== false;
    const unitOf = new Map(units.map((u) => [String(u._id), u]));
    const products = prods
      .filter((p) => !p.category_id || !hidden.has(String(p.category_id)))
      .map((p) => {
        const u = unitOf.get(String(p.unit_id));
        const tracked = stockOn && p.track_stock;
        return {
          _id: p._id,
          name: p.name,
          category_id: p.category_id || null,
          ...(prices ? { price: p.price } : {}),
          unit_en: u ? u.name_en || u.name_km : "",
          unit_km: u ? u.name_km || u.name_en : "",
          photo: p.photo?.url || "",
          fav: !!p.fav,
          // sold out always counts for the shop (an order can't be made); "only N left" when the owner shows stock
          ...(tracked ? { soldout: p.stock <= 0, ...(showStock && p.stock > 0 && p.stock <= (p.low_stock ?? 5) ? { left: p.stock } : {}), ...(full || live.shopOpen ? { stock: Math.max(0, p.stock) } : {}) } : {}),
        };
      });
    const used = new Set(products.map((p) => String(p.category_id)));
    return { categories: cats.filter((c) => !hidden.has(String(c._id)) && used.has(String(c._id))), products };
  }
  const themeOf = async (site) => (site.theme === FREE || (await ownedThemes(site.business_id)).includes(site.theme) ? site.theme : FREE); // a look no longer owned → the free one

  prop.app.get(
    "/api/public/shop/:slug",
    handle(async (req, res) => {
      const live = await liveSite(req.params.slug);
      if (!live) throw new Bad(T.siteOff, 404);
      const { site, business, settings, shopOpen } = live;
      const show = { ...Object.fromEntries(SHOW_KEYS.map((k) => [k, k !== "stock"])), ...(site.show || {}) };
      const cat = await catalogOf(live);
      res.set("Cache-Control", "public, max-age=30");
      res.json({
        success: true,
        data: {
          slug: site.slug,
          theme: await themeOf(site),
          color: site.color || "",
          business: { name: business.name, logo: business.logo_url || "", ...(show.contact ? { phone: business.phone || "", address: business.address || "", facebook: site.facebook || "", telegram: site.telegram || "" } : {}) },
          tagline: site.tagline || "",
          cover: site.cover?.url || "",
          about: show.about ? site.about || "" : "",
          hours: show.hours ? site.hours || "" : "",
          map_url: show.map ? site.map_url || "" : "",
          show,
          currency: settings.currency || "USD",
          khr_rate: settings.khr_rate || 4100,
          categories: cat.categories,
          products: cat.products,
          pages: (site.pages || []).filter((x) => x.visible !== false).map((x) => ({ key: x.key, title: x.title, body: x.body, image: x.image?.url || "" })),
          shop: {
            open: shopOpen,
            paused: !!live.state.addons.mart_shop?.active && settings.shop_on === false,
            pickup: settings.pickup_on !== false,
            delivery: settings.delivery_on !== false,
            delivery_fee: settings.delivery_fee || 0,
            min_order: settings.min_order || 0,
          },
        },
      });
    }),
  );

  // ---------- extra pages ----------
  const pageOf = (site, pid) => {
    const row = (site.pages || []).find((x) => String(x._id) === String(pid));
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  const readPage = (b, row) => {
    const title = text(b, "title", 60, { required: !row.title });
    if (title !== undefined) {
      if (!title) throw new Bad(`${MSG.required}: title`);
      row.title = title;
    }
    const body = text(b, "body", 6000);
    if (body !== undefined) row.body = body;
    const vis = bool(b, "visible");
    if (vis !== undefined) row.visible = vis;
    return row;
  };
  prop.app.post(
    `${base}/site/pages`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const site = await siteOf(ctx.business._id);
      if (site.pages.length >= MAX_PAGES) throw new Bad(T.tooManyPages);
      const row = readPage(req.body || {}, { title: "", body: "", visible: true });
      let key = slugify(row.title).slice(0, 30) || "page";
      while (site.pages.some((x) => x.key === key)) key = `${key.slice(0, 24)}-${require("crypto").randomBytes(2).toString("hex")}`;
      site.pages.push({ ...row, key });
      await site.save();
      res.status(201).json({ success: true, data: await info(ctx, site), message: MSG.saved });
    }),
  );
  prop.app.put(
    `${base}/site/pages/:pid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const site = await siteOf(ctx.business._id);
      readPage(req.body || {}, pageOf(site, req.params.pid));
      await site.save();
      res.json({ success: true, data: await info(ctx, site), message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/site/pages/:pid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const site = await siteOf(ctx.business._id);
      const row = pageOf(site, req.params.pid);
      if (row.image?.public_id) deleteFile(row.image.public_id).catch(() => {});
      site.pages = site.pages.filter((x) => String(x._id) !== String(row._id));
      await site.save();
      res.json({ success: true, data: await info(ctx, site), message: MSG.deleted });
    }),
  );
  // the menu order: { ids: [...] }
  prop.app.put(
    `${base}/site/pages-order`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const site = await siteOf(ctx.business._id);
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      if (ids.length !== site.pages.length || !site.pages.every((x) => ids.includes(String(x._id)))) throw new Bad(`${MSG.badValue} (ids)`);
      site.pages = ids.map((id) => site.pages.find((x) => String(x._id) === id).toObject());
      await site.save();
      res.json({ success: true, data: await info(ctx, site), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${base}/site/pages/:pid/image`,
    ...guard,
    withFile("file"),
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!req.file) throw new Bad(MSG.noFile);
      const site = await siteOf(ctx.business._id);
      const row = pageOf(site, req.params.pid);
      const saved = await uploadBuffer(req.file, "mart/site");
      const old = row.image?.public_id;
      row.image = { url: saved.url, public_id: saved.public_id || "" };
      await site.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: await info(ctx, site), message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/site/pages/:pid/image`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const site = await siteOf(ctx.business._id);
      const row = pageOf(site, req.params.pid);
      const old = row.image?.public_id;
      row.image = { url: "", public_id: "" };
      await site.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: await info(ctx, site), message: MSG.deleted });
    }),
  );

  // ---------- "Contact us" → inbox ----------
  const contactLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 5 });
  prop.app.post(
    "/api/public/shop/:slug/contact",
    contactLimit,
    handle(async (req, res) => {
      const live = await liveSite(req.params.slug);
      if (!live) throw new Bad(T.siteOff, 404);
      if (live.site.show?.contact_form === false) throw new Bad(T.noForm, 403, { code: "closed" });
      const b = req.body || {};
      if (b.website) return res.status(201).json({ success: true, message: T.sent }); // bots fill every field
      const row = await M.MartMessage.create({ business_id: live.bid, name: text(b, "name", 80, { required: true }), contact: text(b, "contact", 120) || "", message: text(b, "message", 2000, { required: true }) });
      await kit.tg?.soon(kit.tg.alert(live.bid, "new_message", { message: row.toObject() }, { settings: live.settings, addons: live.state.addons, name: live.business.name })); // Telegram (mart_telegram)
      res.status(201).json({ success: true, message: T.sent });
    }),
  );
  prop.app.get(
    `${base}/messages`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
      const limit = 30;
      const filter = { business_id: bid, ...(req.query.unread === "true" ? { read: false } : {}) };
      const [rows, total, unread] = await Promise.all([
        M.MartMessage.find(filter)
          .sort({ created_date: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        M.MartMessage.countDocuments(filter),
        M.MartMessage.countDocuments({ business_id: bid, read: false }),
      ]);
      res.json({ success: true, data: rows, unread, pagination: { total, totalPages: Math.max(1, Math.ceil(total / limit)), currentPage: page, pageSize: limit } });
    }),
  );
  prop.app.post(
    `${base}/messages/read-all`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      await M.MartMessage.updateMany({ business_id: ctx.business._id, read: false }, { $set: { read: true } });
      res.json({ success: true, unread: 0 });
    }),
  );
  prop.app.put(
    `${base}/messages/:mid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false); // reading mail never needs a live license
      if (!validId(req.params.mid)) throw new Bad(MSG.badId);
      const row = await M.MartMessage.findOneAndUpdate({ _id: req.params.mid, business_id: ctx.business._id }, { $set: { read: req.body?.read !== false } }, { returnDocument: "after" }).lean();
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, data: row, unread: await M.MartMessage.countDocuments({ business_id: ctx.business._id, read: false }) });
    }),
  );
  prop.app.delete(
    `${base}/messages/:mid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.mid)) throw new Bad(MSG.badId);
      await M.MartMessage.deleteOne({ _id: req.params.mid, business_id: ctx.business._id });
      res.json({ success: true, unread: await M.MartMessage.countDocuments({ business_id: ctx.business._id, read: false }), message: MSG.deleted });
    }),
  );

  return { liveSite, catalogOf, slugOk };
};
