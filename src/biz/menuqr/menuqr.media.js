// Menu QR media library: every picture is uploaded here once, then linked (logo, cover, item photos, promotion banners).
// 35 pictures free; more room is bought per picture (price key "mq_media_slot", 1 coin each, forever).
//   GET    /media                  pictures (newest first) + where each is used + room
//   POST   /media                  upload (multipart "photos", up to 10 at once) — stops when the library is full
//   DELETE /media/:mid             delete the file everywhere (it is unlinked from the menu first)
//   POST   /media/slots { n }      buy n more places (n coins × price)
const mongoose = require("mongoose");
const multer = require("multer");
const M = require("./menuqr.models");
const coin = require("../../coin/coin.service");
const { priceOf } = require("../../homepage/prices");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");

const FREE_MEDIA = 35;
const MAX_SLOTS = 5000;
const T = {
  full: "កន្លែងរូបភាពពេញហើយ! សូមលុបរូបចាស់ ឬទិញកន្លែងបន្ថែម។",
  notFound: "រកមិនឃើញរូបភាព!",
  badN: "ចំនួនមិនត្រឹមត្រូវ!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  bought: "បានបន្ថែមកន្លែងរូបភាព!",
  pick: "សូមជ្រើសរូបពីបណ្ណាល័យ!",
};

const uploadMany = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});

module.exports = (kit) => {
  const { own, Bad, MSG, validId } = kit;
  const capacityOf = (s) => FREE_MEDIA + (s.media_slots || 0);

  // old pictures (from before the library) become library pictures once, so they can be reused + counted
  async function seed(ctx) {
    const s = ctx.settings;
    if (s.media_seeded) return;
    const bid = ctx.business._id;
    const byUrl = new Map((await M.MqMedia.find({ business_id: bid }).select("url").lean()).map((r) => [r.url, r._id]));
    const make = async (p) => {
      if (!p?.url || p.media_id) return null;
      if (!byUrl.has(p.url)) byUrl.set(p.url, (await M.MqMedia.create({ business_id: bid, url: p.url, public_id: p.public_id || "" }))._id);
      return byUrl.get(p.url);
    };
    for (const f of ["logo", "cover"]) {
      const id = await make(s[f]);
      if (id) s[f] = { url: s[f].url, public_id: "", media_id: id };
    }
    for (const it of await M.MqItem.find({ business_id: bid, "photos.0": { $exists: true } })) {
      let changed = false;
      for (const p of it.photos) {
        const id = await make(p);
        if (id) {
          p.media_id = id;
          p.public_id = "";
          changed = true;
        }
      }
      if (changed) await it.save();
    }
    for (const pr of await M.MqPromo.find({ business_id: bid, "photo.url": { $ne: "" } })) {
      const id = await make(pr.photo);
      if (id) {
        pr.photo = { url: pr.photo.url, public_id: "", media_id: id };
        await pr.save();
      }
    }
    s.media_seeded = true;
    await s.save();
  }

  async function room(ctx) {
    await seed(ctx);
    const count = await M.MqMedia.countDocuments({ business_id: ctx.business._id });
    return { count, capacity: capacityOf(ctx.settings), free: FREE_MEDIA, slots: ctx.settings.media_slots || 0 };
  }

  // one file → one library picture (checks the room first)
  async function addFile(ctx, file) {
    const r = await room(ctx);
    if (r.count >= r.capacity) throw new Bad(T.full, 402, { code: "media_full", ...r, slot_price: await priceOf("mq_media_slot") });
    const saved = await uploadBuffer(file, "menuqr");
    return M.MqMedia.create({ business_id: ctx.business._id, url: saved.url, public_id: saved.public_id || "", name: String(file.originalname || "").slice(0, 120), bytes: file.size || 0 });
  }

  // what a picture field gets: { media_id } from the library, or a file just uploaded (it goes into the library)
  async function pictureFrom(ctx, req) {
    if (req.file) {
      const m = await addFile(ctx, req.file);
      return { url: m.url, public_id: "", media_id: m._id };
    }
    const id = req.body?.media_id;
    if (!validId(id)) throw new Bad(T.pick, 400, { code: "pick_media" });
    const m = await M.MqMedia.findOne({ _id: id, business_id: ctx.business._id }).lean();
    if (!m) throw new Bad(T.notFound, 404);
    return { url: m.url, public_id: "", media_id: m._id };
  }

  // where each picture is used
  async function usage(ctx) {
    const bid = ctx.business._id;
    const s = ctx.settings;
    const [items, promos] = await Promise.all([
      M.MqItem.find({ business_id: bid, "photos.0": { $exists: true } })
        .select("name_km name_en photos.media_id")
        .lean(),
      M.MqPromo.find({ business_id: bid, "photo.media_id": { $ne: null } })
        .select("title_km title_en photo.media_id")
        .lean(),
    ]);
    const use = new Map();
    const add = (id, what) => {
      if (!id) return;
      const k = String(id);
      use.set(k, [...(use.get(k) || []), what]);
    };
    add(s.logo?.media_id, { kind: "logo" });
    add(s.cover?.media_id, { kind: "cover" });
    for (const it of items) for (const p of it.photos) add(p.media_id, { kind: "item", id: it._id, name: it.name_km || it.name_en });
    for (const p of promos) add(p.photo?.media_id, { kind: "promo", id: p._id, name: p.title_km || p.title_en });
    return use;
  }

  own("get", "/media", false, async (ctx, req, res) => {
    const r = await room(ctx);
    const [rows, use, price] = await Promise.all([M.MqMedia.find({ business_id: ctx.business._id }).sort({ created_date: -1 }).lean(), usage(ctx), priceOf("mq_media_slot")]);
    res.json({ success: true, data: rows.map((m) => ({ _id: m._id, url: m.url, name: m.name, bytes: m.bytes, created_date: m.created_date, used: use.get(String(m._id)) || [] })), ...r, slot_price: price });
  });

  own(
    "post",
    "/media",
    true,
    async (ctx, req, res) => {
      const files = [...(req.files?.photos || []), ...(req.files?.photo || [])];
      if (!files.length) throw new Bad(MSG.noFile);
      const added = [];
      let full = false;
      for (const f of files) {
        try {
          added.push(await addFile(ctx, f));
        } catch (err) {
          if (err.extra?.code === "media_full") {
            full = true;
            break;
          }
          throw err;
        }
      }
      if (!added.length && full) throw new Bad(T.full, 402, { code: "media_full", ...(await room(ctx)), slot_price: await priceOf("mq_media_slot") });
      res.status(201).json({ success: true, data: added, skipped: files.length - added.length, ...(await room(ctx)), message: MSG.saved });
    },
    [
      (req, res, next) =>
        uploadMany.fields([
          { name: "photos", maxCount: 10 },
          { name: "photo", maxCount: 1 },
        ])(req, res, (err) => {
          if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? MSG.badImage : err.code === "LIMIT_FILE_COUNT" ? MSG.tooMany : err.message });
          next();
        }),
    ],
  );

  own("delete", "/media/:mid", true, async (ctx, req, res) => {
    if (!validId(req.params.mid)) throw new Bad(MSG.badId);
    const bid = ctx.business._id;
    const m = await M.MqMedia.findOne({ _id: req.params.mid, business_id: bid });
    if (!m) throw new Bad(T.notFound, 404);
    const id = m._id;
    // unlink it everywhere first
    const s = ctx.settings;
    for (const f of ["logo", "cover"]) if (String(s[f]?.media_id || "") === String(id)) s[f] = { url: "", public_id: "", media_id: null };
    await s.save();
    await M.MqItem.updateMany({ business_id: bid, "photos.media_id": id }, { $pull: { photos: { media_id: id } } });
    await M.MqPromo.updateMany({ business_id: bid, "photo.media_id": id }, { $set: { photo: { url: "", public_id: "", media_id: null } } });
    await m.deleteOne();
    if (m.public_id) deleteFile(m.public_id).catch(() => {});
    require("../dashboard.route").forget(ctx.business.owner_id);
    res.json({ success: true, ...(await room(ctx)), settings: s, message: MSG.deleted });
  });

  own("post", "/media/slots", true, async (ctx, req, res) => {
    const n = Number(req.body?.n);
    if (!Number.isInteger(n) || n < 1 || n > 500 || (ctx.settings.media_slots || 0) + n > MAX_SLOTS) throw new Bad(T.badN);
    const price = await priceOf("mq_media_slot");
    const total = n * price;
    let tx = null;
    if (total > 0) {
      try {
        tx = await coin.transfer({
          from: await coin.getCustomerWallet(req.customer._id),
          to: await coin.getTreasury(),
          amount: total,
          note: `mq_media_slot × ${n} · ${ctx.business.name}`,
          customerId: req.customer._id,
          type: "spend",
          businessId: ctx.business._id,
          service: "mq_media_slot",
          max: 100000,
        });
      } catch (err) {
        if (err instanceof coin.CoinError) {
          const w = await coin.getCustomerWallet(req.customer._id);
          throw new Bad(T.noCoins, 402, { code: "no_coins", price: total, balance: w.balance });
        }
        throw err;
      }
    }
    await M.MqSettings.updateOne({ _id: ctx.settings._id }, { $inc: { media_slots: n } });
    ctx.settings.media_slots = (ctx.settings.media_slots || 0) + n;
    res.json({ success: true, charged: total, balance: tx ? tx.from_balance_after : undefined, ...(await room(ctx)), message: T.bought });
  });

  return { pictureFrom, room, FREE_MEDIA };
};
