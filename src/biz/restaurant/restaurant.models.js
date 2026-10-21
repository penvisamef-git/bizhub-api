// Restaurant service (business type "restaurant"). Every document belongs to one business (business_id).
const mongoose = require("mongoose");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const image = new Schema({ url: { type: String, default: "" }, public_id: { type: String, default: "" } }, { _id: false });
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };
const owned = { business_id: { type: ObjectId, ref: "Business", required: true, index: true } };

const RESTAURANT_TYPES = ["restaurant", "cafe", "bar", "bakery", "stall"];
const PAYMENT_KINDS = ["cash", "bank", "qr", "card", "other"];
const STAFF_ROLES = ["manager", "cashier", "waiter", "kitchen"];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// ---------- settings (profile + money), one per restaurant ----------
const paymentMethod = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    kind: { type: String, enum: PAYMENT_KINDS, default: "other" },
    active: { type: Boolean, default: true },
  },
  { _id: true },
);
// receipt looks: 1 free + 10 paid (45 coins each, forever) · customer display looks: 1 free + 5 paid (75 coins each)
const RECEIPT_THEMES_FREE = ["classic"];
const RECEIPT_THEMES_PAID = ["modern", "mono", "bold", "compact", "elegant", "boxed", "columns", "biglogo", "minimal", "khmer"];
const RECEIPT_THEMES = [...RECEIPT_THEMES_FREE, ...RECEIPT_THEMES_PAID];
const DISPLAY_THEMES_FREE = ["clean"];
// POS looks (rest_pos_theme, 45 coins each, forever) — the same keys as the web src/pos/restThemes.js
const POS_THEMES_FREE = ["classic"];
const POS_THEMES_PAID = ["ocean", "sunset", "forest", "night", "coffee", "neon", "berry", "angkor", "mint", "slate", "candy", "paper"];
// table QR sticker looks (rest_qr_theme, one price each, forever) — used for every printed table sticker
const QR_THEMES_FREE = ["classic"];
const QR_THEMES_PAID = ["minimal", "block", "tent", "kraft", "neon", "gold", "bubble", "khmer", "polaroid", "ticket"];
// looks of the guest's ordering page (rest_order_theme, one price each, forever)
const ORDER_THEMES_FREE = ["fresh"];
// looks of the members' pages (points page + "check my points"): classic free, others yearly (rest_points_theme)
const POINTS_THEMES_FREE = ["classic"];
const POINTS_THEMES_PAID = ["gold", "midnight", "pastel", "kraft", "neon", "khmer"];
const ORDER_THEMES_PAID = ["midnight", "latte", "matcha", "ocean", "sakura", "street", "elegant", "mono", "angkor", "tropical", "neon", "gallery"];
const DISPLAY_THEMES_PAID = ["midnight", "sunset", "nature", "luxe", "playful"];
const DISPLAY_THEMES = [...DISPLAY_THEMES_FREE, ...DISPLAY_THEMES_PAID];
const MAX_BANNERS = 6;
const MAX_SIDE_BANNERS = 3;
// accent colours for the customer display (same set as the name cards)
const DISPLAY_COLORS = ["#E0581A", "#D93025", "#C2185B", "#7B1FA2", "#1A73E8", "#00897B", "#2E7D32", "#16171B"];

const settingsSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true }, // unique index below
    // profile
    name_km: { type: String, default: "", trim: true, maxlength: 80 },
    name_en: { type: String, default: "", trim: true, maxlength: 80 },
    type: { type: String, enum: RESTAURANT_TYPES, default: "restaurant" },
    logo: { type: image, default: () => ({}) },
    cover: { type: image, default: () => ({}) },
    phone: { type: String, default: "", trim: true, maxlength: 30 },
    address: { type: String, default: "", trim: true, maxlength: 200 },
    map_url: { type: String, default: "", trim: true, maxlength: 300 },
    hours: { type: String, default: "", trim: true, maxlength: 120 },
    tin: { type: String, default: "", trim: true, maxlength: 40 },
    color: { type: String, default: "#E0581A", match: COLOR_RE },
    // money
    currency: { type: String, enum: ["USD", "KHR"], default: "USD" },
    khr_rate: { type: Number, default: 4100, min: 1000, max: 10000 },
    khr_rounding: { type: Number, enum: [1, 100, 500, 1000], default: 100 },
    vat: { enabled: { type: Boolean, default: false }, rate: { type: Number, default: 10, min: 0, max: 30 }, included: { type: Boolean, default: false } },
    service_charge: { enabled: { type: Boolean, default: false }, rate: { type: Number, default: 5, min: 0, max: 30 } },
    payment_methods: {
      type: [paymentMethod],
      default: () => [
        { name: "Cash", kind: "cash" },
        { name: "Bank transfer", kind: "bank" },
      ],
    },
    pay_mode: { type: String, enum: ["after", "before"], default: "after" }, // pay after eating / pay first
    no_tables: { type: Boolean, default: false }, // takeaway only
    // receipt
    receipt_size: { type: Number, enum: [58, 80], default: 80 },
    // bill printer at the counter (needs the "Printing" add-on; none = bills show on screen only)
    receipt_printer: { type: { type: String, enum: ["none", "network", "usb"], default: "none" }, address: { type: String, default: "", trim: true, maxlength: 100 } },
    receipt_footer: { type: String, default: "", trim: true, maxlength: 200 },
    receipt_theme: { type: String, enum: RECEIPT_THEMES, default: "classic" }, // paid looks: rest_receipt_theme
    pos_theme: { type: String, enum: [...POS_THEMES_FREE, ...POS_THEMES_PAID], default: "classic" }, // paid looks: rest_pos_theme
    qr_theme: { type: String, enum: [...QR_THEMES_FREE, ...QR_THEMES_PAID], default: "classic" }, // table stickers; paid looks: rest_qr_theme
    // customer display (add-on rest_display): what the guest's screen shows
    display: {
      theme: { type: String, enum: DISPLAY_THEMES, default: "clean" }, // paid looks: rest_display_theme
      header: { type: String, default: "", trim: true, maxlength: 80 }, // line at the top ("Free Wi-Fi: …")
      welcome: { type: String, default: "", trim: true, maxlength: 80 }, // big text when no order ("Welcome!")
      thanks: { type: String, default: "", trim: true, maxlength: 80 }, // after paying ("Thank you, see you soon!")
      footer: { type: String, default: "", trim: true, maxlength: 120 }, // line at the bottom (address, Facebook…)
      show_logo: { type: Boolean, default: true },
      banners: { type: [new Schema({ url: String, public_id: String }, { _id: false })], default: [] }, // pictures shown while waiting
      side_banners: { type: [new Schema({ url: String, public_id: String }, { _id: false })], default: [] }, // small slider beside the order (up to 3)
      color: { type: String, default: "" }, // accent colour ("" = the look's own)
      thanks_bg: { url: { type: String, default: "" }, public_id: { type: String, default: "" } }, // picture behind "thank you"
      thanks_blur: { type: Number, default: 30, min: 0, max: 100 },
      slide_seconds: { type: Number, enum: [4, 6, 10, 15], default: 6 },
    },
    wifi_name: { type: String, default: "", trim: true, maxlength: 40 },
    wifi_pass: { type: String, default: "", trim: true, maxlength: 40 },
    bill_numbering: { type: String, enum: ["daily", "running"], default: "daily" },
    money_saved: { type: Boolean, default: false }, // setup step 2 done
    // online menu (QR) link: /public/menu/<menu_token>
    menu_token: { type: String, required: true },
    // POS: how linked devices behave (owner sets it in the dashboard → POS)
    pos: {
      sync_mode: { type: String, enum: ["instant", "5", "15", "30", "shift"], default: "instant" }, // send sales: instantly / every N min / at shift close
      allow_offline: { type: Boolean, default: true },
      max_offline_hours: { type: Number, enum: [4, 12, 24, 72], default: 24 },
      max_line_discount: { type: Number, default: 100, min: 0, max: 100 }, // biggest % a cashier may take off one item by hand
      pair_code: { type: String, default: "" }, // 6 digits shown in the dashboard to link a device
      pair_expires: { type: Date, default: null },
    },
    // Table ordering add-on (rest_table_order): guests scan the QR on their table and order by themselves
    table_order: {
      enabled: { type: Boolean, default: false },
      lat: { type: Number, default: null, min: -90, max: 90 }, // the shop's place (guests must be near it)
      lng: { type: Number, default: null, min: -180, max: 180 },
      radius: { type: Number, enum: [0, 50, 100, 200, 500], default: 100 }, // metres; 0 = no location check
      require_open: { type: Boolean, default: true }, // only tables that staff have opened on the POS
      theme: { type: String, enum: [...ORDER_THEMES_FREE, ...ORDER_THEMES_PAID], default: "fresh" }, // look of the guest's page; paid: rest_order_theme
      sound: { url: { type: String, default: "" }, public_id: { type: String, default: "" }, name: { type: String, default: "" } }, // alert on the POS ("" = built-in chime)
    },
    // Rewards add-on (rest_rewards): members collect points and swap them for rewards
    rewards: {
      enabled: { type: Boolean, default: false },
      by_amount: { type: Boolean, default: true }, // points for money spent…
      points_per_step: { type: Number, default: 1, min: 0, max: 1000 }, // …this many per $1 (or per 1,000៛ in a riel shop)
      min_bill: { type: Number, default: 0, min: 0, max: 100000000 }, // bills under this give no points
      by_item: { type: Boolean, default: false }, // points set on each menu item (reward_points)
      expire_months: { type: Number, enum: [0, 3, 6, 12, 24], default: 0 }, // points go if the member hasn't come for this long (0 = never)
      mask_phone: { type: Boolean, default: true }, // the POS shows only the last 3 digits
      token: { type: String, default: "" }, // shop QR "check my points": /public/points/<token>
      theme: { type: String, enum: [...POINTS_THEMES_FREE, ...POINTS_THEMES_PAID], default: "classic" },
    },
    // Telegram add-on: the chat that gets the daily report (BizHub bot)
    telegram: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      chat_type: { type: String, default: "" }, // private | group | supergroup
      connected_at: { type: Date, default: null },
      daily_report: { type: Boolean, default: true },
      shift_open: { type: Boolean, default: true }, // message when a cashier opens a shift (opening cash)
      shift_close: { type: Boolean, default: true }, // shift report when it closes (sales, cash, difference)
      stock_alerts: { type: Boolean, default: true }, // an item gets low / sold out (Stock add-on)
      report_time: { type: String, default: "21:00", match: /^([01]\d|2[0-3]):[0-5]\d$/ }, // Cambodia time
      last_report_at: { type: Date, default: null },
      link_code: { type: String, default: "" }, // one-time code in t.me/<bot>?start=<code>
      link_expires: { type: Date, default: null },
    },
  },
  opts,
);
settingsSchema.index({ "telegram.link_code": 1 }, { partialFilterExpression: { "telegram.link_code": { $gt: "" } } });
settingsSchema.index({ business_id: 1 }, { unique: true });
settingsSchema.index({ menu_token: 1 }, { unique: true });

// ---------- floor ----------
const zoneSchema = new Schema({ ...owned, name: { type: String, required: true, trim: true, maxlength: 40 }, sort: { type: Number, default: 0 }, active: { type: Boolean, default: true } }, opts);
const tableSchema = new Schema(
  {
    ...owned,
    zone_id: { type: ObjectId, ref: "RestZone", default: null },
    name: { type: String, required: true, trim: true, maxlength: 20 },
    seats: { type: Number, default: 4, min: 1, max: 50 },
    sort: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    order_token: { type: String, default: "" }, // secret part of this table's ordering link (/public/order/<token>)
  },
  opts,
);
tableSchema.index({ business_id: 1, name: 1 }, { unique: true });
tableSchema.index({ order_token: 1 }, { partialFilterExpression: { order_token: { $gt: "" } } });

// ---------- menu ----------
const categorySchema = new Schema(
  {
    ...owned,
    name_km: { type: String, default: "", trim: true, maxlength: 60 },
    name_en: { type: String, default: "", trim: true, maxlength: 60 },
    color: { type: String, default: "#E0581A", match: COLOR_RE },
    sort: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  opts,
);
const stationSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 40 },
    printer: { type: { type: String, enum: ["none", "network", "usb"], default: "none" }, address: { type: String, default: "", trim: true, maxlength: 100 } },
    sort: { type: Number, default: 0 },
  },
  opts,
);
const priced = new Schema({ name: { type: String, required: true, trim: true, maxlength: 40 }, price: { type: Number, default: 0, min: 0, max: 1000000 } }, { _id: true });
const addonGroupSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 40 },
    required: { type: Boolean, default: false },
    min: { type: Number, default: 0, min: 0, max: 20 },
    max: { type: Number, default: 1, min: 1, max: 20 },
    options: { type: [priced], default: [] },
    sort: { type: Number, default: 0 },
  },
  opts,
);
const itemSchema = new Schema(
  {
    ...owned,
    category_id: { type: ObjectId, ref: "RestCategory", required: true },
    name_km: { type: String, default: "", trim: true, maxlength: 80 },
    name_en: { type: String, default: "", trim: true, maxlength: 80 },
    description: { type: String, default: "", trim: true, maxlength: 300 },
    photo: { type: image, default: () => ({}) },
    price: { type: Number, required: true, min: 0, max: 1000000 },
    code: { type: String, default: "", trim: true, maxlength: 20 },
    station_id: { type: ObjectId, ref: "RestStation", default: null },
    sizes: { type: [priced], default: [] },
    addon_group_ids: { type: [ObjectId], default: [] },
    available: { type: Boolean, default: true }, // "available today"
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
    // costing + stock ("Stock" add-on for tracking; cost is free for everyone so reports show profit)
    cost: { type: Number, default: 0, min: 0, max: 1000000 }, // what one costs the restaurant (main currency)
    track_stock: { type: Boolean, default: false },
    stock: { type: Number, default: 0 }, // how many are left (only changes through sales and stock moves)
    low_stock: { type: Number, default: 5, min: 0, max: 100000 }, // warn at or below this
    reward_points: { type: Number, default: 0, min: 0, max: 10000 }, // Rewards add-on: points for each one sold (stamp-card style)
  },
  opts,
);
itemSchema.index({ business_id: 1, category_id: 1, sort: 1 });
itemSchema.index({ business_id: 1, track_stock: 1 });

// a promotion (add-on rest_promos): % off, $ off, or buy X get Y — on some items / categories, at some dates / days / hours
const PROMO_KINDS = ["percent", "amount", "bxgy"];
const promoSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 60 },
    kind: { type: String, enum: PROMO_KINDS, required: true },
    value: { type: Number, default: 0, min: 0, max: 1000000 }, // percent: 1–100 · amount: off each one
    buy: { type: Number, default: 1, min: 1, max: 20 }, // bxgy: buy this many…
    get_qty: { type: Number, default: 1, min: 1, max: 20 }, // …and this many more…
    get_percent: { type: Number, default: 100, min: 1, max: 100 }, // …at this % off (100 = free). The cheapest ones are the cheaper.
    all_items: { type: Boolean, default: false },
    item_ids: { type: [String], default: [] },
    category_ids: { type: [String], default: [] },
    start_date: { type: String, default: "" }, // "YYYY-MM-DD" (Cambodia), "" = no start
    end_date: { type: String, default: "" },
    days: { type: [Number], default: [] }, // 0 = Sunday … 6; [] = every day
    from: { type: String, default: "" }, // "HH:MM"; "" = all day
    to: { type: String, default: "" },
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  opts,
);
promoSchema.index({ business_id: 1, sort: 1 });

// every change of an item's stock: stock in, out / waste, a count, a sale, a cancelled sale
const STOCK_KINDS = ["opening", "in", "out", "count", "sale", "void"];
const stockMoveSchema = new Schema(
  {
    ...owned,
    item_id: { type: ObjectId, ref: "RestItem", required: true },
    item_name: { type: String, default: "" },
    kind: { type: String, enum: STOCK_KINDS, required: true },
    qty: { type: Number, required: true }, // + in, − out
    before: { type: Number, default: 0 },
    after: { type: Number, default: 0 },
    cost: { type: Number, default: 0 }, // cost of one, at that time
    note: { type: String, default: "", maxlength: 200 },
    by: { type: String, default: "" },
    order_id: { type: String, default: "" },
    order_number: { type: String, default: "" },
  },
  opts,
);
stockMoveSchema.index({ business_id: 1, created_date: -1 });
stockMoveSchema.index({ business_id: 1, item_id: 1, created_date: -1 });

// ---------- staff (log in on the POS with a 4-digit PIN) ----------
const staffSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 60 },
    role: { type: String, enum: STAFF_ROLES, default: "cashier" },
    phone: { type: String, default: "", trim: true, maxlength: 30 },
    pin_key: { type: String, required: true }, // HMAC of the PIN (unique per restaurant), never the PIN itself
    // lets a POS check the PIN with no internet: sha256(pin_salt + ":" + pin); sent only to linked POS devices
    pin_salt: { type: String, default: "" },
    pin_check: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  opts,
);
staffSchema.index({ business_id: 1, pin_key: 1 }, { unique: true });

// ---------- website (add-on): one per restaurant, public at /s/<slug> ----------
const SITE_THEMES_FREE = ["classic", "fresh", "noir"];
const SITE_THEMES_PAID = ["bistro", "street", "zen", "luxe", "coastal", "diner"];
const SITE_THEMES = [...SITE_THEMES_FREE, ...SITE_THEMES_PAID];
const NAV_KEYS = ["home", "menu", "about", "gallery", "message", "contact"];
const MESSAGE_KINDS = ["feedback", "request", "booking", "other"];
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
const str = (max) => ({ type: String, default: "", trim: true, maxlength: max });
const siteSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true }, // unique index below
    slug: { type: String, trim: true, lowercase: true, maxlength: 40 }, // empty until the owner picks one
    published: { type: Boolean, default: false },
    theme: { type: String, enum: SITE_THEMES, default: "classic" },
    color: { type: String, default: "", match: /^(#[0-9a-fA-F]{6})?$/ }, // "" = the theme's own color
    hero: { title: str(80), subtitle: str(200), button: str(30), image: { type: image, default: () => ({}) } },
    // top menu of the site: built-in parts, each can be hidden, renamed and moved (custom links are in `links`)
    nav: { type: [new Schema({ key: { type: String, enum: NAV_KEYS }, label: str(30), show: { type: Boolean, default: true } }, { _id: false })], default: () => NAV_KEYS.map((key) => ({ key, label: "", show: true })) },
    about: {
      enabled: { type: Boolean, default: true },
      title: str(60),
      text: str(1500),
      image: { type: image, default: () => ({}) },
      image_side: { type: String, enum: ["left", "right"], default: "left" },
      highlights: { type: [new Schema({ value: str(20), label: str(40) }, { _id: false })], default: [] }, // e.g. "1998" · "Since"
    },
    // "Send us a message" form → messages arrive in the restaurant's inbox (and Telegram, if connected)
    form: {
      enabled: { type: Boolean, default: true },
      title: str(60),
      text: str(200),
      notify_telegram: { type: Boolean, default: true },
    },
    menu: {
      enabled: { type: Boolean, default: true },
      title: str(60),
      mode: { type: String, enum: ["all", "featured"], default: "all" },
      featured_ids: { type: [ObjectId], default: [] },
      show_prices: { type: Boolean, default: true },
    },
    gallery: { enabled: { type: Boolean, default: true }, title: str(60), images: { type: [image], default: [] } },
    contact: {
      enabled: { type: Boolean, default: true },
      title: str(60),
      phone: str(30),
      email: str(80),
      address: str(200),
      map_url: str(300),
      hours: str(120),
      facebook: str(300),
      instagram: str(300),
      tiktok: str(300),
      telegram: str(300),
    },
    links: { type: [new Schema({ label: str(30), url: str(300) }, { _id: false })], default: [] }, // extra menu links (top bar)
    footer_note: str(200),
    seo: { title: str(70), description: str(160) },
  },
  opts,
);
siteSchema.index({ business_id: 1 }, { unique: true });
siteSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: "string", $gt: "" } } });

// ---------- POS ----------
// a linked POS device (browser / Shop Hub / app). It signs in with a long random token (only its hash is kept).
const deviceSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 40 },
    prefix: { type: String, required: true, maxlength: 3 }, // letter on its bill numbers: A, B, … so two devices never clash offline
    token_hash: { type: String, required: true },
    kind: { type: String, enum: ["web", "hub", "app"], default: "web" },
    last_seen: { type: Date, default: null },
    last_sync: { type: Date, default: null },
    pending: { type: Number, default: 0 }, // sales the device said it still has to send
    revoked: { type: Boolean, default: false },
    // customer display on another tablet: it opens /pos/restaurant/display?key=… and reads what this POS shows
    display_key: { type: String, default: "" },
    display: { type: Schema.Types.Mixed, default: null },
    display_at: { type: Date, default: null },
    open_tables: { type: [String], default: [] }, // tables with an open bill on this device (for table ordering)
  },
  opts,
);
deviceSchema.index({ token_hash: 1 }, { unique: true });
deviceSchema.index({ display_key: 1 }, { partialFilterExpression: { display_key: { $gt: "" } } });

// a cashier shift on one device (id made on the device, so it can start offline)
const money2 = { usd: { type: Number, default: 0 }, khr: { type: Number, default: 0 } };
const shiftSchema = new Schema(
  {
    _id: { type: String }, // uuid from the device
    ...owned,
    device_id: { type: ObjectId, ref: "RestDevice", required: true },
    opened_by: { id: String, name: String },
    opened_at: { type: Date, required: true },
    opening: money2, // cash in the drawer at the start
    closed_by: { id: String, name: String },
    closed_at: { type: Date, default: null },
    counted: money2, // cash counted at the end
    expected: money2, // what should be in the drawer (worked out from the sales)
    totals: { type: Schema.Types.Mixed, default: {} }, // sales, bills, by method… (filled when closed)
    status: { type: String, enum: ["open", "closed"], default: "open" },
    note: { type: String, default: "", maxlength: 300 },
    version: { type: Number, default: 0 },
    seq: { type: Number, default: 0, index: true },
  },
  { ...opts, _id: false },
);
shiftSchema.index({ business_id: 1, opened_at: -1 });

// a table booking (made on any POS, offline too): just a name and a phone, optionally a time
const bookingSchema = new Schema(
  {
    _id: { type: String }, // uuid from the device
    ...owned,
    device_id: { type: ObjectId, ref: "RestDevice" },
    table_id: { type: String, default: "" },
    table_name: { type: String, default: "" },
    name: { type: String, default: "", maxlength: 60 },
    phone: { type: String, default: "", maxlength: 30 },
    time: { type: Date, default: null },
    guests: { type: Number, default: 0 },
    note: { type: String, default: "", maxlength: 200 },
    status: { type: String, enum: ["active", "seated", "cancelled"], default: "active" },
    order_id: { type: String, default: "" },
    created_by: { type: String, default: "" },
    version: { type: Number, default: 0 },
    seq: { type: Number, default: 0 },
  },
  { ...opts, _id: false },
);
bookingSchema.index({ business_id: 1, status: 1 });
bookingSchema.index({ business_id: 1, seq: 1 });

// an order / bill. Lines and payments carry their own ids, so two devices (or an offline one) never overwrite each other.
const orderLine = new Schema(
  {
    id: { type: String, required: true },
    item_id: { type: String, default: "" },
    name_km: { type: String, default: "" },
    name_en: { type: String, default: "" },
    size: { type: String, default: "" },
    unit_price: { type: Number, default: 0 }, // item (or size) price
    addons: { type: [new Schema({ group: String, name: String, price: Number }, { _id: false })], default: [] },
    qty: { type: Number, default: 1 },
    note: { type: String, default: "" },
    status: { type: String, enum: ["new", "sent", "void"], default: "new" },
    void_reason: { type: String, default: "" },
    void_by: { type: String, default: "" },
    station_id: { type: String, default: "" },
    created_at: { type: Date },
    created_by: { type: String, default: "" },
    cost: { type: Number, default: 0 }, // cost of one when sold (for profit)
    // discount on this line: by hand (cashier) or from a promotion (worked out on the POS)
    discount: { kind: { type: String, enum: ["", "percent", "amount"], default: "" }, value: { type: Number, default: 0 }, by: { type: String, default: "" }, reason: { type: String, default: "" } },
    promo: { id: { type: String, default: "" }, name: { type: String, default: "" }, off: { type: Number, default: 0 } },
    from: { type: String, default: "" }, // "guest" = ordered by the guest from the table QR
    guest_name: { type: String, default: "" },
    reward_id: { type: String, default: "" }, // a free item paid with points (redemption id)
  },
  { _id: false },
);
const payment = new Schema(
  {
    id: { type: String, required: true },
    method: { type: String, default: "" }, // name as set in Money (Cash, ABA…)
    kind: { type: String, default: "cash" },
    currency: { type: String, enum: ["USD", "KHR"], default: "USD" },
    amount: { type: Number, default: 0 }, // what the guest handed over, in its currency
    value: { type: Number, default: 0 }, // that amount in the restaurant's main currency
    at: { type: Date },
    by: { type: String, default: "" },
  },
  { _id: false },
);
const orderSchema = new Schema(
  {
    _id: { type: String }, // uuid from the device
    ...owned,
    device_id: { type: ObjectId, ref: "RestDevice", required: true },
    shift_id: { type: String, default: "" },
    number: { type: String, default: "" }, // A-0001
    type: { type: String, enum: ["dine_in", "takeaway"], default: "dine_in" },
    table_id: { type: String, default: "" },
    table_name: { type: String, default: "" },
    guests: { type: Number, default: 0 },
    status: { type: String, enum: ["open", "paid", "void"], default: "open" },
    lines: { type: [orderLine], default: [] },
    discount: { kind: { type: String, enum: ["", "percent", "amount"], default: "" }, value: { type: Number, default: 0 }, by: { type: String, default: "" } },
    payments: { type: [payment], default: [] },
    change: money2, // change handed back
    totals: { type: Schema.Types.Mixed, default: {} }, // worked out again on the server (pos.calc.js)
    currency: { type: String, default: "USD" },
    khr_rate: { type: Number, default: 4100 },
    opened_by: { id: String, name: String },
    closed_by: { id: String, name: String },
    void_reason: { type: String, default: "" },
    opened_at: { type: Date },
    paid_at: { type: Date, default: null },
    bill_printed: { type: Boolean, default: false },
    note: { type: String, default: "", maxlength: 300 },
    stock_applied: { type: Boolean, default: false },
    // Rewards: the member on this bill, a reward taken off the bill, what was swapped for points
    member: { id: { type: String, default: "" }, name: { type: String, default: "" }, phone: { type: String, default: "" } },
    reward_discount: { kind: { type: String, default: "" }, value: { type: Number, default: 0 }, name: { type: String, default: "" }, redemption_id: { type: String, default: "" } },
    redemptions: { type: [Schema.Types.Mixed], default: [] },
    points_earned: { type: Number, default: 0 }, // worked out by the server when the bill is paid
    points_applied: { type: Boolean, default: false }, // the member got them (set by the server) // its items were taken out of stock (set by the server) // about the table / guests ("birthday, friends of the owner…")
    version: { type: Number, default: 0 }, // bumped by the device on each change
    device_updated_at: { type: Date },
    seq: { type: Number, default: 0 }, // server change counter (for pulling changes)
  },
  { ...opts, _id: false },
);
orderSchema.index({ business_id: 1, seq: 1 });
orderSchema.index({ business_id: 1, status: 1 });
orderSchema.index({ business_id: 1, paid_at: -1 });
orderSchema.index({ business_id: 1, status: 1, paid_at: -1 }); // sales of a day (reports, Telegram)

// per-restaurant change counter: every POS write gets the next number, devices pull "everything after N"
const counterSchema = new Schema({ business_id: { type: ObjectId, required: true, unique: true }, seq: { type: Number, default: 0 }, setup: { type: Number, default: 0 } });

// messages sent from the website's contact form (the restaurant's inbox)
const siteMessageSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    contact: { type: String, required: true, trim: true, maxlength: 100 }, // email or phone
    kind: { type: String, enum: MESSAGE_KINDS, default: "feedback" },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    read: { type: Boolean, default: false },
    ip_key: { type: String, default: "" }, // hashed, for spam limits only
  },
  opts,
);
siteMessageSchema.index({ business_id: 1, created_date: -1 });

// ---------- Rewards (add-on rest_rewards) ----------
const REWARD_KINDS = ["free_item", "amount", "percent", "gift", "coupon"];
const memberSchema = new Schema(
  {
    ...owned,
    phone: { type: String, required: true }, // digits only, the member's id in this shop
    name: { type: String, default: "", trim: true, maxlength: 60 },
    birthday: { type: String, default: "" }, // "YYYY-MM-DD" or "MM-DD"
    note: { type: String, default: "", trim: true, maxlength: 200 },
    points: { type: Number, default: 0 },
    total_spent: { type: Number, default: 0 },
    visits: { type: Number, default: 0 },
    last_visit: { type: Date, default: null },
    token: { type: String, required: true }, // private member page /public/member/<token>
    active: { type: Boolean, default: true },
  },
  opts,
);
memberSchema.index({ business_id: 1, phone: 1 }, { unique: true });
memberSchema.index({ token: 1 }, { unique: true });
memberSchema.index({ business_id: 1, total_spent: -1 });
// every change to a member's points
const POINT_KINDS = ["earn", "redeem", "refund", "adjust", "reverse", "expire"];
const pointMoveSchema = new Schema(
  {
    ...owned,
    member_id: { type: ObjectId, required: true },
    kind: { type: String, enum: POINT_KINDS, required: true },
    points: { type: Number, required: true }, // + in, − out
    balance: { type: Number, default: 0 }, // after this move
    order_id: { type: String, default: "" },
    order_number: { type: String, default: "" },
    reward_name: { type: String, default: "" },
    note: { type: String, default: "" },
    by: { type: String, default: "" },
  },
  opts,
);
pointMoveSchema.index({ business_id: 1, member_id: 1, created_date: -1 });
pointMoveSchema.index({ business_id: 1, created_date: -1 });
const rewardSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 60 },
    kind: { type: String, enum: REWARD_KINDS, required: true },
    points: { type: Number, required: true, min: 1, max: 1000000 }, // cost
    item_id: { type: String, default: "" }, // free_item (and coupon → free item)
    value: { type: Number, default: 0, min: 0, max: 100000000 }, // amount off / % off
    coupon_kind: { type: String, enum: ["", "free_item", "amount", "percent"], default: "" }, // what the coupon gives later
    note: { type: String, default: "", trim: true, maxlength: 120 },
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  opts,
);
rewardSchema.index({ business_id: 1, sort: 1 });
// a reward a member took: used on a bill, a gift handed over, or a coupon kept for later
const redemptionSchema = new Schema(
  {
    ...owned,
    member_id: { type: ObjectId, required: true },
    reward_id: { type: String, default: "" },
    name: { type: String, default: "" },
    kind: { type: String, enum: REWARD_KINDS, required: true }, // for a coupon being used: what it gives
    value: { type: Number, default: 0 },
    item_id: { type: String, default: "" },
    points: { type: Number, default: 0 },
    status: { type: String, enum: ["used", "coupon", "refunded"], default: "used" }, // coupon = kept, not used yet
    code: { type: String, default: "" }, // coupons
    order_id: { type: String, default: "" },
    order_number: { type: String, default: "" },
    used_at: { type: Date, default: null },
    by: { type: String, default: "" },
  },
  opts,
);
redemptionSchema.index({ business_id: 1, member_id: 1, status: 1 });
redemptionSchema.index({ business_id: 1, order_id: 1 });

// an order a guest sent from the table QR (add-on rest_table_order). A POS picks it up ("claimed"),
// adds the lines to that table's bill and confirms ("accepted"). The guest sees it but can't change it.
const GUEST_STATUSES = ["new", "claimed", "accepted", "rejected"];
const guestLine = new Schema(
  {
    item_id: String,
    name_km: String,
    name_en: String,
    size: { type: String, default: "" },
    unit_price: Number,
    addons: { type: [new Schema({ group: String, name: String, price: Number }, { _id: false })], default: [] },
    qty: Number,
    note: { type: String, default: "" },
    station_id: { type: String, default: "" },
    cost: { type: Number, default: 0 },
  },
  { _id: false },
);
const guestOrderSchema = new Schema(
  {
    ...owned,
    table_id: { type: String, required: true },
    table_name: { type: String, default: "" },
    guest_key: { type: String, required: true }, // random id kept in the guest's browser (to show them their orders)
    guest_name: { type: String, default: "", maxlength: 40 },
    lines: { type: [guestLine], default: [] },
    total: { type: Number, default: 0 },
    status: { type: String, enum: GUEST_STATUSES, default: "new" },
    claimed_by: { type: ObjectId, default: null }, // device
    claimed_at: { type: Date, default: null },
    accepted_at: { type: Date, default: null },
    order_id: { type: String, default: "" },
    order_number: { type: String, default: "" },
    distance: { type: Number, default: null }, // metres from the shop when sent
    member: { id: { type: String, default: "" }, name: { type: String, default: "" }, phone: { type: String, default: "" } }, // Rewards: phone the guest gave
  },
  opts,
);
guestOrderSchema.index({ business_id: 1, status: 1, created_date: 1 });
guestOrderSchema.index({ table_id: 1, guest_key: 1, created_date: -1 });
guestOrderSchema.index({ business_id: 1, created_date: -1 });

module.exports = {
  RestSettings: mongoose.model("RestSettings", settingsSchema),
  RestZone: mongoose.model("RestZone", zoneSchema),
  RestTable: mongoose.model("RestTable", tableSchema),
  RestCategory: mongoose.model("RestCategory", categorySchema),
  RestStation: mongoose.model("RestStation", stationSchema),
  RestAddonGroup: mongoose.model("RestAddonGroup", addonGroupSchema),
  RestItem: mongoose.model("RestItem", itemSchema),
  RestStaff: mongoose.model("RestStaff", staffSchema),
  RestSite: mongoose.model("RestSite", siteSchema),
  RestSiteMessage: mongoose.model("RestSiteMessage", siteMessageSchema),
  RestDevice: mongoose.model("RestDevice", deviceSchema),
  RestShift: mongoose.model("RestShift", shiftSchema),
  RestOrder: mongoose.model("RestOrder", orderSchema),
  RestBooking: mongoose.model("RestBooking", bookingSchema),
  RestStockMove: mongoose.model("RestStockMove", stockMoveSchema),
  RestPromo: mongoose.model("RestPromo", promoSchema),
  RestGuestOrder: mongoose.model("RestGuestOrder", guestOrderSchema),
  RestMember: mongoose.model("RestMember", memberSchema),
  RestPointMove: mongoose.model("RestPointMove", pointMoveSchema),
  RestReward: mongoose.model("RestReward", rewardSchema),
  RestRedemption: mongoose.model("RestRedemption", redemptionSchema),
  REWARD_KINDS,
  POINT_KINDS,
  QR_THEMES_FREE,
  POINTS_THEMES_FREE,
  POINTS_THEMES_PAID,
  QR_THEMES_PAID,
  ORDER_THEMES_FREE,
  ORDER_THEMES_PAID,
  GUEST_STATUSES,
  PROMO_KINDS,
  STOCK_KINDS,
  RestCounter: mongoose.model("RestCounter", counterSchema),
  NAV_KEYS,
  MESSAGE_KINDS,
  RECEIPT_THEMES_FREE,
  RECEIPT_THEMES_PAID,
  POS_THEMES_FREE,
  POS_THEMES_PAID,
  DISPLAY_THEMES_FREE,
  DISPLAY_THEMES_PAID,
  MAX_BANNERS,
  MAX_SIDE_BANNERS,
  DISPLAY_COLORS,
  SITE_THEMES_FREE,
  SITE_THEMES_PAID,
  SITE_THEMES,
  SLUG_RE,
  RESTAURANT_TYPES,
  PAYMENT_KINDS,
  STAFF_ROLES,
  COLOR_RE,
};
