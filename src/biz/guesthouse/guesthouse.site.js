// Guest house website (gh_website, yearly): the guest house's own website at /g/<slug>
// (top menu, big photo, rooms with prices + photos, about, facilities, gallery, booking request, contact).
// 24 looks: classic is free, the others are bought one by one (gh_site_theme, item = look, forever).
// Base: /api/user/businesses/:id/guesthouse/site
//   GET    /                    site + looks + suggested address + preview data + new requests count
//   PUT    /                    save (slug, published, theme, color, hero, about, rooms, facilities, gallery, booking, contact, footer_note, seo)
//                               (text can be saved before buying; publishing needs the add-on)
//   GET    /slug?value=x        is this address free?
//   POST   /image               form-data: file, slot=hero|about|gallery|room (+ type_id)     DELETE /image { slot, index?, type_id? }
//   POST   /themes/:theme       buy a look (gh_site_theme, 65 coins, forever)
//   GET    /requests?status=new&page=1     PUT /requests/:rid { status }     DELETE /requests/:rid
// Public:
//   GET  /api/public/stay/:slug                       the published website (needs gh_website active)
//   GET  /api/public/stay/:slug/free?from=&to=        free rooms per room type for those dates
//   POST /api/public/stay/:slug/request               { name, contact, from, to, type_id, guests, message } → requests
const crypto = require("crypto");
const multer = require("multer");
const M = require("./guesthouse.models");
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const { buy } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { rate_limit } = require("../../util/rate_limit");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");
const D = require("./guesthouse.deals");
const { livePromos } = require("./guesthouse.promos");

const RESERVED = new Set(["admin", "api", "app", "www", "bizhub", "login", "sign-up", "public", "help", "support", "site", "static", "assets", "test"]);
const MAX = { gallery: 16, highlights: 4, room_images: 6, extra: 12 };
const FREE = M.SITE_THEMES[0];
const PAID = M.SITE_THEMES.slice(1);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const W = {
  needAddon: "សូមដោះសោ “គេហទំព័រ” ជាមុនសិន!",
  badSlug: "អាសយដ្ឋានត្រូវមាន 3–40 តួ៖ អក្សរ a-z លេខ និង - ប៉ុណ្ណោះ",
  slugTaken: "អាសយដ្ឋាននេះមានគេប្រើហើយ!",
  needSlug: "សូមជ្រើសរើសអាសយដ្ឋានគេហទំព័រ មុនពេលបើកផ្សាយ",
  themeLocked: "រចនានេះត្រូវទិញសិន!",
  badTheme: "រចនាមិនត្រឹមត្រូវ!",
  galleryFull: `រូបភាពច្រើនបំផុត ${MAX.gallery}`,
  roomFull: `រូបបន្ទប់ច្រើនបំផុត ${MAX.room_images}`,
  siteOff: "គេហទំព័រនេះមិនទាន់មាន។",
  formOff: "ទម្រង់នេះមិនដំណើរការទេ។",
  sent: "បានផ្ញើសំណើកក់របស់អ្នកហើយ។ យើងនឹងទាក់ទងទៅវិញឆាប់ៗ។ សូមអរគុណ!",
  badContact: "សូមបញ្ចូលអ៊ីមែល ឬលេខទូរស័ព្ទឲ្យត្រឹមត្រូវ",
  badDates: "សូមជ្រើសថ្ងៃចូល និងថ្ងៃចេញឲ្យត្រឹមត្រូវ",
  tooMany: "អ្នកបានផ្ញើច្រើនពេក សូមព្យាយាមម្តងទៀតពេលក្រោយ។",
  badImage: "រូបភាពត្រូវជា JPG, PNG ឬ WEBP និងតូចជាង 4MB",
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
const slugOk = (s) => M.SITE_SLUG_RE.test(s) && !RESERVED.has(s) && !s.includes("--");
const pic = (i) => i?.url || "";
const keep = (i) => ({ url: i?.url || "", public_id: i?.public_id || "" });
const isId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);
const localDay = (t = Date.now()) => new Date(t + 7 * 3600000).toISOString().slice(0, 10);

async function ownedThemes(bid) {
  const rows = await License.find({ business_id: bid, product: "gh_site_theme" }).select("item").lean();
  return rows.map((r) => r.item).filter((t) => PAID.includes(t));
}
async function siteOf(bid) {
  const found = await M.GhSite.findOne({ business_id: bid });
  if (found) return found;
  try {
    return await M.GhSite.create({ business_id: bid });
  } catch (err) {
    if (err.code === 11000) return M.GhSite.findOne({ business_id: bid });
    throw err;
  }
}
async function suggestSlug(name) {
  const base = slugify(name) || "my-guest-house";
  const start = base.length >= 3 ? base : `${base}-stay`;
  for (let i = 0; i < 20; i++) {
    const s = i ? `${start.slice(0, 36)}-${i + 1}` : start;
    if (slugOk(s) && !(await M.GhSite.exists({ slug: s }))) return s;
  }
  return "";
}

// what the public page needs (the editor's live preview lays unsaved changes over it)
function publicSite({ site, settings, business, types, rooms, promos = [], portal = false }) {
  const today = localDay();
  const s = settings || {};
  const c = site.contact || {};
  const items = new Map((site.rooms?.items || []).map((x) => [String(x.type_id), x]));
  const count = {};
  for (const r of rooms || []) if (r.active) count[String(r.type_id)] = (count[String(r.type_id)] || 0) + 1;
  return {
    slug: site.slug || "",
    theme: site.theme || FREE,
    color: site.color || "",
    business: { name: business?.name || "", logo: business?.logo_url || "" },
    currency: s.currency || "USD",
    check_in: s.check_in || "14:00",
    check_out: s.check_out || "12:00",
    hero: {
      kicker: site.hero?.kicker || "",
      title: site.hero?.title || "",
      subtitle: site.hero?.subtitle || s.description?.slice(0, 240) || "",
      button: site.hero?.button || "",
      image: pic(site.hero?.image) || pic(s.cover),
    },
    about: {
      enabled: site.about?.enabled !== false,
      title: site.about?.title || "",
      text: site.about?.text || s.description || "",
      image: pic(site.about?.image),
      highlights: (site.about?.highlights || []).map((h) => ({ value: h.value, label: h.label })),
    },
    rooms: {
      enabled: site.rooms?.enabled !== false,
      title: site.rooms?.title || "",
      subtitle: site.rooms?.subtitle || "",
      show_prices: site.rooms?.show_prices !== false,
      items: (types || [])
        .filter((t) => t.active !== false && count[String(t._id)] && !items.get(String(t._id))?.hidden)
        .map((t) => {
          const x = items.get(String(t._id)) || {};
          const deal = D.nightPrice(promos, t._id, t.price, today, settings?.currency);
          return {
            deal: deal.promo ? { price: deal.price, badge: D.badgeOf(deal.promo, settings?.currency), name: deal.promo.name, to: deal.promo.to } : null,
            _id: String(t._id),
            name: t.name,
            price: t.price,
            capacity: t.capacity || 2,
            beds: t.beds || "",
            amenities: t.amenities || [],
            color: t.color || "",
            rooms: count[String(t._id)] || 0,
            text: x.text || "",
            images: (x.images || []).map(pic).filter(Boolean),
          };
        }),
    },
    facilities: { enabled: site.facilities?.enabled !== false, title: site.facilities?.title || "", keys: (site.facilities?.keys || []).filter((k) => M.FACILITIES.includes(k)), extra: site.facilities?.extra || [] },
    gallery: { enabled: site.gallery?.enabled !== false, title: site.gallery?.title || "", images: (site.gallery?.images || []).map(pic).filter(Boolean) },
    booking: { enabled: site.booking?.enabled !== false, title: site.booking?.title || "", text: site.booking?.text || "", show_free: site.booking?.show_free !== false },
    contact: {
      enabled: c.enabled !== false,
      title: c.title || "",
      phone: c.phone || business?.phone || "",
      email: c.email || s.email || "",
      address: c.address || business?.address || "",
      map_url: c.map_url || s.map_url || "",
      facebook: c.facebook || s.facebook || "",
      telegram: c.telegram || s.telegram || "",
      instagram: c.instagram || "",
      tiktok: c.tiktok || "",
      whatsapp: c.whatsapp || "",
    },
    promos: promos.map((p) => D.publicPromo(p, settings?.currency)),
    portal,
    footer_note: site.footer_note || "",
    seo: { title: site.seo?.title || "", description: site.seo?.description || "" },
  };
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, settingsOf, licenseState, Bad, MSG, text, bool, Business } = kit;
  const path = `${base}/site`;
  const withFile = (req, res, next) =>
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? W.badImage : err.message });
      next();
    });
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
  const needAddon = (ctx) => {
    if (!ctx.addons.gh_website?.active) throw new Bad(W.needAddon, 402, { product: "gh_website" });
  };
  const themesInfo = async (bid) => ({ list: M.SITE_THEMES, free: [FREE], paid: PAID, price: await priceOf("gh_site_theme"), owned: await ownedThemes(bid) });
  const roomData = (bid) => Promise.all([M.GhRoomType.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }).lean(), M.GhRoom.find({ business_id: bid }).select("type_id active").lean()]);

  // ---------- read ----------
  prop.app.get(
    path,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const site = await siteOf(bid);
      const [themes, suggested, [types, rooms], unread, addonPrice] = await Promise.all([
        themesInfo(bid),
        site.slug ? site.slug : suggestSlug(ctx.business.name),
        roomData(bid),
        M.GhSiteRequest.countDocuments({ business_id: bid, status: "new" }),
        priceOf("gh_website"),
      ]);
      res.json({
        success: true,
        data: site,
        themes,
        suggested_slug: suggested,
        unread,
        addon: { ...ctx.addons.gh_website, price: addonPrice },
        facilities: M.FACILITIES,
        preview: publicSite({
          site: site.toObject(),
          settings: ctx.settings,
          business: ctx.business,
          types,
          rooms,
          promos: await livePromos(M, bid, ctx.addons, localDay()),
          portal: !!ctx.addons.gh_customers?.active && ctx.settings.portal_on !== false,
        }),
      });
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
      const other = await M.GhSite.findOne({ slug: value }).select("business_id").lean();
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
      const bid = ctx.business._id;
      const site = await siteOf(bid);
      const b = req.body || {};
      const sub = (key) => (b[key] && typeof b[key] === "object" && !Array.isArray(b[key]) ? b[key] : undefined);

      if (b.slug !== undefined) {
        const slug = String(b.slug || "")
          .trim()
          .toLowerCase();
        if (slug && !slugOk(slug)) throw new Bad(W.badSlug);
        if (slug && (await M.GhSite.exists({ slug, business_id: { $ne: bid } }))) throw new Bad(W.slugTaken, 409);
        site.slug = slug || undefined;
      }
      if (b.theme !== undefined) {
        if (!M.SITE_THEMES.includes(b.theme)) throw new Bad(W.badTheme);
        if (b.theme !== FREE && !(await ownedThemes(bid)).includes(b.theme)) throw new Bad(W.themeLocked, 402, { product: "gh_site_theme", item: b.theme });
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
        site.set("hero", { kicker: text(hero, "kicker", 60) ?? h.kicker, title: text(hero, "title", 90) ?? h.title, subtitle: text(hero, "subtitle", 240) ?? h.subtitle, button: text(hero, "button", 30) ?? h.button, image: keep(h.image) });
      }
      const about = sub("about");
      if (about) {
        let highlights = site.about.highlights;
        if (about.highlights !== undefined) {
          if (!Array.isArray(about.highlights) || about.highlights.length > MAX.highlights) throw new Bad(`${MSG.badValue} (highlights)`);
          highlights = about.highlights.map((h) => ({ value: text(h || {}, "value", 20) || "", label: text(h || {}, "label", 40) || "" })).filter((h) => h.value || h.label);
        }
        site.set("about", { enabled: bool(about, "enabled") ?? site.about.enabled, title: text(about, "title", 70) ?? site.about.title, text: text(about, "text", 2000) ?? site.about.text, image: keep(site.about?.image), highlights });
      }
      const rooms = sub("rooms");
      if (rooms) {
        let items = site.rooms.items;
        if (rooms.items !== undefined) {
          if (!Array.isArray(rooms.items) || rooms.items.length > 100) throw new Bad(`${MSG.badValue} (rooms)`);
          const old = new Map(site.rooms.items.map((x) => [String(x.type_id), x]));
          items = rooms.items
            .filter((x) => isId(String(x?.type_id || "")))
            .map((x) => {
              const prev = old.get(String(x.type_id));
              return { type_id: x.type_id, text: text(x, "text", 400) ?? prev?.text ?? "", hidden: x.hidden === true, images: prev?.images || [] };
            });
          for (const [id, x] of old) if (!items.some((y) => String(y.type_id) === id)) items.push(x); // photos are never lost by a save
        }
        site.set("rooms", {
          enabled: bool(rooms, "enabled") ?? site.rooms.enabled,
          title: text(rooms, "title", 70) ?? site.rooms.title,
          subtitle: text(rooms, "subtitle", 200) ?? site.rooms.subtitle,
          show_prices: bool(rooms, "show_prices") ?? site.rooms.show_prices,
          items,
        });
      }
      const fac = sub("facilities");
      if (fac) {
        let keys = site.facilities.keys;
        let extra = site.facilities.extra;
        if (fac.keys !== undefined) {
          if (!Array.isArray(fac.keys)) throw new Bad(`${MSG.badValue} (facilities)`);
          keys = [...new Set(fac.keys.filter((k) => M.FACILITIES.includes(k)))];
        }
        if (fac.extra !== undefined) {
          if (!Array.isArray(fac.extra) || fac.extra.length > MAX.extra) throw new Bad(`${MSG.badValue} (facilities)`);
          extra = fac.extra
            .map((v) =>
              String(v || "")
                .trim()
                .slice(0, 40),
            )
            .filter(Boolean);
        }
        site.set("facilities", { enabled: bool(fac, "enabled") ?? site.facilities.enabled, title: text(fac, "title", 70) ?? site.facilities.title, keys, extra });
      }
      const gallery = sub("gallery");
      if (gallery) site.set("gallery", { enabled: bool(gallery, "enabled") ?? site.gallery.enabled, title: text(gallery, "title", 70) ?? site.gallery.title, images: site.gallery.images });
      const booking = sub("booking");
      if (booking)
        site.set("booking", {
          enabled: bool(booking, "enabled") ?? site.booking.enabled,
          title: text(booking, "title", 70) ?? site.booking.title,
          text: text(booking, "text", 300) ?? site.booking.text,
          show_free: bool(booking, "show_free") ?? site.booking.show_free,
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
          whatsapp: text(contact, "whatsapp", 30) ?? c.whatsapp,
        };
        for (const k of ["map_url", "facebook", "telegram", "instagram", "tiktok"]) next[k] = url(contact, k, 300) ?? c[k];
        site.set("contact", next);
      }
      if (b.footer_note !== undefined) site.footer_note = text(b, "footer_note", 200);
      const seo = sub("seo");
      if (seo) site.set("seo", { title: text(seo, "title", 70) ?? site.seo.title, description: text(seo, "description", 160) ?? site.seo.description });
      if (b.published !== undefined) {
        if (b.published) needAddon(ctx);
        site.published = !!b.published;
      }
      if (site.published && !site.slug) throw new Bad(W.needSlug);

      try {
        await site.save();
      } catch (err) {
        if (err.code === 11000) throw new Bad(W.slugTaken, 409);
        throw err;
      }
      const [types, rms] = await roomData(bid);
      res.json({
        success: true,
        data: site,
        preview: publicSite({
          site: site.toObject(),
          settings: ctx.settings,
          business: ctx.business,
          types,
          rooms: rms,
          promos: await livePromos(M, bid, ctx.addons, localDay()),
          portal: !!ctx.addons.gh_customers?.active && ctx.settings.portal_on !== false,
        }),
        message: MSG.saved,
      });
    }),
  );

  // ---------- pictures ----------
  const SLOTS = ["hero", "about", "gallery", "room"];
  const roomItem = (site, typeId, create) => {
    let x = site.rooms.items.find((i) => String(i.type_id) === String(typeId));
    if (!x && create) {
      site.rooms.items.push({ type_id: typeId, text: "", hidden: false, images: [] });
      x = site.rooms.items[site.rooms.items.length - 1];
    }
    return x;
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
      if (!req.file) throw new Bad(MSG.noFile || "No file");
      const site = await siteOf(ctx.business._id);
      let box = null;
      if (slot === "gallery" && site.gallery.images.length >= MAX.gallery) throw new Bad(W.galleryFull);
      if (slot === "room") {
        const tid = String(req.body?.type_id || "");
        if (!isId(tid) || !(await M.GhRoomType.exists({ _id: tid, business_id: ctx.business._id }))) throw new Bad(MSG.rowNotFound, 404);
        box = roomItem(site, tid, true);
        if (box.images.length >= MAX.room_images) throw new Bad(W.roomFull);
      }
      const saved = await uploadBuffer(req.file, "guesthouse/site");
      const value = { url: saved.url, public_id: saved.public_id };
      let old = null;
      if (slot === "gallery") site.gallery.images.push(value);
      else if (slot === "room") box.images.push(value);
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
      if (!SLOTS.includes(slot)) throw new Bad(`${MSG.badValue} (slot)`);
      const site = await siteOf(ctx.business._id);
      let old;
      const pickFrom = (list) => {
        const i = Number(req.body?.index);
        if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new Bad(`${MSG.badValue} (index)`);
        old = list[i].public_id;
        list.splice(i, 1);
      };
      if (slot === "gallery") pickFrom(site.gallery.images);
      else if (slot === "room") {
        const box = roomItem(site, req.body?.type_id, false);
        if (!box) throw new Bad(MSG.rowNotFound, 404);
        pickFrom(box.images);
      } else {
        old = site[slot].image?.public_id;
        site.set(`${slot}.image`, { url: "", public_id: "" });
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
      const theme = req.params.theme;
      if (!PAID.includes(theme)) throw new Bad(W.badTheme);
      const r = await buy({ customer: req.customer, business: ctx.business, product: "gh_site_theme", item: theme, expect: null });
      const site = await siteOf(ctx.business._id);
      site.theme = theme;
      await site.save();
      res.json({ success: true, data: { theme }, themes: await themesInfo(ctx.business._id), charged: r.charged, balance: r.balance, message: MSG.saved });
    }),
  );

  // ---------- booking requests ----------
  prop.app.get(
    `${path}/requests`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
      const limit = 20;
      const filter = { business_id: bid, ...(["new", "done"].includes(req.query.status) ? { status: req.query.status } : {}) };
      const [rows, total, unread] = await Promise.all([
        M.GhSiteRequest.find(filter)
          .sort({ created_date: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .select("-ip_key")
          .lean(),
        M.GhSiteRequest.countDocuments(filter),
        M.GhSiteRequest.countDocuments({ business_id: bid, status: "new" }),
      ]);
      res.json({ success: true, data: rows, unread, pagination: { total, totalPages: Math.max(1, Math.ceil(total / limit)), currentPage: page, pageSize: limit } });
    }),
  );
  prop.app.put(
    `${path}/requests/:rid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      if (!isId(req.params.rid)) throw new Bad(MSG.badId);
      const status = req.body?.status === "new" ? "new" : "done";
      const row = await M.GhSiteRequest.findOneAndUpdate({ _id: req.params.rid, business_id: ctx.business._id }, { $set: { status } }, { returnDocument: "after" }).select("-ip_key").lean();
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, data: row, unread: await M.GhSiteRequest.countDocuments({ business_id: ctx.business._id, status: "new" }) });
    }),
  );
  prop.app.delete(
    `${path}/requests/:rid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      if (!isId(req.params.rid)) throw new Bad(MSG.badId);
      const r = await M.GhSiteRequest.deleteOne({ _id: req.params.rid, business_id: ctx.business._id });
      if (!r.deletedCount) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, unread: await M.GhSiteRequest.countDocuments({ business_id: ctx.business._id, status: "new" }), message: MSG.deleted });
    }),
  );

  // ---------- public ----------
  async function liveSite(slug) {
    const site = slugOk(slug) ? await M.GhSite.findOne({ slug, published: true }).lean() : null;
    if (!site) return null;
    const bid = site.business_id;
    const [business, state, settings] = await Promise.all([Business.findOne({ _id: bid, deleted: false }).select("owner_id status name logo_url phone address").lean(), licenseState(bid), settingsOf(bid)]);
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || !owner?.status || state.license.locked || !state.addons.gh_website?.active) return null;
    return { site, business, state, settings };
  }
  const slugParam = (req) => String(req.params.slug || "").toLowerCase();

  prop.app.get(
    "/api/public/stay/:slug",
    handle(async (req, res) => {
      const live = await liveSite(slugParam(req));
      if (!live) throw new Bad(W.siteOff, 404);
      const { site, business, settings, state } = live;
      const theme = site.theme === FREE || (await ownedThemes(site.business_id)).includes(site.theme) ? site.theme : FREE; // a look no longer owned → the free one
      const [types, rooms] = await roomData(site.business_id);
      res.set("Cache-Control", "public, max-age=30");
      const promos = await livePromos(M, site.business_id, state.addons, localDay());
      const data = publicSite({ site: { ...site, theme }, settings, business, types, rooms, promos, portal: !!state.addons.gh_customers?.active && settings?.portal_on !== false });
      data.reviews = await require("./guesthouse.guests").publicReviews(site.business_id, state.addons); // guest reviews (gh_reviews)
      res.json({ success: true, data });
    }),
  );

  // free rooms of each type for the guest's dates (no names, no bookings — just counts)
  const freeLimit = rate_limit({ windowMs: 60 * 1000, max: 40 });
  prop.app.get(
    "/api/public/stay/:slug/free",
    freeLimit,
    handle(async (req, res) => {
      const live = await liveSite(slugParam(req));
      if (!live) throw new Bad(W.siteOff, 404);
      const from = String(req.query.from || "");
      const to = String(req.query.to || "");
      if (!DAY_RE.test(from) || !DAY_RE.test(to) || from >= to || from < localDay() || (Date.parse(to) - Date.parse(from)) / 86400000 > 60) throw new Bad(W.badDates);
      const bid = live.site.business_id;
      const [rooms, stays] = await Promise.all([
        M.GhRoom.find({ business_id: bid, active: true }).select("type_id").lean(),
        M.GhStay.find({ business_id: bid, status: { $in: M.LIVE }, from: { $lt: to }, to: { $gt: from } })
          .select("room_id")
          .lean(),
      ]);
      const busy = new Set(stays.map((s) => String(s.room_id)));
      const free = {};
      for (const r of rooms) if (!busy.has(String(r._id))) free[String(r.type_id)] = (free[String(r.type_id)] || 0) + 1;
      res.json({ success: true, data: { from, to, free } });
    }),
  );

  const requestLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 5, message: W.tooMany });
  prop.app.post(
    "/api/public/stay/:slug/request",
    requestLimit,
    handle(async (req, res) => {
      const b = req.body || {};
      const live = await liveSite(slugParam(req));
      if (!live || live.site.booking?.enabled === false) throw new Bad(W.formOff, 404);
      if (b.website) return res.status(201).json({ success: true, message: W.sent }); // bots fill every field
      const bid = live.site.business_id;
      const name = text(b, "name", 80, { required: true });
      const contact = text(b, "contact", 100, { required: true });
      const message = text(b, "message", 1000) || "";
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
      const isPhone = /^[+\d][\d\s().-]{5,}$/.test(contact) && contact.replace(/\D/g, "").length >= 6;
      if (!isEmail && !isPhone) throw new Bad(W.badContact);
      const from = String(b.from || "");
      const to = String(b.to || "");
      if (!DAY_RE.test(from) || !DAY_RE.test(to) || from >= to || from < localDay()) throw new Bad(W.badDates);
      const guests = Math.max(1, Math.min(50, parseInt(b.guests, 10) || 1));
      let type = null;
      if (isId(String(b.type_id || ""))) type = await M.GhRoomType.findOne({ _id: b.type_id, business_id: bid }).select("name price").lean();
      const estimate = type ? D.stayPrice(await livePromos(M, bid, live.state.addons, from), type._id, type.price, from, to, live.settings?.currency).total : 0;
      const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "";
      const ipKey = crypto.createHash("sha256").update(`${bid}:${ip}`).digest("hex").slice(0, 24);
      if ((await M.GhSiteRequest.countDocuments({ business_id: bid, ip_key: ipKey, created_date: { $gt: new Date(Date.now() - 86400000) } })) >= 20) throw new Bad(W.tooMany, 429);
      await M.GhSiteRequest.create({ business_id: bid, name, contact, from, to, type_id: type?._id || null, type_name: type?.name || "", guests, message, estimate, ip_key: ipKey });
      const TG = require("./guesthouse.telegram");
      await TG.soon(TG.alert(bid, "new_booking", { request: { kind: "website", name, contact, type_name: type?.name || "", from, to, guests, estimate } }, { addons: live.state.addons }));
      res.status(201).json({ success: true, message: W.sent });
    }),
  );
};
module.exports.publicSite = publicSite;
