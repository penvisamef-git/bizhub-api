// Mini Mart: settings, product categories, products (barcode), cashiers, paired POS devices, sales
const mongoose = require("mongoose");

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };
const owned = { business_id: { type: ObjectId, ref: "Business", required: true, index: true } };
const pic = { url: { type: String, default: "" }, public_id: { type: String, default: "" } };

const METHODS = ["cash", "aba", "khqr", "acleda", "wing", "card", "other"]; // built-in keys (older shops may still use the last 4)
const FREE_METHODS = ["cash", "aba", "khqr"]; // the 3 free ones; the shop's own methods need mart_payments
const CUSTOM_RE = /^x_[a-z0-9]{6}$/; // a payment method the shop made: x_ab12cd
// POS looks: "classic" is free, each other one is bought once (mart_pos_theme). Same list as bizhub/src/pos/mart/posThemes.js
const POS_THEMES = ["classic", "ocean", "sunset", "forest", "berry", "midnight", "royal", "coral", "mint", "amber", "slate", "rose", "lime", "sky", "cocoa", "ink", "neon", "lotus", "angkor", "candy", "sand", "ruby", "jade", "paper"];
const STAFF_ROLES = ["manager", "cashier"];
// receipt templates: "classic" is free, each other one is bought once (mart_print_theme). Same list as bizhub/src/pos/mart/themes.js
const PRINT_THEMES = [
  "classic",
  "minimal",
  "bold",
  "mono",
  "typewriter",
  "serif",
  "modern",
  "market",
  "banner",
  "boxed",
  "double",
  "dotted",
  "stars",
  "wave",
  "kiosk",
  "compact",
  "large",
  "table",
  "zebra",
  "ticket",
  "coupon",
  "retro",
  "cafe",
  "bakery",
  "fresh",
  "night",
  "corporate",
  "left",
  "split",
  "bigtotal",
  "underline",
  "stamp",
  "festive",
  "khmer",
  "angkor",
  "lotus",
];
const MOVE_KINDS = ["in", "adjust", "sale", "void", "waste", "transfer_out", "transfer_in"]; // stock in, counted / corrected, sold, sale voided (back in), thrown away (expired / damaged), sent to / received from another branch
// website looks (mart_site_theme) and customer dashboard looks (mart_portal_theme): the first one of each is free.
// Same keys as bizhub/src/msite/looks.js and bizhub/src/msite/portal/plooks.js
const SITE_THEMES = [
  "classic",
  "fresh",
  "market",
  "minimal",
  "bold",
  "night",
  "sunrise",
  "ocean",
  "forest",
  "berry",
  "citrus",
  "mint",
  "coral",
  "slate",
  "sand",
  "royal",
  "candy",
  "grocery",
  "bakery",
  "organic",
  "neon",
  "paper",
  "elegant",
  "tropical",
  "lotus",
  "angkor",
  "mekong",
  "kampot",
  "sunset",
  "sky",
  "rose",
  "coffee",
  "pastel",
  "metro",
  "retro",
  "festival",
];
const PORTAL_THEMES = ["classic", "ocean", "sunset", "forest", "midnight", "rose", "mint", "grape", "sand", "slate", "coral", "sky", "lemon", "berry", "teal", "amber", "ink", "blossom", "jade", "ruby", "cloud", "mocha", "neon", "lotus"];
const ORDER_STATUSES = ["new", "accepted", "ready", "delivering", "done", "declined", "cancelled"]; // new → accepted → ready (pickup) / delivering → done
const OPEN_ORDER = ["new", "accepted", "ready", "delivering"];
const DEBT_KINDS = ["sale", "payment", "adjust", "void"]; // bought on credit, paid back, corrected, debt sale voided
const SHIFT_MOVES = ["in", "out"]; // money put in / taken out of the drawer during a shift

const settingsSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    currency: { type: String, enum: ["USD", "KHR"], default: "USD" }, // prices are in this currency
    khr_rate: { type: Number, default: 4100, min: 1000, max: 10000 }, // 1 USD = ? riel
    khr_round: { type: Number, enum: [100, 500, 1000], default: 100 }, // riel change is rounded to this
    methods: { type: [String], default: () => ["cash", "aba", "khqr"] },
    next_no: { type: Number, default: 1 }, // receipt number counter (S-000001)
    next_shift: { type: Number, default: 1 }, // shift number counter (SH-0001)
    receipt_note: { type: String, default: "", trim: true, maxlength: 300 },
    pay_qr: pic, // ABA / KHQR picture shown on the POS when the customer pays by QR
    pay_qr_label: { type: String, default: "", trim: true, maxlength: 60 },
    print_theme: { type: String, default: "classic" }, // receipt template (mart_print_theme)
    pos_theme: { type: String, default: "classic" }, // POS look (mart_pos_theme)
    pos_color: { type: String, default: "" }, // the owner's colour on the POS ("" = the look's own)
    portal_color: { type: String, default: "" }, // the owner's colour on the customer dashboard ("" = the look's own)
    pos_customers: { type: Boolean, default: false }, // cashiers may open online customers' details on the POS
    // payment methods the shop made itself (mart_payments): key x_ab12cd, a name, a colour, its own QR picture
    custom_methods: {
      type: [
        {
          _id: false,
          key: { type: String, required: true },
          name: { type: String, required: true, trim: true, maxlength: 40 },
          color: { type: String, default: "" },
          qr: pic,
        },
      ],
      default: [],
    },
    print_size: { type: String, enum: ["80", "58"], default: "80" }, // paper width (mm)
    print_auto: { type: Boolean, default: false }, // print the receipt right after each sale (mart_printer)
    logo_public_id: { type: String, default: "" },
    units_seeded: { type: Boolean, default: false }, // the first unit (Piece / ដុំ) was made
    // online orders (mart_shop)
    shop_on: { type: Boolean, default: true }, // customers can order (the owner can pause)
    pickup_on: { type: Boolean, default: true },
    delivery_on: { type: Boolean, default: true },
    delivery_fee: { type: Number, default: 0, min: 0 },
    min_order: { type: Number, default: 0, min: 0 }, // smallest order total (items only)
    shop_cash: { type: Boolean, default: true }, // pay at pickup / on delivery
    shop_qr: { type: Boolean, default: true }, // pay first by ABA / KHQR + screenshot (uses the pay_qr picture)
    shop_note: { type: String, default: "", trim: true, maxlength: 300 }, // shown at checkout (delivery area, times…)
    shop_qr_img: pic, // the QR customers scan to pay online orders (falls back to the POS QR)
    shop_qr_label: { type: String, default: "", trim: true, maxlength: 60 },
    order_sound: pic, // the owner's own alarm for new online orders (mp3); empty = the default ring
    portal_theme: { type: String, default: "classic" }, // customer dashboard look (mart_portal_theme)
    next_order: { type: Number, default: 1 }, // W-0001
    // Telegram alerts (mart_telegram, yearly): the BizHub bot sends alerts to the owner's chat / team group
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      chat_type: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "" },
      link_expires: { type: Date, default: null },
      new_order: { type: Boolean, default: true }, // a new order from the website
      shift_close: { type: Boolean, default: true }, // a POS shift was closed (the count + difference)
      low_stock: { type: Boolean, default: true }, // a product goes low / sold out (stock control)
      new_message: { type: Boolean, default: true }, // "Contact us" on the website
      daily: { type: Boolean, default: true }, // the day's summary every evening (free with mart_telegram)
      report_time: { type: String, default: "21:00" }, // HH:MM, Cambodia time
      last_report_at: { type: Date, default: null },
    },
    // expiry dates (mart_expiry): warn this many days before a batch expires
    expiry_days: { type: Number, default: 30, min: 1, max: 365 },
    // loyalty points (mart_loyalty): spend `earn_per` → 1 point; 1 point = `point_value` off; redeem from `min_redeem` points
    loyalty: {
      on: { type: Boolean, default: true },
      earn_per: { type: Number, default: 1, min: 0.01 },
      point_value: { type: Number, default: 0.05, min: 0 },
      min_redeem: { type: Number, default: 20, min: 1 },
      online: { type: Boolean, default: true }, // website orders earn + can use points
    },
    // weighing-scale barcodes (mart_scale): EAN-13 = prefix + item code (product.plu) + weight (g) or price, + check digit
    scale: {
      on: { type: Boolean, default: false },
      prefix: { type: String, default: "21" },
      item_len: { type: Number, default: 5, min: 4, max: 6 },
      mode: { type: String, enum: ["weight", "price"], default: "weight" },
    },
    // delivery zones (mart_delivery): a fee (and smallest order) per area; customers pick their zone at checkout
    zones: {
      type: [
        {
          _id: false,
          key: { type: String, required: true },
          name: { type: String, required: true, trim: true, maxlength: 60 },
          fee: { type: Number, default: 0, min: 0 },
          min_order: { type: Number, default: 0, min: 0 },
          eta: { type: String, default: "", trim: true, maxlength: 40 }, // "30–45 min"
          active: { type: Boolean, default: true },
        },
      ],
      default: [],
    },
    next_po: { type: Number, default: 1 }, // PO-0001 (mart_purchase)
    branches: { type: [ObjectId], default: [] }, // multi-branch (mart_branches): the other mart businesses of this group
    pair_code: { type: String, default: "" },
    pair_expires: { type: Date, default: null },
  },
  opts,
);

const categorySchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 60 },
    color: { type: String, default: "" },
    sort: { type: Number, default: 0 },
  },
  opts,
);
categorySchema.index({ business_id: 1, name: 1 }, { unique: true });

// units the shop makes itself, in Khmer + English (piece / ដុំ, box / ប្រអប់ …)
const unitSchema = new Schema(
  {
    ...owned,
    name_en: { type: String, default: "", trim: true, maxlength: 30 },
    name_km: { type: String, default: "", trim: true, maxlength: 30 },
    sort: { type: Number, default: 0 },
  },
  opts,
);

const productSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 120 },
    barcode: { type: String, default: "", trim: true, maxlength: 40 },
    category_id: { type: ObjectId, default: null },
    price: { type: Number, required: true, min: 0 },
    cost: { type: Number, default: 0, min: 0 }, // what the shop pays (for profit later)
    unit_id: { type: ObjectId, default: null }, // MartUnit
    unit: { type: String, default: "" }, // (old) fixed unit name, before units were made by the shop
    track_stock: { type: Boolean, default: true }, // stock control (mart_stock): sales take from the stock
    stock: { type: Number, default: 0 }, // can go below 0 when sold before the stock was received
    low_stock: { type: Number, default: 5, min: 0 },
    photo: pic,
    plu: { type: String, default: "", trim: true, maxlength: 6 }, // item code on weighing-scale barcodes (mart_scale)
    supplier_id: { type: ObjectId, default: null }, // who usually brings it (reorder list, mart_purchase)
    reorder_qty: { type: Number, default: 0, min: 0 }, // how many to order when low (0 = work it out)
    fav: { type: Boolean, default: false }, // shown first on the sale screen
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  opts,
);
productSchema.index({ business_id: 1, barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $gt: "" } } });

// cashiers log in to the POS with a 4-digit PIN
const staffSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 60 },
    role: { type: String, enum: STAFF_ROLES, default: "cashier" },
    phone: { type: String, default: "", trim: true, maxlength: 30 },
    pin_key: { type: String, required: true }, // HMAC(business:pin) — never the PIN itself
    pin_salt: { type: String, default: "" }, // the POS checks a PIN offline: sha256(salt:pin) === pin_check
    pin_check: { type: String, default: "" },
    pin_v: { type: Number, default: 0 }, // +1 on a new PIN → old sessions end
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  opts,
);
staffSchema.index({ business_id: 1, pin_key: 1 }, { unique: true });

const deviceSchema = new Schema(
  {
    ...owned,
    name: { type: String, default: "", trim: true, maxlength: 60 },
    token_hash: { type: String, required: true, index: true },
    revoked: { type: Boolean, default: false },
    last_seen: { type: Date, default: null },
  },
  opts,
);

// one sale = one receipt
const lineSchema = new Schema(
  {
    product_id: { type: ObjectId, default: null },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    barcode: { type: String, default: "", maxlength: 40 },
    unit_en: { type: String, default: "" },
    unit_km: { type: String, default: "" },
    price: { type: Number, required: true, min: 0 },
    qty: { type: Number, required: true, min: 0.001 },
    total: { type: Number, required: true, min: 0 },
    cost: { type: Number, default: undefined }, // what one cost the shop at the time of the sale (profit report)
  },
  { _id: false },
);
const saleSchema = new Schema(
  {
    ...owned,
    no: { type: String, default: "" },
    client_id: { type: String, default: undefined }, // made by the POS: sending the same sale twice adds nothing
    items: { type: [lineSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    promo_discount: { type: Number, default: 0 }, // promotions (mart_promos)
    promos: { type: [{ _id: false, id: String, name: String, amount: Number }], default: undefined },
    coupon: { type: String, default: "" },
    member_id: { type: ObjectId, default: null }, // loyalty member (mart_loyalty)
    member_name: { type: String, default: "" },
    member_phone: { type: String, default: "" },
    points_used: { type: Number, default: 0 },
    points_value: { type: Number, default: 0 }, // money off for the points used
    points_earned: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    currency: { type: String, enum: ["USD", "KHR"], default: "USD" },
    khr_rate: { type: Number, default: 4100 },
    method: { type: String, default: "cash" }, // a built-in key, the shop's own (x_ab12cd) or "debt" = written in the debt book (mart_debt)
    method_name: { type: String, default: "" }, // the shop's own method: its name at the time of the sale
    debtor_id: { type: ObjectId, default: null },
    debtor_name: { type: String, default: "" },
    order_id: { type: ObjectId, default: null }, // an online order (mart_shop) that became this sale
    order_no: { type: String, default: "" },
    paid_usd: { type: Number, default: 0 }, // cash received
    paid_khr: { type: Number, default: 0 },
    change: { type: Number, default: 0 }, // in the shop currency
    change_khr: { type: Number, default: 0 }, // all the change in riel (rounded)
    status: { type: String, enum: ["paid", "void"], default: "paid" },
    void_by: { type: String, default: "" },
    void_reason: { type: String, default: "", maxlength: 200 },
    void_at: { type: Date, default: null },
    at: { type: Date, default: Date.now, index: true }, // when it was sold (offline sales keep their time)
    by: { type: String, default: "" },
    staff_id: { type: ObjectId, default: null },
    device_id: { type: ObjectId, default: null },
    offline: { type: Boolean, default: false },
  },
  opts,
);
saleSchema.index({ business_id: 1, at: -1 });
saleSchema.index({ business_id: 1, client_id: 1 }, { unique: true, partialFilterExpression: { client_id: { $type: "string" } } });

// every change of stock, newest first on screen
const moveSchema = new Schema(
  {
    ...owned,
    product_id: { type: ObjectId, required: true, index: true },
    kind: { type: String, enum: MOVE_KINDS, required: true },
    qty: { type: Number, required: true }, // + in, − out
    stock_after: { type: Number, default: 0 },
    cost: { type: Number, default: 0 }, // cost per unit when receiving
    note: { type: String, default: "", maxlength: 200 },
    sale_id: { type: ObjectId, default: null },
    sale_no: { type: String, default: "" },
    po_id: { type: ObjectId, default: null }, // received from a purchase order (mart_purchase)
    transfer_id: { type: ObjectId, default: null }, // moved between branches (mart_branches)
    supplier_id: { type: ObjectId, default: null }, // stock in from this supplier (mart_suppliers)
    batch: { type: String, default: "" }, // one delivery = one batch (several products)
    invoice_no: { type: String, default: "" }, // the supplier's invoice / delivery note number
    by: { type: String, default: "" },
  },
  opts,
);
moveSchema.index({ business_id: 1, created_date: -1 });
moveSchema.index({ business_id: 1, supplier_id: 1, created_date: -1 });

// suppliers (mart_suppliers): who the shop buys from
const supplierSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 100 },
    contact: { type: String, default: "", trim: true, maxlength: 80 }, // the person to call
    phone: { type: String, default: "", trim: true, maxlength: 40 },
    address: { type: String, default: "", trim: true, maxlength: 300 },
    note: { type: String, default: "", trim: true, maxlength: 1000 }, // what they bring, delivery days, terms…
    active: { type: Boolean, default: true },
  },
  opts,
);
supplierSchema.index({ business_id: 1, name: 1 });

// debt book (mart_debt): customers who buy on credit
const debtorSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, default: "", trim: true, maxlength: 30 },
    note: { type: String, default: "", trim: true, maxlength: 200 },
    balance: { type: Number, default: 0 }, // what they owe now (shop currency)
    active: { type: Boolean, default: true },
  },
  opts,
);
debtorSchema.index({ business_id: 1, name: 1 });

const debtTxSchema = new Schema(
  {
    ...owned,
    debtor_id: { type: ObjectId, required: true, index: true },
    kind: { type: String, enum: DEBT_KINDS, required: true },
    amount: { type: Number, required: true }, // + owes more, − paid back
    balance_after: { type: Number, default: 0 },
    sale_id: { type: ObjectId, default: null },
    sale_no: { type: String, default: "" },
    method: { type: String, default: "" }, // how a repayment came in (cash, aba…)
    note: { type: String, default: "", maxlength: 200 },
    by: { type: String, default: "" },
  },
  opts,
);
debtTxSchema.index({ business_id: 1, created_date: -1 });

// shifts & cash drawer (mart_shifts): open with a float, cash in / out, count and close
const shiftMoveSchema = new Schema(
  {
    kind: { type: String, enum: SHIFT_MOVES, required: true },
    amount_usd: { type: Number, default: 0 },
    amount_khr: { type: Number, default: 0 },
    note: { type: String, default: "", maxlength: 200 },
    at: { type: Date, default: Date.now },
    by: { type: String, default: "" },
  },
  { _id: true },
);
const shiftSchema = new Schema(
  {
    ...owned,
    no: { type: String, default: "" },
    device_id: { type: ObjectId, default: null }, // null = opened from the owner dashboard (counts every device)
    device_name: { type: String, default: "" },
    status: { type: String, enum: ["open", "closed"], default: "open" },
    float_usd: { type: Number, default: 0 }, // cash in the drawer at open
    float_khr: { type: Number, default: 0 },
    opened_at: { type: Date, default: Date.now },
    opened_by: { type: String, default: "" },
    moves: { type: [shiftMoveSchema], default: [] },
    closed_at: { type: Date, default: null },
    closed_by: { type: String, default: "" },
    counted_usd: { type: Number, default: 0 }, // cash counted at close
    counted_khr: { type: Number, default: 0 },
    expected_usd: { type: Number, default: 0 },
    expected_khr: { type: Number, default: 0 },
    diff_usd: { type: Number, default: 0 }, // counted − expected
    diff_khr: { type: Number, default: 0 },
    sales_count: { type: Number, default: 0 }, // paid sales during the shift (this device)
    sales_total: { type: Number, default: 0 }, // all methods, shop currency
    cash_usd: { type: Number, default: 0 }, // cash received
    cash_khr: { type: Number, default: 0 },
    change_khr: { type: Number, default: 0 }, // riel given back
    by_method: { type: Schema.Types.Mixed, default: {} }, // sales per payment method
    note: { type: String, default: "", maxlength: 300 },
  },
  opts,
);
shiftSchema.index({ business_id: 1, status: 1 });
shiftSchema.index({ business_id: 1, opened_at: -1 });

// the shop website (mart_website) at /m/<slug>
const siteSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    slug: { type: String, default: undefined, trim: true, lowercase: true },
    published: { type: Boolean, default: false },
    theme: { type: String, default: "classic" }, // mart_site_theme
    color: { type: String, default: "" }, // the owner's colour (replaces the look's accent)
    tagline: { type: String, default: "", trim: true, maxlength: 140 },
    about: { type: String, default: "", trim: true, maxlength: 2000 },
    hours: { type: String, default: "", trim: true, maxlength: 300 }, // e.g. "Every day 6:00–22:00"
    map_url: { type: String, default: "", trim: true, maxlength: 500 },
    facebook: { type: String, default: "", trim: true, maxlength: 200 },
    telegram: { type: String, default: "", trim: true, maxlength: 100 },
    cover: pic,
    // what the website shows (the owner turns parts on / off)
    show: {
      products: { type: Boolean, default: true },
      prices: { type: Boolean, default: true },
      stock: { type: Boolean, default: false }, // "only 3 left" / sold out (needs stock control)
      about: { type: Boolean, default: true },
      hours: { type: Boolean, default: true },
      contact: { type: Boolean, default: true },
      map: { type: Boolean, default: true },
      contact_form: { type: Boolean, default: true }, // "Contact us" form → the owner's inbox
    },
    // extra pages the owner writes (delivery info, promotions, FAQ…), shown in the website menu
    pages: {
      type: [
        {
          key: { type: String, required: true }, // in the address: /m/<slug>?p=<key>
          title: { type: String, required: true, trim: true, maxlength: 60 },
          body: { type: String, default: "", trim: true, maxlength: 6000 },
          image: pic,
          visible: { type: Boolean, default: true },
        },
      ],
      default: [],
    },
    hidden_categories: { type: [ObjectId], default: [] }, // categories not shown online
  },
  opts,
);
siteSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: "string" } } });

// online customers (mart_shop): sign up with phone + password on the website
const customerSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, trim: true, maxlength: 30 }, // signs in with this or the email
    email: { type: String, default: undefined, trim: true, lowercase: true, maxlength: 120 },
    avatar: pic, // their profile photo
    password: { type: String, required: true }, // bcrypt
    pass_v: { type: Number, default: 0 },
    blocked: { type: Boolean, default: false },
    addresses: {
      type: [
        {
          label: { type: String, default: "", trim: true, maxlength: 40 }, // Home, Work…
          address: { type: String, default: "", trim: true, maxlength: 300 },
          note: { type: String, default: "", trim: true, maxlength: 200 },
          map: { type: String, default: "", trim: true, maxlength: 300 }, // a Google Maps link / "lat,lng"
        },
      ],
      default: [],
    },
    last_login: { type: Date, default: null },
  },
  opts,
);
customerSchema.index({ business_id: 1, phone: 1 }, { unique: true });
customerSchema.index({ business_id: 1, email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });

// "Contact us" messages from the website (the owner's inbox)
const messageSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    contact: { type: String, default: "", trim: true, maxlength: 120 }, // phone or email
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    read: { type: Boolean, default: false },
  },
  opts,
);
messageSchema.index({ business_id: 1, created_date: -1 });

const orderLineSchema = new Schema(
  {
    product_id: { type: ObjectId, default: null },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    qty: { type: Number, required: true },
    total: { type: Number, required: true },
    unit_en: { type: String, default: "" },
    unit_km: { type: String, default: "" },
    photo: { type: String, default: "" },
  },
  { _id: false },
);
const orderSchema = new Schema(
  {
    ...owned,
    no: { type: String, default: "" }, // W-0001
    customer_id: { type: ObjectId, required: true, index: true },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    items: { type: [orderLineSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    delivery_fee: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    fulfil: { type: String, enum: ["pickup", "delivery"], default: "pickup" },
    address: { address: { type: String, default: "" }, note: { type: String, default: "" }, map: { type: String, default: "" } },
    note: { type: String, default: "", maxlength: 500 },
    pay_method: { type: String, enum: ["cash", "qr"], default: "cash" },
    pay_proof: pic, // the ABA / KHQR screenshot
    status: { type: String, enum: ORDER_STATUSES, default: "new", index: true },
    reason: { type: String, default: "", maxlength: 200 }, // why declined / cancelled
    promo_discount: { type: Number, default: 0 }, // promotions + coupon (mart_promos)
    promos: { type: [{ _id: false, id: String, name: String, amount: Number }], default: undefined },
    coupon: { type: String, default: "" },
    points_used: { type: Number, default: 0 }, // loyalty points used (taken at order time, back if declined / cancelled)
    points_value: { type: Number, default: 0 },
    member_id: { type: ObjectId, default: null },
    zone_key: { type: String, default: "" }, // delivery zone (mart_delivery)
    zone_name: { type: String, default: "" },
    driver_id: { type: ObjectId, default: null },
    driver_name: { type: String, default: "" },
    driver_phone: { type: String, default: "" },
    stock_held: { type: Boolean, default: false }, // stock was taken when accepted
    sale_id: { type: ObjectId, default: null }, // the sale made when done
    sale_no: { type: String, default: "" },
    timeline: { type: [{ status: String, at: { type: Date, default: Date.now }, by: { type: String, default: "" } }], default: [] },
  },
  opts,
);
orderSchema.index({ business_id: 1, status: 1, created_date: -1 });

// expiry dates (mart_expiry): one delivery of one product with its expiry day; sales take the soonest first
const batchSchema = new Schema(
  {
    ...owned,
    product_id: { type: ObjectId, required: true, index: true },
    qty: { type: Number, required: true, min: 0 }, // received
    left: { type: Number, default: 0 }, // still on the shelf
    expires: { type: String, required: true }, // YYYY-MM-DD
    cost: { type: Number, default: 0 },
    wasted: { type: Number, default: 0 },
    note: { type: String, default: "", maxlength: 200 },
    by: { type: String, default: "" },
  },
  opts,
);
batchSchema.index({ business_id: 1, left: 1, expires: 1 });

// loyalty (mart_loyalty): members by phone (walk-in customers and website customers)
const memberSchema = new Schema(
  {
    ...owned,
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    name: { type: String, default: "", trim: true, maxlength: 80 },
    points: { type: Number, default: 0 },
    earned: { type: Number, default: 0 },
    redeemed: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
    visits: { type: Number, default: 0 },
    last_at: { type: Date, default: null },
    note: { type: String, default: "", trim: true, maxlength: 200 },
  },
  opts,
);
memberSchema.index({ business_id: 1, phone: 1 }, { unique: true });
const pointTxSchema = new Schema(
  {
    ...owned,
    member_id: { type: ObjectId, required: true, index: true },
    kind: { type: String, enum: ["earn", "redeem", "adjust", "void", "refund"], required: true },
    points: { type: Number, required: true }, // + / −
    balance_after: { type: Number, default: 0 },
    sale_id: { type: ObjectId, default: null },
    sale_no: { type: String, default: "" },
    order_id: { type: ObjectId, default: null },
    order_no: { type: String, default: "" },
    note: { type: String, default: "", maxlength: 200 },
    by: { type: String, default: "" },
  },
  opts,
);
pointTxSchema.index({ business_id: 1, created_date: -1 });

// promotions (mart_promos): applied by themselves on the POS + website; a code makes it a coupon
const PROMO_KINDS = ["percent", "amount", "bxgy"];
const promoSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 60 },
    kind: { type: String, enum: PROMO_KINDS, required: true },
    value: { type: Number, default: 0, min: 0 }, // % or money off
    buy_qty: { type: Number, default: 0, min: 0 }, // buy X …
    get_qty: { type: Number, default: 0, min: 0 }, // … get Y free
    target: { type: String, enum: ["all", "categories", "products"], default: "all" },
    category_ids: { type: [ObjectId], default: [] },
    product_ids: { type: [ObjectId], default: [] },
    min_spend: { type: Number, default: 0, min: 0 },
    code: { type: String, default: "", trim: true, uppercase: true, maxlength: 20 }, // coupon
    where: { type: String, enum: ["both", "pos", "online"], default: "both" },
    days: { type: [Number], default: [] }, // 0 = Sunday … 6; empty = every day
    time_from: { type: String, default: "" }, // happy hour "HH:MM"
    time_to: { type: String, default: "" },
    date_from: { type: String, default: "" }, // YYYY-MM-DD
    date_to: { type: String, default: "" },
    max_uses: { type: Number, default: 0, min: 0 }, // 0 = no limit
    uses: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  opts,
);

// purchase orders (mart_purchase)
const PO_STATUSES = ["draft", "sent", "partial", "received", "cancelled"];
const poSchema = new Schema(
  {
    ...owned,
    no: { type: String, default: "" }, // PO-0001
    supplier_id: { type: ObjectId, default: null },
    supplier_name: { type: String, default: "" },
    items: {
      type: [
        {
          _id: false,
          product_id: { type: ObjectId, required: true },
          name: { type: String, default: "" },
          qty: { type: Number, required: true, min: 0.001 },
          cost: { type: Number, default: 0, min: 0 },
          received: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
    total: { type: Number, default: 0 },
    status: { type: String, enum: PO_STATUSES, default: "draft" },
    note: { type: String, default: "", maxlength: 500 },
    sent_at: { type: Date, default: null },
    received_at: { type: Date, default: null },
    invoice_no: { type: String, default: "" },
    by: { type: String, default: "" },
  },
  opts,
);
poSchema.index({ business_id: 1, created_date: -1 });

// delivery drivers (mart_delivery)
const driverSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 60 },
    phone: { type: String, default: "", trim: true, maxlength: 30 },
    telegram: { type: String, default: "", trim: true, maxlength: 60 }, // @username, for "send to driver"
    active: { type: Boolean, default: true },
  },
  opts,
);

// stock moved between branches (mart_branches)
const transferSchema = new Schema(
  {
    group_id: { type: ObjectId, required: true, index: true }, // the main business
    from_id: { type: ObjectId, required: true },
    to_id: { type: ObjectId, required: true },
    from_name: { type: String, default: "" },
    to_name: { type: String, default: "" },
    items: { type: [{ _id: false, product_id: ObjectId, to_product_id: ObjectId, name: String, barcode: String, qty: Number }], default: [] },
    note: { type: String, default: "", maxlength: 200 },
    by: { type: String, default: "" },
  },
  opts,
);
transferSchema.index({ group_id: 1, created_date: -1 });

module.exports = {
  PROMO_KINDS,
  PO_STATUSES,
  METHODS,
  FREE_METHODS,
  CUSTOM_RE,
  POS_THEMES,
  STAFF_ROLES,
  PRINT_THEMES,
  SITE_THEMES,
  PORTAL_THEMES,
  ORDER_STATUSES,
  OPEN_ORDER,
  MOVE_KINDS,
  DEBT_KINDS,
  SHIFT_MOVES,
  MartUnit: mongoose.model("MartUnit", unitSchema),
  MartStockMove: mongoose.model("MartStockMove", moveSchema),
  MartSupplier: mongoose.model("MartSupplier", supplierSchema),
  MartSite: mongoose.model("MartSite", siteSchema),
  MartCustomer: mongoose.model("MartCustomer", customerSchema),
  MartOrder: mongoose.model("MartOrder", orderSchema),
  MartMessage: mongoose.model("MartMessage", messageSchema),
  MartSettings: mongoose.model("MartSettings", settingsSchema),
  MartCategory: mongoose.model("MartCategory", categorySchema),
  MartProduct: mongoose.model("MartProduct", productSchema),
  MartStaff: mongoose.model("MartStaff", staffSchema),
  MartDevice: mongoose.model("MartDevice", deviceSchema),
  MartSale: mongoose.model("MartSale", saleSchema),
  MartDebtor: mongoose.model("MartDebtor", debtorSchema),
  MartDebtTx: mongoose.model("MartDebtTx", debtTxSchema),
  MartShift: mongoose.model("MartShift", shiftSchema),
  MartBatch: mongoose.model("MartBatch", batchSchema),
  MartMember: mongoose.model("MartMember", memberSchema),
  MartPointTx: mongoose.model("MartPointTx", pointTxSchema),
  MartPromo: mongoose.model("MartPromo", promoSchema),
  MartPO: mongoose.model("MartPO", poSchema),
  MartDriver: mongoose.model("MartDriver", driverSchema),
  MartTransfer: mongoose.model("MartTransfer", transferSchema),
};
