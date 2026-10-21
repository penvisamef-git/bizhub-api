// Digital name card (service of businesses with type "namecard")
// Customer (owner of the business):
//   GET  /api/user/businesses/:id/namecard               card settings (made with defaults the first time)
//   PUT  /api/user/businesses/:id/namecard               { name, job_title, company, bio, theme, color, slug, published }
//   POST /api/user/businesses/:id/namecard/image         form-data: file=<image>, kind=photo|cover
//   DELETE /api/user/businesses/:id/namecard/image       { kind: "photo" | "cover" }
//   POST /api/user/businesses/:id/namecard/unlock        { theme }  pay coins to unlock a premium theme for this card
//   (portfolio: POST /api/user/businesses/:id/licenses/portfolio)
//   GET  /api/user/namecard/slug-check?slug=sokha&business_id=…   { available }
// Public (no login):
//   GET  /api/public/card/:slug                          card to show (counts a view)
const crypto = require("crypto");
const mongoose = require("mongoose");
const multer = require("multer");
const Namecard = require("./namecard.model");
const { THEMES, PREMIUM_THEMES, FREE_THEMES, COLOR_RE } = require("./namecard.model");
const coin = require("../../coin/coin.service");
const { priceOf } = require("../../homepage/prices");
const { cleanUrl, publicView } = require("./namecard.shared");
const Portfolio = require("./portfolio.model");
const { licensesOf } = require("../../license/license.service");
const { PRODUCTS } = require("../../license/license.products");
const Business = require("../business.model");
const Customer = require("../../user/customer.model");
const { customer_auth } = require("../../user/customer_auth");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/; // 3–30 chars
const RESERVED = ["admin", "app", "api", "public", "login", "sign-up", "signup", "bizhub", "support", "help", "card", "www"];
const MAX_IMAGE_MB = 4;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  notNamecard: "អាជីវកម្មនេះមិនមែនជាកាតឌីជីថលទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  badSlug: "តំណខ្លីត្រូវមាន 3–30 តួ: អក្សរ a-z លេខ និង - ប៉ុណ្ណោះ!",
  slugTaken: "តំណខ្លីនេះមានគេប្រើហើយ!",
  badTheme: "រចនាប័ទ្មមិនត្រឹមត្រូវ!",
  badColor: "ពណ៌មិនត្រឹមត្រូវ (#RRGGBB)!",
  tooLong: "អត្ថបទវែងពេក!",
  saved: "បានរក្សាទុក!",
  badKind: "kind: photo | cover",
  noFile: "សូមជ្រើសរើសរូបភាព!",
  badImage: `អាចបញ្ចូលបានតែរូបភាព jpg, png, webp (អតិបរមា ${MAX_IMAGE_MB}MB)`,
  cardOff: "កាតនេះមិនទាន់មាននៅឡើយទេ។",
  locked: "រចនាប័ទ្មនេះត្រូវដោះសោជាមុនសិន!",
  notPremium: "រចនាប័ទ្មនេះឥតគិតថ្លៃ មិនចាំបាច់ដោះសោទេ!",
  already: "រចនាប័ទ្មនេះបានដោះសោរួចហើយ!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  unlocked: "បានដោះសោរចនាប័ទ្ម!",
  badEmail: "អ៊ីមែលមិនត្រឹមត្រូវ!",
  badPhone: "លេខទូរស័ព្ទមិនត្រឹមត្រូវ!",
  badUrl: "តំណមិនត្រឹមត្រូវ!",
  badExtras: "ព័ត៌មានបន្ថែមមិនត្រឹមត្រូវ (អតិបរមា 6)!",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (IMAGE_TYPES.includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error(MSG.badImage), { code: "INVALID_TYPE" }))),
});

// "Sokha Chan" → "sokha-chan"; Khmer / empty names → "card-1234"
function slugify(text) {
  const base = String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return base.length >= 3 && !RESERVED.includes(base) ? base : `card-${crypto.randomInt(1000, 9999)}`;
}

async function uniqueSlug(text) {
  const base = slugify(text);
  if (!(await Namecard.exists({ slug: base }))) return base;
  for (let i = 0; i < 20; i += 1) {
    const candidate = `${base.slice(0, 24)}-${crypto.randomInt(10, 9999)}`;
    if (!(await Namecard.exists({ slug: candidate }))) return candidate;
  }
  return `card-${crypto.randomBytes(4).toString("hex")}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ().-]{6,30}$/;

async function themePrice() {
  return priceOf("premium_theme");
}

const route = (prop) => {
  const url = "/api/user/businesses/:id/namecard";
  const guard = [prop.api_auth, customer_auth];

  // the customer's own name card business (or sends the error and returns null)
  async function ownBusiness(req, res, { forEdit = false } = {}) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ success: false, message: MSG.badId });
      return null;
    }
    const business = await Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false });
    if (!business) {
      res.status(404).json({ success: false, message: MSG.notFound });
      return null;
    }
    if (business.category !== "namecard") {
      res.status(400).json({ success: false, message: MSG.notNamecard });
      return null;
    }
    if (forEdit && !business.status) {
      res.status(403).json({ success: false, message: MSG.suspended });
      return null;
    }
    return business;
  }

  // the card of this business (made with defaults the first time)
  async function cardOf(business, customer) {
    const found = await Namecard.findOne({ business_id: business._id });
    if (found) return found;
    try {
      return await Namecard.create({
        business_id: business._id,
        owner_id: business.owner_id,
        slug: await uniqueSlug(business.name),
        name: customer.name || business.name,
        company: business.name,
      });
    } catch (err) {
      if (err.code === 11000) return Namecard.findOne({ business_id: business._id }); // made at the same time
      throw err;
    }
  }

  // ===================================== GET =====================================
  prop.app.get(url, ...guard, async (req, res) => {
    try {
      const business = await ownBusiness(req, res);
      if (!business) return;
      const card = await cardOf(business, req.customer);
      const [themeCost, portfolioCost, licenses] = await Promise.all([
        themePrice(),
        priceOf(PRODUCTS.portfolio.price_key),
        licensesOf(business._id),
      ]);
      res.json({
        success: true,
        data: card,
        business: { _id: business._id, name: business.name, status: business.status },
        themes: { free: FREE_THEMES, premium: PREMIUM_THEMES, price: themeCost },
        licenses, // { portfolio: {active, expires_at, days_left…} }
        prices: { theme: themeCost, portfolio: portfolioCost },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== UPDATE =====================================
  prop.app.put(url, ...guard, async (req, res) => {
    try {
      const business = await ownBusiness(req, res, { forEdit: true });
      if (!business) return;
      const card = await cardOf(business, req.customer);
      const body = req.body || {};
      const set = {};

      const limits = { name: 80, job_title: 80, company: 80, bio: 500, address: 200, telegram: 60 };
      for (const [key, max] of Object.entries(limits)) {
        if (body[key] === undefined) continue;
        const value = String(body[key] ?? "").trim();
        if (value.length > max) return res.status(400).json({ success: false, message: `${MSG.tooLong} (${key} ≤ ${max})` });
        set[key] = value;
      }
      for (const key of ["phone1", "phone2"]) {
        if (body[key] === undefined) continue;
        const value = String(body[key] ?? "").trim();
        if (value && !PHONE_RE.test(value)) return res.status(400).json({ success: false, message: MSG.badPhone });
        set[key] = value;
      }
      if (body.email !== undefined) {
        const value = String(body.email ?? "").trim().toLowerCase();
        if (value && (!EMAIL_RE.test(value) || value.length > 120)) return res.status(400).json({ success: false, message: MSG.badEmail });
        set.email = value;
      }
      for (const key of ["website", "facebook"]) {
        if (body[key] === undefined) continue;
        const value = cleanUrl(body[key]);
        if (value === null || value.length > 200) return res.status(400).json({ success: false, message: `${MSG.badUrl} (${key})` });
        set[key] = value;
      }
      if (body.extras !== undefined) {
        if (!Array.isArray(body.extras) || body.extras.length > 6) return res.status(400).json({ success: false, message: MSG.badExtras });
        const extras = [];
        for (const x of body.extras) {
          const label = String(x?.label ?? "").trim();
          const value = String(x?.value ?? "").trim();
          if (!label && !value) continue;
          if (label.length > 40 || value.length > 200) return res.status(400).json({ success: false, message: MSG.badExtras });
          extras.push({ label, value });
        }
        set.extras = extras;
      }
      if (body.theme !== undefined) {
        if (!THEMES.includes(body.theme)) return res.status(400).json({ success: false, message: MSG.badTheme });
        if (PREMIUM_THEMES.includes(body.theme) && !card.unlocked_themes.includes(body.theme)) {
          return res.status(402).json({ success: false, message: MSG.locked, theme: body.theme });
        }
        set.theme = body.theme;
      }
      if (body.color !== undefined) {
        if (!COLOR_RE.test(String(body.color))) return res.status(400).json({ success: false, message: MSG.badColor });
        set.color = String(body.color).toUpperCase();
      }
      if (body.published !== undefined) set.published = !!body.published;
      if (body.slug !== undefined) {
        const slug = String(body.slug || "").trim().toLowerCase();
        if (!SLUG_RE.test(slug) || RESERVED.includes(slug)) return res.status(400).json({ success: false, message: MSG.badSlug });
        if (slug !== card.slug && (await Namecard.exists({ slug, _id: { $ne: card._id } }))) {
          return res.status(409).json({ success: false, message: MSG.slugTaken });
        }
        set.slug = slug;
      }

      try {
        card.set(set);
        await card.save();
      } catch (err) {
        if (err.code === 11000) return res.status(409).json({ success: false, message: MSG.slugTaken });
        throw err;
      }
      res.json({ success: true, data: card, message: MSG.saved });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== UNLOCK PREMIUM THEME =====================================
  prop.app.post(`${url}/unlock`, ...guard, async (req, res) => {
    try {
      const business = await ownBusiness(req, res, { forEdit: true });
      if (!business) return;
      const theme = String(req.body?.theme || "");
      if (!THEMES.includes(theme)) return res.status(400).json({ success: false, message: MSG.badTheme });
      if (!PREMIUM_THEMES.includes(theme)) return res.status(400).json({ success: false, message: MSG.notPremium });

      // reserve the theme first, so two clicks can't pay twice
      const card = await cardOf(business, req.customer);
      const claimed = await Namecard.findOneAndUpdate(
        { _id: card._id, unlocked_themes: { $ne: theme } },
        { $addToSet: { unlocked_themes: theme } },
        { returnDocument: "after" },
      );
      if (!claimed) return res.status(409).json({ success: false, message: MSG.already });

      const price = await themePrice();
      let tx = null;
      if (price > 0) {
        try {
          tx = await coin.transfer({
            from: await coin.getCustomerWallet(req.customer._id),
            to: await coin.getTreasury(),
            amount: price,
            note: `Premium theme: ${theme} · ${business.name}`,
            customerId: req.customer._id,
            type: "spend",
            businessId: business._id,
            service: "namecard_theme",
            max: 100000,
          });
        } catch (err) {
          await Namecard.updateOne({ _id: card._id }, { $pull: { unlocked_themes: theme } });
          if (err instanceof coin.CoinError) {
            const wallet = await coin.getCustomerWallet(req.customer._id);
            return res.status(402).json({ success: false, message: MSG.noCoins, price, balance: wallet.balance });
          }
          throw err;
        }
      }
      res.json({ success: true, data: claimed, charged: price, balance: tx ? tx.from_balance_after : undefined, message: MSG.unlocked });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== SLUG CHECK =====================================
  prop.app.get("/api/user/namecard/slug-check", ...guard, async (req, res) => {
    try {
      const slug = String(req.query.slug || "").trim().toLowerCase();
      if (!SLUG_RE.test(slug) || RESERVED.includes(slug)) return res.json({ success: true, data: { available: false, valid: false } });
      const filter = { slug };
      if (mongoose.Types.ObjectId.isValid(req.query.business_id)) filter.business_id = { $ne: req.query.business_id };
      const taken = await Namecard.exists(filter);
      res.json({ success: true, data: { available: !taken, valid: true } });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== IMAGES =====================================
  prop.app.post(
    `${url}/image`,
    ...guard,
    (req, res, next) =>
      upload.single("file")(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? MSG.badImage : err.message });
        next();
      }),
    async (req, res) => {
      try {
        const business = await ownBusiness(req, res, { forEdit: true });
        if (!business) return;
        const kind = req.body?.kind;
        if (!["photo", "cover"].includes(kind)) return res.status(400).json({ success: false, message: MSG.badKind });
        if (!req.file) return res.status(400).json({ success: false, message: MSG.noFile });

        const card = await cardOf(business, req.customer);
        const image = await uploadBuffer(req.file, "namecard");
        const old = card[kind]?.public_id;
        card[kind] = { url: image.url, public_id: image.public_id };
        await card.save();
        if (old) deleteFile(old).catch(() => {}); // remove the old picture
        res.status(201).json({ success: true, data: card, message: MSG.saved });
      } catch (err) {
        if (err?.isCloudinary) return res.status(err.status).json({ success: false, message: err.message });
        res.status(500).json({ success: false, message: MSG.server });
      }
    },
  );

  prop.app.delete(`${url}/image`, ...guard, async (req, res) => {
    try {
      const business = await ownBusiness(req, res, { forEdit: true });
      if (!business) return;
      const kind = req.body?.kind;
      if (!["photo", "cover"].includes(kind)) return res.status(400).json({ success: false, message: MSG.badKind });
      const card = await cardOf(business, req.customer);
      const old = card[kind]?.public_id;
      card[kind] = { url: "", public_id: "" };
      await card.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: card, message: MSG.saved });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== PUBLIC =====================================
  prop.app.get("/api/public/card/:slug", async (req, res) => {
    try {
      const slug = String(req.params.slug || "").toLowerCase();
      const card = SLUG_RE.test(slug) ? await Namecard.findOne({ slug }).lean() : null;
      if (!card || !card.published) return res.status(404).json({ success: false, message: MSG.cardOff });
      const [business, owner, licenses, folio] = await Promise.all([
        Business.findOne({ _id: card.business_id, deleted: false }).select("name status").lean(),
        Customer.findOne({ _id: card.owner_id, deleted: false }).select("status").lean(),
        licensesOf(card.business_id),
        Portfolio.findOne({ business_id: card.business_id }).select("published").lean(),
      ]);
      if (!business || !business.status || !owner || !owner.status) return res.status(404).json({ success: false, message: MSG.cardOff });
      Namecard.updateOne({ _id: card._id }, { $inc: { views: 1 } }).catch(() => {});
      res.set("Cache-Control", "public, max-age=30");
      res.json({ success: true, data: publicView(card, business, { portfolio: !!(folio?.published && licenses.portfolio.active) }) });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });
};

module.exports = route;
module.exports.slugify = slugify;
