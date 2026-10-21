// Reward points (add-on rest_rewards, yearly): members collect points and swap them for rewards.
//
// Owner, base /api/user/businesses/:id/restaurant/rewards
//   GET    /                       settings + summary (members, points given / used) + menu items with their points
//   PUT    /                       { enabled, by_amount, points_per_step, min_bill, by_item, expire_months, mask_phone }
//   PUT    /items                  { points: { <itemId>: n } }   points per item (stamp-card style)
//   GET    /members?q=&page=       search by name or phone
//   POST   /members                { phone, name, birthday, note }
//   GET    /members/export.csv
//   GET    /members/:mid           member + point history + coupons kept
//   PUT    /members/:mid           { name, phone, birthday, note, active }
//   POST   /members/:mid/adjust    { points: +/-n, note }
//   POST   /members/:mid/reset     { note }   points to 0 (details + history stay)
//   POST   /reset-all              { note, confirm: "RESET" }   everyone's points to 0
//   the rewards catalogue: generic collection …/restaurant/reward-list (restaurant.route.js)
//
// POS device, header x-device-token
//   GET    /api/pos/members?q=               search by name or (part of the) phone → list
//   GET    /api/pos/members?phone=           find a member (+ the rewards and coupons they can use)
//   GET    /api/pos/members/:mid             the member on a bill (fresh points)
//   POST   /api/pos/members                  { phone, name, birthday }  new member
//   POST   /api/pos/rewards/redeem           { member_id, reward_id, order_id, order_number }  points off now
//   POST   /api/pos/rewards/undo             { redemption_id }  before the bill is paid: points (or the coupon) go back
//   POST   /api/pos/coupons/use              { member_id, redemption_id, order_id, order_number }
// Points for a bill are added by the server when the bill is paid (POS sync) and taken back if it's cancelled.
//
// Member (no login): GET /api/public/member/:token   their points, history, rewards and coupons
// Shop QR (no login): GET /api/public/points/:token  ·  POST { phone } → points (first letter of the name only)
// Owner: PUT /rewards/themes/current { theme } · POST /rewards/themes/:theme (buy a yearly look for the members' pages)
const crypto = require("crypto");
const M = require("./restaurant.models");
const Business = require("../business.model");
const License = require("../../license/license.model");
const { buy, LicenseError } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { rate_limit } = require("../../util/rate_limit");

const W = {
  needAddon: "សូមដោះសោ “ពិន្ទុរង្វាន់” ជាមុនសិន!",
  off: "មុខងារពិន្ទុរង្វាន់មិនទាន់បើកទេ",
  badPhone: "លេខទូរស័ព្ទមិនត្រឹមត្រូវ",
  exists: "លេខទូរស័ព្ទនេះជាសមាជិករួចហើយ",
  notFound: "រកមិនឃើញសមាជិក!",
  noReward: "រកមិនឃើញរង្វាន់!",
  notEnough: "ពិន្ទុមិនគ្រប់គ្រាន់",
  badRedemption: "មិនអាចត្រឡប់វិញបានទេ",
  noCoupon: "គូប៉ុងនេះមិនអាចប្រើបានទេ",
  needNote: "សូមសរសេរមូលហេតុ",
  badPoints: "ចំនួនពិន្ទុមិនត្រឹមត្រូវ",
  memberOff: "ទំព័រនេះមិនមានទេ",
  confirmReset: "សូមវាយ RESET ដើម្បីបញ្ជាក់",
  badTheme: "រចនាប័ទ្មមិនត្រឹមត្រូវ",
  lockedTheme: "សូមទិញរចនាប័ទ្មនេះជាមុនសិន",
  bought: "បានទិញរចនាប័ទ្ម!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  busy: "សូមព្យាយាមម្តងទៀត",
};
const PAGE = 30;
const newToken = () => crypto.randomBytes(18).toString("base64url").replace(/[-_]/g, "").slice(0, 14);
const newCode = () => Array.from(crypto.randomBytes(6), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
const round2 = (v) => Math.round(Number(v) * 100) / 100;

// "012 345 678", "+855 12 345 678" → "012345678"
function normPhone(v) {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.startsWith("855")) d = `0${d.slice(3)}`;
  if (d && !d.startsWith("0") && d.length >= 8 && d.length <= 9) d = `0${d}`;
  return /^\d{8,12}$/.test(d) ? d : "";
}
const maskPhone = (p) => (p ? `••• ${p.slice(-3)}` : "");
const settingsView = (s) => {
  const r = s.rewards || {};
  return {
    enabled: !!r.enabled,
    by_amount: r.by_amount !== false,
    points_per_step: r.points_per_step ?? 1,
    min_bill: r.min_bill || 0,
    by_item: !!r.by_item,
    expire_months: r.expire_months || 0,
    mask_phone: r.mask_phone !== false,
    step: s.currency === "KHR" ? 1000 : 1,
    currency: s.currency || "USD",
  };
};
const on = (state, settings) => !!(state.addons.rest_rewards?.active && settings.rewards?.enabled);
const memberView = (m, mask) => ({
  _id: m._id,
  name: m.name,
  phone: mask ? maskPhone(m.phone) : m.phone,
  points: m.points,
  visits: m.visits,
  total_spent: m.total_spent,
  last_visit: m.last_visit,
  birthday: m.birthday,
  note: mask ? undefined : m.note,
  token: mask ? undefined : m.token,
  active: m.active,
  created_date: m.created_date,
});
const rewardView = (r) => ({ _id: r._id, name: r.name, kind: r.kind, points: r.points, item_id: r.item_id, value: r.value, coupon_kind: r.coupon_kind, note: r.note });
const redemptionView = (x) => ({
  id: String(x._id),
  reward_id: x.reward_id,
  name: x.name,
  kind: x.kind,
  value: x.value,
  item_id: x.item_id,
  points: x.points,
  code: x.code,
  status: x.status,
  order_number: x.order_number,
  created_date: x.created_date,
});

// looks of the members' pages: classic is free, the others are yearly (rest_points_theme)
async function ownedThemes(bid) {
  const rows = await License.find({ business_id: bid, product: "rest_points_theme", $or: [{ expires_at: null }, { expires_at: { $gt: new Date() } }] })
    .select("item expires_at")
    .lean();
  return rows.filter((r) => M.POINTS_THEMES_PAID.includes(r.item));
}
// the look guests see: the chosen one, unless its year ran out
async function liveTheme(bid, settings) {
  const t = settings.rewards?.theme || "classic";
  if (M.POINTS_THEMES_FREE.includes(t)) return t;
  return (await ownedThemes(bid)).some((r) => r.item === t) ? t : "classic";
}

// points a paid bill gives: money spent (after discounts, before service / VAT) and/or points set on items
function pointsFor(order, settings, itemPoints) {
  const r = settingsView(settings);
  let pts = 0;
  const t = order.totals || {};
  const spent = (Number(t.subtotal) || 0) - (Number(t.discount) || 0);
  if (r.by_amount && r.points_per_step > 0 && spent >= r.min_bill) pts += Math.floor((spent / r.step) * r.points_per_step + 1e-9);
  if (r.by_item) for (const l of order.lines || []) if (l.status !== "void" && !l.reward_id) pts += (itemPoints.get(String(l.item_id)) || 0) * (Number(l.qty) || 0);
  return Math.max(0, Math.floor(pts));
}

// change a member's points and write it in the history
async function move(member, kind, points, extra = {}) {
  const after = await M.RestMember.findOneAndUpdate({ _id: member._id }, { $inc: { points } }, { returnDocument: "after" }).lean();
  await M.RestPointMove.create({ business_id: member.business_id, member_id: member._id, kind, points, balance: after.points, ...extra });
  return after;
}
// points go if the member hasn't come for the set number of months
async function expireIfIdle(member, settings) {
  const months = settings.rewards?.expire_months || 0;
  if (!months || member.points <= 0 || !member.last_visit) return member;
  const limit = new Date();
  limit.setMonth(limit.getMonth() - months);
  if (new Date(member.last_visit) >= limit) return member;
  return move(member, "expire", -member.points, { note: `${months} months without a visit` });
}

// POS sync: a bill with a member just got paid → points; a paid bill cancelled → points back.
// Redemptions on a cancelled bill go back too (points, or the coupon to the member).
async function applyOrderPoints(bid, merged, stored, settings, state) {
  const memberId = merged.member?.id;
  if (merged.status === "paid" && memberId && !merged.points_applied && on(state, settings)) {
    let member = await M.RestMember.findOne({ _id: memberId, business_id: bid }).lean();
    if (member) {
      member = await expireIfIdle(member, settings);
      const ids = (merged.lines || []).map((l) => l.item_id).filter((id) => /^[a-f0-9]{24}$/.test(id));
      const items =
        settings.rewards?.by_item && ids.length
          ? await M.RestItem.find({ _id: { $in: ids }, business_id: bid })
              .select("reward_points")
              .lean()
          : [];
      const pts = pointsFor(merged, settings, new Map(items.map((i) => [String(i._id), i.reward_points || 0])));
      const total = Number(merged.totals?.total) || 0;
      await M.RestMember.updateOne({ _id: member._id }, { $inc: { total_spent: round2(total), visits: 1 }, $set: { last_visit: merged.paid_at || new Date() } });
      if (pts > 0) await move(member, "earn", pts, { order_id: merged._id, order_number: merged.number || "", by: merged.closed_by?.name || "" });
      merged.points_earned = pts;
      merged.points_applied = true;
    }
  }
  if (merged.status === "void" && stored?.status !== "void") {
    if (merged.points_applied && memberId) {
      const member = await M.RestMember.findOne({ _id: memberId, business_id: bid }).lean();
      if (member) {
        await M.RestMember.updateOne({ _id: member._id }, { $inc: { total_spent: -round2(Number(merged.totals?.total) || 0), visits: -1 } });
        if (merged.points_earned) await move(member, "reverse", -merged.points_earned, { order_id: merged._id, order_number: merged.number || "", note: "Bill cancelled" });
      }
      merged.points_applied = false;
    }
    const used = await M.RestRedemption.find({ business_id: bid, order_id: merged._id, status: "used" }).lean();
    for (const x of used) await giveBack(x, "Bill cancelled");
  }
}
// a redemption goes back: a coupon used on a bill returns to the member; anything else refunds the points
async function giveBack(x, note) {
  if (x.code && x.status === "used") {
    await M.RestRedemption.updateOne({ _id: x._id }, { $set: { status: "coupon", order_id: "", order_number: "", used_at: null } });
    return;
  }
  const done = await M.RestRedemption.findOneAndUpdate({ _id: x._id, status: { $in: ["used", "coupon"] } }, { $set: { status: "refunded" } });
  if (!done) return;
  const member = await M.RestMember.findById(x.member_id).lean();
  if (member && x.points) await move(member, "refund", x.points, { reward_name: x.name, order_id: x.order_id, order_number: x.order_number, note });
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, withSettings, licenseState, Bad, MSG, text, num, bool, validId } = kit;
  const path = `${base}/rewards`;
  const need = (ctx) => {
    if (!ctx.addons.rest_rewards?.active) throw new Bad(W.needAddon, 402, { product: "rest_rewards" });
  };
  const themesInfo = async (bid, settings) => {
    const owned = await ownedThemes(bid);
    return {
      free: M.POINTS_THEMES_FREE,
      paid: M.POINTS_THEMES_PAID,
      price: await priceOf("rest_points_theme"),
      owned: owned.map((r) => r.item),
      until: Object.fromEntries(owned.map((r) => [r.item, r.expires_at])),
      current: settings.rewards?.theme || "classic",
      live: await liveTheme(bid, settings),
    };
  };
  const memberOf = async (bid, mid) => {
    if (!validId(mid)) throw new Bad(MSG.badId);
    const m = await M.RestMember.findOne({ _id: mid, business_id: bid }).lean();
    if (!m) throw new Bad(W.notFound, 404);
    return m;
  };
  const createMember = async (bid, b, by) => {
    const phone = normPhone(b.phone);
    if (!phone) throw new Bad(W.badPhone);
    const birthday = String(b.birthday || "").trim();
    if (birthday && !/^(\d{4}-)?\d{2}-\d{2}$/.test(birthday)) throw new Bad(`${MSG.badValue} (birthday)`);
    try {
      return (
        await M.RestMember.create({
          business_id: bid,
          phone,
          name: String(b.name || "")
            .trim()
            .slice(0, 60),
          birthday,
          note: String(b.note || "")
            .trim()
            .slice(0, 200),
          token: newToken(),
        })
      ).toObject();
    } catch (err) {
      if (err.code === 11000) throw new Bad(W.exists, 409);
      throw err;
    }
  };

  // ===================================== OWNER =====================================
  prop.app.get(
    path,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, false);
      const bid = ctx.business._id;
      if (!settings.rewards?.token) {
        settings.set("rewards.token", newToken());
        await settings.save();
      }
      const since = new Date(Date.now() - 30 * 86400000);
      const [members, fresh, given, used, balance, top, items, rewards] = await Promise.all([
        M.RestMember.countDocuments({ business_id: bid }),
        M.RestMember.countDocuments({ business_id: bid, created_date: { $gte: since } }),
        M.RestPointMove.aggregate([{ $match: { business_id: bid, kind: "earn", created_date: { $gte: since } } }, { $group: { _id: null, n: { $sum: "$points" } } }]),
        M.RestPointMove.aggregate([{ $match: { business_id: bid, kind: "redeem", created_date: { $gte: since } } }, { $group: { _id: null, n: { $sum: "$points" } } }]),
        M.RestMember.aggregate([{ $match: { business_id: bid } }, { $group: { _id: null, n: { $sum: "$points" } } }]),
        M.RestMember.find({ business_id: bid }).sort({ total_spent: -1 }).limit(10).lean(),
        M.RestItem.find({ business_id: bid, active: true }).sort({ sort: 1 }).select("name_km name_en category_id price reward_points").lean(),
        M.RestReward.countDocuments({ business_id: bid, active: true }),
      ]);
      res.json({
        success: true,
        data: {
          active: !!ctx.addons.rest_rewards?.active,
          settings: settingsView(settings),
          summary: { members, new_30d: fresh, given_30d: given[0]?.n || 0, used_30d: -(used[0]?.n || 0), balance: balance[0]?.n || 0, rewards },
          top: top.map((m) => memberView(m, false)),
          items,
          check_token: settings.rewards.token,
          themes: await themesInfo(bid, settings),
        },
      });
    }),
  );

  prop.app.put(
    path,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      need(ctx);
      const b = req.body || {};
      const set = {
        enabled: bool(b, "enabled"),
        by_amount: bool(b, "by_amount"),
        points_per_step: num(b, "points_per_step", 0, 1000),
        min_bill: num(b, "min_bill", 0, 100000000),
        by_item: bool(b, "by_item"),
        expire_months:
          b.expire_months === undefined
            ? undefined
            : [0, 3, 6, 12, 24].includes(Number(b.expire_months))
              ? Number(b.expire_months)
              : (() => {
                  throw new Bad(`${MSG.badValue} (expire_months)`);
                })(),
        mask_phone: bool(b, "mask_phone"),
      };
      for (const [k, v] of Object.entries(set)) if (v !== undefined) settings.set(`rewards.${k}`, v);
      await settings.save();
      res.json({ success: true, data: settingsView(settings), message: MSG.saved });
    }),
  );

  prop.app.put(
    `${path}/items`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      const pts = req.body?.points || {};
      const entries = Object.entries(pts).slice(0, 1000);
      for (const [id, v] of entries) {
        const n = Number(v);
        if (!validId(id) || !Number.isInteger(n) || n < 0 || n > 10000) throw new Bad(W.badPoints);
      }
      for (const [id, v] of entries) await M.RestItem.updateOne({ _id: id, business_id: ctx.business._id }, { $set: { reward_points: Number(v) } });
      res.json({ success: true, data: { updated: entries.length }, message: MSG.saved });
    }),
  );

  prop.app.get(
    `${path}/members`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
      const q = String(req.query.q || "")
        .trim()
        .slice(0, 40);
      const filter = { business_id: ctx.business._id };
      if (q) {
        const digits = q.replace(/\D/g, "");
        const or = [{ name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }];
        if (digits.length >= 3) or.push({ phone: { $regex: digits } });
        filter.$or = or;
      }
      const sort = req.query.sort === "points" ? { points: -1 } : req.query.sort === "spent" ? { total_spent: -1 } : req.query.sort === "recent" ? { last_visit: -1 } : { created_date: -1 };
      const [rows, total] = await Promise.all([
        M.RestMember.find(filter)
          .sort(sort)
          .skip((page - 1) * PAGE)
          .limit(PAGE)
          .lean(),
        M.RestMember.countDocuments(filter),
      ]);
      res.json({ success: true, data: rows.map((m) => memberView(m, false)), pagination: { total, totalPages: Math.max(1, Math.ceil(total / PAGE)), currentPage: page, pageSize: PAGE } });
    }),
  );

  prop.app.post(
    `${path}/members`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      const m = await createMember(ctx.business._id, req.body || {});
      res.status(201).json({ success: true, data: memberView(m, false), message: MSG.saved });
    }),
  );

  prop.app.get(
    `${path}/members/export.csv`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const rows = await M.RestMember.find({ business_id: ctx.business._id }).sort({ created_date: 1 }).limit(50000).lean();
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const day = (d) => (d ? new Date(new Date(d).getTime() + 7 * 3600000).toISOString().slice(0, 10) : "");
      const csv = [
        "Name,Phone,Points,Total spent,Visits,Last visit,Birthday,Joined,Note",
        ...rows.map((m) => [m.name, `'${m.phone}`, m.points, round2(m.total_spent), m.visits, day(m.last_visit), m.birthday, day(m.created_date), m.note].map(esc).join(",")),
      ].join("\n");
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", 'attachment; filename="members.csv"');
      res.send(`﻿${csv}`);
    }),
  );

  prop.app.get(
    `${path}/members/:mid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const m = await memberOf(ctx.business._id, req.params.mid);
      const [moves, coupons] = await Promise.all([
        M.RestPointMove.find({ business_id: ctx.business._id, member_id: m._id }).sort({ created_date: -1 }).limit(60).lean(),
        M.RestRedemption.find({ business_id: ctx.business._id, member_id: m._id, status: "coupon" }).sort({ created_date: -1 }).lean(),
      ]);
      res.json({ success: true, data: { member: memberView(m, false), moves, coupons: coupons.map(redemptionView) } });
    }),
  );

  prop.app.put(
    `${path}/members/:mid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const m = await memberOf(ctx.business._id, req.params.mid);
      const b = req.body || {};
      const set = {};
      if (b.name !== undefined) set.name = text(b, "name", 60);
      if (b.note !== undefined) set.note = text(b, "note", 200);
      if (b.active !== undefined) set.active = bool(b, "active");
      if (b.birthday !== undefined) {
        const v = String(b.birthday || "").trim();
        if (v && !/^(\d{4}-)?\d{2}-\d{2}$/.test(v)) throw new Bad(`${MSG.badValue} (birthday)`);
        set.birthday = v;
      }
      if (b.phone !== undefined) {
        set.phone = normPhone(b.phone);
        if (!set.phone) throw new Bad(W.badPhone);
      }
      try {
        const next = await M.RestMember.findOneAndUpdate({ _id: m._id }, { $set: set }, { returnDocument: "after" }).lean();
        res.json({ success: true, data: memberView(next, false), message: MSG.saved });
      } catch (err) {
        if (err.code === 11000) throw new Bad(W.exists, 409);
        throw err;
      }
    }),
  );

  prop.app.post(
    `${path}/members/:mid/adjust`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      const m = await memberOf(ctx.business._id, req.params.mid);
      const pts = Number(req.body?.points);
      if (!Number.isInteger(pts) || pts === 0 || Math.abs(pts) > 1000000) throw new Bad(W.badPoints);
      const note = String(req.body?.note || "")
        .trim()
        .slice(0, 120);
      if (!note) throw new Bad(W.needNote);
      if (m.points + pts < 0) throw new Bad(W.notEnough);
      const next = await move(m, "adjust", pts, { note, by: req.customer?.name || "" });
      res.json({ success: true, data: memberView(next, false), message: MSG.saved });
    }),
  );

  // looks of the members' pages
  prop.app.put(
    `${path}/themes/current`,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      const theme = String(req.body?.theme || "");
      if (![...M.POINTS_THEMES_FREE, ...M.POINTS_THEMES_PAID].includes(theme)) throw new Bad(W.badTheme);
      if (M.POINTS_THEMES_PAID.includes(theme) && !(await ownedThemes(ctx.business._id)).some((r) => r.item === theme)) throw new Bad(W.lockedTheme, 402, { product: "rest_points_theme", item: theme });
      settings.set("rewards.theme", theme);
      await settings.save();
      res.json({ success: true, data: await themesInfo(ctx.business._id, settings), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${path}/themes/:theme`,
    ...guard,
    handle(async (req, res) => {
      if (!M.POINTS_THEMES_PAID.includes(req.params.theme)) throw new Bad(W.badTheme);
      const ctx = await ctxOf(req, true);
      let r;
      try {
        r = await buy({ customer: req.customer, business: ctx.business, product: "rest_points_theme", item: req.params.theme });
      } catch (err) {
        if (err instanceof LicenseError) throw new Bad(W[err.message] || err.message, err.status, err.extra);
        throw err;
      }
      res.json({ success: true, data: r.status, item: req.params.theme, charged: r.charged, balance: r.balance, message: W.bought });
    }),
  );

  // reset: points back to 0, the member's details and history stay
  prop.app.post(
    `${path}/members/:mid/reset`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      const m = await memberOf(ctx.business._id, req.params.mid);
      const note = String(req.body?.note || "")
        .trim()
        .slice(0, 120);
      if (!note) throw new Bad(W.needNote);
      const next = m.points !== 0 ? await move(m, "adjust", -m.points, { note: `Reset · ${note}`, by: req.customer?.name || "" }) : m;
      res.json({ success: true, data: memberView(next, false), message: MSG.saved });
    }),
  );
  // everyone's points to 0 (a new season); members and their history stay
  prop.app.post(
    `${path}/reset-all`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      const note = String(req.body?.note || "")
        .trim()
        .slice(0, 120);
      if (!note) throw new Bad(W.needNote);
      if (req.body?.confirm !== "RESET") throw new Bad(W.confirmReset);
      const rows = await M.RestMember.find({ business_id: ctx.business._id, points: { $ne: 0 } }).lean();
      for (const m of rows) await move(m, "adjust", -m.points, { note: `Reset all · ${note}`, by: req.customer?.name || "" });
      res.json({ success: true, data: { reset: rows.length }, message: MSG.saved });
    }),
  );

  // ===================================== POS =====================================
  const posCtx = async (req) => {
    const d = await kit.deviceOf(req);
    if (!on(d.state, d.settings)) throw new Bad(d.state.addons.rest_rewards?.active ? W.off : W.needAddon, 402, { product: "rest_rewards" });
    return d;
  };
  const posMember = async (bid, mid) => {
    if (!validId(mid)) throw new Bad(MSG.badId);
    const m = await M.RestMember.findOne({ _id: mid, business_id: bid, active: true }).lean();
    if (!m) throw new Bad(W.notFound, 404);
    return m;
  };
  const posView = async (bid, m, settings) => {
    const [rewards, coupons] = await Promise.all([
      M.RestReward.find({ business_id: bid, active: true }).sort({ sort: 1, points: 1 }).lean(),
      M.RestRedemption.find({ business_id: bid, member_id: m._id, status: "coupon" }).sort({ created_date: -1 }).lean(),
    ]);
    // token: the member's own page, shown as a QR on the POS for them to scan
    return { member: { ...memberView(m, settings.rewards?.mask_phone !== false), token: m.token }, rewards: rewards.map(rewardView), coupons: coupons.map(redemptionView) };
  };

  prop.app.get(
    "/api/pos/members",
    prop.api_auth,
    handle(async (req, res) => {
      const { business, settings } = await posCtx(req);
      // ?q= name or phone (part of it) → a short list to pick from
      if (req.query.q !== undefined) {
        const q = String(req.query.q || "")
          .trim()
          .slice(0, 40);
        if (q.length < 2) return res.json({ success: true, data: { results: [], phone: "" } });
        const digits = q.replace(/\D/g, "");
        const or = [];
        if (/[^\d\s+()-]/.test(q)) or.push({ name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } });
        if (digits.length >= 3) or.push({ phone: { $regex: (normPhone(digits) || digits).replace(/^0/, "") } });
        const rows = or.length ? await M.RestMember.find({ business_id: business._id, active: true, $or: or }).sort({ last_visit: -1 }).limit(12).lean() : [];
        const mask = settings.rewards?.mask_phone !== false;
        return res.json({ success: true, data: { results: rows.map((m) => memberView(m, mask)), phone: normPhone(q) } });
      }
      const phone = normPhone(req.query.phone);
      if (!phone) throw new Bad(W.badPhone);
      let m = await M.RestMember.findOne({ business_id: business._id, phone, active: true }).lean();
      if (!m) return res.json({ success: true, data: { member: null, phone } });
      m = await expireIfIdle(m, settings);
      res.json({ success: true, data: await posView(business._id, m, settings) });
    }),
  );

  // the member already on a bill (the POS only has their id and hidden phone)
  prop.app.get(
    "/api/pos/members/:mid",
    prop.api_auth,
    handle(async (req, res) => {
      const { business, settings } = await posCtx(req);
      const m = await expireIfIdle(await posMember(business._id, req.params.mid), settings);
      // the cashier can look (points, visits, history) but never change points
      const moves = await M.RestPointMove.find({ business_id: business._id, member_id: m._id }).sort({ created_date: -1 }).limit(15).lean();
      res.json({
        success: true,
        data: { ...(await posView(business._id, m, settings)), moves: moves.map((x) => ({ kind: x.kind, points: x.points, balance: x.balance, reward_name: x.reward_name, order_number: x.order_number, at: x.created_date })) },
      });
    }),
  );

  prop.app.post(
    "/api/pos/members",
    prop.api_auth,
    handle(async (req, res) => {
      const { business, settings } = await posCtx(req);
      const m = await createMember(business._id, req.body || {});
      res.status(201).json({ success: true, data: await posView(business._id, m, settings) });
    }),
  );

  prop.app.post(
    "/api/pos/rewards/redeem",
    prop.api_auth,
    handle(async (req, res) => {
      const { business, settings } = await posCtx(req);
      const bid = business._id;
      const b = req.body || {};
      let m = await posMember(bid, b.member_id);
      if (!validId(b.reward_id)) throw new Bad(W.noReward);
      const r = await M.RestReward.findOne({ _id: b.reward_id, business_id: bid, active: true }).lean();
      if (!r) throw new Bad(W.noReward, 404);
      m = await expireIfIdle(m, settings);
      const after = await M.RestMember.findOneAndUpdate({ _id: m._id, points: { $gte: r.points } }, { $inc: { points: -r.points } }, { returnDocument: "after" }).lean();
      if (!after) throw new Bad(W.notEnough, 409, { points: m.points });
      const coupon = r.kind === "coupon";
      const x = await M.RestRedemption.create({
        business_id: bid,
        member_id: m._id,
        reward_id: String(r._id),
        name: r.name,
        kind: coupon ? r.coupon_kind : r.kind,
        value: r.value,
        item_id: r.item_id,
        points: r.points,
        status: coupon ? "coupon" : "used",
        code: coupon ? newCode() : "",
        order_id: coupon ? "" : String(b.order_id || "").slice(0, 40),
        order_number: coupon ? "" : String(b.order_number || "").slice(0, 20),
        used_at: coupon ? null : new Date(),
      });
      await M.RestPointMove.create({ business_id: bid, member_id: m._id, kind: "redeem", points: -r.points, balance: after.points, reward_name: r.name, order_id: x.order_id, order_number: x.order_number });
      res.status(201).json({ success: true, data: { redemption: { ...redemptionView(x.toObject()), coupon }, ...(await posView(bid, after, settings)) } });
    }),
  );

  prop.app.post(
    "/api/pos/rewards/undo",
    prop.api_auth,
    handle(async (req, res) => {
      const { business, settings } = await posCtx(req);
      const id = req.body?.redemption_id;
      if (!validId(id)) throw new Bad(W.badRedemption);
      const x = await M.RestRedemption.findOne({ _id: id, business_id: business._id, status: { $in: ["used", "coupon"] } }).lean();
      if (!x) throw new Bad(W.badRedemption, 404);
      if (x.order_id) {
        const o = await M.RestOrder.findOne({ _id: x.order_id, business_id: business._id }).select("status").lean();
        if (o && o.status === "paid") throw new Bad(W.badRedemption, 409);
      }
      await giveBack(x, "Undone on the POS");
      const m = await M.RestMember.findById(x.member_id).lean();
      res.json({ success: true, data: await posView(business._id, m, settings) });
    }),
  );

  prop.app.post(
    "/api/pos/coupons/use",
    prop.api_auth,
    handle(async (req, res) => {
      const { business, settings } = await posCtx(req);
      const b = req.body || {};
      const m = await posMember(business._id, b.member_id);
      if (!validId(b.redemption_id)) throw new Bad(W.noCoupon);
      const x = await M.RestRedemption.findOneAndUpdate(
        { _id: b.redemption_id, business_id: business._id, member_id: m._id, status: "coupon" },
        { $set: { status: "used", order_id: String(b.order_id || "").slice(0, 40), order_number: String(b.order_number || "").slice(0, 20), used_at: new Date() } },
        { returnDocument: "after" },
      ).lean();
      if (!x) throw new Bad(W.noCoupon, 409);
      res.json({ success: true, data: { redemption: redemptionView(x), ...(await posView(business._id, m, settings)) } });
    }),
  );

  // ===================================== SHOP QR: CHECK MY POINTS (public) =====================================
  // One QR for the whole shop. A guest types their phone and sees their points (first letter of the name only, no history).
  const shopOf = async (req) => {
    const tok = String(req.params.token || "");
    const settings = /^[A-Za-z0-9]{10,20}$/.test(tok) ? await M.RestSettings.findOne({ "rewards.token": tok }).lean() : null;
    if (!settings) throw new Bad(W.memberOff, 404);
    const bid = settings.business_id;
    const [business, state] = await Promise.all([Business.findOne({ _id: bid, deleted: false }).select("status").lean(), licenseState(bid)]);
    if (!business?.status || !on(state, settings)) throw new Bad(W.memberOff, 404);
    return { settings, bid };
  };
  const shopView = async (settings, bid) => {
    const rewards = await M.RestReward.find({ business_id: bid, active: true }).sort({ sort: 1, points: 1 }).lean();
    return {
      restaurant: { name_km: settings.name_km, name_en: settings.name_en, logo: settings.logo?.url || "", color: settings.color, currency: settings.currency },
      rules: settingsView(settings),
      theme: await liveTheme(bid, settings),
      rewards: rewards.map(rewardView),
    };
  };
  prop.app.get(
    "/api/public/points/:token",
    handle(async (req, res) => {
      const { settings, bid } = await shopOf(req);
      res.set("Cache-Control", "no-store");
      res.json({ success: true, data: await shopView(settings, bid) });
    }),
  );
  const checkLimit = rate_limit({ windowMs: 60 * 1000, max: 8, message: "សូមរង់ចាំបន្តិច រួចព្យាយាមម្តងទៀត" });
  prop.app.post(
    "/api/public/points/:token",
    checkLimit,
    handle(async (req, res) => {
      const { settings, bid } = await shopOf(req);
      const phone = normPhone(req.body?.phone);
      if (!phone) throw new Bad(W.badPhone);
      let m = await M.RestMember.findOne({ business_id: bid, phone, active: true }).lean();
      if (m) m = await expireIfIdle(m, settings);
      const first = (m?.name || "").trim();
      res.set("Cache-Control", "no-store");
      res.json({
        success: true,
        data: m ? { found: true, name: first ? `${[...first][0]}***` : "", phone: maskPhone(phone), points: m.points, coupons: await M.RestRedemption.countDocuments({ business_id: bid, member_id: m._id, status: "coupon" }) } : { found: false },
      });
    }),
  );

  // ===================================== MEMBER PAGE (public) =====================================
  prop.app.get(
    "/api/public/member/:token",
    handle(async (req, res) => {
      const tok = String(req.params.token || "");
      const m = /^[A-Za-z0-9]{10,20}$/.test(tok) ? await M.RestMember.findOne({ token: tok, active: true }).lean() : null;
      if (!m) throw new Bad(W.memberOff, 404);
      const bid = m.business_id;
      const [settings, business, state] = await Promise.all([M.RestSettings.findOne({ business_id: bid }).lean(), Business.findOne({ _id: bid, deleted: false }).select("status").lean(), licenseState(bid)]);
      if (!settings || !business?.status || !on(state, settings)) throw new Bad(W.memberOff, 404);
      const [moves, rewards, coupons] = await Promise.all([
        M.RestPointMove.find({ business_id: bid, member_id: m._id }).sort({ created_date: -1 }).limit(30).lean(),
        M.RestReward.find({ business_id: bid, active: true }).sort({ sort: 1, points: 1 }).lean(),
        M.RestRedemption.find({ business_id: bid, member_id: m._id, status: "coupon" }).sort({ created_date: -1 }).lean(),
      ]);
      res.set("Cache-Control", "no-store");
      res.json({
        success: true,
        data: {
          restaurant: { name_km: settings.name_km, name_en: settings.name_en, logo: settings.logo?.url || "", color: settings.color, currency: settings.currency, phone: settings.phone, address: settings.address },
          member: { name: m.name, phone: maskPhone(m.phone), points: m.points, visits: m.visits, since: m.created_date, last_visit: m.last_visit },
          rules: settingsView(settings),
          theme: await liveTheme(bid, settings),
          moves: moves.map((x) => ({ kind: x.kind, points: x.points, balance: x.balance, reward_name: x.reward_name, order_number: x.order_number, note: x.kind === "adjust" || x.kind === "expire" ? x.note : "", at: x.created_date })),
          rewards: rewards.map(rewardView),
          coupons: coupons.map(redemptionView),
        },
      });
    }),
  );
};

module.exports.applyOrderPoints = applyOrderPoints;
module.exports.liveTheme = liveTheme;
module.exports.normPhone = normPhone;
module.exports.maskPhone = maskPhone;
module.exports.rewardsOn = on;
module.exports.settingsView = settingsView;
module.exports.newToken = newToken;
