// Online orders + customer accounts (mart_shop, 75 coins a year — needs the website, mart_website).
// Customers sign up on the shop website (/m/<slug>/account) with phone + password, fill a cart and order:
// pickup or delivery (one delivery fee, a smallest order), cash or ABA / KHQR with a screenshot.
// The shop: new → accept (stock leaves) → ready (pickup) / on the way (delivery) → done (a sale is made); or decline (stock back).
// 24 customer-dashboard looks: classic free, the others bought one by one (mart_portal_theme, 85 coins, forever).
// Owner (/api/user/businesses/:id/mart):
//   GET /shop    PUT /shop { shop_on, pickup_on, delivery_on, delivery_fee, min_order, shop_cash, shop_qr, shop_note, portal_theme }
//   POST /portal-themes/:theme/buy
//   GET /customers?q=&page=     GET /customers/:cid     PUT /customers/:cid { blocked }
// Owner + POS (/api/martpos/...):
//   GET /orders?status=open|new|done|closed|all&page=     GET /orders/count (the POS rings while new > 0)     GET /orders/:oid
//   POST /orders/:oid/accept | ready | deliver | done      POST /orders/:oid/decline { reason }
// Customer (/api/public/shop/:slug/account, header x-mart-cust: <token>):
//   GET /     POST /register { name, phone, password, confirm }     POST /login { phone, password }
//   GET /me   PUT /me { name, addresses }     POST /me/password { old, password, confirm }
//   GET /orders     POST /orders (multipart: items JSON, fulfil, address, address_note, map, note, pay_method, proof)     POST /orders/:oid/cancel
const bcrypt = require("bcrypt");
const multer = require("multer");
const License = require("../../license/license.model");
const { buy } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { rate_limit } = require("../../util/rate_limit");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");

const TOKEN_DAYS = 60;
const MAX_OPEN = 5; // orders a customer can have waiting at once
const MAX_LINES = 100;
const FREE = "classic";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});
// one phone, one account: spaces / dashes dropped, +855 → 0
const phoneKey = (v) => {
  let d = String(v || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+855")) d = `0${d.slice(4)}`;
  else if (d.startsWith("855") && d.length >= 11) d = `0${d.slice(3)}`;
  return d.replace(/\+/g, "");
};
const phoneOk = (p) => /^\d{8,15}$/.test(p);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sound = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (/^audio\/(mpeg|mp3|mp4|x-m4a|aac|wav|x-wav|ogg|webm)$/.test(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, posCtx, Bad, MSG, text, num, bool, validId, roundOf, jwt, M } = kit;
  const T = {
    needShop: "សូមដោះសោ “ការកម្ម៉ង់អនឡាញ” ជាមុនសិន!",
    closed: "ហាងមិនទាន់ទទួលការកម្ម៉ង់អនឡាញទេ។",
    badPhone: "លេខទូរស័ព្ទមិនត្រឹមត្រូវ!",
    badEmail: "អ៊ីមែលមិនត្រឹមត្រូវ!",
    emailTaken: "អ៊ីមែលនេះបានចុះឈ្មោះរួចហើយ — សូមចូលគណនី",
    needPass: "សូមបញ្ចូលពាក្យសម្ងាត់បច្ចុប្បន្ន ដើម្បីប្តូរអ៊ីមែល",
    badSound: "សូមដាក់ឯកសារសំឡេង MP3 / M4A / WAV / OGG (តិចជាង 3MB)!",
    weakPass: "ពាក្យសម្ងាត់ត្រូវមានយ៉ាងហោចណាស់ 6 តួ",
    noMatch: "ពាក្យសម្ងាត់ទាំងពីរមិនដូចគ្នា!",
    phoneTaken: "លេខទូរស័ព្ទនេះបានចុះឈ្មោះរួចហើយ — សូមចូលគណនី",
    badLogin: "លេខទូរស័ព្ទ ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ!",
    blocked: "គណនីនេះត្រូវបានបិទ។ សូមទាក់ទងហាង។",
    login: "សូមចូលគណនីម្តងទៀត",
    oldPass: "ពាក្យសម្ងាត់ចាស់មិនត្រឹមត្រូវ!",
    themeLocked: "សូមទិញរចនានេះជាមុនសិន!",
    badTheme: "រចនាមិនត្រឹមត្រូវ!",
    empty: "កន្ត្រកទំនិញនៅទទេ!",
    tooMany: `អ្នកមានការកម្ម៉ង់កំពុងរង់ចាំ ${MAX_OPEN} រួចហើយ`,
    gone: "ទំនិញខ្លះលែងមានលក់ហើយ — សូមពិនិត្យកន្ត្រកម្តងទៀត",
    soldout: "“{name}” នៅសល់តែ {left} ប៉ុណ្ណោះ",
    minOrder: "ការកម្ម៉ង់តិចបំផុតគឺ {amt}",
    noPickup: "ហាងមិនទទួលមកយកផ្ទាល់ទេ",
    noDelivery: "ហាងមិនមានសេវាដឹកជញ្ជូនទេ",
    needAddress: "សូមបញ្ចូលអាសយដ្ឋានដឹកជញ្ជូន",
    noCash: "ហាងមិនទទួលបង់ប្រាក់សុទ្ធទេ",
    noQr: "ហាងមិនទាន់មាន QR សម្រាប់បង់ប្រាក់ទេ",
    needProof: "សូមភ្ជាប់រូបភាពប្រតិបត្តិការបង់ប្រាក់",
    badImage: "រូបភាពត្រូវជា JPG, PNG ឬ WEBP និងតូចជាង 5MB",
    sent: "បានផ្ញើការកម្ម៉ង់ហើយ។ ហាងនឹងបញ្ជាក់ឆាប់ៗ។",
    wrongStep: "ការកម្ម៉ង់នេះបានផ្លាស់ប្តូររួចហើយ!",
    cantCancel: "ហាងបានទទួលការកម្ម៉ង់នេះហើយ — សូមទាក់ទងហាង",
    noCustomers: "ម្ចាស់ហាងមិនទាន់អនុញ្ញាតឲ្យមើលព័ត៌មានអតិថិជនលើ POS ទេ។",
  };
  const PAID = M.PORTAL_THEMES.filter((t) => t !== FREE);
  const ownedThemes = async (bid) => (await License.find({ business_id: bid, product: "mart_portal_theme", expires_at: null }).select("item").lean()).map((r) => r.item).filter((t) => PAID.includes(t));
  const site = () => kit.site;
  const stock = () => kit.stock;
  const r2 = (v) => Math.round(v * 100) / 100;
  const isOrderNo = (s) => `W-${String(s).padStart(4, "0")}`;

  // ---------------------------------------------------------------- owner: settings, looks, customers
  const SET_KEYS = ["shop_on", "pickup_on", "delivery_on", "shop_cash", "shop_qr", "pos_customers"];
  const shopInfo = async (ctx) => {
    const bid = ctx.business._id;
    const s = ctx.settings;
    const [price, themePrice, owned, customers, waiting, open, siteRow] = await Promise.all([
      priceOf("mart_shop"),
      priceOf("mart_portal_theme"),
      ownedThemes(bid),
      M.MartCustomer.countDocuments({ business_id: bid }),
      M.MartOrder.countDocuments({ business_id: bid, status: "new" }),
      M.MartOrder.countDocuments({ business_id: bid, status: { $in: M.OPEN_ORDER } }),
      M.MartSite.findOne({ business_id: bid }).select("slug published").lean(),
    ]);
    return {
      addon: { ...ctx.addons.mart_shop, price },
      website: !!ctx.addons.mart_website?.active,
      site: { slug: siteRow?.slug || "", published: !!siteRow?.published },
      themes: { list: M.PORTAL_THEMES, free: [FREE], owned, price: themePrice, current: s.portal_theme || FREE, color: s.portal_color || "" },
      settings: {
        shop_on: s.shop_on !== false,
        pickup_on: s.pickup_on !== false,
        delivery_on: s.delivery_on !== false,
        delivery_fee: s.delivery_fee || 0,
        min_order: s.min_order || 0,
        shop_cash: s.shop_cash !== false,
        shop_qr: s.shop_qr !== false,
        shop_note: s.shop_note || "",
        pos_customers: !!s.pos_customers,
      },
      has_qr: !!(s.shop_qr_img?.url || s.pay_qr?.url),
      qr: { url: s.shop_qr_img?.url || "", label: s.shop_qr_label || "", pos_url: s.pay_qr?.url || "" }, // the online-order QR (else the POS QR)
      sound: s.order_sound?.url || "",
      currency: s.currency,
      counts: { customers, new: waiting, open },
    };
  };
  prop.app.get(
    `${base}/shop`,
    ...guard,
    handle(async (req, res) => res.json({ success: true, data: await shopInfo(await ctxOf(req, false)) })),
  );
  prop.app.put(
    `${base}/shop`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      const s = ctx.settings;
      for (const k of SET_KEYS) {
        const v = bool(b, k);
        if (v !== undefined) s[k] = v;
      }
      const fee = num(b, "delivery_fee", 0, 10000000);
      if (fee !== undefined) s.delivery_fee = roundOf(s.currency)(fee);
      const min = num(b, "min_order", 0, 100000000);
      if (min !== undefined) s.min_order = roundOf(s.currency)(min);
      const note = text(b, "shop_note", 300);
      if (note !== undefined) s.shop_note = note;
      const qrLabel = text(b, "shop_qr_label", 60);
      if (qrLabel !== undefined) s.shop_qr_label = qrLabel;
      if (b.portal_color !== undefined) {
        if (b.portal_color && !/^#[0-9A-Fa-f]{6}$/.test(String(b.portal_color))) throw new Bad(`${MSG.badValue} (portal_color)`);
        s.portal_color = String(b.portal_color || "").toUpperCase();
      }
      if (b.portal_theme !== undefined) {
        if (!M.PORTAL_THEMES.includes(b.portal_theme)) throw new Bad(T.badTheme);
        if (b.portal_theme !== FREE && !(await ownedThemes(ctx.business._id)).includes(b.portal_theme)) throw new Bad(T.themeLocked, 402, { product: "mart_portal_theme", item: b.portal_theme });
        s.portal_theme = b.portal_theme;
      }
      if (!s.pickup_on && !s.delivery_on) s.pickup_on = true; // one way to get the goods at least
      if (!s.shop_cash && !s.shop_qr) s.shop_cash = true;
      await s.save();
      res.json({ success: true, data: await shopInfo(ctx), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${base}/portal-themes/:theme/buy`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const theme = req.params.theme;
      if (!PAID.includes(theme)) throw new Bad(T.badTheme);
      const r = await buy({ customer: req.customer, business: ctx.business, product: "mart_portal_theme", item: theme, expect: null });
      ctx.settings.portal_theme = theme;
      await ctx.settings.save();
      res.json({ success: true, data: await shopInfo(ctx), charged: r.charged, balance: r.balance, message: MSG.saved });
    }),
  );
  // the online-order QR (customers scan it at checkout) + the new-order alarm (mp3)
  const withImage = (req, res, next) =>
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? T.badImage : err.message });
      next();
    });
  const withSound = (req, res, next) =>
    sound.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? T.badSound : err.message });
      next();
    });
  const fileRoute = (path, field, mw, folder, type) => {
    prop.app.post(
      `${base}${path}`,
      ...guard,
      mw,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        if (!req.file) throw new Bad(MSG.noFile);
        const saved = await uploadBuffer(req.file, folder, type);
        const old = ctx.settings[field]?.public_id;
        ctx.settings[field] = { url: saved.url, public_id: saved.public_id || "" };
        await ctx.settings.save();
        if (old) deleteFile(old, type).catch(() => {});
        res.json({ success: true, data: await shopInfo(ctx), message: MSG.saved });
      }),
    );
    prop.app.delete(
      `${base}${path}`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        const old = ctx.settings[field]?.public_id;
        ctx.settings[field] = { url: "", public_id: "" };
        await ctx.settings.save();
        if (old) deleteFile(old, type).catch(() => {});
        res.json({ success: true, data: await shopInfo(ctx), message: MSG.deleted });
      }),
    );
  };
  fileRoute("/shop/qr", "shop_qr_img", withImage, "mart", "image");
  fileRoute("/shop/sound", "order_sound", withSound, "mart/sounds", "video"); // audio files are "video" on Cloudinary
  const custOut = (c) => ({ _id: c._id, name: c.name, phone: c.phone, email: c.email || "", avatar: c.avatar?.url || "", blocked: !!c.blocked, addresses: c.addresses || [], last_login: c.last_login, created_date: c.created_date });
  // online customers: the owner always; the POS only when the owner allows it (pos_customers)
  const custGet = (path, fn) => {
    prop.app.get(
      `${base}${path}`,
      ...guard,
      handle(async (req, res) => fn(await ctxOf(req, false), req, res)),
    );
    prop.app.get(
      `/api/martpos${path}`,
      prop.api_auth,
      handle(async (req, res) => {
        const ctx = await posCtx(req, false);
        if (!ctx.settings.pos_customers) throw new Bad(T.noCustomers, 403, { code: "no_permission" });
        await fn(ctx, req, res);
      }),
    );
  };
  custGet("/customers", async (ctx, req, res) => {
    const bid = ctx.business._id;
    const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
    const limit = 30;
    const q = String(req.query.q || "")
      .trim()
      .slice(0, 40);
    const filter = { business_id: bid };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { phone: rx }, { email: rx }];
    }
    const [rows, total] = await Promise.all([
      M.MartCustomer.find(filter)
        .sort({ created_date: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.MartCustomer.countDocuments(filter),
    ]);
    const sums = await M.MartOrder.aggregate([
      { $match: { business_id: bid, customer_id: { $in: rows.map((r) => r._id) } } },
      { $group: { _id: "$customer_id", orders: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ["$status", "done"] }, 1, 0] } }, spent: { $sum: { $cond: [{ $eq: ["$status", "done"] }, "$total", 0] } }, last: { $max: "$created_date" } } },
    ]);
    const by = new Map(sums.map((x) => [String(x._id), x]));
    res.json({
      success: true,
      data: rows.map((r) => {
        const x = by.get(String(r._id));
        return { ...custOut(r), orders: x?.orders || 0, done: x?.done || 0, spent: r2(x?.spent || 0), last_order: x?.last || null };
      }),
      pagination: { total, totalPages: Math.max(1, Math.ceil(total / limit)), currentPage: page, pageSize: limit },
    });
  });
  custGet("/customers/:cid", async (ctx, req, res) => {
    if (!validId(req.params.cid)) throw new Bad(MSG.badId);
    const c = await M.MartCustomer.findOne({ _id: req.params.cid, business_id: ctx.business._id }).lean();
    if (!c) throw new Bad(MSG.rowNotFound, 404);
    const orders = await M.MartOrder.find({ business_id: ctx.business._id, customer_id: c._id }).sort({ created_date: -1 }).limit(100).lean();
    const done = orders.filter((o) => o.status === "done");
    const spent = r2(done.reduce((a, o) => a + o.total, 0));
    // what they buy most (done orders)
    const fav = new Map();
    for (const o of done)
      for (const l of o.items) {
        const k = String(l.product_id || l.name);
        const x = fav.get(k) || { name: l.name, photo: l.photo || "", qty: 0, total: 0 };
        x.qty += l.qty;
        x.total += l.total;
        fav.set(k, x);
      }
    res.json({
      success: true,
      data: {
        customer: custOut(c),
        orders: orders.map(orderOut),
        stats: {
          orders: orders.length,
          done: done.length,
          spent,
          avg: done.length ? r2(spent / done.length) : 0,
          cancelled: orders.filter((o) => ["declined", "cancelled"].includes(o.status)).length,
          open: orders.filter((o) => M.OPEN_ORDER.includes(o.status)).length,
          delivery: orders.filter((o) => o.fulfil === "delivery").length,
          pickup: orders.filter((o) => o.fulfil === "pickup").length,
          qr: orders.filter((o) => o.pay_method === "qr").length,
          cash: orders.filter((o) => o.pay_method === "cash").length,
          first_order: orders.length ? orders[orders.length - 1].created_date : null,
          last_order: orders.length ? orders[0].created_date : null,
        },
        favourites: [...fav.values()]
          .sort((a, b) => b.qty - a.qty)
          .slice(0, 6)
          .map((x) => ({ ...x, total: r2(x.total) })),
        currency: ctx.settings.currency,
      },
    });
  });
  prop.app.put(
    `${base}/customers/:cid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.cid)) throw new Bad(MSG.badId);
      const row = await M.MartCustomer.findOne({ _id: req.params.cid, business_id: ctx.business._id });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      const blocked = bool(req.body || {}, "blocked");
      if (blocked !== undefined) {
        row.blocked = blocked;
        if (blocked) row.pass_v += 1; // logs them out
      }
      await row.save();
      res.json({ success: true, data: custOut(row), message: MSG.saved });
    }),
  );

  // ---------------------------------------------------------------- owner + POS: orders
  function both(method, path, write, fn) {
    prop.app[method](
      `${base}${path}`,
      ...guard,
      handle(async (req, res) => fn(await ctxOf(req, write), req, res)),
    );
    prop.app[method](
      `/api/martpos${path}`,
      prop.api_auth,
      handle(async (req, res) => fn(await posCtx(req, write), req, res)),
    );
  }
  function orderOut(o) {
    return {
      _id: o._id,
      no: o.no,
      customer_id: o.customer_id,
      name: o.name,
      phone: o.phone,
      items: o.items,
      subtotal: o.subtotal,
      delivery_fee: o.delivery_fee,
      total: o.total,
      currency: o.currency,
      fulfil: o.fulfil,
      address: o.address || {},
      note: o.note || "",
      pay_method: o.pay_method,
      proof: o.pay_proof?.url || "",
      status: o.status,
      reason: o.reason || "",
      sale_no: o.sale_no || "",
      promo_discount: o.promo_discount || 0,
      promos: o.promos || [],
      coupon: o.coupon || "",
      points_used: o.points_used || 0,
      points_value: o.points_value || 0,
      zone_name: o.zone_name || "",
      driver_id: o.driver_id || null,
      driver_name: o.driver_name || "",
      driver_phone: o.driver_phone || "",
      timeline: o.timeline || [],
      created_date: o.created_date,
      updated_date: o.updated_date,
    };
  }
  const FILTERS = { open: M.OPEN_ORDER, closed: ["done", "declined", "cancelled"] };
  both("get", "/orders/count", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const [pending, open, latest] = await Promise.all([
      M.MartOrder.countDocuments({ business_id: bid, status: "new" }),
      M.MartOrder.countDocuments({ business_id: bid, status: { $in: M.OPEN_ORDER } }),
      M.MartOrder.findOne({ business_id: bid, status: "new" }).sort({ created_date: -1 }).select("created_date").lean(),
    ]);
    res.json({ success: true, data: { pending, open, latest: latest?.created_date || null, on: !!ctx.addons.mart_shop?.active, sound: ctx.settings.order_sound?.url || "" } });
  });
  both("get", "/orders", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
    const limit = 30;
    const st = String(req.query.status || "open");
    const list = FILTERS[st] || (M.ORDER_STATUSES.includes(st) ? [st] : null);
    const filter = { business_id: bid, ...(list ? { status: { $in: list } } : {}) };
    const [rows, total] = await Promise.all([
      M.MartOrder.find(filter)
        .sort({ created_date: st === "open" ? 1 : -1 }) // open: the oldest first (served in order)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.MartOrder.countDocuments(filter),
    ]);
    res.json({ success: true, data: rows.map(orderOut), pagination: { total, totalPages: Math.max(1, Math.ceil(total / limit)), currentPage: page, pageSize: limit } });
  });
  const loadOrder = async (ctx, oid) => {
    if (!validId(oid)) throw new Bad(MSG.badId);
    const row = await M.MartOrder.findOne({ _id: oid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  both("get", "/orders/:oid", false, async (ctx, req, res) => {
    res.json({ success: true, data: orderOut((await loadOrder(ctx, req.params.oid)).toObject()) });
  });
  // move an order one step; only one person wins when two press at once
  async function step(ctx, oid, from, to, extra = {}) {
    const row = await loadOrder(ctx, oid);
    const moved = await M.MartOrder.findOneAndUpdate({ _id: row._id, status: { $in: from } }, { $set: { status: to, ...extra }, $push: { timeline: { status: to, at: new Date(), by: ctx.by } } }, { returnDocument: "after" });
    if (!moved) throw new Bad(T.wrongStep, 409, { code: "wrong_step", status: row.status });
    return moved;
  }
  const asSale = (o) => ({ _id: o._id, no: o.no, items: o.items });
  both("post", "/orders/:oid/accept", true, async (ctx, req, res) => {
    if (!ctx.addons.mart_shop?.active) throw new Bad(T.needShop, 402, { product: "mart_shop" });
    const o = await step(ctx, req.params.oid, ["new"], "accepted");
    // the goods are put aside: they leave the stock now (stock control)
    if (stock().on(ctx)) {
      await stock().take(ctx, asSale(o));
      o.stock_held = true;
      await o.save();
    }
    res.json({ success: true, data: orderOut(o.toObject()), message: MSG.saved });
  });
  both("post", "/orders/:oid/ready", true, async (ctx, req, res) => {
    const row = await loadOrder(ctx, req.params.oid);
    const o = await step(ctx, row._id, ["accepted"], row.fulfil === "delivery" ? "delivering" : "ready");
    res.json({ success: true, data: orderOut(o.toObject()), message: MSG.saved });
  });
  both("post", "/orders/:oid/deliver", true, async (ctx, req, res) => {
    const o = await step(ctx, req.params.oid, ["accepted", "ready"], "delivering");
    res.json({ success: true, data: orderOut(o.toObject()), message: MSG.saved });
  });
  // done: the customer has the goods and paid → it becomes a sale (the stock already left at accept)
  both("post", "/orders/:oid/done", true, async (ctx, req, res) => {
    const o = await step(ctx, req.params.oid, ["accepted", "ready", "delivering"], "done");
    const s = ctx.settings;
    const methods = s.methods || [];
    const method = o.pay_method === "qr" ? (methods.includes("khqr") ? "khqr" : methods.includes("aba") ? "aba" : "khqr") : "cash";
    const costs = new Map(
      (
        await M.MartProduct.find({ business_id: ctx.business._id, _id: { $in: o.items.map((l) => l.product_id).filter(Boolean) } })
          .select("cost")
          .lean()
      ).map((p) => [String(p._id), p.cost || 0]),
    );
    const lines = o.items.map((l) => ({
      product_id: l.product_id,
      name: l.name,
      price: l.price,
      qty: l.qty,
      total: l.total,
      unit_en: l.unit_en,
      unit_km: l.unit_km,
      ...(l.product_id && costs.has(String(l.product_id)) ? { cost: costs.get(String(l.product_id)) } : {}),
    }));
    if (o.delivery_fee > 0) lines.push({ product_id: null, name: o.zone_name ? `Delivery · ${o.zone_name}` : "Delivery / ដឹកជញ្ជូន", price: o.delivery_fee, qty: 1, total: o.delivery_fee, cost: 0 });
    // loyalty (mart_loyalty): the customer is a member by their phone; points used were taken at order time
    const loy = kit.loyalty.on(ctx) && kit.loyalty.rules(s).online;
    const member = loy ? (o.member_id ? await M.MartMember.findOne({ _id: o.member_id, business_id: ctx.business._id }) : await kit.loyalty.memberFor(ctx, { member_phone: o.phone, member_name: o.name }, { create: true })) : null;
    const seq = await M.MartSettings.findOneAndUpdate({ _id: s._id }, { $inc: { next_no: 1 } }, { returnDocument: "before" }).lean();
    const sale = await M.MartSale.create({
      business_id: ctx.business._id,
      no: `S-${String(seq?.next_no || 1).padStart(6, "0")}`,
      items: lines,
      subtotal: o.subtotal + (o.delivery_fee || 0),
      discount: 0,
      promo_discount: o.promo_discount || 0,
      promos: o.promos?.length ? o.promos : undefined,
      coupon: o.coupon || "",
      points_used: o.points_used || 0,
      points_value: o.points_value || 0,
      member_id: member ? member._id : null,
      member_name: member ? member.name || o.name : "",
      member_phone: member ? member.phone : "",
      total: o.total,
      currency: o.currency,
      khr_rate: s.khr_rate,
      method,
      order_id: o._id,
      order_no: o.no,
      paid_usd: method === "cash" && o.currency === "USD" ? o.total : 0, // cash brought back goes in the drawer
      paid_khr: method === "cash" && o.currency === "KHR" ? o.total : 0,
      change: 0,
      change_khr: 0,
      at: new Date(),
      by: ctx.by,
      staff_id: ctx.staff?._id || null,
      device_id: ctx.device?._id || null,
    });
    o.sale_id = sale._id;
    o.sale_no = sale.no;
    await o.save();
    if (member) {
      const got = await kit.loyalty.afterSale(ctx, member, { ...sale.toObject(), total: Math.max(0, o.total - (o.delivery_fee || 0)) }, { order: o }); // points on the goods, not the delivery
      if (got) sale.points_earned = got.earned;
    }
    res.json({ success: true, data: orderOut(o.toObject()), sale, message: MSG.saved });
  });
  both("post", "/orders/:oid/decline", true, async (ctx, req, res) => {
    const reason = text(req.body || {}, "reason", 200) || "";
    const o = await step(ctx, req.params.oid, M.OPEN_ORDER, "declined", { reason });
    await giveBack(ctx, o);
    await kit.loyalty.orderRefund(ctx.business._id, o, ctx.by); // points used come back
    res.json({ success: true, data: orderOut(o.toObject()), message: MSG.saved });
  });
  async function giveBack(ctx, o) {
    if (!o.stock_held) return;
    await stock().giveBack({ ...ctx, addons: { ...ctx.addons, mart_stock: { active: true } } }, asSale(o)); // what was put aside goes back, even if the add-on ended since
    o.stock_held = false;
    await o.save();
  }

  // ---------------------------------------------------------------- customer side (public)
  const P = "/api/public/shop/:slug/account";
  const need = async (req) => {
    const p = await site().liveSite(req.params.slug);
    if (!p) throw new Bad(T.closed, 404);
    if (!p.shopOpen) throw new Bad(T.closed, 403, { code: "closed" });
    return p;
  };
  const sign = (c) => jwt.sign({ type: "mart_cust", cid: String(c._id), bid: String(c.business_id), v: c.pass_v || 0 }, process.env.JWT_SECRET, { expiresIn: `${TOKEN_DAYS}d` });
  const who = async (req, p) => {
    let data;
    try {
      data = jwt.verify(String(req.headers["x-mart-cust"] || ""), process.env.JWT_SECRET);
    } catch {
      throw new Bad(T.login, 401, { code: "login" });
    }
    if (data.type !== "mart_cust" || data.bid !== String(p.bid)) throw new Bad(T.login, 401, { code: "login" });
    const c = await M.MartCustomer.findOne({ _id: data.cid, business_id: p.bid });
    if (!c || (c.pass_v || 0) !== data.v) throw new Bad(T.login, 401, { code: "login" });
    if (c.blocked) throw new Bad(T.blocked, 403, { code: "blocked" });
    return c;
  };
  const me = (c) => ({ _id: c._id, name: c.name, phone: c.phone, email: c.email || "", avatar: c.avatar?.url || "", addresses: c.addresses || [], created_date: c.created_date });
  const themeOf = async (p) => {
    const t = p.settings.portal_theme || FREE;
    return t === FREE || (await ownedThemes(p.bid)).includes(t) ? t : FREE;
  };
  const shopRules = (p) => {
    const s = p.settings;
    const qrImg = s.shop_qr_img?.url || s.pay_qr?.url || "";
    const qr = s.shop_qr !== false && !!qrImg;
    const cash = s.shop_cash !== false || !qr;
    return {
      pickup: s.pickup_on !== false || s.delivery_on === false,
      delivery: s.delivery_on !== false,
      delivery_fee: s.delivery_fee || 0,
      min_order: s.min_order || 0,
      pay: { cash, qr, qr_image: qr ? qrImg : "", qr_label: (s.shop_qr_img?.url ? s.shop_qr_label : s.pay_qr_label) || s.shop_qr_label || "" },
      note: s.shop_note || "",
      zones: kit.delivery.publicZones(p), // delivery zones (mart_delivery): pick one, its fee applies
      coupons: !!p.state.addons.mart_promos?.active, // a coupon box at checkout (mart_promos)
    };
  };
  // the website's promotions to show (no coupons — those are secret codes)
  const publicPromos = async (p) =>
    p.state.addons.mart_promos?.active
      ? (await kit.promos.live(p.bid))
          .filter((x) => !x.code && x.where !== "pos")
          .map((x) => ({
            _id: x._id,
            name: x.name,
            kind: x.kind,
            value: x.value,
            buy_qty: x.buy_qty,
            get_qty: x.get_qty,
            target: x.target,
            category_ids: x.category_ids,
            product_ids: x.product_ids,
            min_spend: x.min_spend,
            days: x.days,
            time_from: x.time_from,
            time_to: x.time_to,
            date_from: x.date_from,
            date_to: x.date_to,
          }))
      : [];
  // the price of a cart: promotions (+ coupon), the delivery zone, loyalty points — strict = mistakes are errors (placing the order)
  async function priceOrder(p, c, b, lines, fulfil, { strict = true } = {}) {
    const cur = p.settings.currency || "USD";
    const r = roundOf(cur);
    const rules = shopRules(p);
    const subtotal = r(lines.reduce((a, l) => a + l.total, 0));
    const pctx = { bid: p.bid, settings: p.settings, addons: p.state.addons, by: c.name };
    const errors = [];
    const soft = async (fn, fallback) => {
      if (strict) return fn();
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof Bad)) throw err;
        errors.push({ code: err.extra?.code || "", message: err.message });
        return fallback;
      }
    };
    const promo = await kit.promos.forSale(pctx, lines, { at: new Date(), where: "online", coupon: b.coupon, strict });
    if (!strict && String(b.coupon || "").trim() && promo.coupon !== "ok") {
      if (!promo.coupon) promo.coupon = "invalid"; // promotions are off
      errors.push({ code: `coupon_${promo.coupon}`, message: kit.promos.T.coupon[promo.coupon] || "" });
    }
    let fee = fulfil === "delivery" ? rules.delivery_fee : 0;
    let zone = null;
    if (fulfil === "delivery") {
      const z = await soft(async () => kit.delivery.zoneFor(p, String(b.zone || ""), subtotal), kit.delivery.zoneFor(p, String(b.zone || ""), subtotal, { strict: false }));
      if (z) {
        zone = z.zone;
        fee = z.fee;
      }
    }
    const loyalty = await kit.loyalty.forCustomer(p, c);
    let member = null;
    let pts = { points: 0, value: 0 };
    if (loyalty && Number(b.points) > 0) {
      member = await kit.loyalty.memberFor(pctx, { member_phone: c.phone, member_name: c.name }, { create: false });
      if (member) pts = await soft(async () => kit.loyalty.redeemOf(pctx, member, b.points, { left: subtotal - promo.discount }), pts);
      else if (strict) throw new Bad(kit.loyalty.T.notEnough, 400, { code: "not_enough" });
    }
    const total = r(Math.max(0, subtotal - promo.discount - pts.value) + fee);
    return { subtotal, promo, fee, zone, member, pts, total, loyalty, errors };
  }
  prop.app.get(
    P,
    handle(async (req, res) => {
      const p = await site().liveSite(req.params.slug);
      if (!p) throw new Bad(T.closed, 404);
      const cat = p.shopOpen ? await site().catalogOf(p, { full: true }) : { categories: [], products: [] };
      res.json({
        success: true,
        data: {
          open: p.shopOpen,
          theme: await themeOf(p),
          color: p.settings.portal_color || "",
          slug: p.site.slug,
          site_theme: p.site.theme || "classic",
          site_color: p.site.color || "",
          business: { name: p.business.name, logo: p.business.logo_url || "", phone: p.business.phone || "", address: p.business.address || "" },
          hours: p.site.hours || "",
          map_url: p.site.map_url || "",
          telegram: p.site.telegram || "",
          cover: p.site.cover?.url || "",
          currency: p.settings.currency || "USD",
          khr_rate: p.settings.khr_rate || 4100,
          rules: shopRules(p),
          promos: p.shopOpen ? await publicPromos(p) : [],
          categories: cat.categories,
          products: cat.products,
        },
      });
    }),
  );
  const authLimit = rate_limit({ windowMs: 15 * 60 * 1000, max: 20 });
  const readPass = (b) => {
    const password = String(b.password || "");
    if (password.length < 6 || password.length > 100) throw new Bad(T.weakPass, 400, { code: "weak_pass" });
    if (b.confirm !== undefined && String(b.confirm) !== password) throw new Bad(T.noMatch, 400, { code: "no_match" });
    return password;
  };
  prop.app.post(
    `${P}/register`,
    authLimit,
    handle(async (req, res) => {
      const p = await need(req);
      const b = req.body || {};
      if (b.website) return res.status(201).json({ success: true }); // bots fill every field
      const name = text(b, "name", 80, { required: true });
      const email = String(b.email || "")
        .trim()
        .toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 120) throw new Bad(T.badEmail, 400, { code: "bad_email" });
      const phone = phoneKey(b.phone);
      if (!phoneOk(phone)) throw new Bad(T.badPhone, 400, { code: "bad_phone" });
      const password = readPass(b);
      if (await M.MartCustomer.exists({ business_id: p.bid, email })) throw new Bad(T.emailTaken, 409, { code: "email_taken" });
      if (await M.MartCustomer.exists({ business_id: p.bid, phone })) throw new Bad(T.phoneTaken, 409, { code: "phone_taken" });
      let c;
      try {
        c = await M.MartCustomer.create({ business_id: p.bid, name, email, phone, password: await bcrypt.hash(password, 10), last_login: new Date() });
      } catch (err) {
        if (err.code === 11000) throw new Bad(JSON.stringify(err.keyPattern || {}).includes("email") ? T.emailTaken : T.phoneTaken, 409, { code: JSON.stringify(err.keyPattern || {}).includes("email") ? "email_taken" : "phone_taken" });
        throw err;
      }
      res.status(201).json({ success: true, data: { token: sign(c), customer: me(c) } });
    }),
  );
  prop.app.post(
    `${P}/login`,
    authLimit,
    handle(async (req, res) => {
      const p = await need(req);
      // one box: email or phone
      const login = String(req.body?.login ?? req.body?.email ?? req.body?.phone ?? "").trim();
      const phone = phoneKey(login);
      const c = login.includes("@") ? await M.MartCustomer.findOne({ business_id: p.bid, email: login.toLowerCase() }) : phoneOk(phone) ? await M.MartCustomer.findOne({ business_id: p.bid, phone }) : null;
      if (!c || !(await bcrypt.compare(String(req.body?.password || ""), c.password))) throw new Bad(T.badLogin, 401, { code: "bad_login" });
      if (c.blocked) throw new Bad(T.blocked, 403, { code: "blocked" });
      c.last_login = new Date();
      await c.save();
      res.json({ success: true, data: { token: sign(c), customer: me(c) } });
    }),
  );
  prop.app.get(
    `${P}/me`,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      res.json({ success: true, data: { ...me(c), loyalty: await kit.loyalty.forCustomer(p, c) } });
    }),
  );
  const readAddresses = (list) => {
    if (!Array.isArray(list) || list.length > 5) throw new Bad(`${MSG.badValue} (addresses)`);
    return list.map((a) => {
      const x = a || {};
      return { label: text(x, "label", 40) || "", address: text(x, "address", 300, { required: true }), note: text(x, "note", 200) || "", map: text(x, "map", 300) || "" };
    });
  };
  prop.app.put(
    `${P}/me`,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      const b = req.body || {};
      const name = text(b, "name", 80);
      if (name) c.name = name;
      if (b.addresses !== undefined) c.addresses = readAddresses(b.addresses);
      if (b.phone !== undefined) {
        const phone = phoneKey(b.phone);
        if (!phoneOk(phone)) throw new Bad(T.badPhone, 400, { code: "bad_phone" });
        if (phone !== c.phone && (await M.MartCustomer.exists({ business_id: p.bid, phone, _id: { $ne: c._id } }))) throw new Bad(T.phoneTaken, 409, { code: "phone_taken" });
        c.phone = phone;
      }
      if (b.email !== undefined) {
        const email = String(b.email || "")
          .trim()
          .toLowerCase();
        if (email !== (c.email || "")) {
          if (!EMAIL_RE.test(email) || email.length > 120) throw new Bad(T.badEmail, 400, { code: "bad_email" });
          if (!(await bcrypt.compare(String(b.password || ""), c.password))) throw new Bad(T.needPass, 400, { code: "old_pass" }); // a new email is a new login
          if (await M.MartCustomer.exists({ business_id: p.bid, email, _id: { $ne: c._id } })) throw new Bad(T.emailTaken, 409, { code: "email_taken" });
          c.email = email;
        }
      }
      await c.save();
      res.json({ success: true, data: me(c), message: MSG.saved });
    }),
  );
  // the customer's profile photo
  const withPhoto = (req, res, next) =>
    upload.single("photo")(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? T.badImage : err.message });
      next();
    });
  prop.app.post(
    `${P}/me/avatar`,
    authLimit,
    withPhoto,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      if (!req.file) throw new Bad(MSG.noFile);
      const saved = await uploadBuffer(req.file, "mart/customers");
      const old = c.avatar?.public_id;
      c.avatar = { url: saved.url, public_id: saved.public_id || "" };
      await c.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: me(c), message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${P}/me/avatar`,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      const old = c.avatar?.public_id;
      c.avatar = { url: "", public_id: "" };
      await c.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: me(c), message: MSG.deleted });
    }),
  );
  prop.app.post(
    `${P}/me/password`,
    authLimit,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      if (!(await bcrypt.compare(String(req.body?.old || ""), c.password))) throw new Bad(T.oldPass, 400, { code: "old_pass" });
      c.password = await bcrypt.hash(readPass(req.body || {}), 10);
      c.pass_v = (c.pass_v || 0) + 1;
      await c.save();
      res.json({ success: true, data: { token: sign(c) }, message: MSG.saved });
    }),
  );
  const mine = async (p, c) => (await M.MartOrder.find({ business_id: p.bid, customer_id: c._id }).sort({ created_date: -1 }).limit(100).lean()).map(orderOut);
  prop.app.get(
    `${P}/orders`,
    handle(async (req, res) => {
      const p = await need(req);
      res.json({ success: true, data: await mine(p, await who(req, p)) });
    }),
  );
  const orderLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 15 });
  const withProof = (req, res, next) =>
    upload.single("proof")(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? T.badImage : err.message });
      next();
    });
  // the price of the cart before ordering: promotions, coupon, delivery zone, points (nothing is saved)
  //   POST /account/quote { items: [{ product_id, qty }], fulfil, zone, coupon, points }
  prop.app.post(
    `${P}/quote`,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      const b = req.body || {};
      const cur = p.settings.currency || "USD";
      const r = roundOf(cur);
      const items = Array.isArray(b.items) ? b.items.slice(0, MAX_LINES) : [];
      const cat = await site().catalogOf(p, { full: true });
      const byId = new Map(cat.products.map((x) => [String(x._id), x]));
      const qty = new Map();
      for (const it of items) {
        const id = String(it?.product_id || "");
        const n = Math.floor(Number(it?.qty) || 0);
        if (byId.has(id) && n > 0) qty.set(id, Math.min(999, (qty.get(id) || 0) + n));
      }
      const lines = [...qty.entries()].map(([id, n]) => {
        const x = byId.get(id);
        return { product_id: x._id, name: x.name, price: x.price, qty: n, total: r(x.price * n) };
      });
      const fulfil = b.fulfil === "delivery" ? "delivery" : "pickup";
      const q = await priceOrder(p, c, b, lines, fulfil, { strict: false });
      res.json({
        success: true,
        data: {
          subtotal: q.subtotal,
          promo_discount: q.promo.discount,
          promos: q.promo.applied,
          coupon: q.promo.coupon,
          coupon_message: q.promo.coupon && q.promo.coupon !== "ok" ? kit.promos.T.coupon[q.promo.coupon] || "" : "",
          delivery_fee: q.fee,
          zone: q.zone ? { key: q.zone.key, name: q.zone.name, fee: q.zone.fee, min_order: q.zone.min_order, eta: q.zone.eta } : null,
          points_used: q.pts.points,
          points_value: q.pts.value,
          loyalty: q.loyalty,
          earn: q.loyalty ? kit.loyalty.earnOf({ settings: p.settings }, Math.max(0, q.total - q.fee)) : 0,
          total: q.total,
          errors: q.errors,
        },
      });
    }),
  );
  prop.app.post(
    `${P}/orders`,
    orderLimit,
    withProof,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      const b = req.body || {};
      const rules = shopRules(p);
      const cur = p.settings.currency || "USD";
      const r = roundOf(cur);
      const fmt = (v) => (cur === "KHR" ? `${Math.round(v).toLocaleString("en-US")}៛` : `$${v.toFixed(2)}`);
      // the cart: [{ product_id, qty }] (sent as JSON text with the screenshot)
      let items = b.items;
      if (typeof items === "string") {
        try {
          items = JSON.parse(items);
        } catch {
          items = null;
        }
      }
      if (!Array.isArray(items) || !items.length) throw new Bad(T.empty, 400, { code: "empty" });
      if (items.length > MAX_LINES) throw new Bad(MSG.tooMany);
      const qty = new Map();
      for (const it of items) {
        const id = String(it?.product_id || "");
        const n = Number(it?.qty);
        if (!validId(id) || !Number.isInteger(n) || n < 1 || n > 999) throw new Bad(`${MSG.badValue} (items)`);
        qty.set(id, (qty.get(id) || 0) + n);
      }
      const fulfil = b.fulfil === "delivery" ? "delivery" : "pickup";
      if (fulfil === "pickup" && !rules.pickup) throw new Bad(T.noPickup, 400, { code: "no_pickup" });
      if (fulfil === "delivery" && !rules.delivery) throw new Bad(T.noDelivery, 400, { code: "no_delivery" });
      const address = fulfil === "delivery" ? { address: text(b, "address", 300) || "", note: text(b, "address_note", 200) || "", map: text(b, "map", 300) || "" } : { address: "", note: "", map: "" };
      if (fulfil === "delivery" && !address.address) throw new Bad(T.needAddress, 400, { code: "need_address" });
      const method = b.pay_method === "qr" ? "qr" : "cash";
      if (method === "cash" && !rules.pay.cash) throw new Bad(T.noCash, 400, { code: "no_cash" });
      if (method === "qr" && !rules.pay.qr) throw new Bad(T.noQr, 400, { code: "no_qr" });
      if (method === "qr" && !req.file) throw new Bad(T.needProof, 400, { code: "need_proof" });
      if ((await M.MartOrder.countDocuments({ business_id: p.bid, customer_id: c._id, status: "new" })) >= MAX_OPEN) throw new Bad(T.tooMany, 429, { code: "too_many" });
      // prices + names come from the shop, never from the customer
      const cat = await site().catalogOf(p, { full: true });
      const byId = new Map(cat.products.map((x) => [String(x._id), x]));
      if ([...qty.keys()].some((id) => !byId.has(id))) throw new Bad(T.gone, 409, { code: "gone" });
      if (p.state.addons.mart_stock?.active) {
        const tracked = await M.MartProduct.find({ business_id: p.bid, _id: { $in: [...qty.keys()] }, track_stock: true })
          .select("name stock")
          .lean();
        for (const x of tracked) if (x.stock < qty.get(String(x._id))) throw new Bad(T.soldout.replace("{name}", x.name).replace("{left}", Math.max(0, x.stock)), 409, { code: "stock", product_id: x._id, left: Math.max(0, x.stock) });
      }
      const lines = [...qty.entries()].map(([id, n]) => {
        const x = byId.get(id);
        return { product_id: x._id, name: x.name, price: x.price, qty: n, total: r(x.price * n), unit_en: x.unit_en, unit_km: x.unit_km, photo: x.photo };
      });
      const subtotal = r(lines.reduce((a, l) => a + l.total, 0));
      if (rules.min_order > 0 && subtotal < rules.min_order) throw new Bad(T.minOrder.replace("{amt}", fmt(rules.min_order)), 400, { code: "min_order", min: rules.min_order });
      const price = await priceOrder(p, c, b, lines, fulfil);
      const fee = price.fee;
      const seq = await M.MartSettings.findOneAndUpdate({ _id: p.settings._id }, { $inc: { next_order: 1 } }, { returnDocument: "before" }).lean();
      const order = await M.MartOrder.create({
        business_id: p.bid,
        no: isOrderNo(seq?.next_order || 1),
        customer_id: c._id,
        name: c.name,
        phone: c.phone,
        items: lines,
        subtotal,
        delivery_fee: fee,
        promo_discount: price.promo.discount,
        promos: price.promo.applied.length ? price.promo.applied.map((x) => ({ id: x.id, name: x.name, amount: x.amount })) : undefined,
        coupon:
          price.promo.coupon === "ok"
            ? String(b.coupon || "")
                .trim()
                .toUpperCase()
            : "",
        points_used: price.pts.points,
        points_value: price.pts.value,
        member_id: price.member ? price.member._id : null,
        zone_key: price.zone?.key || "",
        zone_name: price.zone?.name || "",
        total: price.total,
        currency: cur,
        fulfil,
        address,
        note: text(b, "note", 500) || "",
        pay_method: method,
        pay_proof: method === "qr" ? await uploadBuffer(req.file, "mart/proofs").then((x) => ({ url: x.url, public_id: x.public_id })) : { url: "", public_id: "" },
        timeline: [{ status: "new", at: new Date(), by: c.name }],
      });
      if (price.member && price.pts.points > 0) await kit.loyalty.orderTake(p, price.member, order);
      await kit.promos.used(price.promo.applied);
      await kit.tg?.soon(kit.tg.alert(p.bid, "new_order", { order: order.toObject() }, { settings: p.settings, addons: p.state.addons, name: p.business.name })); // Telegram (mart_telegram)
      // remember a new delivery address for next time
      if (fulfil === "delivery" && !c.addresses.some((a) => a.address === address.address) && c.addresses.length < 5) {
        c.addresses.push({ label: "", ...address });
        await c.save();
      }
      res.status(201).json({ success: true, data: await mine(p, c), message: T.sent });
    }),
  );
  prop.app.post(
    `${P}/orders/:oid/cancel`,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      if (!validId(req.params.oid)) throw new Bad(MSG.badId);
      const row = await M.MartOrder.findOneAndUpdate(
        { _id: req.params.oid, business_id: p.bid, customer_id: c._id, status: "new" },
        { $set: { status: "cancelled", reason: text(req.body || {}, "reason", 200) || "" }, $push: { timeline: { status: "cancelled", at: new Date(), by: c.name } } },
        { returnDocument: "after" },
      );
      if (!row) {
        if (!(await M.MartOrder.exists({ _id: req.params.oid, business_id: p.bid, customer_id: c._id }))) throw new Bad(MSG.rowNotFound, 404);
        throw new Bad(T.cantCancel, 409, { code: "cant_cancel" });
      }
      await kit.loyalty.orderRefund(p.bid, row, c.name);
      res.json({ success: true, data: await mine(p, c), message: MSG.saved });
    }),
  );
};
