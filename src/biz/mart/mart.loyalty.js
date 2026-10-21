// Loyalty points (mart_loyalty, yearly): customers collect points by phone — at the POS (also offline) and on the website.
// Owner base: /api/user/businesses/:id/mart/loyalty (POS: lookup + members list in boot)
//   GET  /loyalty                      the rules + totals
//   PUT  /loyalty { on, earn_per, point_value, min_redeem, online }
//   GET  /loyalty/members?q=&page=     POST /loyalty/members { phone, name, note }
//   GET  /loyalty/members/:mid         (+ last 100 point moves)   PUT /loyalty/members/:mid   DELETE /loyalty/members/:mid
//   POST /loyalty/members/:mid/adjust { points, note }
//   GET  /loyalty/lookup?phone=        (both doors) the member at the counter
// A sale: spend `earn_per` → 1 point (on what is paid); `redeem` points → `point_value` each off. A void undoes both.
const T = {
  need: "សូមដោះសោ “ពិន្ទុសន្សំ” ជាមុនសិន!",
  badPhone: "លេខទូរស័ព្ទមិនត្រឹមត្រូវ!",
  phoneTaken: "លេខទូរស័ព្ទនេះមានសមាជិករួចហើយ!",
  notEnough: "ពិន្ទុមិនគ្រប់គ្រាន់!",
  minRedeem: "ត្រូវប្រើយ៉ាងតិច {n} ពិន្ទុ!",
  noMember: "រកមិនឃើញសមាជិក!",
};

module.exports = (prop, kit) => {
  const { own, dual, Bad, MSG, text, num, bool, validId, roundOf, phoneKey, phoneOk, M } = kit;
  const on = (ctx) => !!(ctx.addons || ctx.state?.addons)?.mart_loyalty?.active && ctx.settings?.loyalty?.on !== false;
  const need = (ctx) => {
    if (!(ctx.addons || {}).mart_loyalty?.active) throw new Bad(T.need, 402, { product: "mart_loyalty" });
  };
  const rules = (s) => {
    const l = s.loyalty || {};
    return { on: l.on !== false, earn_per: l.earn_per || 1, point_value: l.point_value ?? 0.05, min_redeem: l.min_redeem || 20, online: l.online !== false };
  };
  const bidOf = (ctx) => ctx.business?._id || ctx.bid;
  const memberOut = (x) => ({ _id: x._id, phone: x.phone, name: x.name, points: x.points, earned: x.earned, redeemed: x.redeemed, spent: x.spent, visits: x.visits, last_at: x.last_at, note: x.note, created_date: x.created_date });

  // ------------------------------------------------ settings + members (owner)
  own("get", "/loyalty", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const [members, sums] = await Promise.all([
      M.MartMember.countDocuments({ business_id: bid }),
      M.MartMember.aggregate([{ $match: { business_id: bid } }, { $group: { _id: null, points: { $sum: "$points" }, earned: { $sum: "$earned" }, redeemed: { $sum: "$redeemed" } } }]),
    ]);
    const r = rules(ctx.settings);
    const out = sums[0] || { points: 0, earned: 0, redeemed: 0 };
    res.json({ success: true, data: { active: !!ctx.addons.mart_loyalty?.active, rules: r, totals: { members, points: out.points, earned: out.earned, redeemed: out.redeemed, owed: roundOf(ctx.settings.currency)(out.points * r.point_value) } } });
  });
  own("put", "/loyalty", true, async (ctx, req, res) => {
    need(ctx);
    const b = req.body || {};
    const s = ctx.settings;
    const ON = bool(b, "on");
    if (ON !== undefined) s.set("loyalty.on", ON);
    const online = bool(b, "online");
    if (online !== undefined) s.set("loyalty.online", online);
    const per = num(b, "earn_per", 0.01, 100000000);
    if (per !== undefined) s.set("loyalty.earn_per", per);
    const pv = num(b, "point_value", 0, 100000000);
    if (pv !== undefined) s.set("loyalty.point_value", pv);
    const min = num(b, "min_redeem", 1, 1000000, { int: true });
    if (min !== undefined) s.set("loyalty.min_redeem", min);
    await s.save();
    res.json({ success: true, data: rules(s), message: MSG.saved });
  });
  const readMember = (b, partial) => {
    const out = {};
    if (b.phone !== undefined || !partial) {
      const phone = phoneKey(b.phone);
      if (!phoneOk(phone)) throw new Bad(T.badPhone, 400, { code: "bad_phone" });
      out.phone = phone;
    }
    const name = text(b, "name", 80);
    if (name !== undefined) out.name = name;
    const note = text(b, "note", 200);
    if (note !== undefined) out.note = note;
    return out;
  };
  own("get", "/loyalty/members", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const q = String(req.query.q || "")
      .trim()
      .slice(0, 40);
    const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter = { business_id: bid, ...(q ? { $or: [{ name: { $regex: esc, $options: "i" } }, { phone: { $regex: esc.replace(/\D/g, "") || esc } }] } : {}) };
    const sort = req.query.sort === "recent" ? { last_at: -1 } : { points: -1, last_at: -1 };
    const [rows, total] = await Promise.all([
      M.MartMember.find(filter)
        .sort(sort)
        .skip((page - 1) * 50)
        .limit(50)
        .lean(),
      M.MartMember.countDocuments(filter),
    ]);
    res.json({ success: true, data: rows.map(memberOut), pagination: { total, totalPages: Math.max(1, Math.ceil(total / 50)), currentPage: page } });
  });
  own("post", "/loyalty/members", true, async (ctx, req, res) => {
    need(ctx);
    const set = readMember(req.body || {}, false);
    if (await M.MartMember.exists({ business_id: ctx.business._id, phone: set.phone })) throw new Bad(T.phoneTaken, 409, { code: "phone_taken" });
    const row = await M.MartMember.create({ business_id: ctx.business._id, ...set });
    res.status(201).json({ success: true, data: memberOut(row), message: MSG.saved });
  });
  const load = async (ctx, mid) => {
    if (!validId(mid)) throw new Bad(MSG.badId);
    const row = await M.MartMember.findOne({ _id: mid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  own("get", "/loyalty/members/:mid", false, async (ctx, req, res) => {
    const row = await load(ctx, req.params.mid);
    const moves = await M.MartPointTx.find({ business_id: ctx.business._id, member_id: row._id }).sort({ created_date: -1 }).limit(100).lean();
    res.json({ success: true, data: { member: memberOut(row), moves } });
  });
  own("put", "/loyalty/members/:mid", true, async (ctx, req, res) => {
    const row = await load(ctx, req.params.mid);
    const set = readMember(req.body || {}, true);
    if (set.phone && set.phone !== row.phone && (await M.MartMember.exists({ business_id: ctx.business._id, phone: set.phone }))) throw new Bad(T.phoneTaken, 409, { code: "phone_taken" });
    row.set(set);
    await row.save();
    res.json({ success: true, data: memberOut(row), message: MSG.saved });
  });
  own("delete", "/loyalty/members/:mid", true, async (ctx, req, res) => {
    const row = await load(ctx, req.params.mid);
    await row.deleteOne();
    await M.MartPointTx.deleteMany({ business_id: ctx.business._id, member_id: row._id });
    res.json({ success: true, message: MSG.deleted });
  });
  // points by hand (a gift, a correction)
  async function move(bid, member, kind, points, extra = {}) {
    const after = await M.MartMember.findOneAndUpdate(
      { _id: member._id },
      {
        $inc: {
          points,
          ...(kind === "earn" ? { earned: points } : {}),
          ...(kind === "redeem" ? { redeemed: -points } : {}),
          ...(kind === "void" && extra.wasEarn ? { earned: points } : {}),
          ...((kind === "refund" || (kind === "void" && !extra.wasEarn)) && points > 0 ? { redeemed: -points } : {}),
          ...(extra.inc || {}),
        },
        ...(extra.set ? { $set: extra.set } : {}),
      },
      { returnDocument: "after" },
    ).lean();
    const { wasEarn, inc, set, ...rest } = extra;
    await M.MartPointTx.create({ business_id: bid, member_id: member._id, kind, points, balance_after: after?.points ?? 0, ...rest });
    return after;
  }
  own("post", "/loyalty/members/:mid/adjust", true, async (ctx, req, res) => {
    need(ctx);
    const row = await load(ctx, req.params.mid);
    const b = req.body || {};
    const points = num(b, "points", -10000000, 10000000, { required: true, int: true });
    if (!points) throw new Bad(`${MSG.badValue} (points)`);
    if (row.points + points < 0) throw new Bad(T.notEnough, 400, { code: "not_enough" });
    const after = await move(ctx.business._id, row, "adjust", points, { note: text(b, "note", 200) || "", by: ctx.by });
    res.json({ success: true, data: memberOut(after), message: MSG.saved });
  });

  // ------------------------------------------------ at the counter
  dual("get", "/loyalty/lookup", false, async (ctx, req, res) => {
    need(ctx);
    const phone = phoneKey(req.query.phone);
    const row = phoneOk(phone) ? await M.MartMember.findOne({ business_id: ctx.business._id, phone }).lean() : null;
    res.json({ success: true, data: row ? memberOut(row) : null, rules: rules(ctx.settings) });
  });
  // the members the POS keeps (lookups offline)
  const forPos = async (ctx) => (on(ctx) ? M.MartMember.find({ business_id: ctx.business._id }).sort({ last_at: -1 }).limit(3000).select("phone name points").lean() : []);

  // a sale names its member: member_id, or member_phone (+ member_name for someone new)
  async function memberFor(ctx, b, { create = false } = {}) {
    if (!on(ctx)) return null;
    const bid = bidOf(ctx);
    if (b.member_id && validId(b.member_id)) {
      const m = await M.MartMember.findOne({ _id: b.member_id, business_id: bid });
      if (m) return m;
    }
    const phone = phoneKey(b.member_phone);
    if (!phoneOk(phone)) return null;
    const found = await M.MartMember.findOne({ business_id: bid, phone });
    if (found || !create) return found;
    try {
      return await M.MartMember.create({ business_id: bid, phone, name: text(b, "member_name", 80) || "" });
    } catch (err) {
      if (err.code === 11000) return M.MartMember.findOne({ business_id: bid, phone });
      throw err;
    }
  }
  // points the customer uses now → money off (never more than what is left to pay)
  function redeemOf(ctx, member, asked, { offline = false, left = Infinity } = {}) {
    const n = Math.floor(Number(asked) || 0);
    if (n <= 0) return { points: 0, value: 0 };
    const rl = rules(ctx.settings);
    const r = roundOf(ctx.settings.currency);
    let points = n;
    if (points > member.points) {
      if (!offline) throw new Bad(T.notEnough, 400, { code: "not_enough", points: member.points });
      points = Math.max(0, Math.floor(member.points)); // sent from offline: use what is there
    }
    if (points < rl.min_redeem) {
      if (!offline) throw new Bad(T.minRedeem.replace("{n}", rl.min_redeem), 400, { code: "min_redeem", min: rl.min_redeem });
      return { points: 0, value: 0 };
    }
    if (!(rl.point_value > 0)) return { points: 0, value: 0 };
    let value = r(points * rl.point_value);
    if (value > left) {
      points = Math.ceil(left / rl.point_value - 1e-9);
      value = r(Math.max(0, left));
    }
    return { points, value };
  }
  const earnOf = (ctx, total) => Math.max(0, Math.floor((Number(total) || 0) / rules(ctx.settings).earn_per + 1e-9));
  // after the sale is saved: points used leave, points earned arrive
  async function afterSale(ctx, member, sale, { order } = {}) {
    if (!member) return null;
    const bid = bidOf(ctx);
    const ref = { sale_id: sale._id || null, sale_no: sale.no || "", ...(order ? { order_id: order._id, order_no: order.no } : {}), by: ctx.by || "" };
    if (sale.points_used > 0 && !order) await move(bid, member, "redeem", -sale.points_used, ref); // website orders took them at order time
    const earned = earnOf(ctx, sale.total);
    const stats = { inc: { spent: sale.total || 0, visits: 1 }, set: { last_at: new Date(), ...(sale.member_name && !member.name ? { name: sale.member_name } : {}) } };
    if (earned > 0) await move(bid, member, "earn", earned, { ...ref, ...stats });
    else await M.MartMember.updateOne({ _id: member._id }, { $inc: stats.inc, $set: stats.set });
    if (earned > 0 && sale._id) await M.MartSale.updateOne({ _id: sale._id }, { $set: { points_earned: earned } });
    return { earned };
  }
  async function voidSale(ctx, sale) {
    if (!sale.member_id) return;
    const bid = bidOf(ctx);
    const member = await M.MartMember.findOne({ _id: sale.member_id, business_id: bid });
    if (!member) return;
    const ref = { sale_id: sale._id, sale_no: sale.no, by: ctx.by || "", note: "void" };
    if (sale.points_earned > 0) await move(bid, member, "void", -sale.points_earned, { ...ref, wasEarn: true, inc: { spent: -(sale.total || 0), visits: -1 } });
    if (sale.points_used > 0 && !sale.order_id) await move(bid, member, "void", sale.points_used, ref);
  }

  // ------------------------------------------------ website orders (points used at order time; back if declined / cancelled)
  async function orderTake(p, member, order) {
    if (order.points_used > 0) await move(p.bid, member, "redeem", -order.points_used, { order_id: order._id, order_no: order.no, by: order.name });
  }
  async function orderRefund(bid, order, by) {
    if (!(order.points_used > 0) || !order.member_id) return;
    const member = await M.MartMember.findOne({ _id: order.member_id, business_id: bid });
    if (member) await move(bid, member, "refund", order.points_used, { order_id: order._id, order_no: order.no, by: by || "" });
  }
  // the customer's page: their points
  async function forCustomer(p, c) {
    const ctxLike = { bid: p.bid, settings: p.settings, addons: p.state.addons };
    if (!on(ctxLike) || !rules(p.settings).online) return null;
    const m = await M.MartMember.findOne({ business_id: p.bid, phone: c.phone }).lean();
    const rl = rules(p.settings);
    return { points: m?.points || 0, earned: m?.earned || 0, point_value: rl.point_value, min_redeem: rl.min_redeem, earn_per: rl.earn_per };
  }

  return { on, rules, memberFor, redeemOf, earnOf, afterSale, voidSale, orderTake, orderRefund, forCustomer, forPos, T };
};
