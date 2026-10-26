// POS (point of sale) for restaurants — linked devices, offline-safe sync of orders and shifts.
//
// Owner (dashboard), base /api/user/businesses/:id/restaurant/pos
//   GET    /                     POS settings + devices + recent shifts
//   PUT    /settings             { sync_mode: instant|5|15|30|shift, allow_offline, max_offline_hours: 4|12|24|72 }
//   POST   /pair-code            → { code, expires_at }  6 digits, 10 minutes, typed on the new device
//   PUT    /devices/:did { name }      DELETE /devices/:did   (unlink: the device can't sync any more)
//   GET    /shifts?page=1        closed + open shifts, newest first
//
// Device (the POS itself), header x-device-token: <token from /pair>
//   POST /api/pos/pair            { code, name }  → { token, device }   (no login: the code is the proof)
//   GET  /api/pos/bootstrap       everything the POS needs to sell offline (setup, staff PIN checks, open orders…)
//   POST /api/pos/staff-pin       { pin }  online PIN check (also teaches the device a PIN it can't check offline yet)
//   POST /api/pos/unlink          { pin }  the device unlinks itself (a manager's PIN; any staff PIN if there is no manager)
//   POST /api/pos/sync            { orders: [...], shifts: [...], since, pending } → saves them, returns what changed since `since`
//
// Every order, line, payment and shift has an id made on the device, so a POS can sell offline and send later;
// sending the same thing twice never doubles it. Merge rules: lines and payments are joined by id,
// the newer version wins for the rest, "paid" / "void" / "closed" never go back to "open".
const crypto = require("crypto");
const M = require("./restaurant.models");
const Business = require("../business.model");
const calc = require("./pos.calc");
const { displayOf } = require("./restaurant.extras");
const { applyOrderStock, stockMap, sendStockAlerts } = require("./restaurant.stock");
const { posInfo: tableOrderOf } = require("./restaurant.order");
const rewards = require("./restaurant.rewards");
const telegram = require("../../telegram");
const { rate_limit } = require("../../util/rate_limit");

const PAIR_MINUTES = 10;
const MAX_ORDERS = 200; // per sync call
const MAX_LINES = 300;
const MAX_PAYMENTS = 30;
const UUID = /^[A-Za-z0-9-]{16,40}$/;
const P = {
  badCode: "លេខកូដមិនត្រឹមត្រូវ ឬផុតកំណត់ហើយ!",
  noDevice: "ឧបករណ៍នេះមិនបានភ្ជាប់ ឬត្រូវបានផ្តាច់ហើយ។ សូមភ្ជាប់ម្តងទៀត។",
  badPin: "PIN មិនត្រឹមត្រូវ!",
  notManager: "ត្រូវការ PIN របស់អ្នកគ្រប់គ្រង ដើម្បីផ្តាច់ឧបករណ៍នេះ។",
  selfUnlinked: "បានផ្តាច់ឧបករណ៍នេះ។",
  tooMany: "ទិន្នន័យច្រើនពេកក្នុងម្តង",
  deviceGone: "រកមិនឃើញឧបករណ៍!",
  needDisplay: "សូមបើកមុខងារ “អេក្រង់សម្រាប់ភ្ញៀវ” ក្នុងផ្ទាំង BizHub ជាមុនសិន",
};

const hash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const pinKey = (businessId, pin) =>
  crypto
    .createHmac("sha256", process.env.JWT_SECRET || "bizhub")
    .update(`${businessId}:${pin}`)
    .digest("hex");
const str = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
const n = (v, min = -1e9, max = 1e9) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : 0;
};
const date = (v) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const who = (v) => ({ id: str(v?.id, 40), name: str(v?.name, 60) });
const prefixOf = (i) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

// money settings a device (and calc) needs
const moneyOf = (s) => ({ currency: s.currency, khr_rate: s.khr_rate, khr_rounding: s.khr_rounding, vat: s.vat, service_charge: s.service_charge });
const posOf = (s) => ({ sync_mode: s.pos?.sync_mode || "instant", allow_offline: s.pos?.allow_offline !== false, max_offline_hours: s.pos?.max_offline_hours || 24, max_line_discount: s.pos?.max_line_discount ?? 100 });

async function nextSeq(businessId) {
  const c = await M.RestCounter.findOneAndUpdate({ business_id: businessId }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" }).lean();
  return c.seq;
}

// ---------- cleaning what a device sends ----------
function cleanLine(l) {
  return {
    id: str(l.id, 40),
    item_id: str(l.item_id, 40),
    name_km: str(l.name_km, 80),
    name_en: str(l.name_en, 80),
    size: str(l.size, 40),
    unit_price: n(l.unit_price, 0, 1e9),
    addons: (Array.isArray(l.addons) ? l.addons.slice(0, 30) : []).map((a) => ({ group: str(a.group, 40), name: str(a.name, 40), price: n(a.price, 0, 1e9) })),
    qty: n(l.qty, 0, 9999),
    note: str(l.note, 200),
    status: ["new", "sent", "void"].includes(l.status) ? l.status : "new",
    void_reason: str(l.void_reason, 120),
    void_by: str(l.void_by, 60),
    station_id: str(l.station_id, 40),
    created_at: date(l.created_at) || new Date(),
    created_by: str(l.created_by, 60),
    discount: { kind: ["", "percent", "amount"].includes(l.discount?.kind) ? l.discount.kind : "", value: n(l.discount?.value, 0, 1e9), by: str(l.discount?.by, 60), reason: str(l.discount?.reason, 80) },
    promo: { id: str(l.promo?.id, 40), name: str(l.promo?.name, 60), off: n(l.promo?.off, 0, 1e9) },
    from: l.from === "guest" ? "guest" : "",
    guest_name: str(l.guest_name, 40),
    reward_id: str(l.reward_id, 40),
    // cost of one when sold; missing = filled from the item (kept out of the object so it never wipes a known cost)
    ...(l.cost === undefined || l.cost === null || l.cost === "" ? {} : { cost: n(l.cost, 0, 1e9) }),
  };
}
function cleanPayment(p) {
  return {
    id: str(p.id, 40),
    method: str(p.method, 40),
    kind: str(p.kind, 20) || "cash",
    currency: p.currency === "KHR" ? "KHR" : "USD",
    amount: n(p.amount, 0, 1e10),
    value: n(p.value, 0, 1e10),
    at: date(p.at) || new Date(),
    by: str(p.by, 60),
  };
}
function cleanOrder(o) {
  if (!o || !UUID.test(o._id || "")) return null;
  const lines = Array.isArray(o.lines)
    ? o.lines
        .slice(0, MAX_LINES)
        .filter((l) => UUID.test(l?.id || ""))
        .map(cleanLine)
    : [];
  const payments = Array.isArray(o.payments)
    ? o.payments
        .slice(0, MAX_PAYMENTS)
        .filter((p) => UUID.test(p?.id || ""))
        .map(cleanPayment)
    : [];
  return {
    _id: o._id,
    shift_id: str(o.shift_id, 40),
    number: str(o.number, 20),
    type: o.type === "takeaway" ? "takeaway" : "dine_in",
    table_id: str(o.table_id, 40),
    table_name: str(o.table_name, 40),
    guests: n(o.guests, 0, 999),
    status: ["open", "paid", "void"].includes(o.status) ? o.status : "open",
    lines,
    discount: { kind: ["", "percent", "amount"].includes(o.discount?.kind) ? o.discount.kind : "", value: n(o.discount?.value, 0, 1e9), by: str(o.discount?.by, 60) },
    payments,
    change: { usd: n(o.change?.usd, 0, 1e9), khr: n(o.change?.khr, 0, 1e12) },
    opened_by: who(o.opened_by),
    closed_by: who(o.closed_by),
    void_reason: str(o.void_reason, 120),
    opened_at: date(o.opened_at) || new Date(),
    paid_at: date(o.paid_at),
    bill_printed: !!o.bill_printed,
    note: str(o.note, 300),
    member: { id: /^[a-f0-9]{24}$/.test(o.member?.id || "") ? o.member.id : "", name: str(o.member?.name, 60), phone: str(o.member?.phone, 20) },
    reward_discount: {
      kind: ["amount", "percent"].includes(o.reward_discount?.kind) ? o.reward_discount.kind : "",
      value: n(o.reward_discount?.value, 0, 1e9),
      name: str(o.reward_discount?.name, 60),
      redemption_id: str(o.reward_discount?.redemption_id, 40),
    },
    redemptions: (Array.isArray(o.redemptions) ? o.redemptions.slice(0, 20) : []).map((x) => ({
      id: str(x?.id, 40),
      reward_id: str(x?.reward_id, 40),
      name: str(x?.name, 60),
      kind: str(x?.kind, 20),
      points: n(x?.points, 0, 1e9),
      item_id: str(x?.item_id, 40),
      code: str(x?.code, 20),
    })),
    version: n(o.version, 0, 1e9),
    device_updated_at: date(o.device_updated_at) || new Date(),
  };
}

const BOOKING_RANK = { active: 0, seated: 1, cancelled: 1 };
function cleanBooking(b) {
  if (!b || !UUID.test(b._id || "")) return null;
  return {
    _id: b._id,
    table_id: str(b.table_id, 40),
    table_name: str(b.table_name, 40),
    name: str(b.name, 60),
    phone: str(b.phone, 30),
    time: date(b.time),
    guests: n(b.guests, 0, 999),
    note: str(b.note, 200),
    status: ["active", "seated", "cancelled"].includes(b.status) ? b.status : "active",
    order_id: str(b.order_id, 40),
    created_by: str(b.created_by, 60),
    version: n(b.version, 0, 1e9),
  };
}
// newer version wins; once seated or cancelled a booking never becomes active again
function mergeBooking(stored, incoming) {
  if (!stored) return incoming;
  const next = (incoming.version || 0) >= (stored.version || 0) ? { ...stored, ...incoming } : { ...incoming, ...stored };
  if ((BOOKING_RANK[stored.status] || 0) > (BOOKING_RANK[next.status] || 0)) next.status = stored.status;
  next.version = Math.max(stored.version || 0, incoming.version || 0);
  return next;
}

// merge what a device sent with what the server has (offline edits from two devices both survive)
const rank = { open: 0, paid: 1, void: 2 };
function mergeOrder(stored, incoming) {
  if (!stored) return incoming;
  const newer = incoming.version >= (stored.version || 0);
  const base = newer ? { ...stored, ...incoming } : { ...incoming, ...stored };
  const lines = new Map((stored.lines || []).map((l) => [l.id, l]));
  for (const l of incoming.lines) {
    const old = lines.get(l.id);
    if (!old) lines.set(l.id, l);
    else {
      const pick = newer ? { ...old, ...l } : { ...l, ...old };
      if (old.status === "void" || l.status === "void") Object.assign(pick, { status: "void", void_reason: old.void_reason || l.void_reason, void_by: old.void_by || l.void_by });
      else if (old.status === "sent" || l.status === "sent") pick.status = "sent";
      lines.set(l.id, pick);
    }
  }
  const pays = new Map((stored.payments || []).map((p) => [p.id, p]));
  for (const p of incoming.payments) if (!pays.has(p.id)) pays.set(p.id, p);
  const status = (rank[incoming.status] || 0) >= (rank[stored.status] || 0) ? incoming.status : stored.status;
  return {
    ...base,
    status,
    lines: [...lines.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    payments: [...pays.values()],
    paid_at: stored.paid_at || incoming.paid_at,
    closed_by: status === stored.status && stored.closed_by?.id ? stored.closed_by : base.closed_by,
    version: Math.max(stored.version || 0, incoming.version || 0),
    number: stored.number || incoming.number,
    shift_id: stored.shift_id || incoming.shift_id,
    opened_at: stored.opened_at || incoming.opened_at,
  };
}

// ---------- Telegram reports ----------
function reportText(title, name, sum, s, extra = []) {
  const m = (v) => (s.currency === "KHR" ? `${Math.round(v).toLocaleString("en-US")}៛` : `$${Number(v).toFixed(2)}`);
  const e = telegram.escape;
  const methods = Object.entries(sum.by_method || {})
    .map(([k, v]) => `• ${e(k)}: ${m(v)}`)
    .join("\n");
  return [
    `📊 <b>${e(name)}</b>`,
    e(title),
    "",
    `💰 Sales: <b>${m(sum.sales)}</b>`,
    `🧾 Bills: ${sum.bills}`,
    sum.discounts ? `🏷 Discounts: ${m(sum.discounts)}` : "",
    methods,
    sum.void_orders || sum.void_lines ? `🚫 Cancelled: ${sum.void_orders} bills, ${sum.void_lines} items` : "",
    ...extra,
  ]
    .filter(Boolean)
    .join("\n");
}

// Telegram: a cashier opened a shift (with the cash in the drawer)
async function sendShiftOpen(shift, settings, state, device) {
  const chat = settings?.telegram?.chat_id;
  if (!chat || settings.telegram?.shift_open === false || !state.addons.rest_telegram?.active || !telegram.ready()) return;
  const e = telegram.escape;
  const when = new Date(shift.opened_at || Date.now()).toLocaleString("en-GB", { timeZone: "Asia/Phnom_Penh", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const text = [
    `🟢 <b>Shift opened · បើកវេន</b> · ${e(when)}`,
    `<b>${e(settings.name_km || settings.name_en || "Restaurant")}</b>`,
    "",
    `👤 ${e(shift.opened_by?.name || "")}${device?.name ? ` · 🖥 ${e(device.name)}` : ""}`,
    `💵 Opening cash · ប្រាក់ដើម: <b>$${(Number(shift.opening?.usd) || 0).toFixed(2)}</b> · <b>${(Number(shift.opening?.khr) || 0).toLocaleString("en-US")}៛</b>`,
  ].join("\n");
  await telegram.send(chat, text).catch(() => {});
}

async function sendShiftReport(shift, settings, state) {
  const chat = settings?.telegram?.chat_id;
  if (!chat || settings.telegram?.shift_close === false || !state.addons.rest_telegram?.active || !telegram.ready()) return;
  const t = shift.totals || {};
  const diff = (k) => (Number(shift.counted?.[k]) || 0) - (Number(shift.expected?.[k]) || 0);
  const fmtDiff = (v, cur) => `${v >= 0 ? "+" : "−"}${cur === "khr" ? `${Math.abs(Math.round(v)).toLocaleString("en-US")}៛` : `$${Math.abs(v).toFixed(2)}`}`;
  const extra = [
    "",
    `👤 ${telegram.escape(shift.closed_by?.name || shift.opened_by?.name || "")}`,
    `💵 Cash counted: $${(Number(shift.counted?.usd) || 0).toFixed(2)} · ${(Number(shift.counted?.khr) || 0).toLocaleString("en-US")}៛`,
    `⚖️ Difference: ${fmtDiff(diff("usd"), "usd")} · ${fmtDiff(diff("khr"), "khr")}`,
  ];
  const when = new Date(shift.closed_at || Date.now()).toLocaleString("en-GB", { timeZone: "Asia/Phnom_Penh", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  await telegram.send(chat, reportText(`Shift closed · ${when}`, settings.name_km || settings.name_en || "Restaurant", t, moneyOf(settings), extra)).catch(() => {});
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, withSettings, licenseState, Bad, MSG, text, validId } = kit;
  const path = `${base}/pos`;

  // ===================================== OWNER =====================================
  prop.app.get(
    path,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, false);
      const bid = ctx.business._id;
      const [devices, shifts] = await Promise.all([M.RestDevice.find({ business_id: bid, revoked: false }).select("-token_hash").sort({ created_date: 1 }).lean(), M.RestShift.find({ business_id: bid }).sort({ opened_at: -1 }).limit(10).lean()]);
      const live = settings.pos?.pair_code && settings.pos?.pair_expires > new Date();
      res.json({ success: true, data: { settings: posOf(settings), pair: live ? { code: settings.pos.pair_code, expires_at: settings.pos.pair_expires } : null, devices, shifts, money: moneyOf(settings) } });
    }),
  );

  prop.app.put(
    `${path}/settings`,
    ...guard,
    handle(async (req, res) => {
      const { settings } = await withSettings(req, true);
      const b = req.body || {};
      if (b.sync_mode !== undefined) {
        if (!["instant", "5", "15", "30", "shift"].includes(String(b.sync_mode))) throw new Bad(`${MSG.badValue} (sync_mode)`);
        settings.set("pos.sync_mode", String(b.sync_mode));
      }
      if (b.allow_offline !== undefined) settings.set("pos.allow_offline", !!b.allow_offline);
      if (b.max_line_discount !== undefined) {
        const v = Number(b.max_line_discount);
        if (!Number.isInteger(v) || v < 0 || v > 100) throw new Bad(`${MSG.badValue} (max_line_discount)`);
        settings.set("pos.max_line_discount", v);
      }
      if (b.max_offline_hours !== undefined) {
        if (![4, 12, 24, 72].includes(Number(b.max_offline_hours))) throw new Bad(`${MSG.badValue} (max_offline_hours)`);
        settings.set("pos.max_offline_hours", Number(b.max_offline_hours));
      }
      await settings.save();
      await M.RestCounter.updateOne({ business_id: settings.business_id }, { $inc: { setup: 1 } }, { upsert: true });
      res.json({ success: true, data: posOf(settings), message: MSG.saved });
    }),
  );

  prop.app.post(
    `${path}/pair-code`,
    ...guard,
    handle(async (req, res) => {
      const { settings } = await withSettings(req, true);
      let code = "";
      for (let i = 0; i < 10 && !code; i++) {
        const c = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
        if (!(await M.RestSettings.exists({ "pos.pair_code": c, "pos.pair_expires": { $gt: new Date() } }))) code = c;
      }
      const expires = new Date(Date.now() + PAIR_MINUTES * 60000);
      settings.set("pos.pair_code", code);
      settings.set("pos.pair_expires", expires);
      await settings.save();
      res.json({ success: true, data: { code, expires_at: expires } });
    }),
  );

  prop.app.put(
    `${path}/devices/:did`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      if (!validId(req.params.did)) throw new Bad(MSG.badId);
      const name = text(req.body || {}, "name", 40, { required: true });
      const d = await M.RestDevice.findOneAndUpdate({ _id: req.params.did, business_id: ctx.business._id, revoked: false }, { $set: { name } }, { returnDocument: "after" }).select("-token_hash").lean();
      if (!d) throw new Bad(P.deviceGone, 404);
      res.json({ success: true, data: d, message: MSG.saved });
    }),
  );

  prop.app.delete(
    `${path}/devices/:did`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      if (!validId(req.params.did)) throw new Bad(MSG.badId);
      const r = await M.RestDevice.updateOne({ _id: req.params.did, business_id: ctx.business._id, revoked: false }, { $set: { revoked: true } });
      if (!r.modifiedCount) throw new Bad(P.deviceGone, 404);
      res.json({ success: true, message: MSG.deleted });
    }),
  );

  prop.app.get(
    `${path}/shifts`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
      const limit = 20;
      const filter = { business_id: ctx.business._id };
      const [rows, total, devices] = await Promise.all([
        M.RestShift.find(filter)
          .sort({ opened_at: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        M.RestShift.countDocuments(filter),
        M.RestDevice.find({ business_id: ctx.business._id }).select("name prefix").lean(),
      ]);
      const names = Object.fromEntries(devices.map((d) => [String(d._id), d.name]));
      res.json({ success: true, data: rows.map((s) => ({ ...s, device_name: names[String(s.device_id)] || "" })), pagination: { total, totalPages: Math.max(1, Math.ceil(total / limit)), currentPage: page, pageSize: limit } });
    }),
  );

  // ===================================== DEVICE =====================================
  const pairLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 15 });
  prop.app.post(
    "/api/pos/pair",
    prop.api_auth,
    pairLimit,
    handle(async (req, res) => {
      const code = String(req.body?.code || "").replace(/\D/g, "");
      const name = str(req.body?.name, 40) || "POS";
      if (code.length !== 6) throw new Bad(P.badCode);
      const settings = await M.RestSettings.findOne({ "pos.pair_code": code, "pos.pair_expires": { $gt: new Date() } });
      if (!settings) throw new Bad(P.badCode);
      const business = await Business.findOne({ _id: settings.business_id, deleted: false });
      if (!business || business.category !== "restaurant") throw new Bad(P.badCode);
      if (!business.status) throw new Bad(MSG.suspended, 403);
      const used = await M.RestDevice.countDocuments({ business_id: business._id });
      const token = crypto.randomBytes(32).toString("hex");
      const device = await M.RestDevice.create({ business_id: business._id, name, prefix: prefixOf(used), token_hash: hash(token), kind: ["web", "hub", "app"].includes(req.body?.kind) ? req.body.kind : "web", last_seen: new Date() });
      settings.set("pos.pair_code", "");
      settings.set("pos.pair_expires", null);
      await settings.save();
      res.status(201).json({ success: true, data: { token, device: { _id: device._id, name: device.name, prefix: device.prefix, business_id: business._id } } });
    }),
  );

  // who is calling: the device behind x-device-token (and its restaurant)
  async function deviceOf(req) {
    const token = req.get("x-device-token") || "";
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Bad(P.noDevice, 401, { code: "device" });
    const device = await M.RestDevice.findOne({ token_hash: hash(token), revoked: false });
    if (!device) throw new Bad(P.noDevice, 401, { code: "device" });
    const [business, state, settings] = await Promise.all([Business.findOne({ _id: device.business_id, deleted: false }).lean(), licenseState(device.business_id), M.RestSettings.findOne({ business_id: device.business_id })]);
    if (!business || !settings) throw new Bad(P.noDevice, 401, { code: "device" });
    if (!business.status) throw new Bad(MSG.suspended, 403, { code: "suspended" });
    return { device, business, state, settings };
  }
  kit.deviceOf = deviceOf; // used by the POS "Today" report (restaurant.report.js)
  const licenseOf = (state) => ({
    active: state.restaurant.active,
    expires_at: state.restaurant.expires_at,
    grace_until: state.restaurant.grace_until,
    locked: state.restaurant.locked,
    addons: Object.fromEntries(Object.entries(state.addons).map(([k, v]) => [k, !!v.active])),
  });

  prop.app.get(
    "/api/pos/bootstrap",
    prop.api_auth,
    handle(async (req, res) => {
      const { device, business, state, settings } = await deviceOf(req);
      const bid = business._id;
      const [zones, tables, categories, items, groups, stations, staff, counter, openOrders, shifts, bookings, promos] = await Promise.all([
        M.RestZone.find({ business_id: bid, active: true }).sort({ sort: 1 }).select("name").lean(),
        M.RestTable.find({ business_id: bid, active: true }).sort({ sort: 1, created_date: 1 }).select("name seats zone_id").lean(),
        M.RestCategory.find({ business_id: bid, active: true }).sort({ sort: 1 }).select("name_km name_en color").lean(),
        M.RestItem.find({ business_id: bid, active: true }).sort({ sort: 1 }).select("category_id name_km name_en code photo price sizes addon_group_ids station_id available cost track_stock stock low_stock reward_points").lean(),
        M.RestAddonGroup.find({ business_id: bid }).sort({ sort: 1 }).select("name required min max options").lean(),
        M.RestStation.find({ business_id: bid }).sort({ sort: 1 }).select("name printer").lean(),
        M.RestStaff.find({ business_id: bid, active: true }).sort({ sort: 1 }).select("name role pin_salt pin_check").lean(),
        M.RestCounter.findOne({ business_id: bid }).lean(),
        M.RestOrder.find({ business_id: bid, status: "open" }).lean(),
        M.RestShift.find({ business_id: bid, device_id: device._id, status: "open" }).lean(),
        M.RestBooking.find({ business_id: bid, status: "active" }).lean(),
        state.addons.rest_promos?.active ? M.RestPromo.find({ business_id: bid, active: true }).sort({ sort: 1 }).lean() : [],
      ]);
      // this device's open shift + its orders (for today's numbers on the POS)
      const rewardsInfo = rewards.rewardsOn(state, settings)
        ? {
            ...rewards.settingsView(settings),
            list: (await M.RestReward.find({ business_id: bid, active: true }).sort({ sort: 1, points: 1 }).lean()).map((r) => ({
              _id: r._id,
              name: r.name,
              kind: r.kind,
              points: r.points,
              item_id: r.item_id,
              value: r.value,
              coupon_kind: r.coupon_kind,
            })),
          }
        : null;
      const shiftIds = shifts.map((s) => s._id);
      const shiftOrders = shiftIds.length ? await M.RestOrder.find({ business_id: bid, shift_id: { $in: shiftIds }, status: { $ne: "open" } }).lean() : [];
      device.last_seen = new Date();
      await device.save();
      res.json({
        success: true,
        data: {
          device: { _id: device._id, name: device.name, prefix: device.prefix },
          restaurant: {
            name_km: settings.name_km,
            name_en: settings.name_en || business.name,
            type: settings.type,
            logo: settings.logo?.url || "",
            phone: settings.phone,
            address: settings.address,
            tin: settings.tin,
            color: settings.color,
            pay_mode: settings.pay_mode,
            no_tables: settings.no_tables,
            payment_methods: (settings.payment_methods || []).filter((p) => p.active).map((p) => ({ _id: p._id, name: p.name, kind: p.kind })),
            receipt: { size: settings.receipt_size, footer: settings.receipt_footer, wifi_name: settings.wifi_name, wifi_pass: settings.wifi_pass, numbering: settings.bill_numbering, theme: settings.receipt_theme || "classic" },
            // the bill printer at the counter (needs the Printing add-on): the POS app prints straight to it
            receipt_printer: state.addons.rest_printer?.active ? { type: settings.receipt_printer?.type || "none", address: settings.receipt_printer?.address || "" } : { type: "none", address: "" },
          },
          money: moneyOf(settings),
          pos: posOf(settings),
          pos_theme: settings.pos_theme || "classic", // the POS look (rest_pos_theme)
          license: licenseOf(state),
          // customer display add-on: its look and texts (null = not bought)
          display: state.addons.rest_display?.active ? displayOf(settings) : null,
          // table ordering add-on: guests' orders come in through /api/pos/guest-orders (null = off)
          table_order: tableOrderOf(state, settings),
          // reward points add-on (null = off): rules + what members can swap points for
          rewards: rewardsInfo,
          zones,
          tables,
          categories,
          items: items.map((i) => ({ ...i, photo: i.photo?.url || "" })),
          addon_groups: groups,
          stations,
          staff: staff.map((s) => ({ _id: s._id, name: s.name, role: s.role, pin_salt: s.pin_salt || "", pin_check: s.pin_check || "" })),
          orders: [...openOrders, ...shiftOrders],
          shifts,
          bookings,
          promos: promos.map((p) => ({
            _id: String(p._id),
            name: p.name,
            kind: p.kind,
            value: p.value,
            buy: p.buy,
            get_qty: p.get_qty,
            get_percent: p.get_percent,
            all_items: p.all_items,
            item_ids: p.item_ids,
            category_ids: p.category_ids,
            start_date: p.start_date,
            end_date: p.end_date,
            days: p.days,
            from: p.from,
            to: p.to,
          })),
          cursor: counter?.seq || 0,
          setup_rev: counter?.setup || 0,
          server_time: new Date(),
        },
      });
    }),
  );

  // PIN check online (for staff whose PIN the device can't check offline yet; it learns it here)
  const pinLimit = rate_limit({ windowMs: 5 * 60 * 1000, max: 30 });
  prop.app.post(
    "/api/pos/staff-pin",
    prop.api_auth,
    pinLimit,
    handle(async (req, res) => {
      const { business } = await deviceOf(req);
      const pin = String(req.body?.pin || "");
      if (!/^\d{4}$/.test(pin)) throw new Bad(P.badPin);
      const staff = await M.RestStaff.findOne({ business_id: business._id, pin_key: pinKey(business._id, pin), active: true });
      if (!staff) throw new Bad(P.badPin, 404);
      if (!staff.pin_check) {
        staff.pin_salt = crypto.randomBytes(12).toString("hex");
        staff.pin_check = crypto.createHash("sha256").update(`${staff.pin_salt}:${pin}`).digest("hex");
        await staff.save();
      }
      res.json({ success: true, data: { _id: staff._id, name: staff.name, role: staff.role, pin_salt: staff.pin_salt, pin_check: staff.pin_check } });
    }),
  );

  // the POS unlinks itself: a manager types their PIN (any active staff PIN when the shop has no manager)
  prop.app.post(
    "/api/pos/unlink",
    prop.api_auth,
    pinLimit,
    handle(async (req, res) => {
      const { device, business } = await deviceOf(req);
      const pin = String(req.body?.pin || "");
      if (!/^\d{4}$/.test(pin)) throw new Bad(P.badPin);
      const staff = await M.RestStaff.findOne({ business_id: business._id, pin_key: pinKey(business._id, pin), active: true })
        .select("role")
        .lean();
      if (!staff) throw new Bad(P.badPin, 404);
      if (staff.role !== "manager" && (await M.RestStaff.exists({ business_id: business._id, role: "manager", active: true }))) throw new Bad(P.notManager, 403, { code: "manager" });
      await M.RestDevice.updateOne({ _id: device._id }, { $set: { revoked: true } });
      res.json({ success: true, message: P.selfUnlinked });
    }),
  );

  prop.app.post(
    "/api/pos/sync",
    prop.api_auth,
    handle(async (req, res) => {
      const { device, business, state, settings } = await deviceOf(req);
      const bid = business._id;
      const b = req.body || {};
      const orders = Array.isArray(b.orders) ? b.orders : [];
      const shifts = Array.isArray(b.shifts) ? b.shifts : [];
      const bookings = Array.isArray(b.bookings) ? b.bookings : [];
      if (orders.length > MAX_ORDERS || shifts.length > 50 || bookings.length > 100) throw new Bad(P.tooMany, 413);
      const money = moneyOf(settings);
      const saved = { orders: [], shifts: [], bookings: [] };

      const crossed = []; // items that just got low / sold out (Telegram)
      // ---- orders up ----
      const clean = orders.map(cleanOrder).filter(Boolean);
      const existing = clean.length ? await M.RestOrder.find({ _id: { $in: clean.map((o) => o._id) } }).lean() : [];
      const byId = new Map(existing.map((o) => [o._id, o]));
      for (const incoming of clean) {
        const stored = byId.get(incoming._id);
        if (stored && String(stored.business_id) !== String(bid)) continue; // someone else's id: ignore
        const merged = mergeOrder(stored, incoming);
        // cost of each line when it was sold (for profit): from the device, else the item's cost now
        const missing = merged.lines
          .filter((l) => l.cost === null || l.cost === undefined)
          .map((l) => l.item_id)
          .filter((id) => /^[a-f0-9]{24}$/.test(id));
        const costs = missing.length
          ? new Map(
              (
                await M.RestItem.find({ _id: { $in: missing }, business_id: bid })
                  .select("cost")
                  .lean()
              ).map((i) => [String(i._id), i.cost || 0]),
            )
          : new Map();
        for (const l of merged.lines) if (l.cost === null || l.cost === undefined) l.cost = costs.get(String(l.item_id)) || 0;
        // stock: out once when the bill is paid, back if a paid bill is cancelled
        const by = merged.closed_by?.name || "";
        if (merged.status === "paid" && !merged.stock_applied) {
          crossed.push(...((await applyOrderStock(bid, merged, -1, by)) || []));
          merged.stock_applied = true;
        } else if (merged.status === "void" && merged.stock_applied) {
          await applyOrderStock(bid, stored || merged, +1, by);
          merged.stock_applied = false;
        }
        merged.totals = calc.calcOrder(merged, money);
        await rewards.applyOrderPoints(bid, merged, stored, settings, state); // member points (paid) / back (cancelled)
        merged.currency = money.currency;
        merged.khr_rate = money.khr_rate;
        merged.seq = await nextSeq(bid);
        const doc = { ...merged, business_id: bid, device_id: stored?.device_id || device._id };
        delete doc.__v;
        await M.RestOrder.replaceOne({ _id: incoming._id }, doc, { upsert: true });
        saved.orders.push(incoming._id);
      }

      // ---- shifts up ----
      const newlyClosed = [];
      const newlyOpened = [];
      for (const raw of shifts) {
        if (!raw || !UUID.test(raw._id || "")) continue;
        const stored = await M.RestShift.findById(raw._id).lean();
        if (stored && String(stored.business_id) !== String(bid)) continue;
        const incoming = {
          opened_by: who(raw.opened_by),
          opened_at: date(raw.opened_at) || new Date(),
          opening: { usd: n(raw.opening?.usd, 0, 1e9), khr: n(raw.opening?.khr, 0, 1e12) },
          closed_by: who(raw.closed_by),
          closed_at: date(raw.closed_at),
          counted: { usd: n(raw.counted?.usd, 0, 1e9), khr: n(raw.counted?.khr, 0, 1e12) },
          status: raw.status === "closed" ? "closed" : "open",
          note: str(raw.note, 300),
          version: n(raw.version, 0, 1e9),
        };
        const keep = stored && (stored.status === "closed" || (stored.version || 0) > incoming.version);
        const next = keep ? { ...incoming, ...stored, status: stored.status === "closed" ? "closed" : incoming.status } : { ...stored, ...incoming };
        if (next.status === "closed") {
          // the server works out the numbers itself, from the orders it has
          const shiftOrders = await M.RestOrder.find({ business_id: bid, shift_id: raw._id }).lean();
          const sum = calc.shiftSummary({ _id: raw._id, opening: next.opening }, shiftOrders, money);
          next.totals = sum;
          next.expected = sum.expected;
        }
        next.seq = await nextSeq(bid);
        await M.RestShift.updateOne({ _id: raw._id }, { $set: { ...next, business_id: bid, device_id: stored?.device_id || device._id } }, { upsert: true });
        saved.shifts.push(raw._id);
        if (next.status === "closed" && stored?.status !== "closed") newlyClosed.push({ ...next, _id: raw._id });
        if (!stored) newlyOpened.push({ ...next, _id: raw._id });
      }

      // ---- bookings up ----
      const cleanB = bookings.map(cleanBooking).filter(Boolean);
      const storedB = cleanB.length ? await M.RestBooking.find({ _id: { $in: cleanB.map((x) => x._id) } }).lean() : [];
      const byIdB = new Map(storedB.map((x) => [x._id, x]));
      for (const incoming of cleanB) {
        const stored = byIdB.get(incoming._id);
        if (stored && String(stored.business_id) !== String(bid)) continue;
        const merged = mergeBooking(stored, incoming);
        merged.seq = await nextSeq(bid);
        const doc = { ...merged, business_id: bid, device_id: stored?.device_id || device._id };
        delete doc.__v;
        await M.RestBooking.replaceOne({ _id: incoming._id }, doc, { upsert: true });
        saved.bookings.push(incoming._id);
      }

      // ---- changes down (from every device of this restaurant) ----
      const since = Math.max(0, Number(b.since) || 0);
      const [changed, changedShifts, changedBookings, counter, stock] = await Promise.all([
        M.RestOrder.find({ business_id: bid, seq: { $gt: since } })
          .sort({ seq: 1 })
          .limit(500)
          .lean(),
        M.RestShift.find({ business_id: bid, device_id: device._id, seq: { $gt: since } }).lean(),
        M.RestBooking.find({ business_id: bid, seq: { $gt: since } })
          .sort({ seq: 1 })
          .limit(300)
          .lean(),
        M.RestCounter.findOne({ business_id: bid }).lean(),
        stockMap(bid),
      ]);
      const cursor = changed.length === 500 ? changed.at(-1).seq : counter?.seq || since;

      device.last_seen = new Date();
      device.last_sync = new Date();
      device.pending = Math.max(0, Number(b.pending) || 0);
      await device.save();
      for (const s of newlyOpened) await sendShiftOpen(s, settings, state, device);
      for (const s of newlyClosed) await sendShiftReport(s, settings, state);
      await sendStockAlerts(settings, state, crossed);

      res.json({
        success: true,
        data: {
          saved,
          orders: changed,
          shifts: changedShifts,
          bookings: changedBookings,
          stock,
          cursor,
          more: changed.length === 500,
          setup_rev: counter?.setup || 0,
          license: licenseOf(state),
          pos: posOf(settings),
          table_order: tableOrderOf(state, settings),
          rewards_on: rewards.rewardsOn(state, settings),
          server_time: new Date(),
        },
      });
    }),
  );

  // ===================================== CUSTOMER DISPLAY =====================================
  // A second screen facing the guest. On the same computer the POS talks to it directly (no internet needed);
  // on another tablet it opens /pos/restaurant/display?key=<display_key> and reads what the POS last sent here.
  const lightDevice = async (req) => {
    const token = req.get("x-device-token") || "";
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Bad(P.noDevice, 401, { code: "device" });
    const device = await M.RestDevice.findOne({ token_hash: hash(token), revoked: false });
    if (!device) throw new Bad(P.noDevice, 401, { code: "device" });
    return device;
  };
  prop.app.post(
    "/api/pos/display/key",
    prop.api_auth,
    handle(async (req, res) => {
      const device = await lightDevice(req);
      const state = await licenseState(device.business_id);
      if (!state.addons.rest_display?.active) throw new Bad(P.needDisplay, 402, { product: "rest_display" });
      if (!device.display_key || req.body?.renew) {
        device.display_key = crypto.randomBytes(9).toString("base64url");
        device.display = null;
        await device.save();
      }
      res.json({ success: true, data: { key: device.display_key } });
    }),
  );
  prop.app.put(
    "/api/pos/display",
    prop.api_auth,
    handle(async (req, res) => {
      const token = req.get("x-device-token") || "";
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Bad(P.noDevice, 401, { code: "device" });
      const state = req.body?.state ?? null;
      if (JSON.stringify(state || {}).length > 30000) throw new Bad(P.tooMany, 413);
      const r = await M.RestDevice.updateOne({ token_hash: hash(token), revoked: false, display_key: { $gt: "" } }, { $set: { display: state, display_at: new Date() } });
      if (!r.matchedCount) throw new Bad(P.noDevice, 404);
      res.json({ success: true });
    }),
  );
  const displayLimit = rate_limit({ windowMs: 60 * 1000, max: 120 });
  prop.app.get(
    "/api/pos/display/:key",
    prop.api_auth,
    displayLimit,
    handle(async (req, res) => {
      const key = String(req.params.key || "");
      if (!/^[A-Za-z0-9_-]{8,20}$/.test(key)) throw new Bad(P.noDevice, 404);
      const device = await M.RestDevice.findOne({ display_key: key, revoked: false }).select("display display_at business_id").lean();
      if (!device) throw new Bad(P.noDevice, 404);
      res.json({ success: true, data: { state: device.display, at: device.display_at } });
    }),
  );

  // ===================================== DAILY REPORT (scheduled) =====================================
  // Call every 15–60 min from a scheduler (Vercel Cron, cron-job.org…):
  //   GET /api/cron/daily-report  with header  Authorization: Bearer <CRON_SECRET>  (or ?key=<CRON_SECRET>)
  // Sends each restaurant its day's sales once, after its report time (Cambodia time).
  prop.app.get("/api/cron/daily-report", async (req, res) => {
    const secret = process.env.CRON_SECRET || "";
    const given = (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || String(req.query.key || "");
    if (!secret || given !== secret) return res.sendStatus(404);
    try {
      const now = new Date();
      const local = new Date(now.getTime() + 7 * 3600 * 1000); // Asia/Phnom_Penh, no daylight saving
      const hhmm = local.toISOString().slice(11, 16);
      const dayStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 7 * 3600 * 1000);
      const list = await M.RestSettings.find({
        "telegram.chat_id": { $gt: "" },
        "telegram.daily_report": { $ne: false },
        "telegram.report_time": { $lte: hhmm },
        $or: [{ "telegram.last_report_at": null }, { "telegram.last_report_at": { $lt: dayStart } }],
      }).limit(200);
      let sent = 0;
      for (const s of list) {
        const state = await licenseState(s.business_id);
        if (!state.addons.rest_telegram?.active || state.restaurant.locked) continue;
        const orders = await M.RestOrder.find({ business_id: s.business_id, $or: [{ paid_at: { $gte: dayStart } }, { status: "void", opened_at: { $gte: dayStart } }] }).lean();
        const sum = calc.shiftSummary(
          { _id: "*", opening: {} },
          orders.map((o) => ({ ...o, shift_id: "*" })),
          moneyOf(s),
        );
        const top = {};
        for (const o of orders.filter((x) => x.status === "paid")) for (const l of o.lines || []) if (l.status !== "void") top[l.name_en || l.name_km] = (top[l.name_en || l.name_km] || 0) + l.qty;
        const best = Object.entries(top)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, v], i) => `${i + 1}. ${telegram.escape(k)} × ${v}`);
        const day = local.toISOString().slice(0, 10);
        const ok = await telegram
          .send(s.telegram.chat_id, reportText(`Daily report · ${day}`, s.name_km || s.name_en || "Restaurant", sum, moneyOf(s), best.length ? ["", "🔥 Best sellers", ...best] : []))
          .then(() => true)
          .catch(() => false);
        s.set("telegram.last_report_at", now);
        await s.save();
        if (ok) sent += 1;
      }
      // attendance businesses use the same scheduler
      const att = await (require("../attendance/attendance.addons").dailyReports?.() || Promise.resolve({})).catch(() => ({}));
      // guest houses too (Telegram alerts add-on)
      const gh = await require("../guesthouse/guesthouse.telegram")
        .dailyReports()
        .catch(() => ({}));
      // mini marts: the day's summary (Telegram alerts add-on)
      const mart = await require("../mart/mart.telegram")
        .dailyReports()
        .catch(() => ({}));
      // guest house calendar links (Booking.com / Agoda) on the same scheduler
      const ical = await require("../guesthouse/guesthouse.ical")
        .syncDue()
        .catch(() => ({}));
      // QR Code Generator: Monday summary (Telegram alerts add-on)
      const qr = await require("../qrgen/qrgen.route")
        .weeklyReports()
        .catch(() => ({}));
      // Debt Book: reminders to customers + the owner's summary (auto reminders add-on)
      const debt = await require("../debt/debt.route")
        .dailyReports()
        .catch(() => ({}));
      // Loyalty Stamp Card: the owner's daily summary + stamps that ended (Telegram add-on / expiry add-on)
      const stamp = await require("../stamp/stamp.route")
        .dailyReports()
        .catch(() => ({}));
      // Event Tickets: the organiser's day + guest reminders (Telegram add-ons)
      const event = await (require("../event/event.telegram").tick?.() || Promise.resolve({})).catch(() => ({}));
      // Digital Note: merged alerts, the 08:00 summary, checklist reminders (Telegram alerts add-on)
      const note = await require("../note/note.telegram")
        .tick()
        .catch(() => ({}));
      // Telegram Store: cart reminders (add-on)
      const tgstore = await require("../tgstore/tgstore.route")
        .tick()
        .catch((err) => ({ error: err?.message || String(err) }));
      // "Delete my account": erase the accounts whose 30 days have passed (a few per run)
      const accounts = await require("../../user/account_delete")
        .purgeDueAccounts()
        .catch((err) => ({ error: err?.message || String(err) }));
      // Google Play coin packs: refunds / chargebacks take the coins back (once)
      const googlePlay = await require("../../coin/google.route")
        .syncVoided()
        .catch((err) => ({ error: err?.message || String(err) }));
      res.json({ success: true, checked: list.length, sent, attendance: att, guesthouse: gh, mart, ical, qr, debt, stamp, event, note, tgstore, accounts, googlePlay });
    } catch (err) {
      console.error("[daily-report]", err);
      res.status(500).json({ success: false });
    }
  });
};

module.exports.mergeOrder = mergeOrder;
module.exports.mergeBooking = mergeBooking;
