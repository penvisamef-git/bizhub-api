// Customer accounts (gh_customers, 200 coins a year — needs the Website add-on): guests sign up on the website,
// see free rooms (with deals) and ask for a booking; the desk POS or the owner accepts it (and picks the room) or declines.
// 6 dashboard looks: classic free, the others bought one by one (gh_portal_theme, 25 coins, forever).
// Owner (/api/user/businesses/:id/guesthouse):
//   GET  /portal                    add-on + looks + settings + counts        PUT /portal { portal_on, theme, note }
//   POST /portal-themes/:theme      buy a look
//   GET  /customers?q=&page=        GET /customers/:cid (all details + every booking)        PUT /customers/:cid { blocked }
// Owner + desk POS (/api/ghpos/...):
//   GET  /cust-requests?status=pending|all&page=     GET /cust-requests/count  (the POS polls this; it rings while > 0)
//   GET  /cust-requests/:rid/rooms  free rooms for it      POST /cust-requests/:rid/accept { room_id }      POST /cust-requests/:rid/decline { reason }
// Customer (/api/public/stay/:slug/account, header x-gh-cust: <token>):
//   GET  /                info (open? look, business, rooms + deals)       POST /register { name, phone, email, password, confirm }
//   POST /login { email, password }      GET /me      PUT /me { name, phone, email (+ password to change it) }      POST /me/password { old, password, confirm }
//   GET  /free?from&to    GET /calendar?from (14 days × room types)
//   GET  /bookings        POST /bookings { type_id, from, to, adults, children, note }      POST /bookings/:bid/cancel
const bcrypt = require("bcrypt");
const multer = require("multer");
const { uploadBuffer } = require("../../util/cloudinary");
const License = require("../../license/license.model");
const Customer = require("../../user/customer.model");
const { buy } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { rate_limit } = require("../../util/rate_limit");
const D = require("./guesthouse.deals");
const { livePromos } = require("./guesthouse.promos");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_DAYS = 30;
const MAX_OPEN = 5; // pending requests a customer can have at once
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});
const localDay = (t = Date.now()) => new Date(t + 7 * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const nightsOf = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const isId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, posCtx, settingsOf, licenseState, Bad, MSG, text, num, bool, Business, jwt, billOf } = kit;
  const M = kit.M;
  const T = {
    needWebsite: "សូមដោះសោ “គេហទំព័រ” ជាមុនសិន ទើបអាចបើកគណនីអតិថិជនបាន!",
    needAddon: "សូមដោះសោ “គណនីអតិថិជន” ជាមុនសិន!",
    closed: "ការចុះឈ្មោះមិនទាន់បើកទេ។",
    badEmail: "អ៊ីមែលមិនត្រឹមត្រូវ!",
    badPhone: "លេខទូរស័ព្ទមិនត្រឹមត្រូវ!",
    weakPass: "ពាក្យសម្ងាត់ត្រូវមានយ៉ាងហោចណាស់ 6 តួ",
    noMatch: "ពាក្យសម្ងាត់ទាំងពីរមិនដូចគ្នា!",
    needPass: "សូមបញ្ចូលពាក្យសម្ងាត់បច្ចុប្បន្ន ដើម្បីប្តូរអ៊ីមែល",
    emailTaken: "អ៊ីមែលនេះបានចុះឈ្មោះរួចហើយ — សូមចូលគណនី",
    badLogin: "អ៊ីមែល ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ!",
    blocked: "គណនីនេះត្រូវបានបិទ។ សូមទាក់ទងផ្ទះសំណាក់។",
    login: "សូមចូលគណនីម្តងទៀត",
    badDates: "សូមជ្រើសថ្ងៃចូល និងថ្ងៃចេញឲ្យត្រឹមត្រូវ",
    noRoom: "បន្ទប់ប្រភេទនេះពេញសម្រាប់ថ្ងៃទាំងនោះ",
    tooMany: `អ្នកមានសំណើកំពុងរង់ចាំ ${MAX_OPEN} រួចហើយ`,
    notPending: "សំណើនេះត្រូវបានដោះស្រាយរួចហើយ",
    roomTaken: "បន្ទប់នេះមិនទំនេរសម្រាប់ថ្ងៃទាំងនោះទេ",
    wrongType: "បន្ទប់នេះមិនមែនប្រភេទដែលបានស្នើ",
    cantCancel: "មិនអាចបោះបង់បានទេ — សូមទាក់ទងផ្ទះសំណាក់",
    oldPass: "ពាក្យសម្ងាត់ចាស់មិនត្រឹមត្រូវ!",
    themeLocked: "សូមទិញរចនានេះជាមុនសិន!",
    badTheme: "រចនាមិនត្រឹមត្រូវ!",
    sent: "បានផ្ញើសំណើកក់ហើយ។ ផ្ទះសំណាក់នឹងបញ្ជាក់ឆាប់ៗ។",
    needProof: "សូមភ្ជាប់រូបភាពប្រតិបត្តិការបង់ប្រាក់",
    noQr: "ផ្ទះសំណាក់មិនទាន់មាន QR សម្រាប់បង់ប្រាក់ទេ",
    badImage: "រូបភាពត្រូវជា JPG, PNG ឬ WEBP និងតូចជាង 5MB",
  };
  const FREE_THEME = M.PORTAL_THEMES[0];
  const PAID = M.PORTAL_THEMES.slice(1);
  const ownedThemes = async (bid) => (await License.find({ business_id: bid, product: "gh_portal_theme" }).select("item").lean()).map((r) => r.item).filter((t) => PAID.includes(t));

  // ---------------------------------------------------------------- owner: add-on, looks, settings
  const portalInfo = async (ctx) => {
    const bid = ctx.business._id;
    const [owned, price, themePrice, customers, pending, site] = await Promise.all([
      ownedThemes(bid),
      priceOf("gh_customers"),
      priceOf("gh_portal_theme"),
      M.GhCustomer.countDocuments({ business_id: bid }),
      M.GhCustBooking.countDocuments({ business_id: bid, status: "pending" }),
      M.GhSite.findOne({ business_id: bid }).select("slug published hero").lean(),
    ]);
    return {
      addon: { ...ctx.addons.gh_customers, price },
      website: !!ctx.addons.gh_website?.active,
      themes: { list: M.PORTAL_THEMES, free: [FREE_THEME], owned, price: themePrice, current: ctx.settings.portal_theme || FREE_THEME },
      portal_on: ctx.settings.portal_on !== false,
      note: ctx.settings.portal_note || "",
      counts: { customers, pending },
      site: { slug: site?.slug || "", published: !!site?.published, cover: site?.hero?.image?.url || "" },
    };
  };
  prop.app.get(
    `${base}/portal`,
    ...guard,
    handle(async (req, res) => res.json({ success: true, data: await portalInfo(await ctxOf(req, false)) })),
  );
  prop.app.put(
    `${base}/portal`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      if (b.theme !== undefined) {
        if (!M.PORTAL_THEMES.includes(b.theme)) throw new Bad(T.badTheme);
        if (b.theme !== FREE_THEME && !(await ownedThemes(ctx.business._id)).includes(b.theme)) throw new Bad(T.themeLocked, 402, { product: "gh_portal_theme", item: b.theme });
        ctx.settings.portal_theme = b.theme;
      }
      const on = bool(b, "portal_on");
      if (on !== undefined) ctx.settings.portal_on = on;
      const note = text(b, "note", 300);
      if (note !== undefined) ctx.settings.portal_note = note;
      await ctx.settings.save();
      res.json({ success: true, data: await portalInfo(ctx), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${base}/portal-themes/:theme`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const theme = req.params.theme;
      if (!PAID.includes(theme)) throw new Bad(T.badTheme);
      const r = await buy({ customer: req.customer, business: ctx.business, product: "gh_portal_theme", item: theme, expect: null });
      ctx.settings.portal_theme = theme;
      await ctx.settings.save();
      res.json({ success: true, data: await portalInfo(ctx), charged: r.charged, balance: r.balance, message: MSG.saved });
    }),
  );
  prop.app.get(
    `${base}/customers`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
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
        M.GhCustomer.find(filter)
          .sort({ created_date: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .select("-password")
          .lean(),
        M.GhCustomer.countDocuments(filter),
      ]);
      const counts = await M.GhCustBooking.aggregate([
        { $match: { business_id: bid, customer_id: { $in: rows.map((r) => r._id) } } },
        { $group: { _id: "$customer_id", n: { $sum: 1 }, ok: { $sum: { $cond: [{ $eq: ["$status", "accepted"] }, 1, 0] } } } },
      ]);
      const by = new Map(counts.map((c) => [String(c._id), c]));
      res.json({
        success: true,
        data: rows.map((r) => ({ ...r, requests: by.get(String(r._id))?.n || 0, accepted: by.get(String(r._id))?.ok || 0 })),
        pagination: { total, totalPages: Math.max(1, Math.ceil(total / limit)), currentPage: page, pageSize: limit },
      });
    }),
  );
  // one customer: everything about them + every booking they asked for (with the real booking's bill)
  prop.app.get(
    `${base}/customers/:cid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      if (!isId(req.params.cid)) throw new Bad(MSG.badId);
      const c = await M.GhCustomer.findOne({ _id: req.params.cid, business_id: ctx.business._id }).select("-password").lean();
      if (!c) throw new Bad(MSG.rowNotFound, 404);
      const bookings = await myBookings({ bid: ctx.business._id, settings: ctx.settings }, c, true);
      const live = bookings.filter((b) => b.stay && !["cancelled", "no_show"].includes(b.state));
      res.json({
        success: true,
        data: {
          customer: c,
          bookings,
          stats: {
            requests: bookings.length,
            pending: bookings.filter((b) => b.state === "pending").length,
            accepted: bookings.filter((b) => b.status === "accepted").length,
            declined: bookings.filter((b) => b.state === "declined").length,
            cancelled: bookings.filter((b) => b.state === "cancelled").length,
            nights: bookings.filter((b) => ["staying", "done"].includes(b.state)).reduce((a, b) => a + b.nights, 0),
            spent: Math.round(live.reduce((a, b) => a + (b.stay?.paid || 0), 0) * 100) / 100,
            owed: Math.round(live.reduce((a, b) => a + Math.max(0, b.stay?.balance || 0), 0) * 100) / 100,
          },
        },
      });
    }),
  );
  prop.app.put(
    `${base}/customers/:cid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!isId(req.params.cid)) throw new Bad(MSG.badId);
      const row = await M.GhCustomer.findOne({ _id: req.params.cid, business_id: ctx.business._id });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      const blocked = bool(req.body || {}, "blocked");
      if (blocked !== undefined) {
        row.blocked = blocked;
        if (blocked) row.pass_v += 1; // logs them out
      }
      await row.save();
      const out = row.toObject();
      delete out.password;
      res.json({ success: true, data: out, message: MSG.saved });
    }),
  );

  // ---------------------------------------------------------------- owner + desk: requests
  // registered for the owner (/api/user/businesses/:id/guesthouse/...) and the desk POS (/api/ghpos/...)
  function both(method, path, write, fn) {
    prop.app[method](
      `${base}${path}`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, write);
        ctx.by = req.customer?.name || "owner";
        await fn(ctx, req, res);
      }),
    );
    prop.app[method](
      `/api/ghpos${path}`,
      prop.api_auth,
      handle(async (req, res) => fn(await posCtx(req, write), req, res)),
    );
  }
  const reqOut = async (bid, rows) => {
    const custs = new Map(
      (
        await M.GhCustomer.find({ business_id: bid, _id: { $in: rows.map((r) => r.customer_id) } })
          .select("name phone email")
          .lean()
      ).map((c) => [String(c._id), c]),
    );
    const stays = new Map(
      (
        await M.GhStay.find({ business_id: bid, _id: { $in: rows.map((r) => r.stay_id).filter(Boolean) } })
          .select("no status room_id")
          .lean()
      ).map((s) => [String(s._id), s]),
    );
    const rooms = new Map((await M.GhRoom.find({ business_id: bid }).select("name").lean()).map((r) => [String(r._id), r.name]));
    return rows.map((r) => {
      const st = r.stay_id ? stays.get(String(r.stay_id)) : null;
      return { ...r, nights: nightsOf(r.from, r.to), customer: custs.get(String(r.customer_id)) || null, stay: st ? { _id: st._id, no: st.no, status: st.status, room: rooms.get(String(st.room_id)) || "" } : null };
    });
  };
  both("get", "/cust-requests/count", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const [pending, latest] = await Promise.all([M.GhCustBooking.countDocuments({ business_id: bid, status: "pending" }), M.GhCustBooking.findOne({ business_id: bid, status: "pending" }).sort({ created_date: -1 }).select("created_date").lean()]);
    res.json({ success: true, data: { pending, latest: latest?.created_date || null, on: !!ctx.addons.gh_customers?.active } });
  });
  both("get", "/cust-requests", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
    const limit = 20;
    const filter = { business_id: bid, ...(M.REQUEST_STATUSES.includes(req.query.status) ? { status: req.query.status } : {}) };
    const [rows, total] = await Promise.all([
      M.GhCustBooking.find(filter)
        .sort({ status: -1, created_date: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      M.GhCustBooking.countDocuments(filter),
    ]);
    res.json({ success: true, data: await reqOut(bid, rows), pagination: { total, totalPages: Math.max(1, Math.ceil(total / limit)), currentPage: page, pageSize: limit } });
  });
  const loadReq = async (ctx, rid) => {
    if (!isId(rid)) throw new Bad(MSG.badId);
    const row = await M.GhCustBooking.findOne({ _id: rid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  const freeRooms = async (bid, from, to, typeId) => {
    const [rooms, stays] = await Promise.all([
      M.GhRoom.find({ business_id: bid, active: true, ...(typeId ? { type_id: typeId } : {}) })
        .sort({ sort: 1, name: 1 })
        .lean(),
      M.GhStay.find({ business_id: bid, status: { $in: M.LIVE }, from: { $lt: to }, to: { $gt: from } })
        .select("room_id")
        .lean(),
    ]);
    const busy = new Set(stays.map((s) => String(s.room_id)));
    return rooms.filter((r) => !busy.has(String(r._id)));
  };
  both("get", "/cust-requests/:rid/rooms", false, async (ctx, req, res) => {
    const row = await loadReq(ctx, req.params.rid);
    const free = await freeRooms(ctx.business._id, row.from, row.to, row.type_id);
    res.json({ success: true, data: free.map((r) => ({ _id: r._id, name: r.name, floor: r.floor || "" })) });
  });
  both("post", "/cust-requests/:rid/accept", true, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const row = await loadReq(ctx, req.params.rid);
    if (row.status !== "pending") throw new Bad(T.notPending, 409, { code: "not_pending" });
    const roomId = String(req.body?.room_id || "");
    if (!isId(roomId)) throw new Bad(MSG.badId);
    const room = await M.GhRoom.findOne({ _id: roomId, business_id: bid, active: true }).lean();
    if (!room) throw new Bad(MSG.rowNotFound, 404);
    if (String(room.type_id) !== String(row.type_id) && req.body?.any_type !== true) throw new Bad(T.wrongType, 409, { code: "wrong_type" });
    if (!(await freeRooms(bid, row.from, row.to)).some((r) => String(r._id) === roomId)) throw new Bad(T.roomTaken, 409, { code: "taken" });
    const cust = await M.GhCustomer.findOne({ _id: row.customer_id, business_id: bid }).lean();
    // the request moves first, so two people pressing accept can't make two bookings
    const claimed = await M.GhCustBooking.findOneAndUpdate({ _id: row._id, status: "pending" }, { $set: { status: "accepted", decided_by: ctx.by, decided_at: new Date() } }, { returnDocument: "after" });
    if (!claimed) throw new Bad(T.notPending, 409, { code: "not_pending" });
    const counter = await M.GhSettings.findOneAndUpdate({ business_id: bid }, { $inc: { next_no: 1 } }, { returnDocument: "before" });
    const stay = await M.GhStay.create({
      business_id: bid,
      no: `B-${String(counter.next_no).padStart(4, "0")}`,
      room_id: room._id,
      status: "booked",
      from: row.from,
      to: row.to,
      rate: row.rate || (await M.GhRoomType.findById(row.type_id).lean())?.price || 0,
      guest: { name: cust?.name || "Guest", phone: cust?.phone || "", id_type: "id_card", id_number: "", nationality: "" },
      adults: row.adults || 1,
      children: row.children || 0,
      source: "website",
      customer_id: row.customer_id, // loyalty points (gh_loyalty)
      note: [row.note, cust?.email].filter(Boolean).join(" · ").slice(0, 500),
      // a checked bank / KHQR transfer goes on the bill straight away
      payments: row.pay_method === "qr" && req.body?.record_payment !== false && row.estimate > 0 ? [{ method: (ctx.settings.methods || []).includes("aba") ? "aba" : "bank", amount: row.estimate, note: "online transfer (website)", by: ctx.by }] : [],
      by: ctx.by,
    });
    claimed.stay_id = stay._id;
    claimed.pay_recorded = stay.payments.length > 0;
    await claimed.save();
    res.json({ success: true, data: (await reqOut(bid, [claimed.toObject()]))[0], stay_id: stay._id, message: MSG.saved });
  });
  both("post", "/cust-requests/:rid/decline", true, async (ctx, req, res) => {
    const row = await loadReq(ctx, req.params.rid);
    if (row.status !== "pending") throw new Bad(T.notPending, 409, { code: "not_pending" });
    row.status = "declined";
    row.reason = text(req.body || {}, "reason", 200) || "";
    row.decided_by = ctx.by;
    row.decided_at = new Date();
    await row.save();
    res.json({ success: true, data: (await reqOut(ctx.business._id, [row.toObject()]))[0], message: MSG.saved });
  });

  // ---------------------------------------------------------------- customer side (public)
  const P = "/api/public/stay/:slug/account";
  async function portalOf(slug) {
    const site = await M.GhSite.findOne({ slug: String(slug || "").toLowerCase(), published: true }).lean();
    if (!site) return null;
    const bid = site.business_id;
    const [business, state, settings] = await Promise.all([Business.findOne({ _id: bid, deleted: false }).select("owner_id status name logo_url phone address").lean(), licenseState(bid), settingsOf(bid)]);
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business?.status || !owner?.status || state.license.locked || !state.addons.gh_website?.active) return null;
    const open = !!state.addons.gh_customers?.active && settings.portal_on !== false;
    return { site, bid, business, state, settings, open };
  }
  const need = async (req) => {
    const p = await portalOf(req.params.slug);
    if (!p) throw new Bad(T.closed, 404);
    if (!p.open) throw new Bad(T.closed, 403, { code: "closed" });
    return p;
  };
  const sign = (c) => jwt.sign({ type: "gh_cust", cid: String(c._id), bid: String(c.business_id), v: c.pass_v || 0 }, process.env.JWT_SECRET, { expiresIn: `${TOKEN_DAYS}d` });
  const who = async (req, p) => {
    let data;
    try {
      data = jwt.verify(String(req.headers["x-gh-cust"] || ""), process.env.JWT_SECRET);
    } catch {
      throw new Bad(T.login, 401, { code: "login" });
    }
    if (data.type !== "gh_cust" || data.bid !== String(p.bid)) throw new Bad(T.login, 401, { code: "login" });
    const c = await M.GhCustomer.findOne({ _id: data.cid, business_id: p.bid });
    if (!c || (c.pass_v || 0) !== data.v) throw new Bad(T.login, 401, { code: "login" });
    if (c.blocked) throw new Bad(T.blocked, 403, { code: "blocked" });
    return c;
  };
  const me = (c, p) => ({
    _id: c._id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    created_date: c.created_date,
    last_login: c.last_login,
    ...(p?.state?.addons?.gh_loyalty?.active ? { points: c.points || 0, loyalty: require("./guesthouse.guests").rules(p.settings) } : {}),
  });
  const theme = async (p) => {
    const t = p.settings.portal_theme || FREE_THEME;
    return t === FREE_THEME || (await ownedThemes(p.bid)).includes(t) ? t : FREE_THEME;
  };
  const roomTypes = async (p, day) => {
    const [types, rooms, promos] = await Promise.all([
      M.GhRoomType.find({ business_id: p.bid, active: { $ne: false } })
        .sort({ sort: 1, created_date: 1 })
        .lean(),
      M.GhRoom.find({ business_id: p.bid, active: true }).select("type_id").lean(),
      livePromos(M, p.bid, p.state.addons, day),
    ]);
    const count = {};
    for (const r of rooms) count[String(r.type_id)] = (count[String(r.type_id)] || 0) + 1;
    const pics = new Map((p.site.rooms?.items || []).map((x) => [String(x.type_id), x]));
    return {
      promos,
      types: types
        .filter((t) => count[String(t._id)] && !pics.get(String(t._id))?.hidden)
        .map((t) => {
          const deal = D.nightPrice(promos, t._id, t.price, day, p.settings.currency);
          return {
            _id: String(t._id),
            name: t.name,
            price: t.price,
            capacity: t.capacity || 2,
            beds: t.beds || "",
            amenities: t.amenities || [],
            color: t.color || "",
            rooms: count[String(t._id)],
            text: pics.get(String(t._id))?.text || "",
            image: pics.get(String(t._id))?.images?.[0]?.url || "",
            deal: deal.promo ? { price: deal.price, badge: D.badgeOf(deal.promo, p.settings.currency), name: deal.promo.name, to: deal.promo.to } : null,
          };
        }),
    };
  };
  const readDates = (q, maxNights = 60) => {
    const from = String(q.from || "");
    const to = String(q.to || "");
    if (!DAY_RE.test(from) || !DAY_RE.test(to) || from >= to || from < localDay() || nightsOf(from, to) > maxNights) throw new Bad(T.badDates, 400, { code: "bad_dates" });
    return { from, to };
  };

  prop.app.get(
    P,
    handle(async (req, res) => {
      const p = await portalOf(req.params.slug);
      if (!p) throw new Bad(T.closed, 404);
      const rt = await roomTypes(p, localDay());
      res.json({
        success: true,
        data: {
          open: p.open,
          theme: await theme(p),
          slug: p.site.slug,
          business: { name: p.business.name, logo: p.business.logo_url || "", phone: p.site.contact?.phone || p.business.phone || "", address: p.site.contact?.address || p.business.address || "" },
          currency: p.settings.currency || "USD",
          check_in: p.settings.check_in,
          check_out: p.settings.check_out,
          note: p.settings.portal_note || "",
          pay: { qr: p.settings.pay_qr?.url || "", label: p.settings.pay_qr_label || "", khr_rate: p.settings.khr_rate || 4100, methods: p.settings.pay_qr?.url ? ["cash", "qr"] : ["cash"] },
          cover: p.site.hero?.image?.url || p.settings.cover?.url || "",
          site_color: p.site.color || "",
          types: rt.types,
          promos: rt.promos.map((x) => D.publicPromo(x, p.settings.currency)),
        },
      });
    }),
  );
  const authLimit = rate_limit({ windowMs: 15 * 60 * 1000, max: 20 });
  prop.app.post(
    `${P}/register`,
    authLimit,
    handle(async (req, res) => {
      const p = await need(req);
      const b = req.body || {};
      if (b.website) return res.status(201).json({ success: true }); // bots fill every field
      const name = text(b, "name", 80, { required: true });
      const phone = text(b, "phone", 30, { required: true });
      const email = String(text(b, "email", 120, { required: true }) || "").toLowerCase();
      const password = String(b.password || "");
      if (!EMAIL_RE.test(email)) throw new Bad(T.badEmail);
      if (!/^[+\d][\d\s().-]{5,}$/.test(phone) || phone.replace(/\D/g, "").length < 6) throw new Bad(T.badPhone);
      if (password.length < 6 || password.length > 100) throw new Bad(T.weakPass);
      if (String(b.confirm ?? "") !== password) throw new Bad(T.noMatch, 400, { code: "no_match" });
      if (await M.GhCustomer.exists({ business_id: p.bid, email })) throw new Bad(T.emailTaken, 409, { code: "email_taken" });
      let c;
      try {
        c = await M.GhCustomer.create({ business_id: p.bid, name, phone, email, password: await bcrypt.hash(password, 10), last_login: new Date() });
      } catch (err) {
        if (err.code === 11000) throw new Bad(T.emailTaken, 409, { code: "email_taken" });
        throw err;
      }
      res.status(201).json({ success: true, data: { token: sign(c), customer: me(c, p) } });
    }),
  );
  prop.app.post(
    `${P}/login`,
    authLimit,
    handle(async (req, res) => {
      const p = await need(req);
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();
      const c = EMAIL_RE.test(email) ? await M.GhCustomer.findOne({ business_id: p.bid, email }) : null;
      if (!c || !(await bcrypt.compare(String(req.body?.password || ""), c.password))) throw new Bad(T.badLogin, 401, { code: "bad_login" });
      if (c.blocked) throw new Bad(T.blocked, 403, { code: "blocked" });
      c.last_login = new Date();
      await c.save();
      res.json({ success: true, data: { token: sign(c), customer: me(c, p) } });
    }),
  );
  prop.app.get(
    `${P}/me`,
    handle(async (req, res) => {
      const p = await need(req);
      res.json({ success: true, data: me(await who(req, p), p) });
    }),
  );
  // loyalty points: balance + history (gh_loyalty)
  prop.app.get(
    `${P}/points`,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      if (!p.state.addons.gh_loyalty?.active) return res.json({ success: true, data: { on: false } });
      const rows = await M.GhPointTx.find({ business_id: p.bid, customer_id: c._id }).sort({ created_date: -1 }).limit(100).lean();
      res.json({ success: true, data: { on: true, points: c.points || 0, rules: require("./guesthouse.guests").rules(p.settings), history: rows.map((x) => ({ points: x.points, kind: x.kind, note: x.note, at: x.created_date })) } });
    }),
  );
  prop.app.put(
    `${P}/me`,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      const b = req.body || {};
      const name = text(b, "name", 80);
      if (name) c.name = name;
      const phone = text(b, "phone", 30);
      if (phone !== undefined) {
        if (!/^[+\d][\d\s().-]{5,}$/.test(phone) || phone.replace(/\D/g, "").length < 6) throw new Bad(T.badPhone);
        c.phone = phone;
      }
      let token;
      if (b.email !== undefined) {
        const email = String(b.email || "")
          .trim()
          .toLowerCase();
        if (email !== c.email) {
          if (!EMAIL_RE.test(email) || email.length > 120) throw new Bad(T.badEmail);
          // a new email is a new login: the current password must be given
          if (!(await bcrypt.compare(String(b.password || ""), c.password))) throw new Bad(T.needPass, 400, { code: "old_pass" });
          if (await M.GhCustomer.exists({ business_id: p.bid, email, _id: { $ne: c._id } })) throw new Bad(T.emailTaken, 409, { code: "email_taken" });
          c.email = email;
          c.pass_v = (c.pass_v || 0) + 1; // other devices sign in again
          token = true;
        }
      }
      try {
        await c.save();
      } catch (err) {
        if (err.code === 11000) throw new Bad(T.emailTaken, 409, { code: "email_taken" });
        throw err;
      }
      res.json({ success: true, data: me(c, p), ...(token ? { token: sign(c) } : {}), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${P}/me/password`,
    authLimit,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      if (!(await bcrypt.compare(String(req.body?.old || ""), c.password))) throw new Bad(T.oldPass, 400, { code: "old_pass" });
      const password = String(req.body?.password || "");
      if (password.length < 6 || password.length > 100) throw new Bad(T.weakPass);
      if (req.body?.confirm !== undefined && String(req.body.confirm) !== password) throw new Bad(T.noMatch, 400, { code: "no_match" });
      c.password = await bcrypt.hash(password, 10);
      c.pass_v = (c.pass_v || 0) + 1;
      await c.save();
      res.json({ success: true, data: { token: sign(c) }, message: MSG.saved });
    }),
  );
  // free rooms per type + the price with deals
  prop.app.get(
    `${P}/free`,
    handle(async (req, res) => {
      const p = await need(req);
      await who(req, p);
      const { from, to } = readDates(req.query);
      const [rooms, stays, rt] = await Promise.all([
        M.GhRoom.find({ business_id: p.bid, active: true }).select("type_id").lean(),
        M.GhStay.find({ business_id: p.bid, status: { $in: M.LIVE }, from: { $lt: to }, to: { $gt: from } })
          .select("room_id")
          .lean(),
        roomTypes(p, from),
      ]);
      const busy = new Set(stays.map((s) => String(s.room_id)));
      const free = {};
      for (const r of rooms) if (!busy.has(String(r._id))) free[String(r.type_id)] = (free[String(r.type_id)] || 0) + 1;
      res.json({
        success: true,
        data: { from, to, nights: nightsOf(from, to), types: rt.types.map((t) => ({ ...t, free: free[t._id] || 0, ...D.stayPrice(rt.promos, t._id, t.price, from, to, p.settings.currency), nights: undefined })) },
      });
    }),
  );
  // 14 days × room types: how many rooms are free each night
  prop.app.get(
    `${P}/calendar`,
    handle(async (req, res) => {
      const p = await need(req);
      await who(req, p);
      const start = DAY_RE.test(String(req.query.from || "")) && req.query.from >= localDay() ? String(req.query.from) : localDay();
      const end = addDays(start, 14);
      const [rooms, stays, rt] = await Promise.all([
        M.GhRoom.find({ business_id: p.bid, active: true }).select("type_id").lean(),
        M.GhStay.find({ business_id: p.bid, status: { $in: M.LIVE }, from: { $lt: end }, to: { $gt: start } })
          .select("room_id from to")
          .lean(),
        roomTypes(p, start),
      ]);
      const typeOf = new Map(rooms.map((r) => [String(r._id), String(r.type_id)]));
      const days = Array.from({ length: 14 }, (_, i) => addDays(start, i));
      const grid = {};
      for (const t of rt.types) grid[t._id] = days.map(() => t.rooms);
      for (const s of stays) {
        const t = typeOf.get(String(s.room_id));
        if (!grid[t]) continue;
        days.forEach((d, i) => {
          if (s.from <= d && s.to > d) grid[t][i] = Math.max(0, grid[t][i] - 1);
        });
      }
      res.json({
        success: true,
        data: { days, types: rt.types.map((t) => ({ _id: t._id, name: t.name, color: t.color, rooms: t.rooms, free: grid[t._id], prices: days.map((d) => D.nightPrice(rt.promos, t._id, t.price, d, p.settings.currency).price) })) },
      });
    }),
  );
  const myBookings = async (p, c, owner = false) => {
    const rows = await M.GhCustBooking.find({ business_id: p.bid, customer_id: c._id }).sort({ created_date: -1 }).limit(100).lean();
    const stays = new Map((await M.GhStay.find({ business_id: p.bid, _id: { $in: rows.map((r) => r.stay_id).filter(Boolean) } }).lean()).map((s) => [String(s._id), s]));
    const rooms = new Map((await M.GhRoom.find({ business_id: p.bid }).select("name").lean()).map((r) => [String(r._id), r.name]));
    return rows.map((r) => {
      const s = r.stay_id ? stays.get(String(r.stay_id)) : null;
      // what the guest sees: waiting → confirmed (room) → staying → done; or declined / cancelled
      const state = r.status !== "accepted" ? r.status : !s ? "accepted" : s.status === "booked" ? "confirmed" : s.status === "in" ? "staying" : s.status === "out" ? "done" : s.status === "cancelled" ? "cancelled" : "no_show";
      const bill = s ? billOf(s, p.settings.currency) : null;
      return {
        _id: r._id,
        type_name: r.type_name,
        from: r.from,
        to: r.to,
        nights: nightsOf(r.from, r.to),
        adults: r.adults,
        children: r.children,
        note: r.note,
        estimate: r.estimate,
        state,
        reason: r.reason || "",
        created_date: r.created_date,
        decided_at: r.decided_at,
        stay: s ? { no: s.no, room: rooms.get(String(s.room_id)) || "", total: bill.total, paid: bill.paid, balance: bill.balance } : null,
        pay_method: r.pay_method || "cash",
        proof: r.pay_proof?.url || "",
        ...(owner ? { status: r.status, decided_by: r.decided_by || "", stay_id: s ? s._id : null, stay_status: s ? s.status : "" } : {}),
      };
    });
  };
  prop.app.get(
    `${P}/bookings`,
    handle(async (req, res) => {
      const p = await need(req);
      res.json({ success: true, data: await myBookings(p, await who(req, p)) });
    }),
  );
  const bookLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 10 });
  const withProof = (req, res, next) =>
    upload.single("proof")(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? T.badImage : err.message });
      next();
    });
  prop.app.post(
    `${P}/bookings`,
    bookLimit,
    withProof,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      const b = req.body || {};
      const method = b.pay_method === "qr" ? "qr" : "cash";
      if (method === "qr" && !p.settings.pay_qr?.url) throw new Bad(T.noQr, 400, { code: "no_qr" });
      if (method === "qr" && !req.file) throw new Bad(T.needProof, 400, { code: "need_proof" });
      const { from, to } = readDates(b);
      if (!isId(String(b.type_id || ""))) throw new Bad(MSG.badId);
      const type = await M.GhRoomType.findOne({ _id: b.type_id, business_id: p.bid, active: { $ne: false } }).lean();
      if (!type) throw new Bad(MSG.rowNotFound, 404);
      if ((await M.GhCustBooking.countDocuments({ business_id: p.bid, customer_id: c._id, status: "pending" })) >= MAX_OPEN) throw new Bad(T.tooMany, 429);
      if (!(await freeRooms(p.bid, from, to, type._id)).length) throw new Bad(T.noRoom, 409, { code: "full" });
      const price = D.stayPrice(await livePromos(M, p.bid, p.state.addons, from), type._id, type.price, from, to, p.settings.currency);
      await M.GhCustBooking.create({
        business_id: p.bid,
        customer_id: c._id,
        type_id: type._id,
        type_name: type.name,
        from,
        to,
        adults: num(b, "adults", 1, 20, { int: true }) ?? 1,
        children: num(b, "children", 0, 20, { int: true }) ?? 0,
        note: text(b, "note", 500) || "",
        estimate: price.total,
        rate: price.rate,
        pay_method: method,
        pay_proof: method === "qr" ? await uploadBuffer(req.file, "guesthouse/proofs").then((x) => ({ url: x.url, public_id: x.public_id })) : { url: "", public_id: "" },
      });
      const TG = require("./guesthouse.telegram");
      await TG.soon(
        TG.alert(
          p.bid,
          "new_booking",
          {
            request: {
              kind: "account",
              name: c.name,
              contact: c.phone || c.email,
              type_name: type.name,
              from,
              to,
              guests: (num(b, "adults", 1, 20, { int: true }) ?? 1) + (num(b, "children", 0, 20, { int: true }) ?? 0),
              estimate: price.total,
              pay: method,
            },
          },
          { settings: p.settings, addons: p.state.addons, name: p.business.name },
        ),
      );
      res.status(201).json({ success: true, data: await myBookings(p, c), message: T.sent });
    }),
  );
  prop.app.post(
    `${P}/bookings/:rid/cancel`,
    handle(async (req, res) => {
      const p = await need(req);
      const c = await who(req, p);
      if (!isId(req.params.rid)) throw new Bad(MSG.badId);
      const row = await M.GhCustBooking.findOne({ _id: req.params.rid, business_id: p.bid, customer_id: c._id });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      if (row.status === "pending") row.status = "cancelled";
      else if (row.status === "accepted" && row.stay_id) {
        // a confirmed booking can be cancelled before the arrival day
        const stay = await M.GhStay.findOne({ _id: row.stay_id, business_id: p.bid });
        if (!stay || stay.status !== "booked" || stay.from <= localDay()) throw new Bad(T.cantCancel, 409, { code: "cant_cancel" });
        stay.status = "cancelled";
        stay.note = `${stay.note ? `${stay.note} · ` : ""}cancelled by the guest online`.slice(0, 500);
        await stay.save();
        row.status = "cancelled";
      } else throw new Bad(T.cantCancel, 409, { code: "cant_cancel" });
      await row.save();
      res.json({ success: true, data: await myBookings(p, c), message: MSG.saved });
    }),
  );
};
