// Attendance (business type "attendance") — staff clock in / out on their own phone, checked by GPS.
//
// Owner (dashboard), base /api/user/businesses/:id/attendance
//   GET    /                          settings, license, limits, setup steps, branches, shifts, staff, branch slots
//   PUT    /rules                     { late_grace_min, early_grace_min, ot_after_min, max_accuracy_m }
//   POST   /code                      a new staff link /a/<code> (the old link stops working)
//   GET|POST /branches   PUT|DELETE /branches/:rid        (also /shifts, /staff)
//   POST   /staff/:rid/reset-device   the staff may log in on a new phone
//   POST   /slots                     { item? }  buy one more branch (30 coins / year) or renew slot `item`
//   GET    /today?day=YYYY-MM-DD      everyone's status for a day + their records
//   GET    /review                    records that failed a check (pending) + forgotten clock-outs, last 31 days
//   POST   /punches/:pid/decide       { review: ok | rejected, note }
//   POST   /punches                   { staff_id, kind, at, note }  add a record by hand (note required)
//   DELETE /punches/:pid              remove a hand-made record
//   GET    /report?month=YYYY-MM[&format=csv]   per staff: every day + totals
// Staff (phone web app /a/<code>), header x-att-token
//   GET  /api/att/info/:code   business name + logo for the login screen
//   POST /api/att/login     { code, phone, pin, device_id, device_label }  first login binds this phone
//   GET  /api/att/me        who I am, today's status, what to press next
//   POST /api/att/punch     { kind: in|out, lat, lng, accuracy }   time is the server's
//   GET  /api/att/history?month=YYYY-MM
// Limits: 5 staff (included), 1 branch + 1 per active "att_branch" slot.
// The attendance itself is a yearly license: 7 days after it ends, setup is read-only and clocking stops (402).
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const M = require("./attendance.models");
const C = require("./attendance.calc");
const Business = require("../business.model");
const License = require("../../license/license.model");
const { holidayMap } = require("./attendance.days");
const { planOf, shiftNow, workDaysIn } = require("./attendance.plan");
const { gpsFlags } = require("./attendance.guard");
const { newsFor } = require("./attendance.news");
const { statusOf, buy, LicenseError, DAY } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");
const { rate_limit } = require("../../util/rate_limit");
const { normalizePhone } = require("../../util/firebase_auth");
const multer = require("multer");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");

const MAX_IMAGE_MB = 4;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (IMAGE_TYPES.includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});
// paid looks: staff app (55 coins each) and QR sticker (35 coins each); the first of each list is free
const LOOKS = {
  app: { product: "att_app_theme", list: () => M.APP_THEMES, field: "app_theme" },
  qr: { product: "att_qr_theme", list: () => M.QR_THEMES, field: "qr_theme" },
  kiosk: { product: "att_kiosk_theme", list: () => M.KIOSK_THEMES, field: "kiosk_theme", yearly: true }, // 85 per look per year
};

const GRACE_DAYS = 7;
const STAFF_INCLUDED = 5; // more staff: price decided later
const FREE_BRANCHES = 1;
const MAX = { shifts: 30, staff: 500, slots: 50 };
const TOKEN_DAYS = 180;
const MIN_GAP_SEC = 5; // an accidental double tap is ignored (clock in then out right away is fine)
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  badImage: `អាចបញ្ចូលបានតែរូបភាព jpg, png, webp (អតិបរមា ${MAX_IMAGE_MB}MB)`,
  noFile: "សូមជ្រើសរើសរូបភាព!",
  themeLocked: "សូមទិញរចនាប័ទ្មនេះជាមុនសិន!",
  already: "អ្នកមានរចនាប័ទ្មនេះរួចហើយ!",
  notAttendance: "អាជីវកម្មនេះមិនមែនជាប្រព័ន្ធវត្តមានទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  locked: "ប្រព័ន្ធវត្តមាននេះផុតកំណត់ហើយ! សូមបន្តដើម្បីប្រើប្រាស់។",
  rowNotFound: "រកមិនឃើញទិន្នន័យ!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
  tooLong: "អត្ថបទវែងពេក!",
  required: "សូមបំពេញ",
  badValue: "តម្លៃមិនត្រឹមត្រូវ!",
  tooMany: "ច្រើនពេក!",
  staffLimit: "ចំនួនបុគ្គលិកពេញហើយ។ សូមទិញ “បុគ្គលិកបន្ថែម” (+5 នាក់)។",
  branchLimit: "ចំនួនសាខាពេញហើយ។ សូមទិញសាខាបន្ថែម។",
  badPin: "PIN ត្រូវមាន 4 ខ្ទង់!",
  badPhone: "លេខទូរស័ព្ទមិនត្រឹមត្រូវ!",
  phoneTaken: "លេខទូរស័ព្ទនេះមានបុគ្គលិកផ្សេងប្រើហើយ!",
  inUse: "កំពុងប្រើប្រាស់ មិនអាចលុបបានទេ!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  changed: "ទិន្នន័យបានប្តូរ សូមផ្ទុកឡើងវិញ។",
  busy: "កំពុងដំណើរការ សូមរង់ចាំ។",
  needNote: "សូមសរសេរមូលហេតុ!",
  onlyManual: "អាចលុបបានតែកំណត់ត្រាដែលបញ្ចូលដោយដៃ។",
  // staff app
  badLink: "តំណនេះមិនត្រឹមត្រូវ ឬត្រូវបានប្តូរហើយ។",
  badLogin: "លេខទូរស័ព្ទ ឬ PIN មិនត្រឹមត្រូវ!",
  otherPhone: "គណនីនេះភ្ជាប់ជាមួយទូរស័ព្ទផ្សេងរួចហើយ។ សូមសុំម្ចាស់ឱ្យកំណត់ឡើងវិញ។",
  loggedOut: "សូមចូលម្តងទៀត។",
  alreadyIn: "អ្នកបានចុះឈ្មោះចូលរួចហើយ!",
  notIn: "អ្នកមិនទាន់ចុះឈ្មោះចូលនៅឡើយ!",
  tooSoon: "ទើបតែចុចហើយ សូមរង់ចាំមួយភ្លែត។",
  stopped: "ប្រព័ន្ធវត្តមានត្រូវបានបិទបណ្តោះអាសន្ន។ សូមទាក់ទងម្ចាស់។",
  kioskOld: "QR នេះផុតកំណត់ហើយ។ សូមស្កេនម្តងទៀត។",
  tooEarly: "មិនទាន់ដល់ម៉ោងចុះវត្តមានទេ។ អាចចុះបានពីម៉ោង {from}។",
  tooLate: "ហួសម៉ោងចុះវត្តមានហើយ (ដល់ម៉ោង {to})។ សូមទាក់ទងអ្នកគ្រប់គ្រង។",
};

class Bad extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const validId = (id) => mongoose.Types.ObjectId.isValid(id) && String(id).length === 24;
const newCode = () => crypto.randomBytes(12).toString("base64url").replace(/[-_]/g, "").slice(0, 8);
const pinKey = (businessId, pin) =>
  crypto
    .createHmac("sha256", process.env.JWT_SECRET || "bizhub")
    .update(`att:${businessId}:${pin}`)
    .digest("hex");
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const sameKey = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- small field checkers (throw Bad) ----------
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
function num(body, key, min, max, { required = false, int = false, nullable = false } = {}) {
  if (body[key] === undefined || (body[key] === "" && !nullable)) {
    if (required) throw new Bad(`${MSG.required}: ${key}`);
    return undefined;
  }
  if (nullable && (body[key] === null || body[key] === "")) return null;
  const v = Number(body[key]);
  if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) throw new Bad(`${MSG.badValue} (${key})`);
  return v;
}
const bool = (body, key) => (body[key] === undefined ? undefined : !!body[key]);
function oneOf(body, key, list) {
  if (body[key] === undefined) return undefined;
  if (!list.includes(body[key])) throw new Bad(`${MSG.badValue} (${key})`);
  return body[key];
}
function hhmm(body, key, required) {
  if (body[key] === undefined) {
    if (required) throw new Bad(`${MSG.required}: ${key}`);
    return undefined;
  }
  const v = String(body[key]);
  if (!M.HHMM.test(v)) throw new Bad(`${MSG.badValue} (${key})`);
  return v;
}
function pinOf(body, required) {
  if (body.pin === undefined || body.pin === "") {
    if (required) throw new Bad(MSG.badPin);
    return undefined;
  }
  const v = String(body.pin);
  if (!/^\d{4}$/.test(v)) throw new Bad(MSG.badPin);
  return v;
}

// ---------- license / limits ----------
async function licenseState(businessId) {
  const rows = await License.find({ business_id: businessId, product: { $in: ["attendance", "att_branch", "att_staff", ...M.ATT_ADDONS] } }).lean();
  const main = rows.find((r) => r.product === "attendance");
  const license = statusOf(main);
  const endedAt = license.expires_at ? new Date(license.expires_at).getTime() : null;
  license.grace_until = endedAt ? new Date(endedAt + GRACE_DAYS * DAY) : null;
  license.locked = !!main && !license.active && endedAt !== null && Date.now() > endedAt + GRACE_DAYS * DAY;
  license.in_grace = !!main && !license.active && !license.locked;
  const slots = rows
    .filter((r) => r.product === "att_branch")
    .map((r) => ({ item: r.item, ...statusOf(r) }))
    .sort((a, b) => (Number(a.item.split("-")[1]) || 0) - (Number(b.item.split("-")[1]) || 0));
  const activeSlots = slots.filter((s) => s.active).length;
  const staffSlots = rows
    .filter((r) => r.product === "att_staff")
    .map((r) => ({ item: r.item, ...statusOf(r) }))
    .sort((a, b) => (Number(a.item.split("-")[1]) || 0) - (Number(b.item.split("-")[1]) || 0));
  const addons = {};
  for (const key of M.ATT_ADDONS) addons[key] = statusOf(rows.find((r) => r.product === key));
  const staffLimit = STAFF_INCLUDED + M.STAFF_PACK * staffSlots.filter((s) => s.active).length;
  return { license, slots, staff_slots: staffSlots, addons, limits: { staff: staffLimit, branches: FREE_BRANCHES + activeSlots } };
}

async function settingsOf(businessId) {
  const found = await M.AttSettings.findOne({ business_id: businessId });
  if (found) return found;
  for (let i = 0; i < 5; i += 1) {
    try {
      return await M.AttSettings.create({ business_id: businessId, code: newCode() });
    } catch (err) {
      if (err.code !== 11000) throw err;
      const again = await M.AttSettings.findOne({ business_id: businessId });
      if (again) return again;
    }
  }
  throw new Error("could not make a code");
}

// the branches a business may use right now (the first `limit` active ones; more need a slot)
const usableBranches = (branches, limit) => branches.filter((b) => b.active).slice(0, limit);
const branchSort = { sort: 1, created_date: 1 };

const staffOut = (s) => {
  const o = s.toObject ? s.toObject() : { ...s };
  delete o.pin_key;
  delete o.token_v;
  o.has_pin = !!s.pin_key;
  o.device_bound = !!s.device_id;
  delete o.device_id;
  return o;
};

// door kiosk: the QR changes every KIOSK_SEC seconds; a scan is good for the current and the 2 previous codes
const KIOSK_SEC = 20;
const kioskWindow = (t = Date.now()) => Math.floor(t / (KIOSK_SEC * 1000));
const kioskCode = (token, w) =>
  crypto
    .createHmac("sha256", process.env.JWT_SECRET || "bizhub")
    .update(`kiosk:${token}:${w}`)
    .digest("base64url")
    .replace(/[-_]/g, "")
    .slice(0, 10);
// "k" from the scanned link = "<branchId>.<code>" → the branch, or null
function kioskBranch(branches, k) {
  const [id, code] = String(k || "").split(".");
  const b = branches.find((x) => String(x._id) === id && x.kiosk_token);
  if (!b || !code) return null;
  const w = kioskWindow();
  return [w, w - 1, w - 2].some((x) => kioskCode(b.kiosk_token, x) === code) ? b : null;
}
const SELFIE_DAYS = 60;

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const hm = (min) => (min ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}` : "");
const timeOf = (d) => (d ? new Date(new Date(d).getTime() + 7 * C.HOUR).toISOString().slice(11, 16) : "");

// statuses of many staff over some days: { staffId: { day: status } }
async function statusesOf(bid, staffList, days, settings) {
  const sorted = [...days].sort();
  const ids = staffList.map((s) => s._id);
  // the 4 reads don't depend on each other → at the same time (was one after another)
  const [plan, punches, leaves, hol] = await Promise.all([
    planOf(bid, staffList, days),
    // no database sort: sorting by time made Mongo walk every punch of the staff; sorted below instead
    M.AttPunch.find({ business_id: bid, day: { $in: days }, staff_id: { $in: ids } }).lean(),
    M.AttLeave.find({ business_id: bid, status: "approved", staff_id: { $in: ids }, from: { $lte: sorted[sorted.length - 1] }, to: { $gte: sorted[0] } }).lean(),
    holidayMap(bid, sorted[0], sorted[sorted.length - 1]),
  ]);
  punches.sort((a, b) => new Date(a.at) - new Date(b.at));
  const { shiftOf } = plan;
  const by = new Map();
  for (const p of punches) {
    const k = `${p.staff_id}|${p.day}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(p);
  }
  const now = Date.now();
  const out = {};
  for (const s of staffList) {
    const mine = leaves.filter((l) => String(l.staff_id) === String(s._id));
    out[s._id] = {};
    for (const day of days) {
      const list = by.get(`${s._id}|${day}`) || [];
      const shift = plan.at(s, day);
      out[s._id][day] = { ...C.dayStatus({ day, shift, punches: list, rules: settings.rules, now, since: s.created_date ? C.localDay(s.created_date) : "", leave: C.leaveOn(mine, day), holiday: hol.get(day) || "" }), punches: list };
    }
  }
  return { out, shiftOf, plan };
}

module.exports = (prop) => {
  const base = "/api/user/businesses/:id/attendance";
  const guard = [prop.api_auth, customer_auth];
  // filled by attendance.addons.js (Telegram alerts, selfie clean-up)
  const hooks = { onPunch: async () => {}, cleanSelfies: async () => {}, decide: {} };
  // shared decisions (the owner and, with att_manager, a manager in the staff app)
  hooks.decide.punch = async (bid, pid, review, note, by) => {
    const row = await M.AttPunch.findOneAndUpdate({ _id: pid, business_id: bid }, { $set: { review, note, by, decided_at: new Date() } }, { returnDocument: "after" }).lean();
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };

  async function ctxOf(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    const [business, state] = await Promise.all([Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false }), licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== "attendance") throw new Bad(MSG.notAttendance);
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (state.license.locked) throw new Bad(MSG.locked, 402, { product: "attendance" });
    }
    return { business, ...state };
  }

  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
      if (err instanceof LicenseError) return res.status(err.status).json({ success: false, message: MSG[err.message] || err.message, code: err.message, ...err.extra });
      if (err?.code === 11000) return res.status(409).json({ success: false, message: MSG.phoneTaken, code: "phone_taken" });
      if (err?.name === "ValidationError") return res.status(400).json({ success: false, message: MSG.badValue });
      console.error("[attendance]", err);
      res.status(500).json({ success: false, message: MSG.server });
    }
  };

  const ownerName = (req) => req.customer?.name || "owner";

  // the yearly add-ons with price + status
  const addonList = async (ctx) => {
    const out = { att_staff: { price: await priceOf("att_staff"), days: 365 } };
    for (const key of M.ATT_ADDONS) out[key] = { price: await priceOf(key), days: 365, ...ctx.addons[key] };
    out.att_app = { price: await priceOf("att_app"), days: 365, soon: true }; // the phone app — coming soon
    out.att_holidays = { price: await priceOf("att_holidays"), years: (await License.find({ business_id: ctx.business._id, product: "att_holidays" }).select("item").lean()).map((l) => l.item).sort() }; // next years' public holidays
    out.att_web_theme = { price: await priceOf("att_web_theme"), owned: await License.countDocuments({ business_id: ctx.business._id, product: "att_web_theme" }), max: M.WEB_THEMES.length - 1 }; // website looks
    return out;
  };

  // ===================================== OVERVIEW =====================================
  prop.app.get(
    base,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const [settings, branches, shifts, staff, slotPrice, pending, renewPrice] = await Promise.all([
        settingsOf(bid),
        M.AttBranch.find({ business_id: bid }).sort(branchSort).lean(),
        M.AttShift.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }).lean(),
        M.AttStaff.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }),
        priceOf("att_branch"),
        M.AttPunch.countDocuments({ business_id: bid, review: "pending" }),
        priceOf("attendance"),
      ]);
      const usable = new Set(usableBranches(branches, ctx.limits.branches).map((b) => String(b._id)));
      const located = branches.some((b) => b.active && Number.isFinite(b.lat));
      const steps = {
        branch: located,
        shift: shifts.some((s) => s.active),
        staff: staff.some((s) => s.active),
        link: staff.some((s) => s.device_id), // someone has logged in on their phone
      };
      res.json({
        success: true,
        data: {
          business: { _id: bid, name: ctx.business.name, logo_url: settings.logo?.url || ctx.business.logo_url || "", status: ctx.business.status },
          code: settings.code,
          app_theme: settings.app_theme || "classic",
          app_color: settings.app_color || "#4F46E5",
          qr_theme: settings.qr_theme || "classic",
          qr_note: settings.qr_note || "",
          rules: settings.rules,
          holiday_rate: settings.payroll?.holiday_rate || 2,
          license: ctx.license,
          limits: ctx.limits,
          slots: ctx.slots,
          slot_price: slotPrice,
          staff_slots: ctx.staff_slots,
          staff_pack: M.STAFF_PACK,
          addons: await addonList(ctx),
          renew_price: renewPrice,
          counts: {
            staff: staff.filter((s) => s.active).length,
            branches: branches.filter((b) => b.active).length,
            pending,
            leave_pending: await M.AttLeave.countDocuments({ business_id: bid, status: "pending" }),
            fix_pending: await M.AttFix.countDocuments({ business_id: bid, status: "pending" }),
            ot_pending: await M.AttOvertime.countDocuments({ business_id: bid, status: "pending" }),
          },
          selfie_required: settings.selfie?.required !== false,
          setup: { steps, done: Object.values(steps).filter(Boolean).length, total: 4 },
          branches: branches.map((b) => ({ ...b, usable: usable.has(String(b._id)) })),
          shifts,
          staff: staff.map(staffOut),
        },
      });
    }),
  );

  prop.app.put(
    `${base}/rules`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      const set = clean({
        late_grace_min: num(b, "late_grace_min", 0, 120, { int: true }),
        early_grace_min: num(b, "early_grace_min", 0, 120, { int: true }),
        ot_after_min: num(b, "ot_after_min", 0, 240, { int: true }),
        max_accuracy_m: num(b, "max_accuracy_m", 10, 1000, { int: true }),
        auto_out_hours: num(b, "auto_out_hours", 1, 12, { int: true }),
      });
      const settings = await settingsOf(ctx.business._id);
      for (const [k, v] of Object.entries(set)) settings.rules[k] = v;
      await settings.save();
      res.json({ success: true, data: settings.rules, message: MSG.saved });
    }),
  );

  prop.app.post(
    `${base}/code`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const settings = await settingsOf(ctx.business._id);
      for (let i = 0; i < 5; i += 1) {
        try {
          settings.code = newCode();
          await settings.save();
          return res.json({ success: true, data: { code: settings.code }, message: MSG.saved });
        } catch (err) {
          if (err.code !== 11000) throw err;
        }
      }
      throw new Error("code");
    }),
  );

  // ===================================== LOGO + LOOKS =====================================
  const withUpload = (req, res, next) =>
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? MSG.badImage : err.message });
      next();
    });
  // company logo: shown in the staff app, on the QR sticker and in the business list
  prop.app.post(
    `${base}/logo`,
    ...guard,
    withUpload,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!req.file) throw new Bad(MSG.noFile);
      const settings = await settingsOf(ctx.business._id);
      const saved = await uploadBuffer(req.file, "attendance");
      const old = settings.logo?.public_id;
      settings.logo = { url: saved.url, public_id: saved.public_id };
      await settings.save();
      await Business.updateOne({ _id: ctx.business._id }, { $set: { logo_url: saved.url } });
      if (old) deleteFile(old).catch(() => {});
      res.status(201).json({ success: true, data: { logo_url: saved.url }, message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/logo`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const settings = await settingsOf(ctx.business._id);
      const old = settings.logo?.public_id;
      settings.logo = { url: "", public_id: "" };
      await settings.save();
      await Business.updateOne({ _id: ctx.business._id }, { $set: { logo_url: "" } });
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: { logo_url: "" }, message: MSG.saved });
    }),
  );

  // { app: { list, free, price, owned[], current }, qr: {...}, qr_note }
  async function looksOf(bid, settings) {
    // kiosk looks are yearly: only the ones still running count
    const rows = await License.find({ business_id: bid, product: { $in: ["att_app_theme", "att_qr_theme", "att_kiosk_theme"] }, $or: [{ expires_at: null }, { expires_at: { $gt: new Date() } }] })
      .select("product item expires_at")
      .lean();
    const out = { qr_note: settings.qr_note || "", app_color: settings.app_color || "#4F46E5", kiosk_color: settings.kiosk_color || "#0F766E" };
    for (const [kind, k] of Object.entries(LOOKS)) {
      const list = k.list();
      const mine = rows.filter((r) => r.product === k.product && list.includes(r.item));
      const owned = mine.map((r) => r.item);
      const chosen = settings[k.field] || list[0];
      out[kind] = {
        list,
        free: list[0],
        price: await priceOf(k.product),
        yearly: !!k.yearly,
        owned,
        until: Object.fromEntries(mine.map((r) => [r.item, r.expires_at])),
        current: chosen,
        live: chosen === list[0] || owned.includes(chosen) ? chosen : list[0],
      };
    }
    return out;
  }
  const ownsLook = (looks, kind, theme) => theme === looks[kind].free || looks[kind].owned.includes(theme);

  prop.app.get(
    `${base}/looks`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      res.json({ success: true, data: await looksOf(ctx.business._id, await settingsOf(ctx.business._id)) });
    }),
  );
  // use a look you own: { app?, qr?, qr_note? }
  prop.app.put(
    `${base}/looks`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      const settings = await settingsOf(ctx.business._id);
      const looks = await looksOf(ctx.business._id, settings);
      for (const [kind, k] of Object.entries(LOOKS)) {
        if (b[kind] === undefined) continue;
        if (!k.list().includes(b[kind])) throw new Bad(`${MSG.badValue} (${kind})`);
        if (!ownsLook(looks, kind, b[kind])) throw new Bad(MSG.themeLocked, 402, { product: k.product, item: b[kind] });
        settings[k.field] = b[kind];
      }
      const note = text(b, "qr_note", 80);
      if (note !== undefined) settings.qr_note = note;
      for (const key of ["app_color", "kiosk_color"]) {
        if (b[key] === undefined) continue;
        const c = String(b[key]).toUpperCase();
        if (!M.COLOR_RE.test(c)) throw new Bad(`${MSG.badValue} (${key})`);
        settings[key] = c;
      }
      await settings.save();
      res.json({ success: true, data: await looksOf(ctx.business._id, settings), message: MSG.saved });
    }),
  );
  // buy one look (app / QR: forever; kiosk: a year, buying again adds a year) and start using it
  prop.app.post(
    `${base}/looks/:kind/:theme`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const k = LOOKS[req.params.kind];
      const theme = req.params.theme;
      if (!k || !k.list().includes(theme)) throw new Bad(MSG.badValue);
      const settings = await settingsOf(ctx.business._id);
      if (theme === k.list()[0]) throw new Bad(MSG.already, 409);
      const r = await buy({ customer: req.customer, business: ctx.business, product: k.product, item: theme });
      settings[k.field] = theme;
      await settings.save();
      res.json({ success: true, data: await looksOf(ctx.business._id, settings), item: theme, charged: r.charged, balance: r.balance, message: MSG.saved });
    }),
  );

  // ===================================== BRANCHES / SHIFTS / STAFF =====================================
  const COLLECTIONS = {
    branches: {
      model: M.AttBranch,
      read: (b, partial) => {
        const set = clean({
          name: text(b, "name", 80, { required: !partial }),
          address: text(b, "address", 200),
          lat: num(b, "lat", -90, 90, { nullable: true }),
          lng: num(b, "lng", -180, 180, { nullable: true }),
          radius_m: num(b, "radius_m", 20, 2000, { int: true }),
          active: bool(b, "active"),
        });
        return set;
      },
      before: async (ctx, set, row) => {
        const lat = set.lat !== undefined ? set.lat : (row?.lat ?? null);
        const lng = set.lng !== undefined ? set.lng : (row?.lng ?? null);
        if ((lat === null) !== (lng === null)) throw new Bad(`${MSG.badValue} (lat/lng)`);
        const turningOn = row ? set.active === true && !row.active : set.active !== false;
        if (turningOn) {
          const active = await M.AttBranch.countDocuments({ business_id: ctx.business._id, active: true });
          if (active >= ctx.limits.branches) throw new Bad(MSG.branchLimit, 402, { code: "branch_limit", product: "att_branch", limit: ctx.limits.branches });
        }
      },
      after: async (ctx, row, deleted) => {
        if (deleted) await M.AttStaff.updateMany({ business_id: ctx.business._id }, { $pull: { branch_ids: row._id } });
      },
    },
    shifts: {
      model: M.AttShift,
      max: MAX.shifts,
      read: (b, partial) => {
        const set = clean({
          name: text(b, "name", 60, { required: !partial }),
          start: hhmm(b, "start", !partial),
          end: hhmm(b, "end", !partial),
          break_min: num(b, "break_min", 0, 480, { int: true }),
          color:
            b.color === undefined
              ? undefined
              : /^#[0-9A-Fa-f]{6}$/.test(String(b.color))
                ? String(b.color).toUpperCase()
                : (() => {
                    throw new Bad(`${MSG.badValue} (color)`);
                  })(),
          active: bool(b, "active"),
        });
        for (const k of ["in_from", "in_to", "out_from", "out_to"]) {
          if (b[k] === undefined) continue;
          const v = String(b[k] ?? "");
          if (v && !M.HHMM.test(v)) throw new Bad(`${MSG.badValue} (${k})`);
          set[k] = v;
        }
        if (b.days !== undefined) {
          if (!Array.isArray(b.days) || !b.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Bad(`${MSG.badValue} (days)`);
          set.days = [...new Set(b.days)].sort();
        }
        if (set.start && set.end && set.start === set.end) throw new Bad(`${MSG.badValue} (start = end)`);
        return set;
      },
      inUse: (ctx, row) => M.AttStaff.exists({ business_id: ctx.business._id, shift_id: row._id, active: true }),
    },
    staff: {
      model: M.AttStaff,
      max: MAX.staff,
      read: (b, partial) => {
        const set = clean({
          name: text(b, "name", 80, { required: !partial }),
          role: oneOf(b, "role", M.ROLES),
          position: text(b, "position", 60),
          active: bool(b, "active"),
          salary: num(b, "salary", 0, 1000000000),
          pay_type: oneOf(b, "pay_type", M.PAY_TYPES),
          dependents: num(b, "dependents", 0, 10, { int: true }),
          resident: bool(b, "resident"),
          contract: oneOf(b, "contract", ["udc", "fdc"]),
          bank_name: text(b, "bank_name", 40),
          bank_account: text(b, "bank_account", 40),
          account_name: text(b, "account_name", 80),
          id_number: text(b, "id_number", 40),
          address: text(b, "address", 200),
          emergency_name: text(b, "emergency_name", 80),
          emergency_phone: text(b, "emergency_phone", 30),
          notes: text(b, "notes", 500),
        });
        for (const k of ["start_date", "birthday", "contract_end"]) {
          if (b[k] === undefined) continue;
          const v = String(b[k] ?? "");
          if (v && !DAY_RE.test(v)) throw new Bad(`${MSG.badValue} (${k})`);
          set[k] = v;
        }
        if (b.phone !== undefined || !partial) {
          const phone = normalizePhone(b.phone);
          if (!phone) throw new Bad(MSG.badPhone, 400, { code: "bad_phone" });
          set.phone = phone;
        }
        const pin = pinOf(b, !partial);
        if (pin) set.pin = pin;
        if (b.shift_id !== undefined) set.shift_id = b.shift_id || null;
        if (b.branch_ids !== undefined) {
          if (!Array.isArray(b.branch_ids) || b.branch_ids.length > 100 || !b.branch_ids.every(validId)) throw new Bad(`${MSG.badValue} (branch_ids)`);
          set.branch_ids = [...new Set(b.branch_ids.map(String))];
        }
        return set;
      },
      before: async (ctx, set, row) => {
        const bid = ctx.business._id;
        const turningOn = row ? set.active === true && !row.active : set.active !== false;
        if (turningOn) {
          const active = await M.AttStaff.countDocuments({ business_id: bid, active: true });
          if (active >= ctx.limits.staff) throw new Bad(MSG.staffLimit, 402, { code: "staff_limit", product: "att_staff", limit: ctx.limits.staff });
        }
        if (set.shift_id && !(validId(set.shift_id) && (await M.AttShift.exists({ _id: set.shift_id, business_id: bid })))) throw new Bad(`${MSG.badValue} (shift_id)`);
        if (set.branch_ids?.length && (await M.AttBranch.countDocuments({ _id: { $in: set.branch_ids }, business_id: bid })) !== set.branch_ids.length) throw new Bad(`${MSG.badValue} (branch_ids)`);
        if (set.pin) {
          set.pin_key = pinKey(bid, set.pin);
          delete set.pin;
          if (row) set.token_v = (row.token_v || 0) + 1; // a new PIN logs the old phone session out
        }
        if (row && set.active === false && row.active) set.token_v = (set.token_v ?? row.token_v ?? 0) + 1;
        if (row && set.phone && set.phone !== row.phone) set.token_v = (set.token_v ?? row.token_v ?? 0) + 1;
      },
      out: staffOut,
    },
  };

  for (const [name, def] of Object.entries(COLLECTIONS)) {
    const out = def.out || ((r) => r);
    prop.app.get(
      `${base}/${name}`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, false);
        const rows = await def.model.find({ business_id: ctx.business._id }).sort(branchSort);
        res.json({ success: true, data: rows.map(out) });
      }),
    );
    prop.app.post(
      `${base}/${name}`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        const set = def.read(req.body || {}, false);
        if (def.max && (await def.model.countDocuments({ business_id: ctx.business._id })) >= def.max) throw new Bad(MSG.tooMany);
        if (def.before) await def.before(ctx, set, null);
        const last = await def.model.findOne({ business_id: ctx.business._id }).sort({ sort: -1 }).select("sort").lean();
        const row = await def.model.create({ ...set, business_id: ctx.business._id, sort: (last?.sort ?? -1) + 1 });
        res.status(201).json({ success: true, data: out(row), message: MSG.saved });
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
        res.json({ success: true, data: out(row), message: MSG.saved });
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
        if (def.inUse && (await def.inUse(ctx, row))) throw new Bad(MSG.inUse, 409);
        // staff with records are kept (switched off) so old reports still show them
        if (name === "staff" && (await M.AttPunch.exists({ business_id: ctx.business._id, staff_id: row._id }))) {
          row.active = false;
          row.token_v = (row.token_v || 0) + 1;
          row.device_id = "";
          await row.save();
          return res.json({ success: true, data: out(row), kept: true, message: MSG.deleted });
        }
        await row.deleteOne();
        if (def.after) await def.after(ctx, row, true);
        res.json({ success: true, message: MSG.deleted });
      }),
    );
  }

  prop.app.post(
    `${base}/staff/:rid/reset-device`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.rid)) throw new Bad(MSG.badId);
      const row = await M.AttStaff.findOneAndUpdate({ _id: req.params.rid, business_id: ctx.business._id }, { $set: { device_id: "", device_label: "", device_at: null }, $inc: { token_v: 1 } }, { returnDocument: "after" });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, data: staffOut(row), message: MSG.saved });
    }),
  );

  // one more branch / +5 staff (or renew one): { kind: "branch" | "staff", item? }  item = "slot-N"
  prop.app.post(
    `${base}/slots`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const kind = req.body?.kind === "staff" ? "staff" : "branch";
      const list = kind === "staff" ? ctx.staff_slots : ctx.slots;
      const product = kind === "staff" ? "att_staff" : "att_branch";
      let item = req.body?.item;
      if (item !== undefined) {
        if (!list.some((s) => s.item === item)) throw new Bad(`${MSG.badValue} (item)`);
      } else {
        if (list.length >= MAX.slots) throw new Bad(MSG.tooMany);
        // reuse an ended slot before opening a new number
        const ended = list.find((s) => !s.active);
        item = ended ? ended.item : `slot-${list.reduce((m, s) => Math.max(m, Number(s.item.split("-")[1]) || 0), 0) + 1}`;
      }
      const r = await buy({ customer: req.customer, business: ctx.business, product, item, expect: req.body?.expect });
      const state = await licenseState(ctx.business._id);
      res.json({ success: true, data: { item, kind, ...r.status }, slots: state.slots, staff_slots: state.staff_slots, limits: state.limits, charged: r.charged, balance: r.balance, message: MSG.saved });
    }),
  );

  // ===================================== DAILY / REVIEW =====================================

  prop.app.get(
    `${base}/today`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const day = DAY_RE.test(String(req.query.day || "")) ? String(req.query.day) : C.localDay(Date.now());
      const [settings, staff, branches] = await Promise.all([settingsOf(bid), M.AttStaff.find({ business_id: bid, active: true }).sort({ sort: 1, created_date: 1 }).lean(), M.AttBranch.find({ business_id: bid }).lean()]);
      const { out, plan } = await statusesOf(bid, staff, [day], settings);
      const branchName = new Map(branches.map((b) => [String(b._id), b.name]));
      const rows = staff.map((s) => {
        const st = out[s._id][day];
        return {
          staff: staffOut(s),
          shift: plan.at(s, day),
          rostered: plan.entry(s, day) !== undefined,
          ...st,
          punches: st.punches.map((p) => ({ ...p, branch_name: branchName.get(String(p.branch_id)) || "" })),
        };
      });
      const count = (k) => rows.filter((r) => r.status === k).length;
      res.json({
        success: true,
        data: {
          day,
          rows,
          totals: {
            staff: rows.length,
            in: rows.filter((r) => ["working", "present", "missing_out", "extra"].includes(r.status)).length,
            working: count("working"),
            late: rows.filter((r) => r.late_min > 0).length,
            absent: count("absent"),
            not_yet: count("not_yet"),
            off: count("off"),
            leave: count("leave"),
            pending: rows.reduce((a, r) => a + r.pending, 0),
          },
        },
      });
    }),
  );

  prop.app.get(
    `${base}/review`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const today = C.localDay(Date.now());
      const days = Array.from({ length: 31 }, (_, i) => C.addDays(today, -i));
      const [settings, staff, branches, pending] = await Promise.all([
        settingsOf(bid),
        M.AttStaff.find({ business_id: bid }).lean(),
        M.AttBranch.find({ business_id: bid }).lean(),
        M.AttPunch.find({ business_id: bid, review: "pending" }).sort({ at: -1 }).limit(300).lean(),
      ]);
      const staffName = new Map(staff.map((s) => [String(s._id), s.name]));
      const branchName = new Map(branches.map((b) => [String(b._id), b.name]));
      const { out } = await statusesOf(
        bid,
        staff.filter((s) => s.active),
        days,
        settings,
      );
      const missing = [];
      for (const s of staff.filter((x) => x.active))
        for (const day of days) {
          const st = out[s._id][day];
          if (st.status === "missing_out") missing.push({ staff_id: s._id, staff_name: s.name, day, first_in: st.first_in, end: st.end });
        }
      missing.sort((a, b) => (a.day < b.day ? 1 : -1));
      res.json({
        success: true,
        data: {
          pending: pending.map((p) => ({ ...p, staff_name: staffName.get(String(p.staff_id)) || "?", branch_name: branchName.get(String(p.branch_id)) || "" })),
          missing_out: missing,
        },
      });
    }),
  );

  prop.app.post(
    `${base}/punches/:pid/decide`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.pid)) throw new Bad(MSG.badId);
      const review = oneOf(req.body || {}, "review", ["ok", "rejected"]);
      if (!review) throw new Bad(`${MSG.required}: review`);
      const note = text(req.body || {}, "note", 300) || "";
      const row = await hooks.decide.punch(ctx.business._id, req.params.pid, review, note, ownerName(req));
      res.json({ success: true, data: row, message: MSG.saved });
    }),
  );

  // a record added by hand (forgot to clock out, phone broken…): always with a reason
  prop.app.post(
    `${base}/punches`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      const bid = ctx.business._id;
      if (!validId(b.staff_id)) throw new Bad(`${MSG.badValue} (staff_id)`);
      const kind = oneOf(b, "kind", ["in", "out"]);
      if (!kind) throw new Bad(`${MSG.required}: kind`);
      const at = new Date(b.at);
      if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * C.MIN || at.getTime() < Date.now() - 62 * DAY) throw new Bad(`${MSG.badValue} (at)`);
      const note = text(b, "note", 300);
      if (!note) throw new Bad(MSG.needNote, 400, { code: "need_note" });
      const staff = await M.AttStaff.findOne({ _id: b.staff_id, business_id: bid }).lean();
      if (!staff) throw new Bad(MSG.rowNotFound, 404);
      const shift = staff.shift_id ? await M.AttShift.findOne({ _id: staff.shift_id, business_id: bid }).lean() : null;
      let day = DAY_RE.test(String(b.day || "")) ? String(b.day) : null;
      if (!day) {
        if (kind === "in") day = C.workDayOf(at, shift);
        else {
          const open = await M.AttPunch.findOne({ business_id: bid, staff_id: staff._id, kind: "in", review: { $ne: "rejected" }, at: { $lte: at, $gte: new Date(at.getTime() - C.MAX_SHIFT_HOURS * C.HOUR) } })
            .sort({ at: -1 })
            .lean();
          day = open ? open.day : C.workDayOf(at, shift);
        }
      }
      const row = await M.AttPunch.create({ business_id: bid, staff_id: staff._id, kind, at, day, branch_id: staff.branch_ids?.[0] || null, source: "manual", review: "ok", note, by: ownerName(req), decided_at: new Date() });
      res.status(201).json({ success: true, data: row, message: MSG.saved });
    }),
  );

  prop.app.delete(
    `${base}/punches/:pid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.pid)) throw new Bad(MSG.badId);
      const row = await M.AttPunch.findOne({ _id: req.params.pid, business_id: ctx.business._id });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      if (row.source !== "manual") throw new Bad(MSG.onlyManual);
      await row.deleteOne();
      res.json({ success: true, message: MSG.deleted });
    }),
  );

  // ===================================== MONTH REPORT =====================================
  prop.app.get(
    `${base}/report`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const month = MONTH_RE.test(String(req.query.month || "")) ? String(req.query.month) : C.localDay(Date.now()).slice(0, 7);
      const days = C.daysOfMonth(month);
      const settings = await settingsOf(bid);
      // everyone active + anyone switched off who has records this month
      const withRecords = await M.AttPunch.distinct("staff_id", { business_id: bid, day: { $in: days } });
      const staff = await M.AttStaff.find({ business_id: bid, $or: [{ active: true }, { _id: { $in: withRecords } }] })
        .sort({ sort: 1, created_date: 1 })
        .lean();
      const { out, shiftOf } = await statusesOf(bid, staff, days, settings);
      const rows = staff.map((s) => {
        const list = days.map((d) => {
          const st = out[s._id][d];
          return {
            day: d,
            status: st.status,
            leave_type: st.leave_type,
            late_min: st.late_min,
            early_min: st.early_min,
            ot_min: st.ot_min,
            worked_min: st.worked_min,
            first_in: st.first_in,
            last_out: st.last_out,
            pending: st.pending,
            work_day: st.work_day,
          };
        });
        const shift = s.shift_id ? shiftOf.get(String(s.shift_id)) : null;
        return { staff: staffOut(s), shift: shift ? { name: shift.name, start: shift.start, end: shift.end } : null, days: list, totals: C.monthSummary(list) };
      });

      if (req.query.format === "csv") {
        const km = req.query.lang === "km";
        const H = km
          ? ["ឈ្មោះ", "ទូរស័ព្ទ", "តួនាទី", "វេន", "ថ្ងៃធ្វើការ", "មក", "យឺត (ដង)", "យឺត (ម៉ោង)", "ចេញមុន (ដង)", "អវត្តមាន", "ភ្លេចចេញ", "ថ្ងៃបន្ថែម", "ច្បាប់ (ថ្ងៃ)", "ថែមម៉ោង", "ម៉ោងធ្វើការ"]
          : ["Name", "Phone", "Position", "Shift", "Work days", "Present", "Late (times)", "Late (h:mm)", "Left early (times)", "Absent", "Missed clock-out", "Extra days", "Leave days", "Overtime (h:mm)", "Worked (h:mm)"];
        const lines = [[...H, ...days.map((d) => d.slice(8))].map(csvCell).join(",")];
        const code = { present: "P", working: "P", extra: "X", absent: "A", missing_out: "M", off: "-", upcoming: "", not_yet: "", before: "", leave: "V" };
        for (const r of rows) {
          const t = r.totals;
          const cells = [
            r.staff.name,
            r.staff.phone,
            r.staff.position,
            r.shift ? `${r.shift.name} ${r.shift.start}-${r.shift.end}` : "",
            t.work_days,
            t.present,
            t.late,
            hm(t.late_min),
            t.early,
            t.absent,
            t.missing_out,
            t.extra,
            t.leave,
            hm(t.ot_min),
            hm(t.worked_min),
          ];
          const perDay = r.days.map((d) => (d.first_in ? `${timeOf(d.first_in)}-${timeOf(d.last_out)}${d.late_min ? " L" : ""}${d.status === "missing_out" ? " M" : ""}` : (code[d.status] ?? "")));
          lines.push([...cells, ...perDay].map(csvCell).join(","));
        }
        lines.push("");
        lines.push(csvCell(km ? "P = មក · A = អវត្តមាន · M = ភ្លេចចេញ · X = ថ្ងៃបន្ថែម · L = យឺត · V = ច្បាប់ · - = ថ្ងៃឈប់" : "P = present · A = absent · M = missed clock-out · X = extra day · L = late · V = leave · - = day off"));
        const name = `attendance-${month}.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
        return res.send(`﻿${lines.join("\r\n")}`); // BOM: Excel opens Khmer text correctly
      }
      res.json({ success: true, data: { month, days, rows } });
    }),
  );

  // ===================================== STAFF PHONE APP =====================================
  const loginLimit = rate_limit({ windowMs: 15 * 60 * 1000, max: 20, message: "សូមព្យាយាមម្តងទៀតក្រោយ 15 នាទី!" });
  const punchLimit = rate_limit({ windowMs: 60 * 1000, max: 10 });

  const staffToken = (s, deviceId) => jwt.sign({ type: "att_staff", sid: String(s._id), bid: String(s.business_id), d: deviceId, v: s.token_v || 0 }, process.env.JWT_SECRET, { expiresIn: `${TOKEN_DAYS}d` });

  // who is calling: a valid token for an active staff, on the phone it was bound to, still the same PIN
  async function staffCtx(req, forPunch) {
    const raw = req.headers["x-att-token"];
    let p;
    try {
      p = jwt.verify(String(raw || ""), process.env.JWT_SECRET);
    } catch {
      throw new Bad(MSG.loggedOut, 401, { code: "logged_out" });
    }
    if (p.type !== "att_staff" || !validId(p.sid)) throw new Bad(MSG.loggedOut, 401, { code: "logged_out" });
    const staff = await M.AttStaff.findById(p.sid);
    if (!staff || !staff.active || (staff.token_v || 0) !== p.v || !staff.device_id || staff.device_id !== p.d) throw new Bad(MSG.loggedOut, 401, { code: "logged_out" });
    const [business, state, settings] = await Promise.all([Business.findOne({ _id: staff.business_id, deleted: false }).lean(), licenseState(staff.business_id), settingsOf(staff.business_id)]);
    if (!business || business.category !== "attendance") throw new Bad(MSG.loggedOut, 401, { code: "logged_out" });
    if (forPunch && (!business.status || state.license.locked)) throw new Bad(MSG.stopped, 402, { code: "stopped" });
    return { staff, business, settings, ...state };
  }

  // what this staff's day looks like + what the button should do next
  async function meOf(ctx) {
    const { staff, settings } = ctx;
    const bid = staff.business_id;
    const [now, branches, last] = await Promise.all([
      shiftNow(bid, staff),
      M.AttBranch.find({ business_id: bid }).sort(branchSort).lean(),
      M.AttPunch.findOne({ business_id: bid, staff_id: staff._id, review: { $ne: "rejected" } })
        .sort({ at: -1 })
        .lean(),
    ]);
    const usable = usableBranches(branches, ctx.limits.branches);
    const mine = staff.branch_ids?.length ? usable.filter((b) => staff.branch_ids.some((id) => String(id) === String(b._id))) : usable;
    const open = last && last.kind === "in" && Date.now() - new Date(last.at).getTime() <= C.MAX_SHIFT_HOURS * C.HOUR;
    const day = open ? last.day : now.day;
    // the shift of that day (roster or usual); the coming week's plan for "My schedule"
    const week = Array.from({ length: 7 }, (_, i) => C.addDays(C.localDay(Date.now()), i));
    const plan = await planOf(bid, [staff], [...new Set([day, ...week])], { on: now.plan.on });
    const shift = plan.at(staff, day);
    const [punches, leave, hol] = await Promise.all([
      M.AttPunch.find({ business_id: bid, staff_id: staff._id, day }).sort({ at: 1 }).lean(),
      M.AttLeave.findOne({ business_id: bid, staff_id: staff._id, status: "approved", from: { $lte: day }, to: { $gte: day } }).lean(),
      holidayMap(bid, day, day),
    ]);
    const status = C.dayStatus({ day, shift, punches, rules: settings.rules, leave, holiday: hol.get(day) || "" });
    return {
      staff: { _id: staff._id, name: staff.name, phone: staff.phone, position: staff.position, role: staff.role },
      business: { name: ctx.business.name, logo_url: settings.logo?.url || ctx.business.logo_url || "" },
      theme: settings.app_theme || "classic",
      color: settings.app_color || "#4F46E5",
      shift: shift ? { name: shift.name, start: shift.start, end: shift.end, days: shift.days, break_min: shift.break_min, in_from: shift.in_from || "", in_to: shift.in_to || "", out_from: shift.out_from || "", out_to: shift.out_to || "" } : null,
      schedule: plan.on
        ? week.map((d) => {
            const sh = plan.at(staff, d);
            const work = !!sh && C.isWorkDay(sh, d);
            return { day: d, off: !work, name: work ? sh.name : "", start: work ? sh.start : "", end: work ? sh.end : "", color: work ? sh.color || "" : "", rostered: plan.entry(staff, d) !== undefined };
          })
        : null,
      window: (() => {
        const w = C.punchWindow(shift, day, open ? "out" : "in");
        return w ? { from: Number.isFinite(w.from) ? new Date(w.from) : null, to: Number.isFinite(w.to) ? new Date(w.to) : null } : null;
      })(),
      branches: mine.map((b) => ({ _id: b._id, name: b.name, address: b.address, lat: b.lat, lng: b.lng, radius_m: b.radius_m })),
      rules: { max_accuracy_m: settings.rules.max_accuracy_m },
      next: open ? "out" : "in",
      day,
      today: { ...status, punches: punches.map((x) => ({ _id: x._id, kind: x.kind, at: x.at, review: x.review, flags: x.flags, distance_m: x.distance_m, source: x.source })) },
      server_time: new Date(),
      stopped: !ctx.business.status || ctx.license.locked,
      features: {
        leave: !!ctx.addons.att_leave?.active,
        selfie: !!(ctx.addons.att_selfie?.active && settings.selfie?.required !== false),
        kiosk: !!ctx.addons.att_kiosk?.active,
        pay: !!(ctx.addons.att_payroll?.active && settings.payroll?.show_staff !== false),
        overtime: !!(ctx.addons.att_payroll?.active && settings.payroll?.ot_approval),
        team: !!(ctx.addons.att_manager?.active && staff.role === "manager"),
        news: !!ctx.addons.att_news?.active,
        rewards: !!ctx.addons.att_rewards?.active,
      },
      news_unread: ctx.addons.att_news?.active ? (await newsFor(staff, 1)).unread : 0,
    };
  }

  // the staff link's business (name + logo on the login screen)
  prop.app.get(
    "/api/att/info/:code",
    prop.api_auth,
    loginLimit,
    handle(async (req, res) => {
      const code = String(req.params.code || "");
      if (!/^[A-Za-z0-9]{6,12}$/.test(code)) throw new Bad(MSG.badLink, 404, { code: "bad_link" });
      const settings = await M.AttSettings.findOne({ code }).lean();
      const business = settings && (await Business.findOne({ _id: settings.business_id, deleted: false, category: "attendance" }).lean());
      if (!business) throw new Bad(MSG.badLink, 404, { code: "bad_link" });
      res.json({ success: true, data: { name: business.name, logo_url: settings.logo?.url || business.logo_url || "", theme: settings.app_theme || "classic", color: settings.app_color || "#4F46E5" } });
    }),
  );

  prop.app.post(
    "/api/att/login",
    prop.api_auth,
    loginLimit,
    handle(async (req, res) => {
      const b = req.body || {};
      const code = String(b.code || "").trim();
      if (!/^[A-Za-z0-9]{6,12}$/.test(code)) throw new Bad(MSG.badLink, 404, { code: "bad_link" });
      const settings = await M.AttSettings.findOne({ code }).lean();
      if (!settings) throw new Bad(MSG.badLink, 404, { code: "bad_link" });
      const phone = normalizePhone(b.phone);
      const pin = String(b.pin || "");
      const deviceId = String(b.device_id || "");
      if (!ID_RE.test(deviceId)) throw new Bad(`${MSG.badValue} (device_id)`);
      if (!phone || !/^\d{4}$/.test(pin)) throw new Bad(MSG.badLogin, 401, { code: "bad_login" });
      const staff = await M.AttStaff.findOne({ business_id: settings.business_id, phone, active: true });
      if (!staff || !staff.pin_key || !sameKey(staff.pin_key, pinKey(settings.business_id, pin))) throw new Bad(MSG.badLogin, 401, { code: "bad_login" });
      if (staff.device_id && staff.device_id !== deviceId) throw new Bad(MSG.otherPhone, 403, { code: "other_phone" });
      if (!staff.device_id) {
        // bind this phone (two first logins at once: only one wins)
        const won = await M.AttStaff.findOneAndUpdate(
          { _id: staff._id, device_id: "" },
          { $set: { device_id: deviceId, device_label: String(b.device_label || "").slice(0, 120), device_at: new Date(), last_seen: new Date() } },
          { returnDocument: "after" },
        );
        if (!won) throw new Bad(MSG.otherPhone, 403, { code: "other_phone" });
        staff.device_id = won.device_id;
      }
      const ctx = await staffCtx({ headers: { "x-att-token": staffToken(staff, deviceId) } }, false);
      res.json({ success: true, data: { token: staffToken(staff, deviceId), me: await meOf(ctx) } });
    }),
  );

  prop.app.get(
    "/api/att/me",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      M.AttStaff.updateOne({ _id: ctx.staff._id }, { $set: { last_seen: new Date() } }).catch(() => {});
      res.json({ success: true, data: await meOf(ctx) });
    }),
  );

  // selfie photo comes as form-data "photo" (JSON still works when there is no photo)
  const withPhoto = (req, res, next) =>
    upload.single("photo")(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? MSG.badImage : err.message });
      next();
    });
  prop.app.post(
    "/api/att/punch",
    prop.api_auth,
    punchLimit,
    withPhoto,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, true);
      const { staff, settings } = ctx;
      const bid = staff.business_id;
      const b = req.body || {};
      const kind = oneOf(b, "kind", ["in", "out"]);
      if (!kind) throw new Bad(`${MSG.required}: kind`);
      const lat = Number.isFinite(Number(b.lat)) && b.lat !== null && b.lat !== "" && Math.abs(Number(b.lat)) <= 90 ? Number(b.lat) : null;
      const lng = Number.isFinite(Number(b.lng)) && b.lng !== null && b.lng !== "" && Math.abs(Number(b.lng)) <= 180 ? Number(b.lng) : null;
      const accuracy = Number.isFinite(Number(b.accuracy)) && b.accuracy !== null && b.accuracy !== "" ? Math.max(0, Math.round(Number(b.accuracy))) : null;
      const now = new Date();

      const last = await M.AttPunch.findOne({ business_id: bid, staff_id: staff._id, review: { $ne: "rejected" } })
        .sort({ at: -1 })
        .lean();
      if (last && now - new Date(last.at) < MIN_GAP_SEC * 1000) throw new Bad(MSG.tooSoon, 429, { code: "too_soon" });
      const open = last && last.kind === "in" && now - new Date(last.at) <= C.MAX_SHIFT_HOURS * C.HOUR;
      if (kind === "in" && open) throw new Bad(MSG.alreadyIn, 409, { code: "already_in" });
      if (kind === "out" && !open) throw new Bad(MSG.notIn, 409, { code: "not_in" });

      const [pNow, branches] = await Promise.all([shiftNow(bid, staff, now.getTime()), M.AttBranch.find({ business_id: bid }).sort(branchSort).lean()]);
      // clocking out: the shift of the day it started
      const shift = kind === "in" ? pNow.shift : (await planOf(bid, [staff], [last.day], { on: pNow.plan.on })).at(staff, last.day);
      const usable = usableBranches(branches, ctx.limits.branches);
      const mine = staff.branch_ids?.length ? usable.filter((x) => staff.branch_ids.some((id) => String(id) === String(x._id))) : usable;
      // the shift's allowed times for this press
      const winDay = kind === "in" ? pNow.day : last.day;
      const win = C.punchWindow(shift, winDay, kind);
      const tHM = (ms) => new Date(ms + 7 * C.HOUR).toISOString().slice(11, 16);
      if (win && now.getTime() < win.from) throw new Bad(MSG.tooEarly.replace("{from}", tHM(win.from)), 403, { code: "too_early", from: new Date(win.from), to: Number.isFinite(win.to) ? new Date(win.to) : null });
      if (win && now.getTime() > win.to) throw new Bad(MSG.tooLate.replace("{to}", tHM(win.to)), 403, { code: "too_late", from: Number.isFinite(win.from) ? new Date(win.from) : null, to: new Date(win.to) });
      // scanned the door kiosk QR → at that branch, no GPS needed
      let place;
      let kiosk = false;
      if (b.kiosk) {
        if (!ctx.addons.att_kiosk?.active) throw new Bad(MSG.kioskOld, 400, { code: "kiosk_old" });
        const kb = kioskBranch(mine, b.kiosk);
        if (!kb) throw new Bad(MSG.kioskOld, 400, { code: "kiosk_old" });
        place = { branch: kb, distance_m: 0, flags: [] };
        kiosk = true;
      } else place = C.placeCheck({ lat: lat ?? NaN, lng: lng ?? NaN, accuracy: accuracy ?? NaN }, mine, settings.rules);
      // selfie add-on: a photo at every clock in / out
      let photo = { url: "", public_id: "" };
      const selfieOn = ctx.addons.att_selfie?.active && settings.selfie?.required !== false;
      if (req.file && ctx.addons.att_selfie?.active) {
        const saved = await uploadBuffer(req.file, "attendance-selfie");
        photo = { url: saved.url, public_id: saved.public_id };
      } else if (selfieOn) place.flags = [...place.flags, "no_photo"];
      const day = kind === "in" ? pNow.day : last.day;
      // fake-GPS check (att_gps_guard)
      if (!kiosk && lat !== null && ctx.addons.att_gps_guard?.active) {
        const extra = await gpsFlags({ bid, staffId: staff._id, lat, lng, accuracy, now: now.getTime(), day });
        // the POS app (Android) says the phone's location comes from a fake-GPS app
        if (b.mocked === true || b.mocked === "true") extra.push("gps_zero");
        if (extra.length) place.flags = [...new Set([...place.flags, ...extra])];
      }
      const punch = await M.AttPunch.create({
        business_id: bid,
        staff_id: staff._id,
        kind,
        at: now,
        day,
        branch_id: place.branch?._id || null,
        lat,
        lng,
        accuracy,
        distance_m: place.distance_m,
        flags: place.flags,
        review: place.flags.length ? "pending" : "ok",
        source: "phone",
        photo,
        kiosk,
      });
      M.AttStaff.updateOne({ _id: staff._id }, { $set: { last_seen: now } }).catch(() => {});
      if (photo.url) hooks.cleanSelfies(bid).catch(() => {});
      hooks.onPunch(ctx, punch, shift).catch(() => {});
      res.status(201).json({
        success: true,
        data: { punch: { _id: punch._id, kind, at: punch.at, flags: punch.flags, review: punch.review, distance_m: punch.distance_m, branch_name: place.branch?.name || "", kiosk, photo: photo.url }, me: await meOf(ctx) },
      });
    }),
  );

  prop.app.get(
    "/api/att/history",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      const { staff, settings } = ctx;
      const month = MONTH_RE.test(String(req.query.month || "")) ? String(req.query.month) : C.localDay(Date.now()).slice(0, 7);
      const days = C.daysOfMonth(month);
      const [plan, punches, leaves, hol] = await Promise.all([
        planOf(staff.business_id, [staff], days),
        M.AttPunch.find({ business_id: staff.business_id, staff_id: staff._id, day: { $in: days } })
          .sort({ at: 1 })
          .lean(),
        M.AttLeave.find({ business_id: staff.business_id, staff_id: staff._id, status: "approved", from: { $lte: days[days.length - 1] }, to: { $gte: days[0] } }).lean(),
        holidayMap(staff.business_id, days[0], days[days.length - 1]),
      ]);
      const list = days.map((day) => {
        const st = C.dayStatus({
          day,
          shift: plan.at(staff, day),
          punches: punches.filter((p) => p.day === day),
          rules: settings.rules,
          since: staff.created_date ? C.localDay(staff.created_date) : "",
          leave: C.leaveOn(leaves, day),
          holiday: hol.get(day) || "",
        });
        return {
          day,
          status: st.status,
          holiday: st.holiday,
          leave_type: st.leave_type,
          first_in: st.first_in,
          last_out: st.last_out,
          late_min: st.late_min,
          early_min: st.early_min,
          ot_min: st.ot_min,
          worked_min: st.worked_min,
          pending: st.pending,
        };
      });
      res.json({ success: true, data: { month, days: list, totals: C.monthSummary(list) } });
    }),
  );

  // the add-ons (Telegram, leave, selfie, door kiosk, payroll) live in their own file
  require("./attendance.addons")(prop, {
    base,
    guard,
    handle,
    ctxOf,
    staffCtx,
    settingsOf,
    statusesOf,
    licenseState,
    hooks,
    Bad,
    MSG,
    text,
    num,
    bool,
    oneOf,
    validId,
    staffOut,
    liveKioskTheme: async (bid, settings) => (await looksOf(bid, settings)).kiosk.live,
    withUpload: withPhoto,
    kioskWindow,
    kioskCode,
    KIOSK_SEC,
    SELFIE_DAYS,
    DAY_RE,
    MONTH_RE,
    csvCell,
    hm,
    ownerName,
  });
  // overtime requests (free, with Payroll)
  require("./attendance.ot")(prop, { base, guard, handle, ctxOf, staffCtx, Bad, MSG, text, validId, ownerName, DAY_RE, hooks });
  // weekly roster (att_roster)
  require("./attendance.roster")(prop, { base, guard, handle, ctxOf, Bad, MSG, validId, DAY_RE, staffOut });
  // holidays, "I forgot to clock in / out" requests, days with no clock-out
  require("./attendance.days")(prop, { base, guard, handle, ctxOf, staffCtx, Bad, MSG, text, validId, ownerName, DAY_RE, hooks });
  // manager login (att_manager), staff documents (att_docs), HR reminders
  require("./attendance.team")(prop, { base, guard, handle, ctxOf, staffCtx, settingsOf, statusesOf, Bad, MSG, text, validId, DAY_RE, hooks, withUpload, ownerName });
  // announcements (att_news) and on-time rewards (att_rewards)
  require("./attendance.news")(prop, { base, guard, handle, ctxOf, staffCtx, Bad, MSG, text, bool, validId, ownerName, hooks });
  require("./attendance.rewards")(prop, { base, guard, handle, ctxOf, staffCtx, settingsOf, statusesOf, Bad, MSG, num, bool, MONTH_RE });
  // the company website (att_website) lives in its own file too
  require("./attendance.site")(prop, { base, guard, handle, ctxOf, settingsOf, licenseState, Bad, MSG, text, bool, withFile: withUpload });
};

module.exports.licenseState = licenseState;
module.exports.statusesOf = statusesOf; // the owner's home dashboard: who is late / not in yet
module.exports.settingsOf = settingsOf;
