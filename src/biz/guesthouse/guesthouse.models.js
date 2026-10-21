// Guest House: settings, room types, rooms, stays (a booking = one guest in one room from a date to a date)
const mongoose = require("mongoose");

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };
const owned = { business_id: { type: ObjectId, ref: "Business", required: true, index: true } };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES = ["booked", "in", "out", "cancelled", "no_show"]; // booked → in (checked in) → out (checked out)
const LIVE = ["booked", "in"]; // these hold the room
const SOURCES = ["walk_in", "phone", "facebook", "telegram", "booking_com", "agoda", "airbnb", "expedia", "website", "other"];
const METHODS = ["cash", "aba", "acleda", "wing", "card", "bank", "other"];
const ID_TYPES = ["id_card", "passport", "other"];
const SERVICE_ICONS = ["laundry", "bike", "tour", "minibar", "food", "coffee", "transfer", "spa", "other"];

const settingsSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    currency: { type: String, enum: ["USD", "KHR"], default: "USD" },
    check_in: { type: String, default: "14:00", match: HHMM },
    check_out: { type: String, default: "12:00", match: HHMM },
    methods: { type: [String], default: () => ["cash", "aba"] }, // payment methods shown at the desk
    khr_rate: { type: Number, default: 4100, min: 1000, max: 10000 },
    next_no: { type: Number, default: 1 }, // booking number counter (B-0001)
    receipt_note: { type: String, default: "", trim: true, maxlength: 300 },
    pay_qr: { url: { type: String, default: "" }, public_id: { type: String, default: "" } }, // ABA / KHQR picture shown on the guest display
    pay_qr_label: { type: String, default: "", trim: true, maxlength: 60 }, // e.g. "ABA · Mekong View"
    display_theme: { type: String, default: "classic" }, // guest display look (gh_display_theme)
    print_theme: { type: String, default: "classic" }, // receipt template (gh_print_theme)
    print_size: { type: String, enum: ["80", "58", "a4"], default: "80" }, // receipt paper
    print_auto: { type: Boolean, default: false }, // print the receipt by itself after check-out
    print_qr: { type: Boolean, default: true }, // payment QR on unpaid bills
    portal_on: { type: Boolean, default: true }, // customer accounts on the website (gh_customers)
    portal_theme: { type: String, default: "classic" }, // customer dashboard look (gh_portal_theme)
    portal_note: { type: String, default: "", trim: true, maxlength: 300 }, // shown to customers when they book
    display_image: { url: { type: String, default: "" }, public_id: { type: String, default: "" } }, // shown on the guest display when there is no QR (and when idle)
    // business profile (logo lives on the business: logo_url)
    logo_public_id: { type: String, default: "" },
    cover: { url: { type: String, default: "" }, public_id: { type: String, default: "" } },
    email: { type: String, default: "", trim: true, maxlength: 120 },
    website: { type: String, default: "", trim: true, maxlength: 200 },
    facebook: { type: String, default: "", trim: true, maxlength: 200 },
    telegram: { type: String, default: "", trim: true, maxlength: 100 },
    map_url: { type: String, default: "", trim: true, maxlength: 500 },
    description: { type: String, default: "", trim: true, maxlength: 1000 },
    // Telegram alerts (gh_telegram, yearly): the BizHub bot sends alerts + a daily summary to the owner's chat
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      chat_type: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "" },
      link_expires: { type: Date, default: null },
      daily_report: { type: Boolean, default: true },
      report_time: { type: String, default: "21:00", match: HHMM },
      last_report_at: { type: Date, default: null },
      new_booking: { type: Boolean, default: true }, // online booking requests (website + customer accounts)
      check_in: { type: Boolean, default: true },
      check_out: { type: Boolean, default: true },
      payment: { type: Boolean, default: true },
    },
    // extra services menu (gh_services, forever): tap onto a bill at the desk
    services: {
      type: [
        {
          name: { type: String, required: true, trim: true, maxlength: 60 },
          price: { type: Number, required: true, min: 0, max: 100000000 },
          icon: { type: String, default: "other", maxlength: 20 },
          active: { type: Boolean, default: true },
        },
      ],
      default: [],
    },
    reviews_auto: { type: Boolean, default: true }, // guest reviews (gh_reviews): 4–5 stars go on the website by themselves
    loyalty: {
      earn: { type: Number, default: 1, min: 0, max: 1000 }, // points for each $1 (or each 4,000៛) paid
      redeem_points: { type: Number, default: 100, min: 1, max: 1000000 }, // this many points…
      redeem_value: { type: Number, default: 5, min: 0, max: 100000000 }, // …are worth this much off a bill
    },
    ical_token: { type: String, default: "" }, // secret part of the calendar links we give to Booking.com / Agoda (gh_ical)
    pair_code: { type: String, default: "" }, // 6 digits to pair a desk POS (10 minutes)
    pair_expires: { type: Date, default: null },
  },
  opts,
);

const roomTypeSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 60 }, // "Double", "Family"…
    price: { type: Number, required: true, min: 0, max: 100000000 }, // per night
    capacity: { type: Number, default: 2, min: 1, max: 20 }, // people
    beds: { type: String, default: "", trim: true, maxlength: 60 }, // "1 queen bed"
    amenities: { type: [String], default: [] }, // "ac", "fan", "wifi", "tv", "hot_water", "fridge", "balcony"
    color: { type: String, default: "#2563EB" },
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  opts,
);

const roomSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 20 }, // "101"
    floor: { type: String, default: "", trim: true, maxlength: 20 },
    type_id: { type: ObjectId, required: true },
    note: { type: String, default: "", trim: true, maxlength: 500 }, // description
    details: { type: [{ label: { type: String, maxlength: 40 }, value: { type: String, maxlength: 120 }, _id: false }], default: [] }, // "View: River", "Size: 25 m²"
    // housekeeping (gh_housekeeping): dirty → cleaning → ready (check-out makes it dirty)
    hk: { type: String, enum: ["ready", "dirty", "cleaning"], default: "ready" },
    hk_by: { type: String, default: "" },
    hk_at: { type: Date, default: null },
    hk_note: { type: String, default: "", trim: true, maxlength: 200 },
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  opts,
);
roomSchema.index({ business_id: 1, name: 1 }, { unique: true });

const lineSchema = new Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 80 },
    amount: { type: Number, required: true, min: 0, max: 100000000 }, // unit price
    qty: { type: Number, default: 1, min: 1, max: 1000 },
    at: { type: Date, default: Date.now },
    by: { type: String, default: "" },
    client_id: { type: String, default: "" }, // made offline on a desk POS: replaying it twice adds it once
    service_id: { type: String, default: "" }, // from the extra services menu (gh_services) → sales report
  },
  { _id: true },
);
const paymentSchema = new Schema(
  {
    method: { type: String, enum: METHODS, default: "cash" },
    amount: { type: Number, required: true }, // negative = refund
    note: { type: String, default: "", trim: true, maxlength: 120 },
    at: { type: Date, default: Date.now },
    by: { type: String, default: "" },
    client_id: { type: String, default: "" },
  },
  { _id: true },
);

const staySchema = new Schema(
  {
    ...owned,
    no: { type: String, required: true }, // "B-0001"
    client_id: { type: String, default: undefined }, // booked offline on a desk POS (sent again → the same booking)
    room_id: { type: ObjectId, required: true },
    status: { type: String, enum: STATUSES, default: "booked" },
    from: { type: String, required: true }, // "YYYY-MM-DD" arrival
    to: { type: String, required: true }, // "YYYY-MM-DD" departure (the room is free that night)
    rate: { type: Number, required: true, min: 0, max: 100000000 }, // per night, agreed for this stay
    guest: {
      name: { type: String, required: true, trim: true, maxlength: 80 },
      phone: { type: String, default: "", trim: true, maxlength: 30 },
      id_type: { type: String, enum: ID_TYPES, default: "id_card" },
      id_number: { type: String, default: "", trim: true, maxlength: 40 },
      nationality: { type: String, default: "", trim: true, maxlength: 40 },
      // for the foreign guest report (gh_police)
      gender: { type: String, enum: ["", "m", "f"], default: "" },
      dob: { type: String, default: "", maxlength: 10 }, // YYYY-MM-DD
      visa_type: { type: String, default: "", trim: true, maxlength: 30 }, // T (tourist), E (business), K…
      visa_until: { type: String, default: "", maxlength: 10 }, // YYYY-MM-DD
    },
    // photos of the guest's ID card / passport (optional, taken at the desk) — max 4
    id_photos: { type: [{ url: String, public_id: String, at: { type: Date, default: Date.now }, by: String }], default: [] },
    adults: { type: Number, default: 1, min: 1, max: 20 },
    children: { type: Number, default: 0, min: 0, max: 20 },
    source: { type: String, enum: SOURCES, default: "walk_in" },
    note: { type: String, default: "", trim: true, maxlength: 500 },
    charges: { type: [lineSchema], default: [] }, // extras on the bill (breakfast, laundry, late check-out…)
    discount: { type: Number, default: 0, min: 0, max: 100000000 },
    payments: { type: [paymentSchema], default: [] },
    checked_in_at: { type: Date, default: null },
    checked_out_at: { type: Date, default: null },
    cancelled_at: { type: Date, default: null },
    by: { type: String, default: "" },
    // long stay / monthly rent (gh_longstay): the stay holds the room; each month's bill is added as bill lines
    lease: {
      type: new Schema(
        {
          rent: { type: Number, default: 0, min: 0, max: 100000000 }, // a month
          deposit: { type: Number, default: 0, min: 0, max: 100000000 },
          elec_rate: { type: Number, default: 0, min: 0, max: 1000000 }, // a kWh
          water_rate: { type: Number, default: 0, min: 0, max: 1000000 }, // a m³
          fixed: { type: [{ label: { type: String, maxlength: 60 }, amount: { type: Number, min: 0, max: 100000000 }, _id: false }], default: [] }, // internet, trash…
          bill_day: { type: Number, default: 1, min: 1, max: 28 },
          start: { type: String, default: "" },
          end: { type: String, default: "" }, // "" = open-ended
          meter: { elec: { type: Number, default: 0 }, water: { type: Number, default: 0 } }, // last readings
          bills: { type: [{ month: String, elec_prev: Number, elec_cur: Number, water_prev: Number, water_cur: Number, total: Number, at: Date, by: String, _id: false }], default: [] },
        },
        { _id: false },
      ),
      default: undefined,
    },
    customer_id: { type: ObjectId, default: null }, // a customer account (website booking, or linked at the desk) → loyalty points
    points_used: { type: Number, default: 0 }, // loyalty points turned into a discount on this stay
    points_value: { type: Number, default: 0 }, // …and the money they took off
    points_given: { type: Number, default: 0 }, // loyalty points earned at check-out
    ical_feed: { type: ObjectId, default: null }, // imported from a Booking.com / Agoda / Airbnb calendar (gh_ical)
    ical_uid: { type: String, default: undefined },
  },
  opts,
);
staySchema.index({ business_id: 1, room_id: 1, from: 1, to: 1 });
staySchema.index({ ical_feed: 1, ical_uid: 1 }, { partialFilterExpression: { ical_uid: { $type: "string" } } });
staySchema.index({ business_id: 1, status: 1 });
staySchema.index({ business_id: 1, "payments.at": 1 }); // money taken per day (today, reports, Telegram)
staySchema.index({ business_id: 1, from: -1, created_date: -1 }); // bookings list
staySchema.index({ business_id: 1, no: 1 }, { unique: true });
staySchema.index({ business_id: 1, "guest.phone": 1 });
staySchema.index({ business_id: 1, client_id: 1 }, { unique: true, partialFilterExpression: { client_id: { $type: "string" } } });

// desk staff for the POS (/pos/guest-house): log in with a 4-digit PIN
const STAFF_ROLES = ["manager", "desk", "housekeeper"]; // housekeeper: only the housekeeping screen (gh_housekeeping)
const staffSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 60 },
    role: { type: String, enum: STAFF_ROLES, default: "desk" },
    phone: { type: String, default: "", trim: true, maxlength: 30 },
    pin_key: { type: String, required: true }, // HMAC(business:pin) — never the PIN itself
    pin_salt: { type: String, default: "" }, // the desk checks a PIN offline: sha256(salt:pin) === pin_check
    pin_check: { type: String, default: "" },
    pin_v: { type: Number, default: 0 }, // +1 on a new PIN → old sessions end
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  opts,
);
staffSchema.index({ business_id: 1, pin_key: 1 }, { unique: true });

// a paired desk computer / tablet
const deviceSchema = new Schema(
  {
    ...owned,
    name: { type: String, default: "", trim: true, maxlength: 60 },
    token_hash: { type: String, required: true, index: true },
    revoked: { type: Boolean, default: false },
    last_seen: { type: Date, default: null },
    display_key: { type: String, default: "", index: true }, // a guest display on another tablet reads with this
    display_state: { type: Schema.Types.Mixed, default: null },
    display_at: { type: Date, default: null },
  },
  opts,
);

// receipt templates: the first is free, the others are bought one by one (gh_print_theme, item = name)
const PRINT_THEMES = [
  "classic",
  "modern",
  "typewriter",
  "bold",
  "compact",
  "elegant",
  "boxed",
  "columns",
  "biglogo",
  "minimal",
  "khmer",
  "ticket",
  "stamp",
  "invoice",
  "folio",
  "postcard",
  "retro",
  "banner",
  "grid",
  "regcard",
  "luxe",
  "large",
  "zigzag",
  "calendar",
];
// guest display looks: the first is free, the others are bought one by one (gh_display_theme, item = name)
const DISPLAY_THEMES = ["classic", "paper", "resort", "gold", "sunrise", "minimal", "neon", "khmer", "ocean", "boutique", "forest", "split"];

// ---------- website (gh_website, yearly): public at /g/<slug> ----------
// 24 looks: classic is free, the others are bought one by one (gh_site_theme, item = look, forever)
const SITE_THEMES = [
  "classic",
  "riverside",
  "boutique",
  "tropical",
  "beach",
  "mountain",
  "angkor",
  "hostel",
  "villa",
  "minimal",
  "colonial",
  "bamboo",
  "sunset",
  "lotus",
  "night",
  "nordic",
  "vintage",
  "resort",
  "garden",
  "urban",
  "family",
  "lake",
  "magazine",
  "glass",
];
const SITE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
const COLOR_RE = /^#[0-9A-F]{6}$/;
const FACILITIES = ["wifi", "parking", "ac", "hot_water", "breakfast", "restaurant", "pool", "garden", "laundry", "airport", "tours", "bike", "motorbike", "family", "pets", "reception24", "kitchen", "terrace", "river_view", "cards"];
const img = { url: { type: String, default: "" }, public_id: { type: String, default: "" } };
const siteSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    slug: { type: String, default: undefined, lowercase: true, trim: true },
    published: { type: Boolean, default: false },
    theme: { type: String, enum: SITE_THEMES, default: "classic" },
    color: { type: String, default: "" }, // replaces the look's main colour
    hero: { kicker: { type: String, default: "" }, title: { type: String, default: "" }, subtitle: { type: String, default: "" }, button: { type: String, default: "" }, image: img },
    about: { enabled: { type: Boolean, default: true }, title: { type: String, default: "" }, text: { type: String, default: "" }, image: img, highlights: { type: [{ value: String, label: String, _id: false }], default: [] } },
    rooms: {
      enabled: { type: Boolean, default: true },
      title: { type: String, default: "" },
      subtitle: { type: String, default: "" },
      show_prices: { type: Boolean, default: true },
      items: { type: [{ type_id: ObjectId, text: { type: String, default: "" }, hidden: { type: Boolean, default: false }, images: { type: [img], default: [] }, _id: false }], default: [] }, // extra words + photos per room type
    },
    facilities: { enabled: { type: Boolean, default: true }, title: { type: String, default: "" }, keys: { type: [String], default: () => ["wifi", "parking", "ac", "hot_water"] }, extra: { type: [String], default: [] } },
    gallery: { enabled: { type: Boolean, default: true }, title: { type: String, default: "" }, images: { type: [img], default: [] } },
    booking: { enabled: { type: Boolean, default: true }, title: { type: String, default: "" }, text: { type: String, default: "" }, show_free: { type: Boolean, default: true } },
    contact: {
      enabled: { type: Boolean, default: true },
      title: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
      address: { type: String, default: "" },
      map_url: { type: String, default: "" },
      facebook: { type: String, default: "" },
      telegram: { type: String, default: "" },
      instagram: { type: String, default: "" },
      tiktok: { type: String, default: "" },
      whatsapp: { type: String, default: "" },
    },
    footer_note: { type: String, default: "" },
    seo: { title: { type: String, default: "" }, description: { type: String, default: "" } },
  },
  opts,
);
siteSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: "string" } } });
// a booking request sent from the website (the owner calls back and books it)
const siteRequestSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, maxlength: 80 },
    contact: { type: String, required: true, maxlength: 100 },
    from: { type: String, default: "" },
    to: { type: String, default: "" },
    type_id: { type: ObjectId, default: null },
    type_name: { type: String, default: "" },
    guests: { type: Number, default: 1 },
    message: { type: String, default: "", maxlength: 1000 },
    estimate: { type: Number, default: 0 }, // room total with deals
    status: { type: String, enum: ["new", "done"], default: "new" },
    ip_key: { type: String, default: "" },
  },
  opts,
);
siteRequestSchema.index({ business_id: 1, created_date: -1 });

// ---------- promotions (gh_promos, forever): season / date deals shown on the website ----------
const PROMO_KINDS = ["percent", "amount", "price"]; // % off a night · amount off a night · a special price a night
const promoSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 60 }, // "Low season"
    badge: { type: String, default: "", trim: true, maxlength: 24 }, // "-20%" (empty → made from the deal)
    note: { type: String, default: "", trim: true, maxlength: 200 },
    kind: { type: String, enum: PROMO_KINDS, default: "percent" },
    value: { type: Number, required: true, min: 0, max: 100000000 },
    type_ids: { type: [ObjectId], default: [] }, // empty = every room type
    from: { type: String, required: true }, // first night "YYYY-MM-DD"
    to: { type: String, required: true }, // last night (included)
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  opts,
);

// ---------- customer accounts (gh_customers, yearly; needs gh_website): sign up on the website, ask for bookings ----------
const PORTAL_THEMES = ["classic", "ocean", "sunset", "forest", "midnight", "rose"]; // classic free, others gh_portal_theme
const customerSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    password: { type: String, required: true }, // bcrypt
    pass_v: { type: Number, default: 0 }, // +1 on a new password → old logins end
    blocked: { type: Boolean, default: false },
    last_login: { type: Date, default: null },
    points: { type: Number, default: 0 }, // loyalty points (gh_loyalty)
  },
  opts,
);
customerSchema.index({ business_id: 1, email: 1 }, { unique: true });
const REQUEST_STATUSES = ["pending", "accepted", "declined", "cancelled"];
const custBookingSchema = new Schema(
  {
    ...owned,
    customer_id: { type: ObjectId, required: true, index: true },
    type_id: { type: ObjectId, required: true },
    type_name: { type: String, default: "" },
    from: { type: String, required: true },
    to: { type: String, required: true },
    adults: { type: Number, default: 1 },
    children: { type: Number, default: 0 },
    note: { type: String, default: "", maxlength: 500 },
    estimate: { type: Number, default: 0 }, // room total with deals, when asked
    rate: { type: Number, default: 0 }, // average night price with deals
    status: { type: String, enum: REQUEST_STATUSES, default: "pending" },
    stay_id: { type: ObjectId, default: null }, // the booking made on accept
    decided_by: { type: String, default: "" },
    decided_at: { type: Date, default: null },
    reason: { type: String, default: "", maxlength: 200 }, // why declined
    pay_method: { type: String, enum: ["cash", "qr"], default: "cash" }, // pay at the guest house · paid by bank / KHQR
    pay_proof: { url: { type: String, default: "" }, public_id: { type: String, default: "" } }, // the transfer screenshot
    pay_recorded: { type: Boolean, default: false }, // the transfer was added to the bill on accept
  },
  opts,
);
custBookingSchema.index({ business_id: 1, status: 1, created_date: -1 });

// ---------- expenses (gh_expenses, forever): money going out → profit ----------
const EXPENSE_CATS = ["salary", "electricity", "water", "internet", "supplies", "laundry", "repair", "food", "rent", "tax", "marketing", "commission", "other"];
const expenseSchema = new Schema(
  {
    ...owned,
    day: { type: String, required: true }, // YYYY-MM-DD
    category: { type: String, enum: EXPENSE_CATS, default: "other" },
    amount: { type: Number, required: true, min: 0, max: 100000000 },
    method: { type: String, enum: ["cash", "bank"], default: "cash" },
    note: { type: String, default: "", trim: true, maxlength: 200 },
    by: { type: String, default: "" },
  },
  opts,
);
expenseSchema.index({ business_id: 1, day: -1 });

// ---------- Booking.com / Agoda / Airbnb calendar links (gh_ical, yearly) ----------
const ICAL_SOURCES = ["booking_com", "agoda", "airbnb", "expedia", "other"];
const icalFeedSchema = new Schema(
  {
    ...owned,
    room_id: { type: ObjectId, required: true },
    source: { type: String, enum: ICAL_SOURCES, default: "other" },
    url: { type: String, required: true, trim: true, maxlength: 1000 },
    active: { type: Boolean, default: true },
    last_sync_at: { type: Date, default: null },
    last_ok_at: { type: Date, default: null },
    last_error: { type: String, default: "" },
    last_count: { type: Number, default: 0 }, // bookings in the feed (from today on)
    conflicts: { type: [{ uid: String, from: String, to: String, with_no: String, _id: false }], default: [] }, // overlaps with a booking made here
  },
  opts,
);

// ---------- guest reviews (gh_reviews, yearly): a link after check-out → stars + words ----------
const reviewSchema = new Schema(
  {
    ...owned,
    stay_id: { type: ObjectId, required: true, unique: true },
    token: { type: String, required: true, unique: true },
    guest_name: { type: String, default: "", trim: true, maxlength: 80 },
    room_name: { type: String, default: "" },
    from: { type: String, default: "" },
    to: { type: String, default: "" },
    rating: { type: Number, default: 0, min: 0, max: 5 }, // 0 = not written yet
    text: { type: String, default: "", trim: true, maxlength: 1000 },
    shown: { type: Boolean, default: false }, // on the website
    reply: { type: String, default: "", trim: true, maxlength: 500 },
    submitted_at: { type: Date, default: null },
  },
  opts,
);
reviewSchema.index({ business_id: 1, submitted_at: -1 });
// ---------- loyalty points (gh_loyalty, yearly) ----------
const pointTxSchema = new Schema(
  {
    ...owned,
    customer_id: { type: ObjectId, required: true, index: true },
    stay_id: { type: ObjectId, default: null },
    points: { type: Number, required: true }, // + earned, − used
    kind: { type: String, enum: ["earn", "redeem", "adjust", "undo"], default: "earn" },
    note: { type: String, default: "", maxlength: 200 },
    by: { type: String, default: "" },
  },
  opts,
);

module.exports = {
  GhReview: mongoose.model("GhReview", reviewSchema),
  GhPointTx: mongoose.model("GhPointTx", pointTxSchema),
  ICAL_SOURCES,
  GhIcalFeed: mongoose.model("GhIcalFeed", icalFeedSchema),
  EXPENSE_CATS,
  HK_STATES: ["ready", "dirty", "cleaning"],
  GhExpense: mongoose.model("GhExpense", expenseSchema),
  PROMO_KINDS,
  PORTAL_THEMES,
  REQUEST_STATUSES,
  GhPromo: mongoose.model("GhPromo", promoSchema),
  GhCustomer: mongoose.model("GhCustomer", customerSchema),
  GhCustBooking: mongoose.model("GhCustBooking", custBookingSchema),
  SITE_THEMES,
  SITE_SLUG_RE,
  COLOR_RE,
  FACILITIES,
  GhSite: mongoose.model("GhSite", siteSchema),
  GhSiteRequest: mongoose.model("GhSiteRequest", siteRequestSchema),
  DISPLAY_THEMES,
  PRINT_THEMES,
  STAFF_ROLES,
  GhStaff: mongoose.model("GhStaff", staffSchema),
  GhDevice: mongoose.model("GhDevice", deviceSchema),
  HHMM,
  STATUSES,
  LIVE,
  SOURCES,
  METHODS,
  ID_TYPES,
  SERVICE_ICONS,
  AMENITIES: ["ac", "fan", "wifi", "tv", "hot_water", "fridge", "balcony", "kitchen", "bathtub", "parking"],
  GhSettings: mongoose.model("GhSettings", settingsSchema),
  GhRoomType: mongoose.model("GhRoomType", roomTypeSchema),
  GhRoom: mongoose.model("GhRoom", roomSchema),
  GhStay: mongoose.model("GhStay", staySchema),
};
