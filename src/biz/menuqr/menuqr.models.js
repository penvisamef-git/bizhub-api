// Menu QR: a view-only menu behind a QR code (no orders, no sales)
const mongoose = require("mongoose");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const owned = { business_id: { type: ObjectId, ref: "Business", required: true, index: true } };
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };
// a picture used somewhere: it points at a file in the media library (media_id); public_id only on old rows
const pic = { url: { type: String, default: "" }, public_id: { type: String, default: "" }, media_id: { type: ObjectId, default: null } };
const TAGS = ["new", "hot", "spicy", "veg", "best", "chef"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const settingsSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 40 }, // /q/<slug>
    tagline: { type: String, default: "", trim: true, maxlength: 120 },
    about: { type: String, default: "", trim: true, maxlength: 600 },
    logo: { type: pic, default: () => ({}) },
    cover: { type: pic, default: () => ({}) },
    contact: {
      phone: { type: String, default: "", trim: true, maxlength: 30 },
      phone2: { type: String, default: "", trim: true, maxlength: 30 },
      telegram: { type: String, default: "", trim: true, maxlength: 120 },
      facebook: { type: String, default: "", trim: true, maxlength: 200 },
      instagram: { type: String, default: "", trim: true, maxlength: 200 },
      tiktok: { type: String, default: "", trim: true, maxlength: 200 },
      website: { type: String, default: "", trim: true, maxlength: 200 },
      email: { type: String, default: "", trim: true, maxlength: 120 },
      address: { type: String, default: "", trim: true, maxlength: 300 },
      map_url: { type: String, default: "", trim: true, maxlength: 400 },
      wifi_name: { type: String, default: "", trim: true, maxlength: 60 },
      wifi_pass: { type: String, default: "", trim: true, maxlength: 60 },
    },
    hours: { type: String, default: "", trim: true, maxlength: 160 },
    currency: { type: String, enum: ["USD", "KHR"], default: "USD" },
    khr_rate: { type: Number, default: 4100, min: 1000, max: 10000 },
    show_both: { type: Boolean, default: false }, // show the price in the other currency too
    lang: { type: String, enum: ["km", "en"], default: "km" }, // first language on the menu
    theme: { type: String, default: "classic" },
    color: { type: String, default: "", match: /^(#[0-9a-fA-F]{6})?$/ }, // "" = the theme's own colour
    qr: {
      style: { type: String, default: "classic" },
      color: { type: String, default: "#111111", match: /^#[0-9a-fA-F]{6}$/ },
      bg: { type: String, default: "#ffffff", match: /^#[0-9a-fA-F]{6}$/ },
      accent: { type: String, default: "#E0581A", match: /^#[0-9a-fA-F]{6}$/ }, // the card colour
      header: { type: String, default: "", trim: true, maxlength: 60 },
      footer: { type: String, default: "", trim: true, maxlength: 80 },
      info: { type: String, default: "", trim: true, maxlength: 120 }, // Wi-Fi, hours… under the code
      logo: { type: Boolean, default: true }, // the logo in the middle of the code
    },
    feedback_on: { type: Boolean, default: true },
    views: { type: Number, default: 0 },
    media_slots: { type: Number, default: 0, min: 0 }, // pictures bought on top of the 35 free (1 coin each, forever)
    media_seeded: { type: Boolean, default: false }, // old pictures copied into the media library once
  },
  opts,
);

const categorySchema = new Schema(
  {
    ...owned,
    name_km: { type: String, default: "", trim: true, maxlength: 60 },
    name_en: { type: String, default: "", trim: true, maxlength: 60 },
    icon: { type: String, default: "", trim: true, maxlength: 8 }, // an emoji
    sort: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  opts,
);

const itemSchema = new Schema(
  {
    ...owned,
    category_id: { type: ObjectId, required: true, index: true },
    category_ids: { type: [ObjectId], default: [], index: true }, // every category it shows in (category_id = the first)
    name_km: { type: String, default: "", trim: true, maxlength: 80 },
    name_en: { type: String, default: "", trim: true, maxlength: 80 },
    desc_km: { type: String, default: "", trim: true, maxlength: 400 },
    desc_en: { type: String, default: "", trim: true, maxlength: 400 },
    price: { type: Number, default: 0, min: 0, max: 100000000 },
    sale_price: { type: Number, default: null, min: 0, max: 100000000 }, // mq_promos: shown crossed-out price
    photos: { type: [new Schema({ ...pic }, { _id: true })], default: [] }, // up to 5
    tags: { type: [{ type: String, enum: TAGS }], default: [] },
    available: { type: Boolean, default: true }, // false = "sold out today"
    active: { type: Boolean, default: true }, // false = hidden
    sort: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
  },
  opts,
);

// promotions (mq_promos): a banner on top + money off what it covers, on some days / hours
const promoSchema = new Schema(
  {
    ...owned,
    title_km: { type: String, default: "", trim: true, maxlength: 80 },
    title_en: { type: String, default: "", trim: true, maxlength: 80 },
    note: { type: String, default: "", trim: true, maxlength: 200 },
    kind: { type: String, enum: ["percent", "amount", "banner"], default: "percent" }, // banner = just a message
    value: { type: Number, default: 0, min: 0, max: 100000000 },
    all_items: { type: Boolean, default: false },
    category_ids: { type: [ObjectId], default: [] },
    item_ids: { type: [ObjectId], default: [] },
    start_date: { type: String, default: "" }, // YYYY-MM-DD ("" = from now)
    end_date: { type: String, default: "" },
    days: { type: [Number], default: [] }, // 0 = Sunday … 6; [] = every day
    from: { type: String, default: "", validate: (v) => !v || HHMM.test(v) },
    to: { type: String, default: "", validate: (v) => !v || HHMM.test(v) },
    photo: { type: pic, default: () => ({}) },
    active: { type: Boolean, default: true },
  },
  opts,
);

// the media library: every picture of the menu lives here once and is linked from logo / cover / items / promotions
const mediaSchema = new Schema(
  {
    ...owned,
    url: { type: String, required: true },
    public_id: { type: String, default: "" },
    name: { type: String, default: "", trim: true, maxlength: 120 },
    bytes: { type: Number, default: 0 },
  },
  opts,
);
mediaSchema.index({ business_id: 1, created_date: -1 });

// customer feedback (mq_feedback)
const feedbackSchema = new Schema(
  {
    ...owned,
    stars: { type: Number, required: true, min: 1, max: 5 },
    text: { type: String, default: "", trim: true, maxlength: 600 },
    name: { type: String, default: "", trim: true, maxlength: 60 },
    phone: { type: String, default: "", trim: true, maxlength: 30 },
    read: { type: Boolean, default: false },
  },
  opts,
);
feedbackSchema.index({ business_id: 1, created_date: -1 });

// scans per Cambodia day (mq_stats reads them; counted for everyone)
const statSchema = new Schema(
  {
    ...owned,
    day: { type: String, required: true }, // YYYY-MM-DD
    scans: { type: Number, default: 0 },
    hours: { type: [Number], default: () => Array(24).fill(0) },
    items: { type: Map, of: Number, default: () => ({}) }, // item id → opened
  },
  opts,
);
statSchema.index({ business_id: 1, day: 1 }, { unique: true });

module.exports = {
  TAGS,
  MqSettings: mongoose.model("MqSettings", settingsSchema),
  MqCategory: mongoose.model("MqCategory", categorySchema),
  MqItem: mongoose.model("MqItem", itemSchema),
  MqPromo: mongoose.model("MqPromo", promoSchema),
  MqMedia: mongoose.model("MqMedia", mediaSchema),
  MqFeedback: mongoose.model("MqFeedback", feedbackSchema),
  MqStat: mongoose.model("MqStat", statSchema),
};
