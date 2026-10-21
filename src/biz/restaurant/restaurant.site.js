// Website add-on (rest_website, yearly): the restaurant's own website at /s/<slug>
// (home with top menu, about, food menu with a page per item, gallery, contact footer).
// 3 free themes; 6 paid themes, each bought once per restaurant (rest_site_theme, item = theme).
// Base: /api/user/businesses/:id/restaurant/site
//   GET    /                    site + themes (free, paid, price, owned) + suggested address
//   PUT    /                    save (slug, published, theme, color, hero, about, menu, gallery, contact, links, footer_note, seo)
//   GET    /slug?value=x        is this address free?
//   POST   /image               form-data: file, slot=hero|about|gallery      DELETE /image { slot, index }
//   POST   /themes/:theme       buy a paid theme
//   GET    /messages?unread=1&page=1   inbox (from the website's contact form)   PUT /messages/:mid { read }
//   DELETE /messages/:mid       POST /messages/read-all
// Public:
//   GET  /api/public/site/:slug           the published website (needs rest_website active)
//   POST /api/public/site/:slug/message   { name, contact, kind, message }  → inbox (+ Telegram if connected)
const mongoose = require("mongoose");
const M = require("./restaurant.models");
const Business = require("../business.model");
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const { buy, LicenseError } = require("../../license/license.service");
const crypto = require("crypto");
const { priceOf } = require("../../homepage/prices");
const { rate_limit } = require("../../util/rate_limit");
const telegram = require("../../telegram");

const RESERVED = new Set(["admin", "api", "app", "www", "bizhub", "login", "sign-up", "public", "help", "support", "menu", "site", "static", "assets", "test"]);
const MAX_GALLERY = 12;
const MAX_LINKS = 6;
const MAX_FEATURED = 24;
const W = {
  needAddon: "សូមដោះសោ “គេហទំព័រ” ជាមុនសិន!",
  badSlug: "អាសយដ្ឋានត្រូវមាន 3–40 តួ៖ អក្សរ a-z លេខ និង - ប៉ុណ្ណោះ",
  slugTaken: "អាសយដ្ឋាននេះមានគេប្រើហើយ!",
  needSlug: "សូមជ្រើសរើសអាសយដ្ឋានគេហទំព័រ មុនពេលបើកផ្សាយ",
  themeLocked: "រចនាប័ទ្មនេះត្រូវទិញសិន!",
  badTheme: "រចនាប័ទ្មមិនត្រឹមត្រូវ!",
  galleryFull: `រូបភាពច្រើនបំផុត ${MAX_GALLERY}`,
  siteOff: "គេហទំព័រនេះមិនទាន់មាន។",
  formOff: "ទម្រង់នេះមិនដំណើរការទេ។",
  sent: "បានផ្ញើសាររបស់អ្នកហើយ។ សូមអរគុណ!",
  badContact: "សូមបញ្ចូលអ៊ីមែល ឬលេខទូរស័ព្ទឲ្យត្រឹមត្រូវ",
  tooManyMessages: "អ្នកបានផ្ញើសារច្រើនពេក សូមព្យាយាមម្តងទៀតពេលក្រោយ។",
  bought: "ទិញបានជោគជ័យ!",
  already: "បានទិញរួចហើយ!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  busy: "កំពុងដំណើរការ សូមព្យាយាមម្តងទៀត!",
};

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
const slugOk = (s) => M.SLUG_RE.test(s) && !RESERVED.has(s) && !s.includes("--");

async function ownedThemes(businessId) {
  const rows = await License.find({ business_id: businessId, product: "rest_site_theme" }).select("item").lean();
  return rows.map((r) => r.item).filter((t) => M.SITE_THEMES_PAID.includes(t));
}

async function siteOf(business) {
  const found = await M.RestSite.findOne({ business_id: business._id });
  if (found) return found;
  try {
    return await M.RestSite.create({ business_id: business._id });
  } catch (err) {
    if (err.code === 11000) return M.RestSite.findOne({ business_id: business._id });
    throw err;
  }
}

async function suggestSlug(settings, businessName) {
  const base = slugify(settings.name_en || businessName) || "my-restaurant";
  const start = base.length >= 3 ? base : `${base}-shop`;
  for (let i = 0; i < 20; i++) {
    const s = i ? `${start.slice(0, 36)}-${i + 1}` : start;
    if (slugOk(s) && !(await M.RestSite.exists({ slug: s }))) return s;
  }
  return "";
}

const img = (i) => i?.url || "";
// the saved top menu, with any missing part added at the end
const navOf = (nav) => {
  const list = (nav || []).filter((n) => M.NAV_KEYS.includes(n.key)).map((n) => ({ key: n.key, label: n.label || "", show: n.show !== false }));
  for (const key of M.NAV_KEYS) if (!list.some((n) => n.key === key)) list.push({ key, label: "", show: true });
  return list;
};

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, withSettings, licenseState, Bad, MSG, text, bool, oneOf, url, validId, withUpload, uploadBuffer, deleteFile } = kit;
  const path = `${base}/site`;
  const needAddon = (ctx) => {
    if (!ctx.addons.rest_website.active) throw new Bad(W.needAddon, 402, { product: "rest_website" });
  };
  const themesInfo = async (businessId) => ({ free: M.SITE_THEMES_FREE, paid: M.SITE_THEMES_PAID, price: await priceOf("rest_site_theme"), owned: await ownedThemes(businessId) });

  // ---------- read ----------
  prop.app.get(
    path,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, false);
      const site = await siteOf(ctx.business);
      const bid = ctx.business._id;
      const [themes, suggested, categories, items, groups] = await Promise.all([
        themesInfo(bid),
        site.slug ? site.slug : suggestSlug(settings, ctx.business.name),
        M.RestCategory.find({ business_id: bid, active: true }).sort({ sort: 1 }).select("name_km name_en color").lean(),
        M.RestItem.find({ business_id: bid, active: true }).sort({ sort: 1 }).select("category_id name_km name_en description photo price sizes addon_group_ids available").lean(),
        M.RestAddonGroup.find({ business_id: bid }).select("name required min max options").lean(),
      ]);
      // preview = the public page data for the saved site; the editor lays unsaved changes over it
      const preview = publicSite({ site: site.toObject(), settings, business: ctx.business, categories, items, groups });
      res.json({ success: true, data: site, themes, suggested_slug: suggested, active: ctx.addons.rest_website, preview });
    }),
  );

  prop.app.get(
    `${path}/slug`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const value = String(req.query.value || "")
        .trim()
        .toLowerCase();
      if (!slugOk(value)) return res.json({ success: true, data: { value, available: false, reason: "format" } });
      const other = await M.RestSite.findOne({ slug: value }).select("business_id").lean();
      const available = !other || String(other.business_id) === String(ctx.business._id);
      res.json({ success: true, data: { value, available, reason: available ? "" : "taken" } });
    }),
  );

  // ---------- save ----------
  prop.app.put(
    path,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      const site = await siteOf(ctx.business);
      const b = req.body || {};
      const sub = (key) => (b[key] && typeof b[key] === "object" ? b[key] : undefined);

      if (b.slug !== undefined) {
        const slug = String(b.slug || "")
          .trim()
          .toLowerCase();
        if (slug && !slugOk(slug)) throw new Bad(W.badSlug);
        if (slug && (await M.RestSite.exists({ slug, business_id: { $ne: ctx.business._id } }))) throw new Bad(W.slugTaken, 409);
        site.slug = slug || undefined;
      }
      if (b.theme !== undefined) {
        if (!M.SITE_THEMES.includes(b.theme)) throw new Bad(W.badTheme);
        if (M.SITE_THEMES_PAID.includes(b.theme) && !(await ownedThemes(ctx.business._id)).includes(b.theme)) throw new Bad(W.themeLocked, 402, { product: "rest_site_theme", item: b.theme });
        site.theme = b.theme;
      }
      if (b.color !== undefined) {
        const c = String(b.color || "").toUpperCase();
        if (c && !M.COLOR_RE.test(c)) throw new Bad(`${MSG.badValue} (color)`);
        site.color = c;
      }
      const hero = sub("hero");
      if (hero) site.set("hero", { title: text(hero, "title", 80) ?? site.hero.title, subtitle: text(hero, "subtitle", 200) ?? site.hero.subtitle, button: text(hero, "button", 30) ?? site.hero.button, image: site.hero.image });
      if (b.nav !== undefined) {
        if (!Array.isArray(b.nav) || b.nav.length > M.NAV_KEYS.length) throw new Bad(`${MSG.badValue} (nav)`);
        const seen = new Set();
        const nav = b.nav.map((n) => {
          if (!M.NAV_KEYS.includes(n?.key) || seen.has(n.key)) throw new Bad(`${MSG.badValue} (nav)`);
          seen.add(n.key);
          return { key: n.key, label: text(n, "label", 30) || "", show: n.show !== false };
        });
        for (const key of M.NAV_KEYS) if (!seen.has(key)) nav.push({ key, label: "", show: true }); // never lose a part
        site.nav = nav;
      }
      const about = sub("about");
      if (about) {
        let highlights = site.about.highlights;
        if (about.highlights !== undefined) {
          if (!Array.isArray(about.highlights) || about.highlights.length > 4) throw new Bad(`${MSG.badValue} (highlights)`);
          highlights = about.highlights.map((h) => ({ value: text(h || {}, "value", 20) || "", label: text(h || {}, "label", 40) || "" })).filter((h) => h.value || h.label);
        }
        site.set("about", {
          enabled: bool(about, "enabled") ?? site.about.enabled,
          title: text(about, "title", 60) ?? site.about.title,
          text: text(about, "text", 1500) ?? site.about.text,
          image: site.about.image,
          image_side: oneOf(about, "image_side", ["left", "right"]) ?? site.about.image_side,
          highlights,
        });
      }
      const form = sub("form");
      if (form)
        site.set("form", {
          enabled: bool(form, "enabled") ?? site.form.enabled,
          title: text(form, "title", 60) ?? site.form.title,
          text: text(form, "text", 200) ?? site.form.text,
          notify_telegram: bool(form, "notify_telegram") ?? site.form.notify_telegram,
        });
      const menu = sub("menu");
      if (menu) {
        let featured = site.menu.featured_ids;
        if (menu.featured_ids !== undefined) {
          if (!Array.isArray(menu.featured_ids) || menu.featured_ids.length > MAX_FEATURED || !menu.featured_ids.every(validId)) throw new Bad(`${MSG.badValue} (featured_ids)`);
          const ids = [...new Set(menu.featured_ids.map(String))];
          const found = await M.RestItem.find({ _id: { $in: ids }, business_id: ctx.business._id })
            .select("_id")
            .lean();
          const ok = new Set(found.map((x) => String(x._id)));
          featured = ids.filter((id) => ok.has(id)).map((id) => new mongoose.Types.ObjectId(id));
        }
        site.set("menu", {
          enabled: bool(menu, "enabled") ?? site.menu.enabled,
          title: text(menu, "title", 60) ?? site.menu.title,
          mode: oneOf(menu, "mode", ["all", "featured"]) ?? site.menu.mode,
          featured_ids: featured,
          show_prices: bool(menu, "show_prices") ?? site.menu.show_prices,
        });
      }
      const gallery = sub("gallery");
      if (gallery) site.set("gallery", { enabled: bool(gallery, "enabled") ?? site.gallery.enabled, title: text(gallery, "title", 60) ?? site.gallery.title, images: site.gallery.images });
      const contact = sub("contact");
      if (contact) {
        const c = site.contact;
        const email = text(contact, "email", 80);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Bad(`${MSG.badValue} (email)`);
        site.set("contact", {
          enabled: bool(contact, "enabled") ?? c.enabled,
          title: text(contact, "title", 60) ?? c.title,
          phone: text(contact, "phone", 30) ?? c.phone,
          email: email ?? c.email,
          address: text(contact, "address", 200) ?? c.address,
          hours: text(contact, "hours", 120) ?? c.hours,
          map_url: url(contact, "map_url", 300) ?? c.map_url,
          facebook: url(contact, "facebook", 300) ?? c.facebook,
          instagram: url(contact, "instagram", 300) ?? c.instagram,
          tiktok: url(contact, "tiktok", 300) ?? c.tiktok,
          telegram: url(contact, "telegram", 300) ?? c.telegram,
        });
      }
      if (b.links !== undefined) {
        if (!Array.isArray(b.links) || b.links.length > MAX_LINKS) throw new Bad(`${MSG.badValue} (links)`);
        site.links = b.links
          .map((l) => ({ label: text(l || {}, "label", 30) || "", url: url(l || {}, "url", 300) || "" }))
          .filter((l) => l.label || l.url)
          .map((l) => {
            if (!l.label || !l.url) throw new Bad(`${MSG.badValue} (links)`);
            return l;
          });
      }
      if (b.footer_note !== undefined) site.footer_note = text(b, "footer_note", 200);
      const seo = sub("seo");
      if (seo) site.set("seo", { title: text(seo, "title", 70) ?? site.seo.title, description: text(seo, "description", 160) ?? site.seo.description });
      if (b.published !== undefined) site.published = !!b.published;
      if (site.published && !site.slug) throw new Bad(W.needSlug);

      try {
        await site.save();
      } catch (err) {
        if (err.code === 11000) throw new Bad(W.slugTaken, 409);
        throw err;
      }
      res.json({ success: true, data: site, message: MSG.saved });
    }),
  );

  // ---------- images ----------
  prop.app.post(
    `${path}/image`,
    ...guard,
    withUpload,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      const slot = req.body?.slot;
      if (!["hero", "about", "gallery"].includes(slot)) throw new Bad(`${MSG.badValue} (slot)`);
      if (!req.file) throw new Bad(MSG.noFile);
      const site = await siteOf(ctx.business);
      if (slot === "gallery" && site.gallery.images.length >= MAX_GALLERY) throw new Bad(W.galleryFull);
      const saved = await uploadBuffer(req.file, "restaurant/site");
      const value = { url: saved.url, public_id: saved.public_id };
      let old = null;
      if (slot === "gallery") site.gallery.images.push(value);
      else {
        old = site[slot].image?.public_id;
        site.set(`${slot}.image`, value);
      }
      await site.save();
      if (old) deleteFile(old).catch(() => {});
      res.status(201).json({ success: true, data: site, message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${path}/image`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const slot = req.body?.slot;
      if (!["hero", "about", "gallery"].includes(slot)) throw new Bad(`${MSG.badValue} (slot)`);
      const site = await siteOf(ctx.business);
      let old;
      if (slot === "gallery") {
        const i = Number(req.body?.index);
        if (!Number.isInteger(i) || i < 0 || i >= site.gallery.images.length) throw new Bad(`${MSG.badValue} (index)`);
        old = site.gallery.images[i].public_id;
        site.gallery.images.splice(i, 1);
      } else {
        old = site[slot].image?.public_id;
        site.set(`${slot}.image`, { url: "", public_id: "" });
      }
      await site.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: site, message: MSG.deleted });
    }),
  );

  // ---------- buy a paid theme ----------
  prop.app.post(
    `${path}/themes/:theme`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      if (!M.SITE_THEMES_PAID.includes(req.params.theme)) throw new Bad(W.badTheme);
      try {
        const r = await buy({ customer: req.customer, business: ctx.business, product: "rest_site_theme", item: req.params.theme });
        res.json({ success: true, data: r.status, item: req.params.theme, charged: r.charged, balance: r.balance, message: W.bought });
      } catch (err) {
        if (err instanceof LicenseError) throw new Bad(W[err.message] || err.message, err.status, err.extra);
        throw err;
      }
    }),
  );

  // ---------- inbox (messages from the website) ----------
  prop.app.get(
    `${path}/messages`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
      const limit = 20;
      const filter = { business_id: bid, ...(req.query.unread === "1" ? { read: false } : {}) };
      const [rows, total, unread] = await Promise.all([
        M.RestSiteMessage.find(filter)
          .sort({ created_date: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .select("-ip_key")
          .lean(),
        M.RestSiteMessage.countDocuments(filter),
        M.RestSiteMessage.countDocuments({ business_id: bid, read: false }),
      ]);
      res.json({ success: true, data: rows, unread, pagination: { total, totalPages: Math.max(1, Math.ceil(total / limit)), currentPage: page, pageSize: limit } });
    }),
  );
  prop.app.post(
    `${path}/messages/read-all`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      await M.RestSiteMessage.updateMany({ business_id: ctx.business._id, read: false }, { $set: { read: true } });
      res.json({ success: true, unread: 0 });
    }),
  );
  prop.app.put(
    `${path}/messages/:mid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      if (!validId(req.params.mid)) throw new Bad(MSG.badId);
      const row = await M.RestSiteMessage.findOneAndUpdate({ _id: req.params.mid, business_id: ctx.business._id }, { $set: { read: req.body?.read !== false } }, { returnDocument: "after" })
        .select("-ip_key")
        .lean();
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      const unread = await M.RestSiteMessage.countDocuments({ business_id: ctx.business._id, read: false });
      res.json({ success: true, data: row, unread });
    }),
  );
  prop.app.delete(
    `${path}/messages/:mid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      if (!validId(req.params.mid)) throw new Bad(MSG.badId);
      const r = await M.RestSiteMessage.deleteOne({ _id: req.params.mid, business_id: ctx.business._id });
      if (!r.deletedCount) throw new Bad(MSG.rowNotFound, 404);
      const unread = await M.RestSiteMessage.countDocuments({ business_id: ctx.business._id, read: false });
      res.json({ success: true, unread, message: MSG.deleted });
    }),
  );

  // ---------- visitor sends a message ----------
  const messageLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 5, message: W.tooManyMessages });
  prop.app.post(
    "/api/public/site/:slug/message",
    messageLimit,
    handle(async (req, res) => {
      const b = req.body || {};
      const slug = String(req.params.slug || "").toLowerCase();
      const site = slugOk(slug) ? await M.RestSite.findOne({ slug, published: true }).lean() : null;
      if (!site || site.form?.enabled === false) throw new Bad(W.formOff, 404);
      // bots fill every field, people never see this one
      if (b.website) return res.status(201).json({ success: true, message: W.sent });
      const bid = site.business_id;
      const [business, state, settings] = await Promise.all([Business.findOne({ _id: bid, deleted: false }).select("status name").lean(), licenseState(bid), M.RestSettings.findOne({ business_id: bid }).lean()]);
      if (!business?.status || state.restaurant.locked || !state.addons.rest_website.active) throw new Bad(W.formOff, 404);
      const name = text(b, "name", 80, { required: true });
      const contact = text(b, "contact", 100, { required: true });
      const message = text(b, "message", 2000, { required: true });
      const kind = M.MESSAGE_KINDS.includes(b.kind) ? b.kind : "feedback";
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
      const isPhone = /^[+\d][\d\s().-]{5,}$/.test(contact) && contact.replace(/\D/g, "").length >= 6;
      if (!isEmail && !isPhone) throw new Bad(W.badContact);
      const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "";
      const ipKey = crypto.createHash("sha256").update(`${bid}:${ip}`).digest("hex").slice(0, 24);
      // a little flood guard per restaurant: 20 messages a day from the same place
      if ((await M.RestSiteMessage.countDocuments({ business_id: bid, ip_key: ipKey, created_date: { $gt: new Date(Date.now() - 86400000) } })) >= 20) throw new Bad(W.tooManyMessages, 429);
      await M.RestSiteMessage.create({ business_id: bid, name, contact, kind, message, ip_key: ipKey });

      // tell the owner on Telegram (if connected)
      const chat = settings?.telegram?.chat_id;
      if (chat && site.form?.notify_telegram !== false && state.addons.rest_telegram.active && telegram.ready()) {
        const icon = { feedback: "💬", request: "📝", booking: "📅", other: "✉️" }[kind];
        const label = { feedback: "Feedback", request: "Request", booking: "Booking", other: "Message" }[kind];
        const e = telegram.escape;
        await telegram.send(chat, `${icon} <b>${label}</b> · ${e(settings.name_km || settings.name_en || business.name)}\n\n👤 ${e(name)}\n📞 ${e(contact)}\n\n${e(message.slice(0, 1500))}`).catch(() => {});
      }
      res.status(201).json({ success: true, message: W.sent });
    }),
  );

  // ---------- public website ----------
  prop.app.get(
    "/api/public/site/:slug",
    handle(async (req, res) => {
      const slug = String(req.params.slug || "").toLowerCase();
      const site = slugOk(slug) ? await M.RestSite.findOne({ slug, published: true }).lean() : null;
      if (!site) throw new Bad(W.siteOff, 404);
      const bid = site.business_id;
      const [business, state, settings, owned] = await Promise.all([Business.findOne({ _id: bid, deleted: false }).select("owner_id status name").lean(), licenseState(bid), M.RestSettings.findOne({ business_id: bid }).lean(), ownedThemes(bid)]);
      const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
      if (!business?.status || !owner?.status || !settings || state.restaurant.locked || !state.addons.rest_website.active) throw new Bad(W.siteOff, 404);
      const [categories, items, groups] = await Promise.all([
        M.RestCategory.find({ business_id: bid, active: true }).sort({ sort: 1 }).select("name_km name_en color").lean(),
        M.RestItem.find({ business_id: bid, active: true }).sort({ sort: 1 }).select("category_id name_km name_en description photo price sizes addon_group_ids available").lean(),
        M.RestAddonGroup.find({ business_id: bid }).select("name required min max options").lean(),
      ]);
      // a paid theme that is no longer owned falls back to the free one
      const theme = M.SITE_THEMES_FREE.includes(site.theme) || owned.includes(site.theme) ? site.theme : "classic";
      res.set("Cache-Control", "public, max-age=30");
      res.json({ success: true, data: publicSite({ site: { ...site, theme }, settings, business, categories, items, groups }) });
    }),
  );
};

// what the public page needs (also used by the editor's live preview, built in the browser)
function publicSite({ site, settings, business, categories, items, groups }) {
  const c = site.contact || {};
  return {
    slug: site.slug,
    theme: site.theme,
    color: site.color || "",
    hero: { title: site.hero?.title || "", subtitle: site.hero?.subtitle || "", button: site.hero?.button || "", image: img(site.hero?.image) },
    nav: navOf(site.nav),
    about: {
      enabled: site.about?.enabled !== false,
      title: site.about?.title || "",
      text: site.about?.text || "",
      image: img(site.about?.image),
      image_side: site.about?.image_side || "left",
      highlights: (site.about?.highlights || []).map((h) => ({ value: h.value, label: h.label })),
    },
    form: { enabled: site.form?.enabled !== false, title: site.form?.title || "", text: site.form?.text || "" },
    menu: { enabled: site.menu?.enabled !== false, title: site.menu?.title || "", mode: site.menu?.mode || "all", featured_ids: (site.menu?.featured_ids || []).map(String), show_prices: site.menu?.show_prices !== false },
    gallery: { enabled: site.gallery?.enabled !== false, title: site.gallery?.title || "", images: (site.gallery?.images || []).map(img).filter(Boolean) },
    contact: {
      enabled: c.enabled !== false,
      title: c.title || "",
      phone: c.phone || settings.phone || "",
      email: c.email || "",
      address: c.address || settings.address || "",
      hours: c.hours || settings.hours || "",
      map_url: c.map_url || settings.map_url || "",
      facebook: c.facebook || "",
      instagram: c.instagram || "",
      tiktok: c.tiktok || "",
      telegram: c.telegram || "",
    },
    links: site.links || [],
    footer_note: site.footer_note || "",
    seo: site.seo || {},
    restaurant: {
      name_km: settings.name_km,
      name_en: settings.name_en || business?.name || "",
      type: settings.type,
      logo: img(settings.logo),
      cover: img(settings.cover),
      color: settings.color,
      currency: settings.currency,
      khr_rate: settings.khr_rate,
      khr_rounding: settings.khr_rounding,
    },
    categories,
    items: items.map((i) => ({ ...i, photo: img(i.photo) })),
    addon_groups: groups,
  };
}
