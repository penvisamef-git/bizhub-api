// QR Code Generator: named QR codes (link, text, file, form, contact, map, Wi-Fi, phone, SMS), scans, form replies
const mongoose = require("mongoose");
const { TEMPLATES, THEMES } = require("./qrgen.designs");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const owned = { business_id: { type: ObjectId, ref: "Business", required: true, index: true } };
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };
const pic = { url: { type: String, default: "" }, public_id: { type: String, default: "" } };

const settingsSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    logo: pic, // the business picture (dashboard + pages)
    color: { type: String, default: "#E0581A", match: /^#[0-9a-fA-F]{6}$/ }, // default colour for new pages
    file_packs: { type: Number, default: 0, min: 0 }, // +10 files each ("qr_file_pack")
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      chat_type: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "", index: true },
      link_expires: { type: Date, default: null },
      weekly: { type: Boolean, default: true }, // Monday summary of last week's scans + answers
      last_weekly_at: { type: Date, default: null },
    },
  },
  opts,
);

const folderSchema = new Schema({ ...owned, name: { type: String, required: true, trim: true, maxlength: 60 }, sort: { type: Number, default: 0 } }, opts);

const fieldSchema = new Schema(
  {
    key: { type: String, required: true, maxlength: 20 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    kind: { type: String, enum: ["text", "textarea", "select", "checkbox", "radio", "phone", "email", "number", "date", "photo", "rating", "signature"], default: "text" },
    options: { type: [String], default: [] },
    required: { type: Boolean, default: false },
    placeholder: { type: String, default: "", trim: true, maxlength: 120 },
    // show this field only when another field has this answer (form extras)
    show_if: { key: { type: String, default: "", maxlength: 20 }, value: { type: String, default: "", maxlength: 80 } },
  },
  { _id: false },
);
const linkSchema = new Schema(
  {
    kind: { type: String, enum: ["web", "facebook", "tiktok", "telegram", "instagram", "youtube", "x", "whatsapp", "messenger", "line", "linkedin", "phone", "email", "map", "shop"], default: "web" },
    label: { type: String, default: "", trim: true, maxlength: 60 },
    url: { type: String, default: "", trim: true, maxlength: 600 },
  },
  { _id: false },
);

const codeSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 80 }, // "Table 5 menu", "Job form 2026"
    type: { type: String, enum: ["url", "text", "file", "form", "vcard", "map", "wifi", "phone", "sms", "links", "coupon"], required: true },
    slug: { type: String, required: true, unique: true, trim: true, maxlength: 40 }, // /x/<slug> (the printed link never changes)
    old_slugs: { type: [String], default: [], index: true }, // links it had before a custom link name — still open it
    deleted_at: { type: Date, default: null, index: true }, // in the trash (30 days, then gone)
    folder_id: { type: ObjectId, default: null, index: true },
    active: { type: Boolean, default: true },
    // what it opens
    url: { type: String, default: "", trim: true, maxlength: 2000 },
    // smart redirect (qr_smart): iPhone / Android links and links by time of day
    smart: {
      ios: { type: String, default: "", trim: true, maxlength: 2000 },
      android: { type: String, default: "", trim: true, maxlength: 2000 },
      times: { type: [new Schema({ from: { type: String, default: "00:00" }, to: { type: String, default: "23:59" }, url: { type: String, default: "", maxlength: 2000 } }, { _id: false })], default: [] },
    },
    links: { type: [linkSchema], default: [] }, // link page (qr_links)
    // coupon (qr_coupons): each person gets a one-time code; staff mark it used
    coupon: {
      title: { type: String, default: "", trim: true, maxlength: 120 },
      offer: { type: String, default: "", trim: true, maxlength: 60 }, // "20% OFF", "Free drink"
      terms: { type: String, default: "", trim: true, maxlength: 1000 },
      ends_at: { type: Date, default: null },
      limit: { type: Number, default: 0, min: 0 }, // 0 = no limit
      pin_hash: { type: String, default: "" }, // staff PIN to mark coupons used
      issued: { type: Number, default: 0 },
      used: { type: Number, default: 0 },
    },
    text: { title: { type: String, default: "", trim: true, maxlength: 160 }, body: { type: String, default: "", maxlength: 8000 } },
    file: { url: { type: String, default: "" }, public_id: { type: String, default: "" }, name: { type: String, default: "" }, bytes: { type: Number, default: 0 }, kind: { type: String, default: "" } },
    form: {
      title: { type: String, default: "", trim: true, maxlength: 160 },
      intro: { type: String, default: "", trim: true, maxlength: 1000 },
      button: { type: String, default: "", trim: true, maxlength: 40 },
      thanks: { type: String, default: "", trim: true, maxlength: 300 },
      fields: { type: [fieldSchema], default: [] },
    },
    vcard: {
      name: { type: String, default: "", trim: true, maxlength: 80 },
      org: { type: String, default: "", trim: true, maxlength: 80 },
      job: { type: String, default: "", trim: true, maxlength: 80 },
      phone: { type: String, default: "", trim: true, maxlength: 40 },
      phone2: { type: String, default: "", trim: true, maxlength: 40 },
      email: { type: String, default: "", trim: true, maxlength: 120 },
      website: { type: String, default: "", trim: true, maxlength: 200 },
      address: { type: String, default: "", trim: true, maxlength: 300 },
    },
    map: { place: { type: String, default: "", trim: true, maxlength: 160 }, link: { type: String, default: "", trim: true, maxlength: 600 }, note: { type: String, default: "", trim: true, maxlength: 300 } },
    wifi: { ssid: { type: String, default: "", maxlength: 64 }, password: { type: String, default: "", maxlength: 64 }, security: { type: String, enum: ["WPA", "WEP", "nopass"], default: "WPA" }, hidden: { type: Boolean, default: false } },
    phone: { number: { type: String, default: "", trim: true, maxlength: 40 }, body: { type: String, default: "", maxlength: 300 } },
    // the page people see after scanning (text, file, form, contact, map)
    page: {
      template: { type: String, enum: [...TEMPLATES, ...THEMES], default: "card" },
      color: { type: String, default: "#E0581A", match: /^#[0-9a-fA-F]{6}$/ },
      header: { type: String, default: "", trim: true, maxlength: 120 },
      footer: { type: String, default: "", trim: true, maxlength: 200 },
      rows: { type: [new Schema({ label: { type: String, default: "", trim: true, maxlength: 60 }, value: { type: String, default: "", trim: true, maxlength: 300 } }, { _id: false })], default: [] },
      logo: { type: Boolean, default: true },
    },
    // how the code looks (design = shape + frame; colours can be changed)
    design: {
      key: { type: String, default: "plain" },
      color: { type: String, default: "", match: /^(#[0-9a-fA-F]{6})?$/ },
      bg: { type: String, default: "", match: /^(#[0-9a-fA-F]{6})?$/ },
      accent: { type: String, default: "", match: /^(#[0-9a-fA-F]{6})?$/ },
      label: { type: String, default: "", trim: true, maxlength: 40 }, // text on the frame ("Scan me")
      logo: { type: Boolean, default: false },
    },
    // rules (qr_rules)
    rules: { expires_at: { type: Date, default: null }, max_scans: { type: Number, default: 0, min: 0 }, password_hash: { type: String, default: "" } },
    notify_scan: { type: Boolean, default: false }, // Telegram on every scan (qr_telegram)
    scans: { type: Number, default: 0 },
    last_scan: { type: Date, default: null },
    replies: { type: Number, default: 0 },
    unread: { type: Number, default: 0 },
  },
  opts,
);
codeSchema.index({ business_id: 1, created_date: -1 });

// one coupon given to one person (qr_coupons)
const couponSchema = new Schema(
  {
    ...owned,
    code_id: { type: ObjectId, required: true, index: true },
    code: { type: String, required: true }, // "7KQ-4MZ"
    device: { type: String, default: "" }, // one per phone
    used_at: { type: Date, default: null },
  },
  opts,
);
couponSchema.index({ code_id: 1, code: 1 }, { unique: true });
couponSchema.index({ code_id: 1, device: 1 });

// one scan (device always; city / country only while "qr_geo" is on)
const scanSchema = new Schema(
  {
    ...owned,
    code_id: { type: ObjectId, required: true, index: true },
    at: { type: Date, default: Date.now, index: true },
    day: { type: String, required: true }, // Cambodia day
    device: { type: String, default: "" }, // mobile | tablet | desktop
    os: { type: String, default: "" },
    browser: { type: String, default: "" },
    country: { type: String, default: "" },
    city: { type: String, default: "" },
  },
  { versionKey: false },
);
scanSchema.index({ business_id: 1, at: -1 });

// a form sent from a Form QR
const replySchema = new Schema(
  {
    ...owned,
    code_id: { type: ObjectId, required: true, index: true },
    answers: { type: [new Schema({ key: String, label: String, value: String, kind: { type: String, default: "" } }, { _id: false })], default: [] },
    read: { type: Boolean, default: false },
  },
  opts,
);
replySchema.index({ business_id: 1, created_date: -1 });

module.exports = {
  QgSettings: mongoose.model("QgSettings", settingsSchema),
  QgFolder: mongoose.model("QgFolder", folderSchema),
  QgCode: mongoose.model("QgCode", codeSchema),
  QgScan: mongoose.model("QgScan", scanSchema),
  QgReply: mongoose.model("QgReply", replySchema),
  QgCoupon: mongoose.model("QgCoupon", couponSchema),
};
