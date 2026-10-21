// Guest reviews (gh_reviews, yearly) + loyalty points (gh_loyalty, yearly, needs customer accounts)
//
// Reviews: after check-out each stay gets a private link (/r/<token>); the guest gives stars + words;
// 4–5 stars go on the website by themselves (or the owner picks), and the owner can reply.
//   owner:  GET /reviews · PUT /reviews/:rid { shown, reply } · DELETE /reviews/:rid · PUT /reviews-settings { reviews_auto }
//   both:   GET /stays/:sid/review   the stay's review link (made if missing)
//   public: GET|POST /api/public/review/:token
// Loyalty: customer accounts earn points when they pay; points become a discount at the desk.
//   owner:  GET /loyalty · PUT /loyalty { earn, redeem_points, redeem_value } · POST /customers/:cid/points { points, note }
//   both:   GET /members?q= · PUT /stays/:sid/customer { customer_id|null } · POST /stays/:sid/points { points } · DELETE /stays/:sid/points
//   portal: GET /api/public/stay/:slug/account/points
const crypto = require("crypto");
const M = require("./guesthouse.models");

const T = {
  needReviews: "សូមដោះសោ “ការវាយតម្លៃពីភ្ញៀវ” ជាមុនសិន!",
  needLoyalty: "សូមដោះសោ “ពិន្ទុសមាជិក” ជាមុនសិន!",
  done: "អរគុណសម្រាប់ការវាយតម្លៃ!",
  already: "ការវាយតម្លៃនេះបានផ្ញើរួចហើយ។",
  badRating: "សូមជ្រើសផ្កាយ 1–5!",
  noMember: "ការស្នាក់នេះមិនទាន់ភ្ជាប់សមាជិកទេ!",
  notEnough: "ពិន្ទុមិនគ្រប់គ្រាន់!",
  closed: "ការស្នាក់នេះបានបិទហើយ!",
  noBalance: "វិក្កយបត្របានបង់គ្រប់ហើយ!",
};
const token = () => crypto.randomBytes(16).toString("base64url").replace(/[-_]/g, "").slice(0, 20);
const unitOf = (cur) => (cur === "KHR" ? 4000 : 1); // points are earned for each $1 / 4,000៛

// ---------- reviews ----------
async function inviteFor(stay, roomName) {
  const had = await M.GhReview.findOne({ stay_id: stay._id });
  if (had) return had;
  try {
    return await M.GhReview.create({ business_id: stay.business_id, stay_id: stay._id, token: token(), guest_name: stay.guest?.name || "", room_name: roomName || "", from: stay.from, to: stay.to });
  } catch (err) {
    if (err.code === 11000) return M.GhReview.findOne({ stay_id: stay._id });
    throw err;
  }
}
async function publicReviews(bid, addons) {
  if (!addons?.gh_reviews?.active) return null;
  const [rows, stats] = await Promise.all([
    M.GhReview.find({ business_id: bid, shown: true, rating: { $gt: 0 } })
      .sort({ submitted_at: -1 })
      .limit(9)
      .select("guest_name rating text reply submitted_at")
      .lean(),
    M.GhReview.aggregate([{ $match: { business_id: bid, shown: true, rating: { $gt: 0 } } }, { $group: { _id: null, avg: { $avg: "$rating" }, n: { $sum: 1 } } }]),
  ]);
  if (!rows.length) return null;
  const first = (n) =>
    String(n || "Guest")
      .trim()
      .split(/\s+/)[0]; // first name only
  return { avg: Math.round((stats[0]?.avg || 0) * 10) / 10, count: stats[0]?.n || 0, items: rows.map((r) => ({ name: first(r.guest_name), rating: r.rating, text: r.text, reply: r.reply, at: r.submitted_at })) };
}

// ---------- loyalty ----------
const rules = (s) => ({ earn: s.loyalty?.earn ?? 1, redeem_points: s.loyalty?.redeem_points || 100, redeem_value: s.loyalty?.redeem_value ?? 5, unit: unitOf(s.currency) });
// after check-out: reviews link + points for what was paid
async function afterCheckout(ctx, stay, bill) {
  if (ctx.addons.gh_reviews?.active) {
    const room = await M.GhRoom.findById(stay.room_id).select("name").lean();
    await inviteFor(stay, room?.name).catch(() => null);
  }
  if (ctx.addons.gh_loyalty?.active && stay.customer_id && !stay.points_given) {
    const r = rules(ctx.settings);
    const points = Math.floor((Math.max(0, Math.min(bill.paid, bill.total)) / r.unit) * r.earn); // what was really paid for the stay
    if (points > 0) {
      const c = await M.GhCustomer.findOneAndUpdate({ _id: stay.customer_id, business_id: ctx.business._id }, { $inc: { points } }, { returnDocument: "after" });
      if (c) {
        await M.GhStay.updateOne({ _id: stay._id }, { $set: { points_given: points } });
        await M.GhPointTx.create({ business_id: ctx.business._id, customer_id: c._id, stay_id: stay._id, points, kind: "earn", note: stay.no, by: ctx.by });
      }
    }
  }
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, dual, Bad, MSG, text, num, bool, validId, reply, billOf, managerOnly } = kit;
  const needReviews = (ctx) => {
    if (!ctx.addons.gh_reviews?.active) throw new Bad(T.needReviews, 402, { product: "gh_reviews" });
  };
  const needLoyalty = (ctx) => {
    if (!ctx.addons.gh_loyalty?.active) throw new Bad(T.needLoyalty, 402, { product: "gh_loyalty" });
  };
  const owner = (method, path, write, fn) =>
    prop.app[method](
      `${base}${path}`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, write);
        ctx.by = req.customer?.name || "owner";
        await fn(ctx, req, res);
      }),
    );
  const loadStay = async (ctx, sid) => {
    if (!validId(sid)) throw new Bad(MSG.badId);
    const s = await M.GhStay.findOne({ _id: sid, business_id: ctx.business._id });
    if (!s) throw new Bad(MSG.rowNotFound, 404);
    return s;
  };

  // ===================================== REVIEWS =====================================
  owner("get", "/reviews", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const [items, waiting] = await Promise.all([
      M.GhReview.find({ business_id: bid, rating: { $gt: 0 } })
        .sort({ submitted_at: -1 })
        .limit(300)
        .lean(),
      M.GhReview.find({ business_id: bid, rating: 0, created_date: { $gt: new Date(Date.now() - 45 * 86400000) } })
        .sort({ created_date: -1 })
        .limit(100)
        .lean(),
    ]);
    const stars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of items) stars[r.rating] += 1;
    const avg = items.length ? Math.round((items.reduce((a, r) => a + r.rating, 0) / items.length) * 10) / 10 : 0;
    res.json({ success: true, data: { on: !!ctx.addons.gh_reviews?.active, auto: ctx.settings.reviews_auto !== false, avg, count: items.length, stars, items, waiting } });
  });
  owner("put", "/reviews/:rid", true, async (ctx, req, res) => {
    needReviews(ctx);
    if (!validId(req.params.rid)) throw new Bad(MSG.badId);
    const r = await M.GhReview.findOne({ _id: req.params.rid, business_id: ctx.business._id });
    if (!r) throw new Bad(MSG.rowNotFound, 404);
    const b = req.body || {};
    const shown = bool(b, "shown");
    if (shown !== undefined) r.shown = shown && r.rating > 0;
    const rep = text(b, "reply", 500);
    if (rep !== undefined) r.reply = rep;
    await r.save();
    res.json({ success: true, data: r, message: MSG.saved });
  });
  owner("delete", "/reviews/:rid", true, async (ctx, req, res) => {
    if (!validId(req.params.rid)) throw new Bad(MSG.badId);
    await M.GhReview.deleteOne({ _id: req.params.rid, business_id: ctx.business._id });
    res.json({ success: true, message: MSG.saved });
  });
  owner("put", "/reviews-settings", true, async (ctx, req, res) => {
    needReviews(ctx);
    const auto = bool(req.body || {}, "reviews_auto");
    if (auto !== undefined) ctx.settings.reviews_auto = auto;
    await ctx.settings.save();
    res.json({ success: true, data: { auto: ctx.settings.reviews_auto }, message: MSG.saved });
  });
  // the review link of a stay (desk + owner) — to send by WhatsApp / Telegram / SMS or show as a QR
  dual("get", "/stays/:sid/review", false, async (ctx, req, res) => {
    needReviews(ctx);
    const s = await loadStay(ctx, req.params.sid);
    if (!["in", "out"].includes(s.status)) throw new Bad(T.closed, 409, { code: "not_stayed" });
    const room = await M.GhRoom.findById(s.room_id).select("name").lean();
    const r = await inviteFor(s, room?.name);
    res.json({ success: true, data: { token: r.token, path: `/r/${r.token}`, rating: r.rating, guest: s.guest, phone: s.guest?.phone || "" } });
  });

  prop.app.get(
    "/api/public/review/:token",
    handle(async (req, res) => {
      const tok = String(req.params.token || "");
      const r = /^[A-Za-z0-9]{10,30}$/.test(tok) ? await M.GhReview.findOne({ token: tok }).lean() : null;
      if (!r) throw new Bad(MSG.rowNotFound, 404);
      const [biz, site] = await Promise.all([require("../business.model").findById(r.business_id).select("name logo_url").lean(), M.GhSite.findOne({ business_id: r.business_id, published: true }).select("slug color").lean()]);
      res.json({
        success: true,
        data: {
          business: { name: biz?.name || "", logo: biz?.logo_url || "" },
          slug: site?.slug || "",
          color: site?.color || "",
          guest_name: r.guest_name,
          room_name: r.room_name,
          from: r.from,
          to: r.to,
          rating: r.rating,
          text: r.text,
          done: r.rating > 0,
        },
      });
    }),
  );
  const { rate_limit } = require("../../util/rate_limit");
  prop.app.post(
    "/api/public/review/:token",
    rate_limit({ windowMs: 10 * 60 * 1000, max: 10 }),
    handle(async (req, res) => {
      const tok = String(req.params.token || "");
      const r = /^[A-Za-z0-9]{10,30}$/.test(tok) ? await M.GhReview.findOne({ token: tok }) : null;
      if (!r) throw new Bad(MSG.rowNotFound, 404);
      if (r.rating > 0) throw new Bad(T.already, 409, { code: "done" });
      const b = req.body || {};
      const rating = Number(b.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Bad(T.badRating);
      const settings = await M.GhSettings.findOne({ business_id: r.business_id }).select("reviews_auto").lean();
      r.rating = rating;
      r.text = text(b, "text", 1000) || "";
      const name = text(b, "name", 80);
      if (name) r.guest_name = name;
      r.submitted_at = new Date();
      r.shown = settings?.reviews_auto !== false && rating >= 4;
      await r.save();
      res.json({ success: true, message: T.done });
    }),
  );

  // ===================================== LOYALTY =====================================
  owner("get", "/loyalty", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const [members, recent, sums] = await Promise.all([
      M.GhCustomer.find({ business_id: bid }).sort({ points: -1, created_date: 1 }).limit(50).select("name phone email points").lean(),
      M.GhPointTx.find({ business_id: bid }).sort({ created_date: -1 }).limit(50).lean(),
      M.GhPointTx.aggregate([{ $match: { business_id: bid } }, { $group: { _id: "$kind", n: { $sum: "$points" } } }]),
    ]);
    const names = new Map(members.map((m) => [String(m._id), m.name]));
    const missing = recent.filter((t) => !names.has(String(t.customer_id))).map((t) => t.customer_id);
    if (missing.length)
      for (const c of await M.GhCustomer.find({ _id: { $in: missing } })
        .select("name")
        .lean())
        names.set(String(c._id), c.name);
    const sum = Object.fromEntries(sums.map((x) => [x._id, x.n]));
    res.json({
      success: true,
      data: {
        on: !!ctx.addons.gh_loyalty?.active,
        accounts: !!ctx.addons.gh_customers?.active,
        rules: rules(ctx.settings),
        members: members.filter((m) => m.points > 0 || members.length <= 50),
        recent: recent.map((t) => ({ ...t, name: names.get(String(t.customer_id)) || "?" })),
        totals: { earned: sum.earn || 0, used: -(sum.redeem || 0), open: members.reduce((a, m) => a + (m.points || 0), 0) },
      },
    });
  });
  owner("put", "/loyalty", true, async (ctx, req, res) => {
    needLoyalty(ctx);
    const b = req.body || {};
    for (const [k, min, max] of [
      ["earn", 0, 1000],
      ["redeem_points", 1, 1000000],
      ["redeem_value", 0, 100000000],
    ]) {
      const v = num(b, k, min, max);
      if (v !== undefined) ctx.settings.set(`loyalty.${k}`, v);
    }
    await ctx.settings.save();
    res.json({ success: true, data: rules(ctx.settings), message: MSG.saved });
  });
  owner("post", "/customers/:cid/points", true, async (ctx, req, res) => {
    needLoyalty(ctx);
    if (!validId(req.params.cid)) throw new Bad(MSG.badId);
    const points = num(req.body || {}, "points", -1000000, 1000000, { required: true, int: true });
    if (!points) throw new Bad(`${MSG.badValue} (points)`);
    const c = await M.GhCustomer.findOneAndUpdate({ _id: req.params.cid, business_id: ctx.business._id, ...(points < 0 ? { points: { $gte: -points } } : {}) }, { $inc: { points } }, { returnDocument: "after" }).lean();
    if (!c) throw new Bad(T.notEnough, 409, { code: "not_enough" });
    await M.GhPointTx.create({ business_id: ctx.business._id, customer_id: c._id, points, kind: "adjust", note: text(req.body || {}, "note", 200) || "", by: ctx.by });
    res.json({ success: true, data: { points: c.points }, message: MSG.saved });
  });

  // desk: find a member, link them to a stay, use points
  dual("get", "/members", false, async (ctx, req, res) => {
    needLoyalty(ctx);
    const term = String(req.query.q || "")
      .trim()
      .slice(0, 40);
    if (term.length < 2) return res.json({ success: true, data: [] });
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const rows = await M.GhCustomer.find({ business_id: ctx.business._id, blocked: { $ne: true }, $or: [{ name: rx }, { phone: rx }, { email: rx }] })
      .limit(8)
      .select("name phone email points")
      .lean();
    res.json({ success: true, data: rows, rules: rules(ctx.settings) });
  });
  const memberOut = async (ctx, s) => {
    const c = s.customer_id ? await M.GhCustomer.findOne({ _id: s.customer_id, business_id: ctx.business._id }).select("name phone email points").lean() : null;
    return c;
  };
  dual("get", "/stays/:sid/member", false, async (ctx, req, res) => {
    const s = await loadStay(ctx, req.params.sid);
    res.json({ success: true, data: { on: !!ctx.addons.gh_loyalty?.active, member: await memberOut(ctx, s), rules: rules(ctx.settings), used: s.points_used || 0, value: s.points_value || 0, given: s.points_given || 0 } });
  });
  dual("put", "/stays/:sid/customer", true, async (ctx, req, res) => {
    needLoyalty(ctx);
    const s = await loadStay(ctx, req.params.sid);
    if (s.points_used) throw new Bad(T.closed, 409, { code: "points_used" });
    const cid = req.body?.customer_id;
    if (cid) {
      if (!validId(String(cid))) throw new Bad(MSG.badId);
      const c = await M.GhCustomer.findOne({ _id: cid, business_id: ctx.business._id }).select("_id").lean();
      if (!c) throw new Bad(MSG.rowNotFound, 404);
      s.customer_id = c._id;
    } else s.customer_id = null;
    await s.save();
    await reply(res, ctx, s);
  });
  dual("post", "/stays/:sid/points", true, async (ctx, req, res) => {
    needLoyalty(ctx);
    const s = await loadStay(ctx, req.params.sid);
    if (!["booked", "in"].includes(s.status)) throw new Bad(T.closed, 409, { code: "closed" });
    if (!s.customer_id) throw new Bad(T.noMember, 409, { code: "no_member" });
    const r = rules(ctx.settings);
    let points = num(req.body || {}, "points", 1, 100000000, { required: true, int: true });
    const bill = billOf(s, ctx.settings.currency);
    if (bill.balance <= 0) throw new Bad(T.noBalance, 409, { code: "paid" });
    const round = (v) => (ctx.settings.currency === "KHR" ? Math.round(v) : Math.round(v * 100) / 100);
    let value = round((points / r.redeem_points) * r.redeem_value);
    if (value > bill.balance) {
      // never more than what is left to pay
      points = Math.ceil((bill.balance / r.redeem_value) * r.redeem_points);
      value = bill.balance;
    }
    const c = await M.GhCustomer.findOneAndUpdate({ _id: s.customer_id, business_id: ctx.business._id, points: { $gte: points } }, { $inc: { points: -points } }, { returnDocument: "after" });
    if (!c) throw new Bad(T.notEnough, 409, { code: "not_enough" });
    s.points_used = (s.points_used || 0) + points;
    s.points_value = round((s.points_value || 0) + value);
    s.discount = round((s.discount || 0) + value);
    await s.save();
    await M.GhPointTx.create({ business_id: ctx.business._id, customer_id: c._id, stay_id: s._id, points: -points, kind: "redeem", note: `${s.no} · −${value}`, by: ctx.by });
    await reply(res, ctx, s);
  });
  dual("delete", "/stays/:sid/points", true, async (ctx, req, res) => {
    needLoyalty(ctx);
    managerOnly(ctx);
    const s = await loadStay(ctx, req.params.sid);
    if (!s.points_used) return reply(res, ctx, s);
    if (!["booked", "in"].includes(s.status)) throw new Bad(T.closed, 409, { code: "closed" });
    const points = s.points_used;
    await M.GhCustomer.updateOne({ _id: s.customer_id, business_id: ctx.business._id }, { $inc: { points } });
    s.discount = Math.max(0, (s.discount || 0) - (s.points_value || 0));
    s.points_used = 0;
    s.points_value = 0;
    await s.save();
    await M.GhPointTx.create({ business_id: ctx.business._id, customer_id: s.customer_id, stay_id: s._id, points, kind: "undo", note: s.no, by: ctx.by });
    await reply(res, ctx, s);
  });
};
module.exports.inviteFor = inviteFor;
module.exports.publicReviews = publicReviews;
module.exports.afterCheckout = afterCheckout;
module.exports.rules = rules;
