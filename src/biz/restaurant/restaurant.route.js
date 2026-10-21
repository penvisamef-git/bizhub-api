// Restaurant setup (business type "restaurant") — everything the owner prepares before the POS sells.
// Base: /api/user/businesses/:id/restaurant
//   GET    /                          settings + setup progress + license + add-ons + limits + counts
//   PUT    /settings                  profile, money, receipt, payment_methods[] (2 free; more = add-on)
//   POST   /image                     form-data: file, kind=logo|cover      DELETE /image { kind }
//   GET|POST /zones   PUT|DELETE /zones/:rid        (also /tables, /categories, /items, /addon-groups, /stations, /staff)
//   PUT    /:collection/order         { ids: [...] }  new sort order
//   POST   /tables/bulk               { zone_id, prefix, from, to, seats }   e.g. A1–A10
//   POST   /items/:rid/photo          form-data: file        DELETE /items/:rid/photo
// Add-ons (licenses, bought on POST /api/user/businesses/:id/licenses/<key>):
//   rest_staff    more than 2 staff accounts         rest_payments  more than 2 payment methods
//   rest_kitchen  kitchen stations                   rest_qr_menu   online menu + table QR
//   rest_printer  bill + kitchen printers            rest_telegram  daily report to Telegram (restaurant.telegram.js)
//   rest_website  own website /s/<slug> + themes (restaurant.site.js)
// The restaurant itself is a yearly license: 7 days after it ends, setup becomes read-only (402 locked).
// Public:
//   GET /api/public/menu/:token       online menu (needs rest_qr_menu)
const crypto = require("crypto");
const mongoose = require("mongoose");
const multer = require("multer");
const M = require("./restaurant.models");
const Business = require("../business.model");
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const { statusOf, DAY } = require("../../license/license.service");
const { PRODUCTS, REST_ADDONS } = require("../../license/license.products");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");

const GRACE_DAYS = 7;
const FREE = { staff: 2, payments: 2 };
const MAX = { zones: 30, tables: 300, categories: 100, items: 2000, addonGroups: 100, stations: 20, staff: 200, payments: 20 };
const MAX_IMAGE_MB = 4;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  notRestaurant: "អាជីវកម្មនេះមិនមែនជាភោជនីយដ្ឋានទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  locked: "ភោជនីយដ្ឋាននេះផុតកំណត់ហើយ! សូមបន្តដើម្បីកែប្រែ។",
  rowNotFound: "រកមិនឃើញទិន្នន័យ!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
  tooLong: "អត្ថបទវែងពេក!",
  required: "សូមបំពេញ",
  badValue: "តម្លៃមិនត្រឹមត្រូវ!",
  tooMany: "ច្រើនពេក!",
  staffLimit: `អាចបង្កើតបុគ្គលិកបានតែ ${FREE.staff} នាក់ប៉ុណ្ណោះ។ សូមដោះសោ “បុគ្គលិកបន្ថែម”។`,
  printerLocked: "ត្រូវដោះសោ “ការបោះពុម្ព” សិន ទើបអាចភ្ជាប់ម៉ាស៊ីនព្រីនបាន។",
  paymentLimit: `អាចមានវិធីបង់ប្រាក់បានតែ ${FREE.payments} ប៉ុណ្ណោះ។ សូមដោះសោ “វិធីបង់ប្រាក់បន្ថែម”។`,
  needKitchen: "សូមដោះសោ “ផ្ទះបាយ” ជាមុនសិន!",
  needStock: "សូមដោះសោ “ស្តុក” ជាមុនសិន!",
  needPromos: "សូមដោះសោ “ប្រូម៉ូសិន” ជាមុនសិន!",
  needRewards: "សូមដោះសោ “ពិន្ទុរង្វាន់” ជាមុនសិន!",
  pinTaken: "PIN នេះមានបុគ្គលិកផ្សេងប្រើហើយ!",
  badPin: "PIN ត្រូវមាន 4 ខ្ទង់!",
  tableTaken: "ឈ្មោះតុនេះមានហើយ!",
  inUse: "កំពុងប្រើប្រាស់ មិនអាចលុបបានទេ!",
  badImage: `អាចបញ្ចូលបានតែរូបភាព jpg, png, webp (អតិបរមា ${MAX_IMAGE_MB}MB)`,
  noFile: "សូមជ្រើសរើសរូបភាព!",
  menuOff: "ម៉ឺនុយនេះមិនទាន់មាន។",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (IMAGE_TYPES.includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});
const withUpload = (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? MSG.badImage : err.message });
    next();
  });

const validId = (id) => mongoose.Types.ObjectId.isValid(id);
const token = (n = 10) => crypto.randomBytes(16).toString("base64url").replace(/[-_]/g, "").slice(0, n);
const pinKey = (businessId, pin) =>
  crypto
    .createHmac("sha256", process.env.JWT_SECRET || "bizhub")
    .update(`${businessId}:${pin}`)
    .digest("hex");
const money = (v) => Math.round(Number(v) * 100) / 100;

const ADDON_MSG = { rest_promos: MSG.needPromos, rest_rewards: MSG.needRewards };
class Bad extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

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
function num(body, key, min, max, { required = false, int = false } = {}) {
  if (body[key] === undefined || body[key] === "") {
    if (required) throw new Bad(`${MSG.required}: ${key}`);
    return undefined;
  }
  const v = Number(body[key]);
  if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) throw new Bad(`${MSG.badValue} (${key})`);
  return int ? v : money(v);
}
const bool = (body, key) => (body[key] === undefined ? undefined : !!body[key]);
function oneOf(body, key, list) {
  if (body[key] === undefined) return undefined;
  if (!list.includes(body[key])) throw new Bad(`${MSG.badValue} (${key})`);
  return body[key];
}
function color(body, key) {
  if (body[key] === undefined) return undefined;
  const v = String(body[key]).toUpperCase();
  if (!M.COLOR_RE.test(v)) throw new Bad(`${MSG.badValue} (${key})`);
  return v;
}
function url(body, key, max) {
  const v = text(body, key, max);
  if (!v) return v;
  const withProtocol = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withProtocol);
    if (!/\./.test(u.hostname)) throw new Error();
    return u.toString();
  } catch {
    throw new Bad(`${MSG.badValue} (${key})`);
  }
}
function pricedList(list, key, max = 20) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length > max) throw new Bad(`${MSG.badValue} (${key})`);
  return list
    .map((x) => ({ name: String(x?.name ?? "").trim(), price: Number(x?.price ?? 0) }))
    .filter((x) => x.name)
    .map((x) => {
      if (x.name.length > 40 || !Number.isFinite(x.price) || x.price < 0 || x.price > 1000000) throw new Bad(`${MSG.badValue} (${key})`);
      return { ...x, price: money(x.price) };
    });
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// printer setting { type, address }; a real printer needs the "Printing" add-on
function printerOf(value, ctx) {
  const type = ["none", "network", "usb"].includes(value?.type) ? value.type : "none";
  if (type !== "none" && !ctx.addons.rest_printer.active) throw new Bad(MSG.printerLocked, 402, { product: "rest_printer" });
  return {
    type,
    address:
      type === "none"
        ? ""
        : String(value?.address || "")
            .trim()
            .slice(0, 100),
  };
}

// ---------- license / add-ons ----------
async function licenseState(businessId) {
  const rows = await License.find({ business_id: businessId, product: { $in: ["restaurant", ...REST_ADDONS] } }).lean();
  const restaurant = statusOf(rows.find((r) => r.product === "restaurant"));
  // locked = ended more than 7 days ago (no license row at all = older data: treat as active)
  const hasRow = rows.some((r) => r.product === "restaurant");
  const endedAt = restaurant.expires_at ? new Date(restaurant.expires_at).getTime() : null;
  restaurant.grace_until = endedAt ? new Date(endedAt + GRACE_DAYS * DAY) : null;
  restaurant.locked = hasRow && !restaurant.active && endedAt !== null && Date.now() > endedAt + GRACE_DAYS * DAY;
  restaurant.in_grace = hasRow && !restaurant.active && !restaurant.locked;
  const addons = {};
  for (const key of REST_ADDONS) addons[key] = statusOf(rows.find((r) => r.product === key));
  return { restaurant, addons };
}

async function addonCatalog(addons) {
  return Promise.all(
    REST_ADDONS.map(async (key) => {
      const def = PRODUCTS[key];
      return { key, price: await priceOf(def.price_key), days: def.days, soon: !!def.soon, ...addons[key] };
    }),
  );
}

async function settingsOf(business, preloaded) {
  const found = preloaded !== undefined ? preloaded : await M.RestSettings.findOne({ business_id: business._id });
  if (found) return found;
  try {
    return await M.RestSettings.create({ business_id: business._id, name_en: business.name, menu_token: token(10) });
  } catch (err) {
    if (err.code === 11000) return M.RestSettings.findOne({ business_id: business._id });
    throw err;
  }
}

async function setupOf(business, settings) {
  const [tables, items, staff] = await Promise.all([
    M.RestTable.countDocuments({ business_id: business._id, active: true }),
    M.RestItem.countDocuments({ business_id: business._id, active: true }),
    M.RestStaff.countDocuments({ business_id: business._id, active: true }),
  ]);
  const steps = {
    profile: !!((settings.name_km || settings.name_en) && settings.logo?.url),
    money: !!settings.money_saved,
    tables: settings.no_tables || tables > 0,
    menu: items > 0,
    staff: staff > 0,
  };
  return { steps, done: Object.values(steps).filter(Boolean).length, total: 5, ready: Object.values(steps).every(Boolean), counts: { tables, items, staff } };
}

// ---------- collections (simple CRUD) ----------
// read(body, ctx, partial) → fields to save   ·  before(ctx, set, row?) → extra checks
const COLLECTIONS = {
  zones: {
    model: M.RestZone,
    max: MAX.zones,
    read: (b, ctx, partial) => clean({ name: text(b, "name", 40, { required: !partial }), active: bool(b, "active") }),
    inUse: (ctx, row) => M.RestTable.exists({ business_id: ctx.business._id, zone_id: row._id }),
  },
  tables: {
    model: M.RestTable,
    max: MAX.tables,
    read: (b, ctx, partial) => clean({ name: text(b, "name", 20, { required: !partial }), seats: num(b, "seats", 1, 50, { int: true }), zone_id: b.zone_id === undefined ? undefined : b.zone_id || null, active: bool(b, "active") }),
    before: async (ctx, set) => {
      if (set.zone_id && !(validId(set.zone_id) && (await M.RestZone.exists({ _id: set.zone_id, business_id: ctx.business._id })))) throw new Bad(`${MSG.badValue} (zone_id)`);
    },
  },
  categories: {
    model: M.RestCategory,
    max: MAX.categories,
    read: (b, ctx, partial) => {
      const set = clean({ name_km: text(b, "name_km", 60), name_en: text(b, "name_en", 60), color: color(b, "color"), active: bool(b, "active") });
      if (!partial && !set.name_km && !set.name_en) throw new Bad(`${MSG.required}: name`);
      return set;
    },
    inUse: (ctx, row) => M.RestItem.exists({ business_id: ctx.business._id, category_id: row._id }),
  },
  stations: {
    model: M.RestStation,
    max: MAX.stations,
    addon: "rest_kitchen",
    read: (b, ctx, partial) => {
      const set = clean({ name: text(b, "name", 40, { required: !partial }) });
      if (b.printer !== undefined) set.printer = printerOf(b.printer, ctx);
      return set;
    },
    after: async (ctx, row, deleted) => {
      if (deleted) await M.RestItem.updateMany({ business_id: ctx.business._id, station_id: row._id }, { $set: { station_id: null } });
    },
  },
  "addon-groups": {
    model: M.RestAddonGroup,
    max: MAX.addonGroups,
    read: (b, ctx, partial) => {
      const set = clean({
        name: text(b, "name", 40, { required: !partial }),
        required: bool(b, "required"),
        min: num(b, "min", 0, 20, { int: true }),
        max: num(b, "max", 1, 20, { int: true }),
        options: pricedList(b.options, "options", 30),
      });
      if (set.min !== undefined && set.max !== undefined && set.min > set.max) throw new Bad(`${MSG.badValue} (min > max)`);
      return set;
    },
    after: async (ctx, row, deleted) => {
      if (deleted) await M.RestItem.updateMany({ business_id: ctx.business._id }, { $pull: { addon_group_ids: row._id } });
    },
  },
  items: {
    model: M.RestItem,
    max: MAX.items,
    read: (b, ctx, partial) => {
      const set = clean({
        name_km: text(b, "name_km", 80),
        name_en: text(b, "name_en", 80),
        description: text(b, "description", 300),
        price: num(b, "price", 0, 1000000, { required: !partial }),
        code: text(b, "code", 20),
        category_id: b.category_id,
        station_id: b.station_id === undefined ? undefined : b.station_id || null,
        sizes: pricedList(b.sizes, "sizes", 10),
        addon_group_ids: b.addon_group_ids,
        available: bool(b, "available"),
        active: bool(b, "active"),
        cost: num(b, "cost", 0, 1000000),
        track_stock: bool(b, "track_stock"),
        low_stock: num(b, "low_stock", 0, 100000, { int: true }),
        reward_points: num(b, "reward_points", 0, 10000, { int: true }),
        // the first quantity, only when the item is created (later changes go through Stock → in / out / count)
        stock: partial ? undefined : num(b, "stock", 0, 1000000),
      });
      if (!partial && !set.name_km && !set.name_en) throw new Bad(`${MSG.required}: name`);
      if (!partial && !set.category_id) throw new Bad(`${MSG.required}: category_id`);
      return set;
    },
    created: async (ctx, row) => {
      if (row.track_stock && row.stock)
        await M.RestStockMove.create({ business_id: ctx.business._id, item_id: row._id, item_name: row.name_en || row.name_km, kind: "opening", qty: row.stock, before: 0, after: row.stock, cost: row.cost, note: "", by: "" });
    },
    before: async (ctx, set) => {
      const bid = ctx.business._id;
      if (set.track_stock && !ctx.addons.rest_stock?.active) throw new Bad(MSG.needStock, 402, { product: "rest_stock" });
      if (set.category_id !== undefined && !(validId(set.category_id) && (await M.RestCategory.exists({ _id: set.category_id, business_id: bid })))) throw new Bad(`${MSG.badValue} (category_id)`);
      if (set.station_id) {
        if (!ctx.addons.rest_kitchen.active) throw new Bad(MSG.needKitchen, 402, { product: "rest_kitchen" });
        if (!(validId(set.station_id) && (await M.RestStation.exists({ _id: set.station_id, business_id: bid })))) throw new Bad(`${MSG.badValue} (station_id)`);
      }
      if (set.addon_group_ids !== undefined) {
        if (!Array.isArray(set.addon_group_ids) || set.addon_group_ids.length > 10 || !set.addon_group_ids.every(validId)) throw new Bad(`${MSG.badValue} (addon_group_ids)`);
        const ids = [...new Set(set.addon_group_ids.map(String))];
        if ((await M.RestAddonGroup.countDocuments({ _id: { $in: ids }, business_id: bid })) !== ids.length) throw new Bad(`${MSG.badValue} (addon_group_ids)`);
        set.addon_group_ids = ids;
      }
    },
  },
  promos: {
    model: M.RestPromo,
    max: 100,
    addon: "rest_promos",
    read: (b, ctx, partial) => {
      const day = (k) => {
        const v = b[k];
        if (v === undefined) return undefined;
        if (v === "" || v === null) return "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Bad(`${MSG.badValue} (${k})`);
        return String(v);
      };
      const hhmm = (k) => {
        const v = b[k];
        if (v === undefined) return undefined;
        if (v === "" || v === null) return "";
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw new Bad(`${MSG.badValue} (${k})`);
        return String(v);
      };
      const ids = (k, max) => {
        const v = b[k];
        if (v === undefined) return undefined;
        if (!Array.isArray(v) || v.length > max || !v.every(validId)) throw new Bad(`${MSG.badValue} (${k})`);
        return [...new Set(v.map(String))];
      };
      const set = clean({
        name: text(b, "name", 60, { required: !partial }),
        kind: oneOf(b, "kind", M.PROMO_KINDS),
        value: num(b, "value", 0, 1000000),
        buy: num(b, "buy", 1, 20, { int: true }),
        get_qty: num(b, "get_qty", 1, 20, { int: true }),
        get_percent: num(b, "get_percent", 1, 100, { int: true }),
        all_items: bool(b, "all_items"),
        item_ids: ids("item_ids", 500),
        category_ids: ids("category_ids", 100),
        start_date: day("start_date"),
        end_date: day("end_date"),
        days:
          b.days === undefined
            ? undefined
            : Array.isArray(b.days) && b.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
              ? [...new Set(b.days)].sort()
              : (() => {
                  throw new Bad(`${MSG.badValue} (days)`);
                })(),
        from: hhmm("from"),
        to: hhmm("to"),
        active: bool(b, "active"),
      });
      if (!partial && !set.kind) throw new Bad(`${MSG.required}: kind`);
      if (set.kind === "percent" && set.value !== undefined && (set.value <= 0 || set.value > 100)) throw new Bad(`${MSG.badValue} (value 1–100)`);
      if (set.kind && set.kind !== "bxgy" && !partial && !(set.value > 0)) throw new Bad(`${MSG.required}: value`);
      if (set.start_date && set.end_date && set.start_date > set.end_date) throw new Bad(`${MSG.badValue} (start_date > end_date)`);
      if (!partial && !set.all_items && !(set.item_ids || []).length && !(set.category_ids || []).length) throw new Bad(`${MSG.required}: items`);
      return set;
    },
  },
  // Rewards add-on: what members can swap their points for (…/restaurant/reward-list)
  "reward-list": {
    model: M.RestReward,
    max: 60,
    addon: "rest_rewards",
    read: (b, ctx, partial) => {
      const set = clean({
        name: text(b, "name", 60, { required: !partial }),
        kind: oneOf(b, "kind", M.REWARD_KINDS),
        points: num(b, "points", 1, 1000000, { required: !partial, int: true }),
        item_id: b.item_id === undefined ? undefined : String(b.item_id || ""),
        value: num(b, "value", 0, 100000000),
        coupon_kind: oneOf(b, "coupon_kind", ["", "free_item", "amount", "percent"]),
        note: text(b, "note", 120),
        active: bool(b, "active"),
      });
      if (!partial && !set.kind) throw new Bad(`${MSG.required}: kind`);
      const effect = set.kind === "coupon" ? set.coupon_kind : set.kind;
      if (set.kind === "coupon" && !partial && !set.coupon_kind) throw new Bad(`${MSG.required}: coupon_kind`);
      if (effect === "percent" && set.value !== undefined && (set.value <= 0 || set.value > 100)) throw new Bad(`${MSG.badValue} (value 1–100)`);
      if (["amount", "percent"].includes(effect) && !partial && !(set.value > 0)) throw new Bad(`${MSG.required}: value`);
      if (effect === "free_item" && !partial && !set.item_id) throw new Bad(`${MSG.required}: item_id`);
      return set;
    },
    before: async (ctx, set) => {
      if (set.item_id && !(validId(set.item_id) && (await M.RestItem.exists({ _id: set.item_id, business_id: ctx.business._id })))) throw new Bad(`${MSG.badValue} (item_id)`);
    },
  },
  staff: {
    model: M.RestStaff,
    max: MAX.staff,
    hide: "-pin_key -pin_salt -pin_check",
    read: (b, ctx, partial) => {
      const set = clean({ name: text(b, "name", 60, { required: !partial }), role: oneOf(b, "role", M.STAFF_ROLES), phone: text(b, "phone", 30), active: bool(b, "active") });
      if (b.pin !== undefined || !partial) {
        const pin = String(b.pin ?? "");
        if (!/^\d{4}$/.test(pin)) throw new Bad(MSG.badPin);
        set.pin_key = pinKey(ctx.business._id, pin);
        set.pin_salt = crypto.randomBytes(12).toString("hex");
        set.pin_check = crypto.createHash("sha256").update(`${set.pin_salt}:${pin}`).digest("hex");
      }
      return set;
    },
    beforeCreate: async (ctx) => {
      // only 2 staff accounts unless the "More staff" add-on is active (inactive ones count too: they still exist)
      const count = await M.RestStaff.countDocuments({ business_id: ctx.business._id });
      if (count >= FREE.staff && !ctx.addons.rest_staff.active) throw new Bad(MSG.staffLimit, 402, { product: "rest_staff", limit: FREE.staff });
    },
  },
};

const route = (prop) => {
  const base = "/api/user/businesses/:id/restaurant";
  const guard = [prop.api_auth, customer_auth];

  // load the owner's restaurant + license state; write=true also blocks suspended / locked ones
  async function ctxOf(req, write) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    // both reads at once (one round trip to the database instead of two)
    const [business, state] = await Promise.all([Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false }), licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== "restaurant") throw new Bad(MSG.notRestaurant);
    if (write) {
      if (!business.status) throw new Bad(MSG.suspended, 403);
      if (state.restaurant.locked) throw new Bad(MSG.locked, 402, { product: "restaurant" });
    }
    return { business, ...state };
  }
  // restaurant + its settings in one go
  async function withSettings(req, write) {
    const [ctx, found] = await Promise.all([ctxOf(req, write), validId(req.params.id) ? M.RestSettings.findOne({ business_id: req.params.id }) : null]);
    return { ctx, settings: await settingsOf(ctx.business, found) };
  }
  // a change to the restaurant setup (menu, tables, staff, money…) bumps a counter, so linked POS devices
  // know to download the setup again (checked on every POS sync)
  const touchesSetup = (req) => req.method !== "GET" && req.params?.id && /\/restaurant(\/|$)/.test(req.path) && !/\/restaurant\/(site|telegram|pos|report|stock|rewards\/members)(\/|$)/.test(req.path);
  const handle = (fn) => async (req, res) => {
    if (touchesSetup(req)) {
      const send = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 400 || !validId(req.params.id)) return send(body);
        M.RestCounter.updateOne({ business_id: req.params.id }, { $inc: { setup: 1 } }, { upsert: true })
          .catch(() => {})
          .finally(() => send(body));
        return res;
      };
    }
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
      if (err?.isCloudinary) return res.status(err.status).json({ success: false, message: err.message });
      if (err?.code === 11000) return res.status(409).json({ success: false, message: /pin_key/.test(err.message) ? MSG.pinTaken : MSG.tableTaken });
      console.error("[restaurant]", err);
      res.status(500).json({ success: false, message: MSG.server });
    }
  };

  // ===================================== OVERVIEW =====================================
  prop.app.get(
    base,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, false);
      const [setup, addons, renewPrice, inboxUnread] = await Promise.all([setupOf(ctx.business, settings), addonCatalog(ctx.addons), priceOf("restaurant"), M.RestSiteMessage.countDocuments({ business_id: ctx.business._id, read: false })]);
      res.json({
        success: true,
        data: settings,
        business: { _id: ctx.business._id, name: ctx.business.name, status: ctx.business.status },
        setup,
        license: ctx.restaurant,
        addons,
        limits: { staff: ctx.addons.rest_staff.active ? null : FREE.staff, payments: ctx.addons.rest_payments.active ? null : FREE.payments },
        renew_price: renewPrice,
        inbox_unread: inboxUnread,
      });
    }),
  );

  // ===================================== SETTINGS =====================================
  prop.app.put(
    `${base}/settings`,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      const b = req.body || {};
      const set = clean({
        name_km: text(b, "name_km", 80),
        name_en: text(b, "name_en", 80),
        type: oneOf(b, "type", M.RESTAURANT_TYPES),
        phone: text(b, "phone", 30),
        address: text(b, "address", 200),
        map_url: url(b, "map_url", 300),
        hours: text(b, "hours", 120),
        tin: text(b, "tin", 40),
        color: color(b, "color"),
        currency: oneOf(b, "currency", ["USD", "KHR"]),
        khr_rate: num(b, "khr_rate", 1000, 10000, { int: true }),
        khr_rounding: b.khr_rounding === undefined ? undefined : oneOf({ v: Number(b.khr_rounding) }, "v", [1, 100, 500, 1000]),
        pay_mode: oneOf(b, "pay_mode", ["after", "before"]),
        no_tables: bool(b, "no_tables"),
        receipt_size: b.receipt_size === undefined ? undefined : oneOf({ v: Number(b.receipt_size) }, "v", [58, 80]),
        receipt_footer: text(b, "receipt_footer", 200),
        wifi_name: text(b, "wifi_name", 40),
        wifi_pass: text(b, "wifi_pass", 40),
        bill_numbering: oneOf(b, "bill_numbering", ["daily", "running"]),
      });
      if (b.vat !== undefined) set.vat = { enabled: !!b.vat?.enabled, rate: num(b.vat || {}, "rate", 0, 30) ?? settings.vat.rate, included: !!b.vat?.included };
      if (b.service_charge !== undefined) set.service_charge = { enabled: !!b.service_charge?.enabled, rate: num(b.service_charge || {}, "rate", 0, 30) ?? settings.service_charge.rate };
      if (b.payment_methods !== undefined) {
        if (!Array.isArray(b.payment_methods) || b.payment_methods.length > MAX.payments) throw new Bad(`${MSG.badValue} (payment_methods)`);
        const list = b.payment_methods.map((p) => ({
          ...(p?._id && validId(p._id) ? { _id: p._id } : {}),
          name: String(p?.name ?? "").trim(),
          kind: M.PAYMENT_KINDS.includes(p?.kind) ? p.kind : "other",
          active: p?.active !== false,
        }));
        if (list.some((p) => !p.name || p.name.length > 40)) throw new Bad(`${MSG.badValue} (payment_methods)`);
        if (!list.some((p) => p.active)) throw new Bad(`${MSG.required}: payment_methods`);
        if (list.length > FREE.payments && !ctx.addons.rest_payments.active) throw new Bad(MSG.paymentLimit, 402, { product: "rest_payments", limit: FREE.payments });
        set.payment_methods = list;
      }
      if (b.receipt_printer !== undefined) set.receipt_printer = printerOf(b.receipt_printer, ctx);
      if (b.mark_money_saved) set.money_saved = true;
      settings.set(set);
      await settings.save();
      res.json({ success: true, data: settings, setup: await setupOf(ctx.business, settings), message: MSG.saved });
    }),
  );

  // logo / cover
  prop.app.post(
    `${base}/image`,
    ...guard,
    withUpload,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const kind = req.body?.kind;
      if (!["logo", "cover"].includes(kind)) throw new Bad(`${MSG.badValue} (kind)`);
      if (!req.file) throw new Bad(MSG.noFile);
      const settings = await settingsOf(ctx.business);
      const saved = await uploadBuffer(req.file, "restaurant");
      const old = settings[kind]?.public_id;
      settings[kind] = { url: saved.url, public_id: saved.public_id };
      await settings.save();
      if (old) deleteFile(old).catch(() => {});
      res.status(201).json({ success: true, data: settings, setup: await setupOf(ctx.business, settings), message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/image`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const kind = req.body?.kind;
      if (!["logo", "cover"].includes(kind)) throw new Bad(`${MSG.badValue} (kind)`);
      const settings = await settingsOf(ctx.business);
      const old = settings[kind]?.public_id;
      settings[kind] = { url: "", public_id: "" };
      await settings.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: settings, setup: await setupOf(ctx.business, settings), message: MSG.saved });
    }),
  );

  // ===================================== TABLES: quick add A1–A10 =====================================
  prop.app.post(
    `${base}/tables/bulk`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      const prefix = String(b.prefix ?? "")
        .trim()
        .slice(0, 10);
      const from = num(b, "from", 0, 999, { required: true, int: true });
      const to = num(b, "to", 0, 999, { required: true, int: true });
      const seats = num(b, "seats", 1, 50, { int: true }) ?? 4;
      if (to < from || to - from >= 100) throw new Bad(`${MSG.badValue} (from–to, max 100)`);
      const zone_id = b.zone_id || null;
      if (zone_id && !(validId(zone_id) && (await M.RestZone.exists({ _id: zone_id, business_id: ctx.business._id })))) throw new Bad(`${MSG.badValue} (zone_id)`);
      const existing = await M.RestTable.countDocuments({ business_id: ctx.business._id });
      if (existing + (to - from + 1) > MAX.tables) throw new Bad(MSG.tooMany);
      const taken = new Set((await M.RestTable.find({ business_id: ctx.business._id }).select("name").lean()).map((t) => t.name.toLowerCase()));
      const docs = [];
      for (let n = from; n <= to; n += 1) {
        const name = `${prefix}${n}`;
        if (!taken.has(name.toLowerCase())) docs.push({ business_id: ctx.business._id, zone_id, name, seats, sort: existing + docs.length });
      }
      if (docs.length) await M.RestTable.insertMany(docs, { ordered: false });
      res.status(201).json({ success: true, data: await M.RestTable.find({ business_id: ctx.business._id }).sort({ sort: 1, created_date: 1 }).lean(), added: docs.length, skipped: to - from + 1 - docs.length, message: MSG.saved });
    }),
  );

  // ===================================== ITEM PHOTO =====================================
  prop.app.post(
    `${base}/items/:rid/photo`,
    ...guard,
    withUpload,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.rid)) throw new Bad(MSG.badId);
      if (!req.file) throw new Bad(MSG.noFile);
      const item = await M.RestItem.findOne({ _id: req.params.rid, business_id: ctx.business._id });
      if (!item) throw new Bad(MSG.rowNotFound, 404);
      const saved = await uploadBuffer(req.file, "restaurant/menu");
      const old = item.photo?.public_id;
      item.photo = { url: saved.url, public_id: saved.public_id };
      await item.save();
      if (old) deleteFile(old).catch(() => {});
      res.status(201).json({ success: true, data: item, message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/items/:rid/photo`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.rid)) throw new Bad(MSG.badId);
      const item = await M.RestItem.findOne({ _id: req.params.rid, business_id: ctx.business._id });
      if (!item) throw new Bad(MSG.rowNotFound, 404);
      const old = item.photo?.public_id;
      item.photo = { url: "", public_id: "" };
      await item.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: item, message: MSG.saved });
    }),
  );

  // ===================================== GENERIC CRUD =====================================
  for (const [name, c] of Object.entries(COLLECTIONS)) {
    const path = `${base}/${name}`;
    const list = (bid) =>
      c.model
        .find({ business_id: bid })
        .select(c.hide || "")
        .sort({ sort: 1, created_date: 1 })
        .lean();

    prop.app.get(
      path,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, false);
        res.json({ success: true, data: await list(ctx.business._id) });
      }),
    );

    prop.app.put(
      `${path}/order`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        const ids = req.body?.ids;
        if (!Array.isArray(ids) || ids.length > 3000 || !ids.every(validId)) throw new Bad(`${MSG.badValue} (ids)`);
        await c.model.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id, business_id: ctx.business._id }, update: { $set: { sort: i } } } })));
        res.json({ success: true, data: await list(ctx.business._id), message: MSG.saved });
      }),
    );

    prop.app.post(
      path,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        if (c.addon && !ctx.addons[c.addon].active) throw new Bad(ADDON_MSG[c.addon] || MSG.needKitchen, 402, { product: c.addon });
        const set = c.read(req.body || {}, ctx, false);
        if (c.before) await c.before(ctx, set);
        if (c.beforeCreate) await c.beforeCreate(ctx, set);
        const count = await c.model.countDocuments({ business_id: ctx.business._id });
        if (count >= c.max) throw new Bad(`${MSG.tooMany} (≤ ${c.max})`);
        const row = await c.model.create({ ...set, business_id: ctx.business._id, sort: count });
        if (c.created) await c.created(ctx, row);
        const data = row.toObject();
        delete data.pin_key;
        delete data.pin_salt;
        delete data.pin_check;
        res.status(201).json({ success: true, data, message: MSG.saved });
      }),
    );

    prop.app.put(
      `${path}/:rid`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        if (c.addon && !ctx.addons[c.addon].active) throw new Bad(ADDON_MSG[c.addon] || MSG.needKitchen, 402, { product: c.addon });
        if (!validId(req.params.rid)) throw new Bad(MSG.badId);
        const row = await c.model.findOne({ _id: req.params.rid, business_id: ctx.business._id });
        if (!row) throw new Bad(MSG.rowNotFound, 404);
        const set = c.read(req.body || {}, ctx, true);
        if (c.before) await c.before(ctx, set, row);
        row.set(set);
        await row.save();
        const data = row.toObject();
        delete data.pin_key;
        delete data.pin_salt;
        delete data.pin_check;
        res.json({ success: true, data, message: MSG.saved });
      }),
    );

    prop.app.delete(
      `${path}/:rid`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        if (!validId(req.params.rid)) throw new Bad(MSG.badId);
        const row = await c.model.findOne({ _id: req.params.rid, business_id: ctx.business._id });
        if (!row) throw new Bad(MSG.rowNotFound, 404);
        if (c.inUse && (await c.inUse(ctx, row))) throw new Bad(MSG.inUse, 409);
        await row.deleteOne();
        if (row.photo?.public_id) deleteFile(row.photo.public_id).catch(() => {});
        if (c.after) await c.after(ctx, row, true);
        res.json({ success: true, message: MSG.deleted });
      }),
    );
  }

  // ===================================== TELEGRAM + WEBSITE (add-ons, own files) =====================================
  const kit = { base, guard, handle, ctxOf, withSettings, settingsOf, licenseState, Bad, MSG, text, num, bool, oneOf, color, url, validId, token, withUpload, uploadBuffer, deleteFile };
  require("./restaurant.telegram")(prop, kit);
  require("./restaurant.site")(prop, kit);
  require("./restaurant.pos")(prop, kit);
  require("./restaurant.report")(prop, kit);
  require("./restaurant.extras")(prop, kit);
  require("./restaurant.stock")(prop, kit);
  require("./restaurant.order")(prop, kit);
  require("./restaurant.rewards")(prop, kit);

  // ===================================== PUBLIC ONLINE MENU (QR) =====================================
  prop.app.get(
    "/api/public/menu/:token",
    handle(async (req, res) => {
      const t = String(req.params.token || "");
      const settings = /^[A-Za-z0-9]{6,20}$/.test(t) ? await M.RestSettings.findOne({ menu_token: t }).lean() : null;
      if (!settings) throw new Bad(MSG.menuOff, 404);
      const [business, state] = await Promise.all([Business.findOne({ _id: settings.business_id, deleted: false }).select("owner_id status").lean(), licenseState(settings.business_id)]);
      const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
      if (!business?.status || !owner?.status || state.restaurant.locked || !state.addons.rest_qr_menu.active) throw new Bad(MSG.menuOff, 404);
      const [categories, items, groups] = await Promise.all([
        M.RestCategory.find({ business_id: settings.business_id, active: true }).sort({ sort: 1 }).select("name_km name_en color").lean(),
        M.RestItem.find({ business_id: settings.business_id, active: true }).sort({ sort: 1 }).select("category_id name_km name_en description photo price sizes addon_group_ids available").lean(),
        M.RestAddonGroup.find({ business_id: settings.business_id }).select("name required min max options").lean(),
      ]);
      res.set("Cache-Control", "public, max-age=30");
      res.json({
        success: true,
        data: {
          restaurant: {
            name_km: settings.name_km,
            name_en: settings.name_en,
            logo: settings.logo?.url || "",
            cover: settings.cover?.url || "",
            phone: settings.phone,
            address: settings.address,
            map_url: settings.map_url,
            hours: settings.hours,
            color: settings.color,
            currency: settings.currency,
            khr_rate: settings.khr_rate,
            khr_rounding: settings.khr_rounding,
            wifi_name: settings.wifi_name,
          },
          categories,
          items: items.map((i) => ({ ...i, photo: i.photo?.url || "" })),
          addon_groups: groups,
        },
      });
    }),
  );
};

module.exports = route;
module.exports.FREE = FREE;
module.exports.GRACE_DAYS = GRACE_DAYS;
