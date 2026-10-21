// Company website add-on (att_website, yearly): the company's own website at /w/<slug>
// (home with top menu, about, services, gallery, message form, contact footer) + the owner's own pages.
// 24 looks: classic is free, the others are bought one by one (att_web_theme, item = theme, forever).
// Base: /api/user/businesses/:id/attendance/site
//   GET    /                 site + looks (free, paid, price, owned) + suggested address
//   PUT    /                 save (slug, published, theme, color, hero, about, services, gallery, pages, nav, form, contact, footer_note, seo)
//   GET    /slug?value=x     is this address free?
//   POST   /image            form-data: file, slot=hero|about|gallery|page|service, id (page / service)
//   DELETE /image            { slot, id?, index? }
//   POST   /themes/:theme    buy a look
//   GET    /messages?unread=1&page=1     PUT /messages/:mid { read }     DELETE /messages/:mid     POST /messages/read-all
// Public:
//   GET  /api/public/web/:slug            the published website (needs att_website active)
//   POST /api/public/web/:slug/message    { name, contact, kind, message } → inbox (+ Telegram if connected)
const crypto = require("crypto");
const mongoose = require("mongoose");
const M = require("./attendance.models");
const Business = require("../business.model");
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const { buy, LicenseError } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { rate_limit } = require("../../util/rate_limit");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");
const telegram = require("../../telegram");

const RESERVED = new Set(["admin", "api", "app", "www", "bizhub", "login", "sign-up", "public", "help", "support", "site", "static", "assets", "test"]);
const MAX = { gallery: 12, services: 24, pages: 12, nav: 24, highlights: 4 };
const FREE = M.WEB_THEMES[0];
const PAID = M.WEB_THEMES.slice(1);
const W = {
  needAddon: "សូមដោះសោ “គេហទំព័រក្រុមហ៊ុន” ជាមុនសិន!",
  badSlug: "អាសយដ្ឋានត្រូវមាន 3–40 តួ៖ អក្សរ a-z លេខ និង - ប៉ុណ្ណោះ",
  slugTaken: "អាសយដ្ឋាននេះមានគេប្រើហើយ!",
  needSlug: "សូមជ្រើសរើសអាសយដ្ឋានគេហទំព័រ មុនពេលបើកផ្សាយ",
  themeLocked: "រចនានេះត្រូវទិញសិន!",
  badTheme: "រចនាមិនត្រឹមត្រូវ!",
  galleryFull: `រូបភាពច្រើនបំផុត ${MAX.gallery}`,
  pageSlug: "អាសយដ្ឋានទំព័រត្រូវខុសគ្នា ហើយមានតែ a-z លេខ និង -",
  pageTitle: "ទំព័រនីមួយៗត្រូវមានចំណងជើង",
  serviceTitle: "សេវាកម្មនីមួយៗត្រូវមានឈ្មោះ",
  saveFirst: "សូមរក្សាទុកជាមុនសិន ទើបបន្ថែមរូបបាន",
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
const slugOk = (s) => M.WEB_SLUG_RE.test(s) && !RESERVED.has(s) && !s.includes("--");
const img = (i) => i?.url || "";
const isId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);

async function ownedThemes(bid) {
  const rows = await License.find({ business_id: bid, product: "att_web_theme" }).select("item").lean();
  return rows.map((r) => r.item).filter((t) => PAID.includes(t));
}
async function siteOf(bid) {
  const found = await M.AttSite.findOne({ business_id: bid });
  if (found) return found;
  try {
    return await M.AttSite.create({ business_id: bid });
  } catch (err) {
    if (err.code === 11000) return M.AttSite.findOne({ business_id: bid });
    throw err;
  }
}
async function suggestSlug(name) {
  const base = slugify(name) || "my-company";
  const start = base.length >= 3 ? base : `${base}-co`;
  for (let i = 0; i < 20; i++) {
    const s = i ? `${start.slice(0, 36)}-${i + 1}` : start;
    if (slugOk(s) && !(await M.AttSite.exists({ slug: s }))) return s;
  }
  return "";
}
// the saved menu, with any missing part / page added at the end (a menu never loses a part)
function navOf(nav, pages) {
  const ids = new Set((pages || []).map((p) => String(p._id)));
  const list = (nav || [])
    .filter((n) => (n.kind === "part" ? M.WEB_PARTS.includes(n.key) : n.kind === "page" ? ids.has(String(n.key)) : n.kind === "link" && n.url))
    .map((n) => ({ kind: n.kind, key: n.kind === "link" ? "" : String(n.key), label: n.label || "", url: n.kind === "link" ? n.url : "", show: n.show !== false }));
  for (const key of M.WEB_PARTS) if (!list.some((n) => n.kind === "part" && n.key === key)) list.push({ kind: "part", key, label: "", url: "", show: true });
  for (const p of pages || []) if (!list.some((n) => n.kind === "page" && n.key === String(p._id))) list.push({ kind: "page", key: String(p._id), label: "", url: "", show: true });
  return list;
}

// what the public page needs (the editor's live preview lays unsaved changes over it)
function publicSite({ site, settings, business }) {
  const c = site.contact || {};
  const pages = (site.pages || []).map((p) => ({ _id: String(p._id), slug: p.slug, title: p.title, subtitle: p.subtitle || "", body: p.body || "", image: img(p.image), button: p.button || "", button_to: p.button_to || "" }));
  return {
    slug: site.slug || "",
    theme: site.theme || FREE,
    color: site.color || "",
    hero: { kicker: site.hero?.kicker || "", title: site.hero?.title || "", subtitle: site.hero?.subtitle || "", button: site.hero?.button || "", button_to: site.hero?.button_to || "", image: img(site.hero?.image) },
    about: { enabled: site.about?.enabled !== false, title: site.about?.title || "", text: site.about?.text || "", image: img(site.about?.image), highlights: (site.about?.highlights || []).map((h) => ({ value: h.value, label: h.label })) },
    services: {
      enabled: site.services?.enabled !== false,
      title: site.services?.title || "",
      subtitle: site.services?.subtitle || "",
      items: (site.services?.items || []).map((x) => ({ _id: String(x._id), icon: x.icon, title: x.title, text: x.text || "", price: x.price || "", image: img(x.image), page_id: x.page_id || "" })),
    },
    gallery: { enabled: site.gallery?.enabled !== false, title: site.gallery?.title || "", images: (site.gallery?.images || []).map(img).filter(Boolean) },
    pages,
    nav: navOf(site.nav, pages),
    form: { enabled: site.form?.enabled !== false, title: site.form?.title || "", text: site.form?.text || "" },
    contact: {
      enabled: c.enabled !== false,
      title: c.title || "",
      phone: c.phone || "",
      email: c.email || "",
      address: c.address || "",
      hours: c.hours || "",
      map_url: c.map_url || "",
      facebook: c.facebook || "",
      instagram: c.instagram || "",
      tiktok: c.tiktok || "",
      telegram: c.telegram || "",
      linkedin: c.linkedin || "",
      youtube: c.youtube || "",
    },
    footer_note: site.footer_note || "",
    seo: { title: site.seo?.title || "", description: site.seo?.description || "" },
    company: { name: business?.name || "", logo: settings?.logo?.url || business?.logo_url || "" },
  };
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, settingsOf, licenseState, Bad, MSG, text, bool, withFile } = kit;
  const path = `${base}/site`;
  const url = (body, key, max) => {
    const v = text(body, key, max);
    if (!v) return v;
    const full = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    try {
      const u = new URL(full);
      if (!/\./.test(u.hostname)) throw new Error();
      return u.toString();
    } catch {
      throw new Bad(`${MSG.badValue} (${key})`);
    }
  };
  // a button / link target: "#part", "page:<id>", or a web address
  const target = (body, key) => {
    const v = text(body, key, 300);
    if (!v) return v;
    if (/^#[a-z]+$/.test(v) && M.WEB_PARTS.includes(v.slice(1))) return v;
    if (/^page:[a-f0-9]{24}$/i.test(v)) return v;
    if (/^(tel:|mailto:)/i.test(v)) return v.slice(0, 300);
    return url(body, key, 300);
  };
  const needAddon = (ctx) => {
    if (!ctx.addons.att_website?.active) throw new Bad(W.needAddon, 402, { product: "att_website" });
  };
  const themesInfo = async (bid) => ({ list: M.WEB_THEMES, free: [FREE], paid: PAID, price: await priceOf("att_web_theme"), owned: await ownedThemes(bid) });

  // ---------- read ----------
  prop.app.get(
    path,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const [site, settings] = await Promise.all([siteOf(bid), settingsOf(bid)]);
      const [themes, suggested] = await Promise.all([themesInfo(bid), site.slug ? site.slug : suggestSlug(ctx.business.name)]);
      const unread = await M.AttSiteMessage.countDocuments({ business_id: bid, read: false });
      res.json({ success: true, data: site, themes, suggested_slug: suggested, unread, preview: publicSite({ site: site.toObject(), settings, business: ctx.business }) });
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
      const other = await M.AttSite.findOne({ slug: value }).select("business_id").lean();
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
      const site = await siteOf(ctx.business._id);
      const b = req.body || {};
      const sub = (key) => (b[key] && typeof b[key] === "object" && !Array.isArray(b[key]) ? b[key] : undefined);
      const dropped = []; // images of removed pages / services

      if (b.slug !== undefined) {
        const slug = String(b.slug || "")
          .trim()
          .toLowerCase();
        if (slug && !slugOk(slug)) throw new Bad(W.badSlug);
        if (slug && (await M.AttSite.exists({ slug, business_id: { $ne: ctx.business._id } }))) throw new Bad(W.slugTaken, 409);
        site.slug = slug || undefined;
      }
      if (b.theme !== undefined) {
        if (!M.WEB_THEMES.includes(b.theme)) throw new Bad(W.badTheme);
        if (b.theme !== FREE && !(await ownedThemes(ctx.business._id)).includes(b.theme)) throw new Bad(W.themeLocked, 402, { product: "att_web_theme", item: b.theme });
        site.theme = b.theme;
      }
      if (b.color !== undefined) {
        const c = String(b.color || "").toUpperCase();
        if (c && !M.COLOR_RE.test(c)) throw new Bad(`${MSG.badValue} (color)`);
        site.color = c;
      }
      const hero = sub("hero");
      if (hero) {
        const h = site.hero;
        site.set("hero", {
          kicker: text(hero, "kicker", 60) ?? h.kicker,
          title: text(hero, "title", 90) ?? h.title,
          subtitle: text(hero, "subtitle", 240) ?? h.subtitle,
          button: text(hero, "button", 30) ?? h.button,
          button_to: target(hero, "button_to") ?? h.button_to,
          image: h.image,
        });
      }
      const about = sub("about");
      if (about) {
        let highlights = site.about.highlights;
        if (about.highlights !== undefined) {
          if (!Array.isArray(about.highlights) || about.highlights.length > MAX.highlights) throw new Bad(`${MSG.badValue} (highlights)`);
          highlights = about.highlights.map((h) => ({ value: text(h || {}, "value", 20) || "", label: text(h || {}, "label", 40) || "" })).filter((h) => h.value || h.label);
        }
        site.set("about", { enabled: bool(about, "enabled") ?? site.about.enabled, title: text(about, "title", 70) ?? site.about.title, text: text(about, "text", 2000) ?? site.about.text, image: site.about.image, highlights });
      }

      // pages first: services and the menu point at them
      if (b.pages !== undefined) {
        if (!Array.isArray(b.pages) || b.pages.length > MAX.pages) throw new Bad(`${MSG.badValue} (pages)`);
        const old = new Map(site.pages.map((p) => [String(p._id), p]));
        const slugs = new Set();
        const pages = b.pages.map((p) => {
          p = p || {};
          const title = text(p, "title", 70);
          if (!title) throw new Bad(W.pageTitle);
          const slug =
            String(p.slug || "")
              .trim()
              .toLowerCase() ||
            slugify(title) ||
            `page-${slugs.size + 1}`;
          if (!M.PAGE_SLUG_RE.test(slug) || slugs.has(slug) || M.WEB_PARTS.includes(slug)) throw new Bad(W.pageSlug);
          slugs.add(slug);
          const prev = isId(p._id) ? old.get(p._id) : null;
          return {
            _id: prev ? prev._id : isId(p._id) ? new mongoose.Types.ObjectId(p._id) : new mongoose.Types.ObjectId(),
            slug,
            title,
            subtitle: text(p, "subtitle", 200) || "",
            body: text(p, "body", 6000) || "",
            image: prev?.image || {},
            button: text(p, "button", 30) || "",
            button_to: target(p, "button_to") || "",
          };
        });
        const keep = new Set(pages.map((p) => String(p._id)));
        for (const [id, p] of old) if (!keep.has(id) && p.image?.public_id) dropped.push(p.image.public_id);
        site.pages = pages;
      }
      const pageIds = new Set(site.pages.map((p) => String(p._id)));

      const services = sub("services");
      if (services) {
        let items = site.services.items;
        if (services.items !== undefined) {
          if (!Array.isArray(services.items) || services.items.length > MAX.services) throw new Bad(`${MSG.badValue} (services)`);
          const old = new Map(site.services.items.map((x) => [String(x._id), x]));
          items = services.items.map((x) => {
            x = x || {};
            const title = text(x, "title", 70);
            if (!title) throw new Bad(W.serviceTitle);
            const prev = isId(x._id) ? old.get(x._id) : null;
            return {
              _id: prev ? prev._id : isId(x._id) ? new mongoose.Types.ObjectId(x._id) : new mongoose.Types.ObjectId(),
              icon: M.WEB_ICONS.includes(x.icon) ? x.icon : "briefcase",
              title,
              text: text(x, "text", 400) || "",
              price: text(x, "price", 30) || "",
              image: prev?.image || {},
              page_id: pageIds.has(String(x.page_id || "")) ? String(x.page_id) : "",
            };
          });
          const keep = new Set(items.map((x) => String(x._id)));
          for (const [id, x] of old) if (!keep.has(id) && x.image?.public_id) dropped.push(x.image.public_id);
        }
        site.set("services", { enabled: bool(services, "enabled") ?? site.services.enabled, title: text(services, "title", 70) ?? site.services.title, subtitle: text(services, "subtitle", 200) ?? site.services.subtitle, items });
      } else if (b.pages !== undefined) {
        // a removed page can't stay linked from a service
        site.services.items.forEach((x) => {
          if (x.page_id && !pageIds.has(x.page_id)) x.page_id = "";
        });
      }

      if (b.nav !== undefined) {
        if (!Array.isArray(b.nav) || b.nav.length > MAX.nav) throw new Bad(`${MSG.badValue} (nav)`);
        const seen = new Set();
        const nav = [];
        for (const n of b.nav) {
          const kind = n?.kind;
          if (kind === "part" || kind === "page") {
            const key = String(n.key || "");
            if ((kind === "part" && !M.WEB_PARTS.includes(key)) || (kind === "page" && !pageIds.has(key)) || seen.has(`${kind}:${key}`)) throw new Bad(`${MSG.badValue} (nav)`);
            seen.add(`${kind}:${key}`);
            nav.push({ kind, key, label: text(n, "label", 30) || "", url: "", show: n.show !== false });
          } else if (kind === "link") {
            const label = text(n, "label", 30) || "";
            const link = url(n, "url", 300) || "";
            if (!label || !link) throw new Bad(`${MSG.badValue} (nav)`);
            nav.push({ kind, key: "", label, url: link, show: n.show !== false });
          } else throw new Bad(`${MSG.badValue} (nav)`);
        }
        site.nav = navOf(nav, site.pages);
      } else if (b.pages !== undefined) site.nav = navOf(site.nav, site.pages);

      const gallery = sub("gallery");
      if (gallery) site.set("gallery", { enabled: bool(gallery, "enabled") ?? site.gallery.enabled, title: text(gallery, "title", 70) ?? site.gallery.title, images: site.gallery.images });
      const form = sub("form");
      if (form)
        site.set("form", {
          enabled: bool(form, "enabled") ?? site.form.enabled,
          title: text(form, "title", 70) ?? site.form.title,
          text: text(form, "text", 200) ?? site.form.text,
          notify_telegram: bool(form, "notify_telegram") ?? site.form.notify_telegram,
        });
      const contact = sub("contact");
      if (contact) {
        const c = site.contact;
        const email = text(contact, "email", 80);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Bad(`${MSG.badValue} (email)`);
        const next = {
          enabled: bool(contact, "enabled") ?? c.enabled,
          title: text(contact, "title", 70) ?? c.title,
          phone: text(contact, "phone", 30) ?? c.phone,
          email: email ?? c.email,
          address: text(contact, "address", 200) ?? c.address,
          hours: text(contact, "hours", 120) ?? c.hours,
        };
        for (const k of ["map_url", "facebook", "instagram", "tiktok", "telegram", "linkedin", "youtube"]) next[k] = url(contact, k, 300) ?? c[k];
        site.set("contact", next);
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
      dropped.forEach((id) => deleteFile(id).catch(() => {}));
      res.json({ success: true, data: site, message: MSG.saved });
    }),
  );

  // ---------- images ----------
  const SLOTS = ["hero", "about", "gallery", "page", "service"];
  const holder = (site, slot, id) => {
    if (slot === "page") return site.pages.find((p) => String(p._id) === String(id));
    if (slot === "service") return site.services.items.find((x) => String(x._id) === String(id));
    return site[slot];
  };
  prop.app.post(
    `${path}/image`,
    ...guard,
    withFile,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      const slot = req.body?.slot;
      if (!SLOTS.includes(slot)) throw new Bad(`${MSG.badValue} (slot)`);
      if (!req.file) throw new Bad(MSG.noFile);
      const site = await siteOf(ctx.business._id);
      if (slot === "gallery" && site.gallery.images.length >= MAX.gallery) throw new Bad(W.galleryFull);
      const box = slot === "gallery" ? null : holder(site, slot, req.body?.id);
      if (slot !== "gallery" && !box) throw new Bad(W.saveFirst, 404);
      const saved = await uploadBuffer(req.file, "attendance/site");
      const value = { url: saved.url, public_id: saved.public_id };
      let old = null;
      if (slot === "gallery") site.gallery.images.push(value);
      else {
        old = box.image?.public_id;
        if (slot === "hero" || slot === "about") site.set(`${slot}.image`, value);
        else box.set("image", value);
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
      if (!SLOTS.includes(slot)) throw new Bad(`${MSG.badValue} (slot)`);
      const site = await siteOf(ctx.business._id);
      let old;
      if (slot === "gallery") {
        const i = Number(req.body?.index);
        if (!Number.isInteger(i) || i < 0 || i >= site.gallery.images.length) throw new Bad(`${MSG.badValue} (index)`);
        old = site.gallery.images[i].public_id;
        site.gallery.images.splice(i, 1);
      } else {
        const box = holder(site, slot, req.body?.id);
        if (!box) throw new Bad(MSG.rowNotFound, 404);
        old = box.image?.public_id;
        if (slot === "hero" || slot === "about") site.set(`${slot}.image`, { url: "", public_id: "" });
        else box.set("image", { url: "", public_id: "" });
      }
      await site.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: site, message: MSG.deleted });
    }),
  );

  // ---------- buy a look ----------
  prop.app.post(
    `${path}/themes/:theme`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!PAID.includes(req.params.theme)) throw new Bad(W.badTheme);
      try {
        const r = await buy({ customer: req.customer, business: ctx.business, product: "att_web_theme", item: req.params.theme });
        res.json({ success: true, data: r.status, item: req.params.theme, charged: r.charged, balance: r.balance, themes: await themesInfo(ctx.business._id), message: W.bought });
      } catch (err) {
        if (err instanceof LicenseError) throw new Bad(W[err.message] || err.message, err.status, err.extra);
        throw err;
      }
    }),
  );

  // ---------- inbox ----------
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
        M.AttSiteMessage.find(filter)
          .sort({ created_date: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .select("-ip_key")
          .lean(),
        M.AttSiteMessage.countDocuments(filter),
        M.AttSiteMessage.countDocuments({ business_id: bid, read: false }),
      ]);
      res.json({ success: true, data: rows, unread, pagination: { total, totalPages: Math.max(1, Math.ceil(total / limit)), currentPage: page, pageSize: limit } });
    }),
  );
  prop.app.post(
    `${path}/messages/read-all`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      await M.AttSiteMessage.updateMany({ business_id: ctx.business._id, read: false }, { $set: { read: true } });
      res.json({ success: true, unread: 0 });
    }),
  );
  prop.app.put(
    `${path}/messages/:mid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      if (!isId(req.params.mid)) throw new Bad(MSG.badId);
      const row = await M.AttSiteMessage.findOneAndUpdate({ _id: req.params.mid, business_id: ctx.business._id }, { $set: { read: req.body?.read !== false } }, { returnDocument: "after" })
        .select("-ip_key")
        .lean();
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, data: row, unread: await M.AttSiteMessage.countDocuments({ business_id: ctx.business._id, read: false }) });
    }),
  );
  prop.app.delete(
    `${path}/messages/:mid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      if (!isId(req.params.mid)) throw new Bad(MSG.badId);
      const r = await M.AttSiteMessage.deleteOne({ _id: req.params.mid, business_id: ctx.business._id });
      if (!r.deletedCount) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, unread: await M.AttSiteMessage.countDocuments({ business_id: ctx.business._id, read: false }), message: MSG.deleted });
    }),
  );

  // ---------- public ----------
  // the published site, if the business, its owner, its license and the add-on are all fine
  async function liveSite(slug) {
    const site = slugOk(slug) ? await M.AttSite.findOne({ slug, published: true }).lean() : null;
    if (!site) return null;
    const bid = site.business_id;
    const [business, state, settings] = await Promise.all([Business.findOne({ _id: bid, deleted: false }).select("owner_id status name logo_url").lean(), licenseState(bid), M.AttSettings.findOne({ business_id: bid }).lean()]);
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || !owner?.status || state.license.locked || !state.addons.att_website?.active) return null;
    return { site, business, state, settings };
  }

  prop.app.get(
    "/api/public/web/:slug",
    handle(async (req, res) => {
      const live = await liveSite(String(req.params.slug || "").toLowerCase());
      if (!live) throw new Bad(W.siteOff, 404);
      const { site, business, settings } = live;
      // a look that is no longer owned falls back to the free one
      const theme = site.theme === FREE || (await ownedThemes(site.business_id)).includes(site.theme) ? site.theme : FREE;
      res.set("Cache-Control", "public, max-age=30");
      res.json({ success: true, data: publicSite({ site: { ...site, theme }, settings, business }) });
    }),
  );

  const messageLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 5, message: W.tooManyMessages });
  prop.app.post(
    "/api/public/web/:slug/message",
    messageLimit,
    handle(async (req, res) => {
      const b = req.body || {};
      const live = await liveSite(String(req.params.slug || "").toLowerCase());
      if (!live || live.site.form?.enabled === false) throw new Bad(W.formOff, 404);
      if (b.website) return res.status(201).json({ success: true, message: W.sent }); // bots fill every field
      const { site, business, state, settings } = live;
      const bid = site.business_id;
      const name = text(b, "name", 80, { required: true });
      const contact = text(b, "contact", 100, { required: true });
      const message = text(b, "message", 2000, { required: true });
      const kind = M.WEB_MESSAGE_KINDS.includes(b.kind) ? b.kind : "question";
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
      const isPhone = /^[+\d][\d\s().-]{5,}$/.test(contact) && contact.replace(/\D/g, "").length >= 6;
      if (!isEmail && !isPhone) throw new Bad(W.badContact);
      const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "";
      const ipKey = crypto.createHash("sha256").update(`${bid}:${ip}`).digest("hex").slice(0, 24);
      if ((await M.AttSiteMessage.countDocuments({ business_id: bid, ip_key: ipKey, created_date: { $gt: new Date(Date.now() - 86400000) } })) >= 20) throw new Bad(W.tooManyMessages, 429);
      await M.AttSiteMessage.create({ business_id: bid, name, contact, kind, message, ip_key: ipKey });
      const chat = settings?.telegram?.chat_id;
      if (chat && site.form?.notify_telegram !== false && state.addons.att_telegram?.active && telegram.ready()) {
        const e = telegram.escape;
        const label = { question: "❓ Question", quote: "💼 Quote request", booking: "📅 Booking", other: "✉️ Message" }[kind];
        await telegram.send(chat, `${label} · <b>${e(business.name)}</b> (website)\n\n👤 ${e(name)}\n📞 ${e(contact)}\n\n${e(message.slice(0, 1500))}`).catch(() => {});
      }
      res.status(201).json({ success: true, message: W.sent });
    }),
  );
};
module.exports.publicSite = publicSite;
