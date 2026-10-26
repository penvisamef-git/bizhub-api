// Portfolio (personal web CV) of a digital name card — needs the "portfolio" license (coins per year)
// Customer:
//   GET /api/user/businesses/:id/portfolio     { data, license: {active, expires_at, days_left, status}, price, slug }
//   PUT /api/user/businesses/:id/portfolio     { headline, about, skills[], experience[], education[], projects[], certifications[], languages[], published }
//   POST /api/user/businesses/:id/portfolio/unlock { theme }   pay coins for a premium theme (portfolio must be active)
//   POST   /api/user/businesses/:id/portfolio/files         form-data: file=<pdf|image>, title   (certificates, work documents)
//   PATCH  /api/user/businesses/:id/portfolio/files/:fileId { title }
//   DELETE /api/user/businesses/:id/portfolio/files/:fileId
//   (buy / renew: POST /api/user/businesses/:id/licenses/portfolio)
// Public:
//   GET /api/public/portfolio/:slug            (only while the license is active)
//   GET /api/public/portfolio/:slug/files/:fileId[?download=1]   → redirect to the file (PDFs via a signed link)
const mongoose = require("mongoose");
const Portfolio = require("./portfolio.model");
const multer = require("multer");
const { LISTS, TEXTS, SKILLS, THEMES, FREE_THEMES, PREMIUM_THEMES, FILES } = require("./portfolio.spec");
const { uploadBuffer, deleteFile, cloudinary } = require("../../util/cloudinary");
const coin = require("../../coin/coin.service");
const Namecard = require("./namecard.model");
const Business = require("../business.model");
const Customer = require("../../user/customer.model");
const { customer_auth } = require("../../user/customer_auth");
const { licensesOf } = require("../../license/license.service");
const { PRODUCTS } = require("../../license/license.products");
const { priceOf } = require("../../homepage/prices");
const { publicView, cleanUrl } = require("./namecard.shared");

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  notNamecard: "អាជីវកម្មនេះមិនមែនជាកាតឌីជីថលទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  locked: "សូមដោះសោផលប័ត្រ (Portfolio) ជាមុនសិន!",
  noCard: "សូមបើកកាតឌីជីថលជាមុនសិន!",
  tooLong: "អត្ថបទវែងពេក!",
  tooMany: "ច្រើនពេក!",
  required: "សូមបំពេញ",
  badUrl: "តំណមិនត្រឹមត្រូវ!",
  saved: "បានរក្សាទុក!",
  off: "ផលប័ត្រនេះមិនមាន ឬផុតកំណត់ហើយ។",
  badTheme: "រចនាប័ទ្មមិនត្រឹមត្រូវ!",
  themeLocked: "រចនាប័ទ្មនេះត្រូវដោះសោជាមុនសិន!",
  notPremium: "រចនាប័ទ្មនេះឥតគិតថ្លៃ មិនចាំបាច់ដោះសោទេ!",
  already: "រចនាប័ទ្មនេះបានដោះសោរួចហើយ!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  unlocked: "បានដោះសោរចនាប័ទ្ម!",
  badColor: "ពណ៌មិនត្រឹមត្រូវ (#RRGGBB)!",
  badFile: `អាចបញ្ចូលបានតែ PDF ឬរូបភាព jpg, png, webp (អតិបរមា ${FILES.maxMB}MB)`,
  noFile: "សូមជ្រើសរើសឯកសារ!",
  tooManyFiles: `ឯកសារច្រើនពេក (អតិបរមា ${FILES.max})!`,
  fileNotFound: "រកមិនឃើញឯកសារ!",
  deleted: "បានលុប!",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FILES.maxMB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (FILES.types.includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});

// first page of a PDF as a small jpg (Cloudinary makes it on the fly)
const pdfThumb = (url) => url.replace("/upload/", "/upload/pg_1,w_480,c_limit,f_jpg/").replace(/\.pdf$/i, ".jpg");
const imageThumb = (url) => url.replace("/upload/", "/upload/w_480,c_limit/");
// The Cloudinary account refuses plain delivery of PDF files (401 "deny or ACL failure"), so a PDF is opened with a
// short-lived signed API link (like the notes' downloads). Images keep their plain URL. inline = open in the browser.
function signedUrl(f, inline = true) {
  const type = /\/raw\/upload\//.test(f.url || "") ? "raw" : "image";
  const ext = String(f.url || "").split("?")[0].split("/").pop().split(".").pop().toLowerCase();
  const expires_at = Math.floor(Date.now() / 1000) + 60 * 60;
  return cloudinary.utils.private_download_url(f.public_id, type === "raw" ? "" : ext || "pdf", { resource_type: type, type: "upload", attachment: !inline, expires_at });
}
const openUrl = (f) => (f.kind === "pdf" && f.public_id ? signedUrl(f) : f.url);
const fileView = (f) => ({ _id: f._id, title: f.title, kind: f.kind, url: openUrl(f), thumb: f.thumb, bytes: f.bytes });
// this API's own address (for links on the public page that must come back here)
const apiUrl = (req) => (process.env.API_PUBLIC_URL || "").trim().replace(/\/+$/, "") || `${req.get("x-forwarded-proto")?.split(",")[0] || req.protocol}://${req.get("x-forwarded-host") || req.get("host")}`;

const EMPTY = () => ({ theme: "classic", color: "", files: [], unlocked_themes: [], headline: "", about: "", skills: [], experience: [], education: [], projects: [], certifications: [], languages: [], published: true, views: 0 });

// check + clean what the customer sent → { set } or { error }
function clean(body) {
  const set = {};
  for (const [key, max] of Object.entries(TEXTS)) {
    if (body[key] === undefined) continue;
    const v = String(body[key] ?? "").trim();
    if (v.length > max) return { error: `${MSG.tooLong} (${key} ≤ ${max})` };
    set[key] = v;
  }
  if (body.skills !== undefined) {
    if (!Array.isArray(body.skills)) return { error: "skills" };
    const skills = [...new Set(body.skills.map((s) => String(s ?? "").trim()).filter(Boolean))];
    if (skills.length > SKILLS.max) return { error: `${MSG.tooMany} (skills ≤ ${SKILLS.max})` };
    if (skills.some((s) => s.length > SKILLS.length)) return { error: `${MSG.tooLong} (skill ≤ ${SKILLS.length})` };
    set.skills = skills;
  }
  for (const [key, spec] of Object.entries(LISTS)) {
    if (body[key] === undefined) continue;
    if (!Array.isArray(body[key])) return { error: key };
    const rows = [];
    for (const raw of body[key]) {
      const row = {};
      for (const [f, max] of Object.entries(spec.fields)) {
        let v = String(raw?.[f] ?? "").trim();
        if ((spec.urls || []).includes(f) && v) {
          v = cleanUrl(v);
          if (v === null) return { error: `${MSG.badUrl} (${key}.${f})` };
        }
        if (v.length > max) return { error: `${MSG.tooLong} (${key}.${f} ≤ ${max})` };
        row[f] = v;
      }
      for (const f of spec.bools || []) row[f] = !!raw?.[f];
      const hasAny = Object.keys(spec.fields).some((f) => row[f]);
      if (!hasAny) continue; // empty row → skip
      if (!row[spec.required]) return { error: `${MSG.required}: ${key} #${rows.length + 1} (${spec.required})` };
      rows.push(row);
    }
    if (rows.length > spec.max) return { error: `${MSG.tooMany} (${key} ≤ ${spec.max})` };
    set[key] = rows;
  }
  if (body.published !== undefined) set.published = !!body.published;
  return { set };
}

const route = (prop) => {
  const url = "/api/user/businesses/:id/portfolio";
  const guard = [prop.api_auth, customer_auth];

  async function ownBusiness(req, res, forEdit) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return void res.status(400).json({ success: false, message: MSG.badId });
    const business = await Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false });
    if (!business) return void res.status(404).json({ success: false, message: MSG.notFound });
    if (business.category !== "namecard") return void res.status(400).json({ success: false, message: MSG.notNamecard });
    if (forEdit && !business.status) return void res.status(403).json({ success: false, message: MSG.suspended });
    return business;
  }

  prop.app.get(url, ...guard, async (req, res) => {
    try {
      const business = await ownBusiness(req, res, false);
      if (!business) return;
      const [doc, card, licenses, price] = await Promise.all([
        Portfolio.findOne({ business_id: business._id }).lean(),
        Namecard.findOne({ business_id: business._id }).select("slug").lean(),
        licensesOf(business._id),
        priceOf(PRODUCTS.portfolio.price_key),
      ]);
      res.json({
        success: true,
        data: doc || EMPTY(),
        license: licenses.portfolio,
        price,
        days: PRODUCTS.portfolio.days,
        slug: card?.slug || null,
        themes: { free: FREE_THEMES, premium: PREMIUM_THEMES, price: await priceOf("portfolio_theme") },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  prop.app.put(url, ...guard, async (req, res) => {
    try {
      const business = await ownBusiness(req, res, true);
      if (!business) return;
      const licenses = await licensesOf(business._id);
      if (!licenses.portfolio.active) return res.status(402).json({ success: false, message: MSG.locked, product: "portfolio" });
      const { set, error } = clean(req.body || {});
      if (error) return res.status(400).json({ success: false, message: error });
      if (req.body?.color !== undefined) {
        const color = String(req.body.color || "").toUpperCase();
        if (color && !/^#[0-9A-F]{6}$/.test(color)) return res.status(400).json({ success: false, message: MSG.badColor });
        set.color = color;
      }
      if (req.body?.theme !== undefined) {
        const theme = String(req.body.theme);
        if (!THEMES.includes(theme)) return res.status(400).json({ success: false, message: MSG.badTheme });
        if (PREMIUM_THEMES.includes(theme)) {
          const owned = await Portfolio.exists({ business_id: business._id, unlocked_themes: theme });
          if (!owned) return res.status(402).json({ success: false, message: MSG.themeLocked, theme });
        }
        set.theme = theme;
      }
      const doc = await Portfolio.findOneAndUpdate(
        { business_id: business._id },
        { $set: set, $setOnInsert: { owner_id: business.owner_id } },
        { upsert: true, returnDocument: "after", runValidators: true },
      ).lean();
      res.json({ success: true, data: doc, message: MSG.saved });
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ success: false, message: MSG.server });
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== UNLOCK PREMIUM THEME =====================================
  prop.app.post(`${url}/unlock`, ...guard, async (req, res) => {
    try {
      const business = await ownBusiness(req, res, true);
      if (!business) return;
      const theme = String(req.body?.theme || "");
      if (!THEMES.includes(theme)) return res.status(400).json({ success: false, message: MSG.badTheme });
      if (!PREMIUM_THEMES.includes(theme)) return res.status(400).json({ success: false, message: MSG.notPremium });
      const licenses = await licensesOf(business._id);
      if (!licenses.portfolio.active) return res.status(402).json({ success: false, message: MSG.locked, product: "portfolio" });

      // make sure the portfolio row exists, then reserve the theme so two clicks can't pay twice
      await Portfolio.updateOne({ business_id: business._id }, { $setOnInsert: { owner_id: business.owner_id } }, { upsert: true }).catch((err) => {
        if (err.code !== 11000) throw err;
      });
      const claimed = await Portfolio.findOneAndUpdate(
        { business_id: business._id, unlocked_themes: { $ne: theme } },
        { $addToSet: { unlocked_themes: theme } },
        { returnDocument: "after" },
      ).lean();
      if (!claimed) return res.status(409).json({ success: false, message: MSG.already });

      const price = await priceOf("portfolio_theme");
      let tx = null;
      if (price > 0) {
        try {
          tx = await coin.transfer({
            from: await coin.getCustomerWallet(req.customer._id),
            to: await coin.getTreasury(),
            amount: price,
            note: `Portfolio theme: ${theme} · ${business.name}`,
            customerId: req.customer._id,
            type: "spend",
            businessId: business._id,
            service: "portfolio_theme",
            max: 100000,
          });
        } catch (err) {
          await Portfolio.updateOne({ business_id: business._id }, { $pull: { unlocked_themes: theme } });
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

  // ===================================== FILES (certificates, work documents) =====================================
  const activeOr402 = async (business, res) => {
    const licenses = await licensesOf(business._id);
    if (!licenses.portfolio.active) {
      res.status(402).json({ success: false, message: MSG.locked, product: "portfolio" });
      return false;
    }
    return true;
  };

  prop.app.post(
    `${url}/files`,
    ...guard,
    (req, res, next) =>
      upload.single("file")(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? MSG.badFile : err.message });
        next();
      }),
    async (req, res) => {
      try {
        const business = await ownBusiness(req, res, true);
        if (!business) return;
        if (!(await activeOr402(business, res))) return;
        if (!req.file) return res.status(400).json({ success: false, message: MSG.noFile });
        const title = String(req.body?.title || "").trim().slice(0, FILES.titleLength);
        const current = await Portfolio.findOne({ business_id: business._id }).select("files").lean();
        if ((current?.files || []).length >= FILES.max) return res.status(400).json({ success: false, message: MSG.tooManyFiles });

        const kind = req.file.mimetype === "application/pdf" ? "pdf" : "image";
        const saved = await uploadBuffer(req.file, "portfolio");
        const file = {
          title: title || saved.original_name?.replace(/\.[^.]+$/, "").slice(0, FILES.titleLength) || "",
          kind,
          url: saved.url,
          thumb: kind === "pdf" ? pdfThumb(saved.url) : imageThumb(saved.url),
          public_id: saved.public_id,
          bytes: saved.bytes || req.file.size,
        };
        // add only if still under the limit (two uploads at once)
        const doc = await Portfolio.findOneAndUpdate(
          { business_id: business._id, [`files.${FILES.max - 1}`]: { $exists: false } },
          { $push: { files: file }, $setOnInsert: { owner_id: business.owner_id } },
          { returnDocument: "after", upsert: !current },
        ).lean();
        if (!doc) {
          deleteFile(saved.public_id).catch(() => {});
          return res.status(400).json({ success: false, message: MSG.tooManyFiles });
        }
        res.status(201).json({ success: true, data: doc.files.map(fileView), file: fileView(doc.files[doc.files.length - 1]), message: MSG.saved });
      } catch (err) {
        if (err?.isCloudinary) return res.status(err.status).json({ success: false, message: err.message });
        res.status(500).json({ success: false, message: MSG.server });
      }
    },
  );

  prop.app.patch(`${url}/files/:fileId`, ...guard, async (req, res) => {
    try {
      const business = await ownBusiness(req, res, true);
      if (!business) return;
      if (!(await activeOr402(business, res))) return;
      if (!mongoose.Types.ObjectId.isValid(req.params.fileId)) return res.status(400).json({ success: false, message: MSG.badId });
      const title = String(req.body?.title ?? "").trim();
      if (title.length > FILES.titleLength) return res.status(400).json({ success: false, message: MSG.tooLong });
      const doc = await Portfolio.findOneAndUpdate(
        { business_id: business._id, "files._id": req.params.fileId },
        { $set: { "files.$.title": title } },
        { returnDocument: "after" },
      ).lean();
      if (!doc) return res.status(404).json({ success: false, message: MSG.fileNotFound });
      res.json({ success: true, data: doc.files.map(fileView), message: MSG.saved });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  prop.app.delete(`${url}/files/:fileId`, ...guard, async (req, res) => {
    try {
      const business = await ownBusiness(req, res, true);
      if (!business) return;
      if (!mongoose.Types.ObjectId.isValid(req.params.fileId)) return res.status(400).json({ success: false, message: MSG.badId });
      const before = await Portfolio.findOneAndUpdate(
        { business_id: business._id, "files._id": req.params.fileId },
        { $pull: { files: { _id: req.params.fileId } } },
        { returnDocument: "before" },
      ).lean();
      if (!before) return res.status(404).json({ success: false, message: MSG.fileNotFound });
      const gone = before.files.find((f) => String(f._id) === req.params.fileId);
      if (gone?.public_id) deleteFile(gone.public_id).catch(() => {});
      res.json({ success: true, data: before.files.filter((f) => f !== gone).map(fileView), message: MSG.deleted });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== PUBLIC =====================================
  // the published portfolio of a card slug, or null (not found, unpublished, license over, suspended)
  async function published(rawSlug) {
    const slug = String(rawSlug || "").toLowerCase();
    const card = SLUG_RE.test(slug) ? await Namecard.findOne({ slug }).lean() : null;
    if (!card) return null;
    const [doc, business, owner, licenses] = await Promise.all([
      Portfolio.findOne({ business_id: card.business_id }).lean(),
      Business.findOne({ _id: card.business_id, deleted: false }).select("name status").lean(),
      Customer.findOne({ _id: card.owner_id, deleted: false }).select("status").lean(),
      licensesOf(card.business_id),
    ]);
    if (!doc || !doc.published || !licenses.portfolio.active || !business?.status || !owner?.status) return null;
    return { slug, card, doc, business };
  }

  // GET /api/public/portfolio/:slug/files/:fileId[?download=1] → redirect to the file (a PDF through a fresh signed
  // link, so the link on the public page never expires)
  prop.app.get("/api/public/portfolio/:slug/files/:fileId", async (req, res) => {
    try {
      const p = await published(req.params.slug);
      const f = p && (p.doc.files || []).find((x) => String(x._id) === String(req.params.fileId));
      if (!f) return res.status(404).json({ success: false, message: MSG.off });
      res.set("Cache-Control", "no-store");
      res.redirect(302, f.kind === "pdf" && f.public_id ? signedUrl(f, req.query.download !== "1") : f.url);
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  prop.app.get("/api/public/portfolio/:slug", async (req, res) => {
    try {
      const p = await published(req.params.slug);
      if (!p) return res.status(404).json({ success: false, message: MSG.off });
      const { slug, card, doc, business } = p;
      Portfolio.updateOne({ _id: doc._id }, { $inc: { views: 1 } }).catch(() => {});
      const { _id, owner_id, business_id, views, created_date, __v, unlocked_themes, files, ...content } = doc;
      const base = apiUrl(req);
      content.files = (files || []).map(({ _id: id, title, kind, url, thumb, public_id }) => ({
        title,
        kind,
        url: kind === "pdf" && public_id ? `${base}/api/public/portfolio/${slug}/files/${id}` : url,
        thumb,
      }));
      // a premium theme someone no longer owns (shouldn't happen) falls back to classic
      if (PREMIUM_THEMES.includes(content.theme) && !(unlocked_themes || []).includes(content.theme)) content.theme = "classic";
      res.set("Cache-Control", "public, max-age=30");
      res.json({ success: true, data: { ...content, card: publicView(card, business) } });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });
};

module.exports = route;
module.exports.clean = clean;
