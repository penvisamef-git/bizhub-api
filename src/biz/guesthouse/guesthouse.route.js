// Guest House (yearly license, 150 coins): room types, rooms, bookings, check-in / check-out and the room bill.
// Base: /api/user/businesses/:id/guesthouse (owner)
//   GET  /                        everything the dashboard needs (license, limits, settings, room types, rooms)
//   PUT  /settings                { currency, check_in, check_out, methods, khr_rate, receipt_note }
//   CRUD /room-types  /rooms      (free: 2 room types, 5 rooms; add-ons gh_types / gh_rooms unlock unlimited, forever)
// Add-ons (forever, bought on the Licenses route): gh_rooms (unlimited rooms), gh_types (unlimited room types),
//   gh_payments (more than 3 payment methods)
//   GET  /stays?from&to | ?q= | ?status=      POST /stays (book, or walk-in with check_in_now)
//   PUT  /stays/:sid              change dates / room / rate / guest
//   POST /stays/:sid/check-in | /check-out { force } | /cancel | /no-show
//   POST /stays/:sid/charges { label, amount, qty }   DELETE /stays/:sid/charges/:cid
//   POST /stays/:sid/payments { method, amount, note } DELETE /stays/:sid/payments/:pid
//   PUT  /stays/:sid/discount { discount }
//   GET  /today   GET /report?month=YYYY-MM   GET /guests?q=
// The license: 7 days after it ends, everything is read-only (402).
const mongoose = require("mongoose");
const M = require("./guesthouse.models");
const Business = require("../business.model");
const License = require("../../license/license.model");
const { statusOf, LicenseError, DAY } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");

const GRACE_DAYS = 7;
const FREE = { rooms: 5, types: 2, methods: 3, staff: 2 };
const ADDONS = [
  "gh_rooms",
  "gh_types",
  "gh_payments",
  "gh_staff",
  "gh_display",
  "gh_printer",
  "gh_website",
  "gh_promos",
  "gh_customers",
  "gh_telegram",
  "gh_police",
  "gh_services",
  "gh_housekeeping",
  "gh_expenses",
  "gh_ical",
  "gh_longstay",
  "gh_reviews",
  "gh_loyalty",
  "gh_branches",
];
const MAX = { types: 30, rooms: 500, slots: 50, charges: 100, payments: 100, nights: 366 };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  notGh: "អាជីវកម្មនេះមិនមែនជាផ្ទះសំណាក់ទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  locked: "ប្រព័ន្ធផ្ទះសំណាក់ផុតកំណត់ហើយ! សូមបន្តដើម្បីប្រើប្រាស់។",
  rowNotFound: "រកមិនឃើញទិន្នន័យ!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
  tooLong: "អត្ថបទវែងពេក!",
  required: "សូមបំពេញ",
  badValue: "តម្លៃមិនត្រឹមត្រូវ!",
  tooMany: "ច្រើនពេក!",
  roomLimit: "បន្ទប់ឥតគិតថ្លៃមានតែ 5។ សូមដោះសោ “បន្ទប់មិនកំណត់”។",
  typeLimit: "ប្រភេទបន្ទប់ឥតគិតថ្លៃមានតែ 2។ សូមដោះសោ “ប្រភេទបន្ទប់មិនកំណត់”។",
  methodLimit: "វិធីបង់ប្រាក់ឥតគិតថ្លៃមានតែ 3។ សូមដោះសោ “វិធីបង់ប្រាក់បន្ថែម”។",
  nameTaken: "ឈ្មោះបន្ទប់នេះមានរួចហើយ!",
  inUse: "កំពុងប្រើប្រាស់ មិនអាចលុបបានទេ!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  changed: "ទិន្នន័យបានប្តូរ សូមផ្ទុកឡើងវិញ។",
  busy: "កំពុងដំណើរការ សូមរង់ចាំ។",
  badDates: "ថ្ងៃចូល និងថ្ងៃចេញមិនត្រឹមត្រូវ!",
  taken: "បន្ទប់នេះមានភ្ញៀវកក់រួចហើយនៅថ្ងៃទាំងនេះ!",
  roomOff: "បន្ទប់នេះបិទ!",
  badImage: "សូមដាក់រូបភាព JPG / PNG / WEBP (តិចជាង 6MB)!",
  notBooked: "ការកក់នេះមិនអាចប្តូរបានទេ!",
  notIn: "ភ្ញៀវមិនទាន់ចូលស្នាក់នៅ!",
  tooEarly: "មិនទាន់ដល់ថ្ងៃចូលស្នាក់នៅទេ។ សូមប្តូរថ្ងៃជាមុនសិន។",
  unpaid: "នៅខ្វះប្រាក់ {amt}។ សូមទទួលប្រាក់ជាមុន ឬចុច “ចេញទោះមិនទាន់បង់”។",
  refund: "ភ្ញៀវបង់លើស {amt}។ សូមប្រគល់ប្រាក់វិញ ឬចុច “ចេញទោះយ៉ាងណា”។",
  posLogin: "ឧបករណ៍នេះមិនទាន់ភ្ជាប់ទេ។ សូមភ្ជាប់ម្តងទៀត។",
  posLocked: "សូមវាយ PIN របស់អ្នក។",
  managerOnly: "សម្រាប់តែអ្នកគ្រប់គ្រង ឬម្ចាស់ប៉ុណ្ណោះ។",
  walkInToday: "ភ្ញៀវ walk-in ត្រូវចូលថ្ងៃនេះ!",
};

class Bad extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const validId = (id) => mongoose.Types.ObjectId.isValid(id) && String(id).length === 24;
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const localDay = (t = Date.now()) => new Date(t + 7 * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const nightsOf = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const realDay = (v) => DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function text(body, key, max, { required = false } = {}) {
  if (body[key] === undefined) {
    if (required) throw new Bad(`${MSG.required}: ${key}`);
    return undefined;
  }
  const v = String(body[key] ?? "").trim();
  if (required && !v) throw new Bad(`${MSG.required}: ${key}`);
  if (v.length > max) throw new Bad(`${MSG.tooLong} (${key} ≤ ${max})`);
  return v;
}
function num(body, key, min, max, { required = false, int = false } = {}) {
  if (body[key] === undefined || body[key] === "" || body[key] === null) {
    if (required) throw new Bad(`${MSG.required}: ${key}`);
    return undefined;
  }
  const v = Number(body[key]);
  if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) throw new Bad(`${MSG.badValue} (${key})`);
  return v;
}
const bool = (body, key) => (body[key] === undefined ? undefined : body[key] === true || body[key] === "true");
function oneOf(body, key, list) {
  if (body[key] === undefined) return undefined;
  if (!list.includes(body[key])) throw new Bad(`${MSG.badValue} (${key})`);
  return body[key];
}

// the money of one stay: nights × rate + extras − discount, what was paid, what is left
function billOf(s, currency = "USD") {
  const r = (v) => (currency === "KHR" ? Math.round(v) : Math.round(v * 100) / 100);
  const nights = Math.max(0, nightsOf(s.from, s.to));
  const room = r(nights * s.rate);
  const extras = r((s.charges || []).reduce((a, c) => a + c.amount * (c.qty || 1), 0));
  const total = r(Math.max(0, room + extras - (s.discount || 0)));
  const paid = r((s.payments || []).reduce((a, p) => a + p.amount, 0));
  return { nights, room, extras, discount: s.discount || 0, total, paid, balance: r(total - paid) };
}

async function licenseState(businessId) {
  const rows = await License.find({ business_id: businessId, product: { $in: ["guest_house", ...ADDONS] } }).lean();
  const main = rows.find((r) => r.product === "guest_house");
  const license = statusOf(main);
  const endedAt = license.expires_at ? new Date(license.expires_at).getTime() : null;
  license.grace_until = endedAt ? new Date(endedAt + GRACE_DAYS * DAY) : null;
  license.locked = !!main && !license.active && endedAt !== null && Date.now() > endedAt + GRACE_DAYS * DAY;
  license.in_grace = !!main && !license.active && !license.locked;
  const addons = {};
  for (const key of ADDONS) addons[key] = statusOf(rows.find((r) => r.product === key && !r.item));
  const limits = {
    rooms: addons.gh_rooms.active ? MAX.rooms : FREE.rooms,
    types: addons.gh_types.active ? MAX.types : FREE.types,
    methods: addons.gh_payments.active ? M.METHODS.length : FREE.methods,
    staff: addons.gh_staff.active ? 100 : FREE.staff,
  };
  return { license, addons, limits };
}

async function settingsOf(bid) {
  const found = await M.GhSettings.findOne({ business_id: bid });
  if (found) return found;
  try {
    return await M.GhSettings.create({ business_id: bid });
  } catch (err) {
    if (err.code === 11000) return M.GhSettings.findOne({ business_id: bid });
    throw err;
  }
}

module.exports = (prop) => {
  const base = "/api/user/businesses/:id/guesthouse";
  const guard = [prop.api_auth, customer_auth];

  async function ctxOf(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    const [business, state] = await Promise.all([Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false }), licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== "guest_house") throw new Bad(MSG.notGh);
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (state.license.locked) throw new Bad(MSG.locked, 402, { product: "guest_house" });
    }
    const settings = await settingsOf(business._id);
    return { business, settings, ...state };
  }
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
      if (err instanceof LicenseError) return res.status(err.status).json({ success: false, message: MSG[err.message] || err.message, code: err.message, ...err.extra });
      if (err?.code === 11000) return res.status(409).json({ success: false, message: MSG.nameTaken, code: "name_taken" });
      if (err?.name === "ValidationError" || err?.name === "CastError") return res.status(400).json({ success: false, message: MSG.badValue });
      console.error("[guesthouse]", err);
      res.status(500).json({ success: false, message: MSG.server });
    }
  };
  const ownerName = (req) => req.customer?.name || "owner";
  const sortBy = { sort: 1, created_date: 1 };

  // a stay for the screen: room name + type + the bill
  const stayOut = (s, rooms, currency) => {
    const o = s.toObject ? s.toObject() : { ...s };
    const room = rooms?.get(String(o.room_id));
    return { ...o, room_name: room?.name || "?", type_id: room?.type_id || null, bill: billOf(o, currency) };
  };
  const roomMap = async (bid) => new Map((await M.GhRoom.find({ business_id: bid }).lean()).map((r) => [String(r._id), r]));
  const taken = (bid, roomId, from, to, except) => M.GhStay.exists({ business_id: bid, room_id: roomId, status: { $in: M.LIVE }, from: { $lt: to }, to: { $gt: from }, ...(except ? { _id: { $ne: except } } : {}) });

  // ===================================== OVERVIEW =====================================
  prop.app.get(
    base,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const [types, rooms, prices, renewPrice, live] = await Promise.all([
        M.GhRoomType.find({ business_id: bid }).sort(sortBy).lean(),
        M.GhRoom.find({ business_id: bid }).sort(sortBy).lean(),
        Promise.all(ADDONS.map((k) => priceOf(k))),
        priceOf("guest_house"),
        M.GhStay.countDocuments({ business_id: bid, status: { $in: M.LIVE } }),
      ]);
      const activeRooms = rooms.filter((r) => r.active);
      res.json({
        success: true,
        data: {
          business: ctx.business,
          license: ctx.license,
          limits: ctx.limits,
          free: FREE,
          addons: {
            ...Object.fromEntries(ADDONS.map((k, i) => [k, { price: prices[i], ...ctx.addons[k] }])),
            gh_display_theme: { price: await priceOf("gh_display_theme") },
            gh_print_theme: { price: await priceOf("gh_print_theme") },
            gh_site_theme: { price: await priceOf("gh_site_theme") },
            gh_portal_theme: { price: await priceOf("gh_portal_theme") },
          },
          renew_price: renewPrice,
          settings: ctx.settings,
          services: ctx.addons.gh_services?.active ? (ctx.settings.services || []).filter((x) => x.active) : [],
          types,
          rooms: rooms.map((r, i) => ({ ...r, usable: !r.active || activeRooms.indexOf(r) < ctx.limits.rooms })),
          counts: { rooms: activeRooms.length, types: types.length, live },
          lists: { sources: M.SOURCES, methods: M.METHODS, id_types: M.ID_TYPES, amenities: M.AMENITIES },
        },
      });
    }),
  );

  prop.app.put(
    `${base}/settings`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      const s = ctx.settings;
      const cur = oneOf(b, "currency", ["USD", "KHR"]);
      if (cur) s.currency = cur;
      for (const k of ["check_in", "check_out"]) {
        if (b[k] === undefined) continue;
        if (!M.HHMM.test(String(b[k]))) throw new Bad(`${MSG.badValue} (${k})`);
        s[k] = String(b[k]);
      }
      if (b.methods !== undefined) {
        if (!Array.isArray(b.methods) || !b.methods.length || !b.methods.every((m) => M.METHODS.includes(m))) throw new Bad(`${MSG.badValue} (methods)`);
        const list = [...new Set(b.methods)];
        if (list.length > ctx.limits.methods) throw new Bad(MSG.methodLimit, 402, { code: "method_limit", product: "gh_payments", limit: ctx.limits.methods });
        s.methods = list;
      }
      const rate = num(b, "khr_rate", 1000, 10000);
      if (rate !== undefined) s.khr_rate = rate;
      const note = text(b, "receipt_note", 300);
      if (note !== undefined) s.receipt_note = note;
      const qrLabel = text(b, "pay_qr_label", 60);
      if (qrLabel !== undefined) s.pay_qr_label = qrLabel;
      await s.save();
      res.json({ success: true, data: s, message: MSG.saved });
    }),
  );

  // ===================================== ROOM TYPES + ROOMS =====================================
  const COLLECTIONS = {
    "room-types": {
      model: M.GhRoomType,
      max: MAX.types,
      read: (b, partial) => {
        const set = clean({
          name: text(b, "name", 60, { required: !partial }),
          price: num(b, "price", 0, 100000000, { required: !partial }),
          capacity: num(b, "capacity", 1, 20, { int: true }),
          beds: text(b, "beds", 60),
          active: bool(b, "active"),
          color: b.color === undefined ? undefined : /^#[0-9A-Fa-f]{6}$/.test(String(b.color)) ? String(b.color).toUpperCase() : (() => { throw new Bad(`${MSG.badValue} (color)`); })(), // prettier-ignore
        });
        if (b.amenities !== undefined) {
          if (!Array.isArray(b.amenities) || !b.amenities.every((a) => M.AMENITIES.includes(a))) throw new Bad(`${MSG.badValue} (amenities)`);
          set.amenities = [...new Set(b.amenities)];
        }
        return set;
      },
      before: async (ctx, set, row) => {
        if (!row && (await M.GhRoomType.countDocuments({ business_id: ctx.business._id })) >= ctx.limits.types) throw new Bad(MSG.typeLimit, 402, { code: "type_limit", product: "gh_types", limit: ctx.limits.types });
      },
      inUse: (ctx, row) => M.GhRoom.exists({ business_id: ctx.business._id, type_id: row._id }),
    },
    rooms: {
      model: M.GhRoom,
      max: MAX.rooms,
      read: (b, partial) => {
        const set = clean({ name: text(b, "name", 20, { required: !partial }), floor: text(b, "floor", 20), note: text(b, "note", 500), active: bool(b, "active") });
        // extra details shown on the room: [{ label: "View", value: "River" }]
        if (b.details !== undefined) {
          if (!Array.isArray(b.details) || b.details.length > 12) throw new Bad(`${MSG.badValue} (details)`);
          set.details = b.details.map((d) => ({ label: text(d || {}, "label", 40) || "", value: text(d || {}, "value", 120) || "" })).filter((d) => d.label || d.value);
        }
        if (b.type_id !== undefined || !partial) {
          if (!validId(b.type_id)) throw new Bad(`${MSG.required}: type_id`);
          set.type_id = b.type_id;
        }
        return set;
      },
      before: async (ctx, set, row) => {
        const bid = ctx.business._id;
        if (set.type_id && !(await M.GhRoomType.exists({ _id: set.type_id, business_id: bid }))) throw new Bad(`${MSG.badValue} (type_id)`);
        const turningOn = row ? set.active === true && !row.active : set.active !== false;
        if (turningOn && (await M.GhRoom.countDocuments({ business_id: bid, active: true })) >= ctx.limits.rooms) throw new Bad(MSG.roomLimit, 402, { code: "room_limit", product: "gh_rooms", limit: ctx.limits.rooms });
      },
      inUse: (ctx, row) => M.GhStay.exists({ business_id: ctx.business._id, room_id: row._id }),
    },
  };
  for (const [name, def] of Object.entries(COLLECTIONS)) {
    prop.app.get(
      `${base}/${name}`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, false);
        res.json({ success: true, data: await def.model.find({ business_id: ctx.business._id }).sort(sortBy).lean() });
      }),
    );
    prop.app.post(
      `${base}/${name}`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        const set = def.read(req.body || {}, false);
        if ((await def.model.countDocuments({ business_id: ctx.business._id })) >= def.max) throw new Bad(MSG.tooMany);
        if (def.before) await def.before(ctx, set, null);
        const last = await def.model.findOne({ business_id: ctx.business._id }).sort({ sort: -1 }).select("sort").lean();
        const row = await def.model.create({ ...set, business_id: ctx.business._id, sort: (last?.sort ?? -1) + 1 });
        res.status(201).json({ success: true, data: row, message: MSG.saved });
      }),
    );
    prop.app.put(
      `${base}/${name}/:rid`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        if (!validId(req.params.rid)) throw new Bad(MSG.badId);
        const row = await def.model.findOne({ _id: req.params.rid, business_id: ctx.business._id });
        if (!row) throw new Bad(MSG.rowNotFound, 404);
        const set = def.read(req.body || {}, true);
        if (def.before) await def.before(ctx, set, row);
        row.set(set);
        await row.save();
        res.json({ success: true, data: row, message: MSG.saved });
      }),
    );
    prop.app.delete(
      `${base}/${name}/:rid`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        if (!validId(req.params.rid)) throw new Bad(MSG.badId);
        const row = await def.model.findOne({ _id: req.params.rid, business_id: ctx.business._id });
        if (!row) throw new Bad(MSG.rowNotFound, 404);
        if (await def.inUse(ctx, row)) throw new Bad(MSG.inUse, 409, { code: "in_use" });
        await row.deleteOne();
        res.json({ success: true, message: MSG.deleted });
      }),
    );
  }

  // the desk POS (/pos/guest-house) uses the same booking routes: a paired device + a staff PIN session
  const jwt = require("jsonwebtoken");
  const crypto = require("crypto");
  const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
  async function posCtx(req, write, { hk = false } = {}) {
    const raw = String(req.headers["x-gh-device"] || "");
    if (!raw) throw new Bad(MSG.posLogin, 401, { code: "no_device" });
    const device = await M.GhDevice.findOne({ token_hash: sha(raw), revoked: false });
    if (!device) throw new Bad(MSG.posLogin, 401, { code: "no_device" });
    let p;
    try {
      p = jwt.verify(String(req.headers["x-gh-session"] || ""), process.env.JWT_SECRET);
    } catch {
      throw new Bad(MSG.posLocked, 401, { code: "locked" });
    }
    if (p.type !== "gh_staff" || p.did !== String(device._id)) throw new Bad(MSG.posLocked, 401, { code: "locked" });
    const [staff, business, state] = await Promise.all([M.GhStaff.findOne({ _id: p.sid, business_id: device.business_id, active: true }).lean(), Business.findOne({ _id: device.business_id, deleted: false }), licenseState(device.business_id)]);
    if (!staff || (staff.pin_v || 0) !== (p.v || 0)) throw new Bad(MSG.posLocked, 401, { code: "locked" });
    // a housekeeper's phone only opens the housekeeping screen
    if (staff.role === "housekeeper" && !hk) throw new Bad(MSG.managerOnly, 403, { code: "housekeeper" });
    if (!business || business.category !== "guest_house") throw new Bad(MSG.posLogin, 401, { code: "no_device" });
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (state.license.locked) throw new Bad(MSG.locked, 402, { product: "guest_house" });
    }
    if (Date.now() - new Date(device.last_seen || 0).getTime() > 60000) M.GhDevice.updateOne({ _id: device._id }, { $set: { last_seen: new Date() } }).catch(() => {});
    const settings = await settingsOf(business._id);
    return { business, settings, ...state, device, staff, role: staff.role, by: `${staff.name}` };
  }
  // one handler, two doors: the owner dashboard and the desk POS
  function dual(method, path, write, fn, { hk = false } = {}) {
    prop.app[method](
      `${base}${path}`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, write);
        ctx.by = ownerName(req);
        ctx.role = "owner";
        await fn(ctx, req, res);
      }),
    );
    prop.app[method](
      `/api/ghpos${path}`,
      prop.api_auth,
      handle(async (req, res) => fn(await posCtx(req, write, { hk }), req, res)),
    );
  }
  // Telegram alerts (gh_telegram): sent while answering, but never holding the answer back for long
  const TG = require("./guesthouse.telegram");
  const tgAlert = (ctx, kind, info) => TG.soon(TG.alert(ctx.business._id, kind, { by: ctx.by, ...info }, { settings: ctx.settings, addons: ctx.addons, name: ctx.business.name }));
  const managerOnly = (ctx) => {
    if (ctx.role === "desk") throw new Bad(MSG.managerOnly, 403, { code: "manager_only" });
  };

  // staff, desk devices, guest display, payment QR
  require("./guesthouse.pos")(prop, { base, guard, handle, ctxOf, posCtx, Bad, MSG, text, num, bool, oneOf, validId, licenseState, settingsOf, sha, jwt, ownerName, M, Business });
  // the guest house website (/g/<slug>)
  require("./guesthouse.site")(prop, { base, guard, handle, ctxOf, settingsOf, licenseState, Bad, MSG, text, bool, Business });

  // ===================================== STAYS =====================================
  const loadStay = async (ctx, sid) => {
    if (!validId(sid)) throw new Bad(MSG.badId);
    const s = await M.GhStay.findOne({ _id: sid, business_id: ctx.business._id });
    if (!s) throw new Bad(MSG.rowNotFound, 404);
    return s;
  };
  const readDates = (b, cur = {}) => {
    const from = b.from !== undefined ? String(b.from) : cur.from;
    const to = b.to !== undefined ? String(b.to) : cur.to;
    if (!realDay(from || "") || !realDay(to || "") || to <= from || nightsOf(from, to) > MAX.nights) throw new Bad(MSG.badDates, 400, { code: "bad_dates" });
    return { from, to };
  };
  const optDay = (g, key) => {
    const v = text(g, key, 10);
    if (v && !realDay(v)) throw new Bad(`${MSG.badValue} (${key})`);
    return v;
  };
  const readGuest = (b, cur = null) => {
    const g = b.guest || {};
    const set = clean({
      name: text(g, "name", 80, { required: !cur }),
      phone: text(g, "phone", 30),
      id_type: oneOf(g, "id_type", M.ID_TYPES),
      id_number: text(g, "id_number", 40),
      nationality: text(g, "nationality", 40),
      gender: oneOf(g, "gender", ["", "m", "f"]),
      dob: optDay(g, "dob"),
      visa_type: text(g, "visa_type", 30),
      visa_until: optDay(g, "visa_until"),
    });
    return cur ? { ...cur, ...set } : set;
  };
  const roomOf = async (ctx, roomId) => {
    if (!validId(roomId)) throw new Bad(`${MSG.required}: room_id`);
    const room = await M.GhRoom.findOne({ _id: roomId, business_id: ctx.business._id }).lean();
    if (!room) throw new Bad(`${MSG.badValue} (room_id)`);
    if (!room.active) throw new Bad(MSG.roomOff, 409, { code: "room_off" });
    return room;
  };
  const reply = async (res, ctx, stay, status = 200) => res.status(status).json({ success: true, data: stayOut(stay, await roomMap(ctx.business._id), ctx.settings.currency), message: MSG.saved });

  dual("get", "/stays", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const q = { business_id: bid };
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    if (realDay(from) && realDay(to)) Object.assign(q, { from: { $lt: to }, to: { $gt: from }, status: { $in: ["booked", "in", "out"] } });
    if (M.STATUSES.includes(req.query.status)) q.status = req.query.status;
    const term = String(req.query.q || "")
      .trim()
      .slice(0, 40);
    if (term) {
      const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ "guest.name": rx }, { "guest.phone": rx }, { no: rx }, { "guest.id_number": rx }];
    }
    const rows = await M.GhStay.find(q).sort({ from: -1, created_date: -1 }).limit(500).lean();
    const rooms = await roomMap(bid);
    res.json({ success: true, data: rows.map((s) => stayOut(s, rooms, ctx.settings.currency)) });
  });
  dual("get", "/stays/:sid", false, async (ctx, req, res) => {
    await reply(res, ctx, await loadStay(ctx, req.params.sid));
  });

  // a booking (or a walk-in that checks in now)
  dual("post", "/stays", true, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const b = req.body || {};
    const clientId = typeof b.client_id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(b.client_id) ? b.client_id : undefined;
    if (clientId) {
      const again = await M.GhStay.findOne({ business_id: bid, client_id: clientId });
      if (again) return reply(res, ctx, again, 200); // sent again after a lost answer
    }
    const today = localDay();
    const now = bool(b, "check_in_now") === true;
    const { from, to } = readDates(b);
    if (now && from !== today) throw new Bad(MSG.walkInToday, 400, { code: "walk_in_today" });
    if (!now && from < addDays(today, -1)) throw new Bad(MSG.badDates, 400, { code: "bad_dates" });
    const room = await roomOf(ctx, b.room_id);
    const type = await M.GhRoomType.findOne({ _id: room.type_id, business_id: bid }).lean();
    const rate = num(b, "rate", 0, 100000000) ?? type?.price ?? 0;
    if (await taken(bid, room._id, from, to)) throw new Bad(MSG.taken, 409, { code: "taken" });
    const deposit = num(b, "deposit", 0, 100000000) || 0;
    const method = oneOf(b, "method", M.METHODS) || ctx.settings.methods?.[0] || "cash";
    const counter = await M.GhSettings.findOneAndUpdate({ business_id: bid }, { $inc: { next_no: 1 } }, { returnDocument: "before" });
    const stay = await M.GhStay.create({
      business_id: bid,
      no: `B-${String(counter.next_no).padStart(4, "0")}`,
      room_id: room._id,
      status: now ? "in" : "booked",
      from,
      to,
      rate,
      guest: readGuest(b),
      adults: num(b, "adults", 1, 20, { int: true }) ?? 1,
      children: num(b, "children", 0, 20, { int: true }) ?? 0,
      source: oneOf(b, "source", M.SOURCES) || (now ? "walk_in" : "phone"),
      note: text(b, "note", 500) || "",
      payments: deposit > 0 ? [{ method, amount: deposit, note: now ? "" : "deposit", by: ctx.by }] : [],
      checked_in_at: now ? new Date() : null,
      by: ctx.by,
      ...(clientId ? { client_id: clientId } : {}),
    });
    // a second booking may have slipped in at the same moment: keep the first one
    const clash = await M.GhStay.findOne({ business_id: bid, room_id: room._id, status: { $in: M.LIVE }, from: { $lt: to }, to: { $gt: from }, _id: { $ne: stay._id } })
      .sort({ created_date: 1, _id: 1 })
      .lean();
    if (clash && String(clash._id) < String(stay._id)) {
      await stay.deleteOne();
      throw new Bad(MSG.taken, 409, { code: "taken" });
    }
    await reply(res, ctx, stay, 201);
  });

  // change a booking / a stay
  dual("put", "/stays/:sid", true, async (ctx, req, res) => {
    const stay = await loadStay(ctx, req.params.sid);
    if (!M.LIVE.includes(stay.status)) throw new Bad(MSG.notBooked, 409, { code: "not_live" });
    const b = req.body || {};
    if (stay.status === "in" && b.from !== undefined && String(b.from) !== stay.from) throw new Bad(MSG.badDates, 400, { code: "in_from" });
    const { from, to } = readDates(b, stay);
    let roomId = stay.room_id;
    if (b.room_id !== undefined && String(b.room_id) !== String(stay.room_id)) roomId = (await roomOf(ctx, b.room_id))._id;
    if (await taken(ctx.business._id, roomId, from, to, stay._id)) throw new Bad(MSG.taken, 409, { code: "taken" });
    stay.set(
      clean({
        from,
        to,
        room_id: roomId,
        rate: num(b, "rate", 0, 100000000),
        adults: num(b, "adults", 1, 20, { int: true }),
        children: num(b, "children", 0, 20, { int: true }),
        source: oneOf(b, "source", M.SOURCES),
        note: text(b, "note", 500),
      }),
    );
    if (b.guest !== undefined) stay.guest = readGuest(b, stay.guest.toObject ? stay.guest.toObject() : stay.guest);
    await stay.save();
    await reply(res, ctx, stay);
  });

  // ---- ID card / passport photos (optional): the desk takes a photo so everyone knows who the guest is ----
  const multer = require("multer");
  const { uploadBuffer, deleteFile } = require("../../util/cloudinary");
  const idUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 6 * 1024 * 1024, files: 1 },
    fileFilter: (r, file, cb) => (["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
  });
  const withPhoto = (req, res, next) =>
    idUpload.single("photo")(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: MSG.badImage, code: "bad_image" });
      next();
    });
  const idPhotos = (path, handler) => {
    prop.app.post(
      `${base}${path}`,
      ...guard,
      withPhoto,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        ctx.by = ownerName(req);
        ctx.role = "owner";
        await handler(ctx, req, res);
      }),
    );
    prop.app.post(
      `/api/ghpos${path}`,
      prop.api_auth,
      withPhoto,
      handle(async (req, res) => handler(await posCtx(req, true), req, res)),
    );
  };
  idPhotos("/stays/:sid/id-photos", async (ctx, req, res) => {
    const stay = await loadStay(ctx, req.params.sid);
    if (!req.file) throw new Bad(MSG.badImage, 400, { code: "no_file" });
    if ((stay.id_photos || []).length >= 4) throw new Bad(MSG.tooMany);
    const saved = await uploadBuffer(req.file, "guesthouse/ids");
    stay.id_photos.push({ url: saved.url, public_id: saved.public_id || "", by: ctx.by });
    await stay.save();
    await reply(res, ctx, stay, 201);
  });
  dual("delete", "/stays/:sid/id-photos/:pid", true, async (ctx, req, res) => {
    const stay = await loadStay(ctx, req.params.sid);
    const ph = stay.id_photos.id(req.params.pid);
    if (!ph) throw new Bad(MSG.rowNotFound, 404);
    const pub = ph.public_id;
    ph.deleteOne();
    await stay.save();
    if (pub) deleteFile(pub).catch(() => {});
    await reply(res, ctx, stay);
  });

  dual("post", "/stays/:sid/check-in", true, async (ctx, req, res) => {
    const stay = await loadStay(ctx, req.params.sid);
    if (stay.status !== "booked") throw new Bad(MSG.notBooked, 409, { code: "not_booked" });
    const today = localDay();
    if (stay.from > today) throw new Bad(MSG.tooEarly, 409, { code: "too_early" });
    // the room may still have someone in it (they haven't checked out yet)
    if (await M.GhStay.exists({ business_id: ctx.business._id, room_id: stay.room_id, status: "in", _id: { $ne: stay._id } })) throw new Bad(MSG.taken, 409, { code: "occupied" });
    // arrived late: the nights before today aren't counted
    if (stay.from < today && bool(req.body || {}, "keep_dates") !== true) stay.from = today < stay.to ? today : stay.from;
    stay.status = "in";
    stay.checked_in_at = new Date();
    await stay.save();
    await tgAlert(ctx, "check_in", { stay });
    await reply(res, ctx, stay);
  });
  dual("post", "/stays/:sid/check-out", true, async (ctx, req, res) => {
    const stay = await loadStay(ctx, req.params.sid);
    if (stay.status !== "in") throw new Bad(MSG.notIn, 409, { code: "not_in" });
    const today = localDay();
    // leaving early: the stay ends today (at least one night)
    if (stay.to > today) stay.to = today > stay.from ? today : addDays(stay.from, 1);
    const bill = billOf(stay, ctx.settings.currency);
    if (bill.balance !== 0 && bool(req.body || {}, "force") !== true) {
      const money = (v) => (ctx.settings.currency === "KHR" ? `${Math.abs(v).toLocaleString("en-US")}៛` : `$${Math.abs(v).toFixed(2)}`);
      if (bill.balance > 0) throw new Bad(MSG.unpaid.replace("{amt}", money(bill.balance)), 409, { code: "unpaid", balance: bill.balance, to: stay.to, nights: bill.nights, total: bill.total });
      throw new Bad(MSG.refund.replace("{amt}", money(bill.balance)), 409, { code: "refund", balance: bill.balance, to: stay.to, nights: bill.nights, total: bill.total });
    }
    stay.status = "out";
    stay.checked_out_at = new Date();
    await stay.save();
    // housekeeping: the room needs cleaning now
    if (ctx.addons.gh_housekeeping?.active) await M.GhRoom.updateOne({ _id: stay.room_id, business_id: ctx.business._id }, { $set: { hk: "dirty", hk_at: new Date(), hk_by: ctx.by, hk_note: "" } });
    await tgAlert(ctx, "check_out", { stay, bill: billOf(stay, ctx.settings.currency) });
    // review link (gh_reviews) + loyalty points (gh_loyalty)
    await require("./guesthouse.guests")
      .afterCheckout(ctx, stay, billOf(stay, ctx.settings.currency))
      .catch((err) => console.error("[guesthouse] after check-out", err));
    await reply(res, ctx, stay);
  });
  dual("post", "/stays/:sid/cancel", true, async (ctx, req, res) => {
    const stay = await loadStay(ctx, req.params.sid);
    if (stay.status !== "booked") throw new Bad(MSG.notBooked, 409, { code: "not_booked" });
    stay.status = "cancelled";
    stay.cancelled_at = new Date();
    const note = text(req.body || {}, "note", 500);
    if (note) stay.note = [stay.note, `✖ ${note}`].filter(Boolean).join("\n").slice(0, 500);
    await stay.save();
    await reply(res, ctx, stay);
  });
  dual("post", "/stays/:sid/no-show", true, async (ctx, req, res) => {
    const stay = await loadStay(ctx, req.params.sid);
    if (stay.status !== "booked") throw new Bad(MSG.notBooked, 409, { code: "not_booked" });
    if (stay.from > localDay()) throw new Bad(MSG.tooEarly, 409, { code: "too_early" });
    stay.status = "no_show";
    stay.cancelled_at = new Date();
    await stay.save();
    await reply(res, ctx, stay);
  });

  // ---- the bill ----
  const notCancelled = (stay) => {
    if (["cancelled"].includes(stay.status)) throw new Bad(MSG.notBooked, 409, { code: "cancelled" });
  };
  dual("post", "/stays/:sid/charges", true, async (ctx, req, res) => {
    const stay = await loadStay(ctx, req.params.sid);
    notCancelled(stay);
    if (stay.charges.length >= MAX.charges) throw new Bad(MSG.tooMany);
    const b = req.body || {};
    const cid = typeof b.client_id === "string" ? b.client_id.slice(0, 64) : "";
    if (cid && stay.charges.some((c) => c.client_id === cid)) return reply(res, ctx, stay, 200);
    // from the extra services menu: name + price come from the menu (the price can still be changed)
    const svc = typeof b.service_id === "string" && ctx.addons.gh_services?.active ? (ctx.settings.services || []).find((x) => String(x._id) === b.service_id) : null;
    stay.charges.push({
      label: svc && !b.label ? svc.name : text(b, "label", 80, { required: true }),
      amount: svc && (b.amount === undefined || b.amount === "") ? svc.price : num(b, "amount", 0, 100000000, { required: true }),
      qty: num(b, "qty", 1, 1000, { int: true }) ?? 1,
      by: ctx.by,
      client_id: cid,
      service_id: svc ? String(svc._id) : "",
    });
    await stay.save();
    await reply(res, ctx, stay, 201);
  });
  dual("delete", "/stays/:sid/charges/:cid", true, async (ctx, req, res) => {
    managerOnly(ctx);
    const stay = await loadStay(ctx, req.params.sid);
    const line = stay.charges.id(req.params.cid);
    if (!line) throw new Bad(MSG.rowNotFound, 404);
    line.deleteOne();
    await stay.save();
    await reply(res, ctx, stay);
  });
  dual("post", "/stays/:sid/payments", true, async (ctx, req, res) => {
    const stay = await loadStay(ctx, req.params.sid);
    if (stay.payments.length >= MAX.payments) throw new Bad(MSG.tooMany);
    const b = req.body || {};
    const amount = num(b, "amount", -100000000, 100000000, { required: true });
    if (!amount) throw new Bad(`${MSG.badValue} (amount)`);
    const pid = typeof b.client_id === "string" ? b.client_id.slice(0, 64) : "";
    if (pid && stay.payments.some((p) => p.client_id === pid)) return reply(res, ctx, stay, 200);
    const method = oneOf(b, "method", M.METHODS) || "cash";
    stay.payments.push({ method, amount, note: text(b, "note", 120) || "", by: ctx.by, client_id: pid });
    await stay.save();
    await tgAlert(ctx, "payment", { stay, amount, method, bill: billOf(stay, ctx.settings.currency) });
    await reply(res, ctx, stay, 201);
  });
  dual("delete", "/stays/:sid/payments/:pid", true, async (ctx, req, res) => {
    managerOnly(ctx);
    const stay = await loadStay(ctx, req.params.sid);
    const line = stay.payments.id(req.params.pid);
    if (!line) throw new Bad(MSG.rowNotFound, 404);
    line.deleteOne();
    await stay.save();
    await reply(res, ctx, stay);
  });
  dual("put", "/stays/:sid/discount", true, async (ctx, req, res) => {
    managerOnly(ctx);
    const stay = await loadStay(ctx, req.params.sid);
    notCancelled(stay);
    stay.discount = num(req.body || {}, "discount", 0, 100000000, { required: true });
    await stay.save();
    await reply(res, ctx, stay);
  });

  // ===================================== TODAY / REPORT / GUESTS =====================================
  dual("get", "/today", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const today = localDay();
    const dayStart = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 3600000);
    const [rooms, types, live, paidToday] = await Promise.all([
      M.GhRoom.find({ business_id: bid, active: true }).sort(sortBy).lean(),
      M.GhRoomType.find({ business_id: bid }).lean(),
      M.GhStay.find({ business_id: bid, status: { $in: M.LIVE }, from: { $lte: addDays(today, 60) } }).lean(),
      M.GhStay.find({ business_id: bid, "payments.at": { $gte: dayStart } })
        .select("payments no guest.name")
        .lean(),
    ]);
    const cur = ctx.settings.currency;
    const rmap = new Map(rooms.map((r) => [String(r._id), r]));
    const out = (s) => stayOut(s, rmap, cur);
    const typeOf = new Map(types.map((t) => [String(t._id), t]));
    const arrivals = live.filter((s) => s.status === "booked" && s.from <= today).sort((a, b) => (a.from < b.from ? -1 : 1));
    const inHouse = live.filter((s) => s.status === "in");
    const departures = inHouse.filter((s) => s.to <= today);
    const board = rooms.map((r) => {
      const here = inHouse.find((s) => String(s.room_id) === String(r._id));
      const next = live.filter((s) => s.status === "booked" && String(s.room_id) === String(r._id)).sort((a, b) => (a.from < b.from ? -1 : 1))[0];
      const state = here ? (here.to <= today ? "due_out" : "occupied") : next && next.from <= today ? "arriving" : "free";
      return {
        _id: r._id,
        name: r.name,
        floor: r.floor,
        type: typeOf.get(String(r.type_id))?.name || "",
        color: typeOf.get(String(r.type_id))?.color || "",
        state,
        hk: ctx.addons.gh_housekeeping?.active ? r.hk || "ready" : null,
        stay: here ? out(here) : next && next.from <= today ? out(next) : null,
        next: !here && next && next.from > today ? { _id: next._id, from: next.from, to: next.to, guest: next.guest.name } : here && next && next.from >= here.to ? { _id: next._id, from: next.from, to: next.to, guest: next.guest.name } : null,
      };
    });
    const money = {};
    let taken = 0;
    for (const s of paidToday)
      for (const p of s.payments)
        if (new Date(p.at) >= dayStart) {
          money[p.method] = (money[p.method] || 0) + p.amount;
          taken += p.amount;
        }
    const r = (v) => (cur === "KHR" ? Math.round(v) : Math.round(v * 100) / 100);
    res.json({
      success: true,
      data: {
        day: today,
        rooms: board,
        arrivals: arrivals.map(out),
        departures: departures.map(out),
        in_house: inHouse.map(out),
        counts: { rooms: rooms.length, occupied: inHouse.length, free: board.filter((b) => b.state === "free").length, arrivals: arrivals.length, departures: departures.length },
        money: { total: r(taken), by_method: Object.fromEntries(Object.entries(money).map(([k, v]) => [k, r(v)])) },
        currency: cur,
      },
    });
  });

  // the month report — owner dashboard + desk POS (cashiers too)
  dual("get", "/report", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const month = MONTH_RE.test(String(req.query.month || "")) ? String(req.query.month) : localDay().slice(0, 7);
    const first = `${month}-01`;
    const [yy, mm] = month.split("-").map(Number);
    const next = mm === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
    const days = nightsOf(first, next);
    const cur = ctx.settings.currency;
    const r = (v) => (cur === "KHR" ? Math.round(v) : Math.round(v * 100) / 100);
    const start = new Date(Date.parse(`${first}T00:00:00Z`) - 7 * 3600000);
    const end = new Date(Date.parse(`${next}T00:00:00Z`) - 7 * 3600000);
    const [rooms, types, stays, paid] = await Promise.all([
      M.GhRoom.find({ business_id: bid, active: true }).lean(),
      M.GhRoomType.find({ business_id: bid }).lean(),
      M.GhStay.find({ business_id: bid, status: { $in: ["in", "out"] }, from: { $lt: next }, to: { $gt: first } }).lean(),
      M.GhStay.find({ business_id: bid, payments: { $elemMatch: { at: { $gte: start, $lt: end } } } })
        .select("payments room_id")
        .lean(),
    ]);
    const roomType = new Map(rooms.map((x) => [String(x._id), String(x.type_id)]));
    const byType = new Map(types.map((t) => [String(t._id), { name: t.name, nights: 0, revenue: 0 }]));
    const typeName = new Map(types.map((t) => [String(t._id), t.name]));
    const byRoom = new Map(rooms.map((x) => [String(x._id), { _id: x._id, name: x.name, type: typeName.get(String(x.type_id)) || "", nights: 0, revenue: 0, extras: 0, stays: 0 }]));
    const perDay = Array.from({ length: days }, (_, i) => ({ day: addDays(first, i), occupied: 0 }));
    let nights = 0;
    let roomRevenue = 0;
    let extras = 0;
    for (const s of stays) {
      const a = s.from > first ? s.from : first;
      const z = s.to < next ? s.to : next;
      const n = Math.max(0, nightsOf(a, z));
      nights += n;
      roomRevenue += n * s.rate;
      for (let i = nightsOf(first, a); i < nightsOf(first, a) + n; i++) if (perDay[i]) perDay[i].occupied += 1;
      const t = byType.get(roomType.get(String(s.room_id)));
      if (t) {
        t.nights += n;
        t.revenue += n * s.rate;
      }
      const rm = byRoom.get(String(s.room_id));
      if (rm) {
        rm.nights += n;
        rm.revenue += n * s.rate;
        rm.stays += 1;
      }
      for (const c of s.charges || [])
        if (new Date(c.at) >= start && new Date(c.at) < end) {
          extras += c.amount * (c.qty || 1);
          if (rm) rm.extras += c.amount * (c.qty || 1);
        }
    }
    const byMethod = {};
    let received = 0;
    for (const s of paid)
      for (const p of s.payments)
        if (new Date(p.at) >= start && new Date(p.at) < end) {
          byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;
          received += p.amount;
        }
    const capacity = rooms.length * days;
    res.json({
      success: true,
      data: {
        month,
        currency: cur,
        rooms: rooms.length,
        nights,
        occupancy: capacity ? Math.round((nights / capacity) * 1000) / 10 : 0,
        adr: nights ? r(roomRevenue / nights) : 0,
        room_revenue: r(roomRevenue),
        extras: r(extras),
        received: r(received),
        by_method: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, r(v)])),
        by_type: [...byType.values()].map((t) => ({ ...t, revenue: r(t.revenue) })),
        by_room: [...byRoom.values()].map((x) => ({ ...x, revenue: r(x.revenue), extras: r(x.extras), occupancy: days ? Math.round((x.nights / days) * 1000) / 10 : 0 })),
        days: perDay,
        stays: stays.length,
      },
    });
  });

  // earlier guests (to fill the form again): by name / phone / ID
  dual("get", "/guests", false, async (ctx, req, res) => {
    const term = String(req.query.q || "")
      .trim()
      .slice(0, 40);
    if (term.length < 2) return res.json({ success: true, data: [] });
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const rows = await M.GhStay.find({ business_id: ctx.business._id, $or: [{ "guest.name": rx }, { "guest.phone": rx }, { "guest.id_number": rx }] })
      .sort({ created_date: -1 })
      .limit(100)
      .select("guest from")
      .lean();
    const seen = new Map();
    for (const s of rows) {
      const k = `${s.guest.name.toLowerCase()}|${s.guest.phone}`;
      if (!seen.has(k)) seen.set(k, { ...s.guest, last: s.from, stays: 0 });
      seen.get(k).stays += 1;
    }
    res.json({ success: true, data: [...seen.values()].slice(0, 10) });
  });

  // season / date deals (gh_promos) + customer accounts on the website (gh_customers)
  require("./guesthouse.promos")(prop, { base, guard, handle, ctxOf, Bad, MSG, text, num, bool, validId, M });
  require("./guesthouse.customers")(prop, { base, guard, handle, ctxOf, posCtx, settingsOf, licenseState, Bad, MSG, text, num, bool, Business, jwt, billOf, M });
  // Telegram alerts (gh_telegram) · extra services menu (gh_services) · foreign guest report (gh_police)
  require("./guesthouse.telegram")(prop, { base, guard, handle, ctxOf, Bad, MSG, bool });
  require("./guesthouse.extras")(prop, { base, guard, handle, ctxOf, Bad, MSG, text, num, M });
  // housekeeping (gh_housekeeping) · expenses & profit (gh_expenses)
  require("./guesthouse.guests")(prop, { base, guard, handle, ctxOf, dual, Bad, MSG, text, num, bool, validId, reply, billOf, managerOnly });
  require("./guesthouse.lease")(prop, { dual, Bad, MSG, text, num, oneOf, validId, realDay, localDay, addDays, managerOnly, M, billOf, reply, readGuest, taken });
  require("./guesthouse.ical")(prop, { base, guard, handle, ctxOf, Bad, MSG, text, bool, validId });
  require("./guesthouse.ops")(prop, { dual, Bad, MSG, text, num, oneOf, validId, realDay, localDay, addDays, managerOnly, M });
};
module.exports.licenseState = licenseState;
module.exports.settingsOf = settingsOf;
module.exports.billOf = billOf;
