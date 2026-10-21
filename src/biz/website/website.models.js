// Website Builder: a website made of pages, each page a list of blocks (hero, text, gallery, prices…).
// The owner edits a draft; "Publish" copies the draft into site.live — visitors only ever see site.live.
const mongoose = require("mongoose");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const owned = { business_id: { type: ObjectId, ref: "Business", required: true, index: true } };
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };
const tr = { km: { type: String, default: "" }, en: { type: String, default: "" } }; // text in both languages

const siteSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    slug: { type: String, required: true, unique: true, trim: true, maxlength: 40 }, // /site/<slug>
    template: { type: String, default: "" }, // the starter it began from
    name: tr, // shown in the header (the business name when empty)
    tagline: tr,
    logo: { type: String, default: "" }, // a picture URL from the media library
    langs: { type: [String], default: ["km", "en"] }, // languages the site is in (first = default)
    // look: a theme + the owner's changes on top of it
    theme: { type: String, default: "clean" },
    style: {
      color: { type: String, default: "" }, // main colour ("" = the theme's)
      accent: { type: String, default: "" }, // second colour (brand style)
      bg: { type: String, default: "" }, // page background (brand style)
      font: { type: String, default: "" }, // font pair key ("" = the theme's)
      buttons: { type: String, enum: ["", "round", "pill", "square"], default: "" },
      mode: { type: String, enum: ["", "light", "dark"], default: "" },
    },
    contact: {
      phone: { type: String, default: "" },
      telegram: { type: String, default: "" },
      facebook: { type: String, default: "" },
      instagram: { type: String, default: "" },
      tiktok: { type: String, default: "" },
      youtube: { type: String, default: "" },
      email: { type: String, default: "" },
      address: tr,
      map_url: { type: String, default: "" },
    },
    footer: tr, // a line in the footer
    seo: { title: tr, description: tr, image: { type: String, default: "" } },
    // publishing
    live: { type: Schema.Types.Mixed, default: null }, // { pages, site, at } — what visitors see
    published: { type: Boolean, default: false },
    published_at: { type: Date, default: null },
    changed_at: { type: Date, default: null }, // last draft change (so "unpublished changes" can show)
    views: { type: Number, default: 0 },
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      chat_type: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "", index: true },
      link_expires: { type: Date, default: null },
    },
  },
  opts,
);

// one block on a page: its type + its content (checked against website.blocks.js)
const blockSchema = new Schema(
  {
    id: { type: String, required: true, maxlength: 20 },
    type: { type: String, required: true, maxlength: 20 },
    hidden: { type: Boolean, default: false },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const pageSchema = new Schema(
  {
    ...owned,
    slug: { type: String, required: true, trim: true, maxlength: 40 }, // "" is not allowed: home is "home"
    title: tr,
    home: { type: Boolean, default: false },
    menu: { type: Boolean, default: true }, // shown in the top menu
    sort: { type: Number, default: 0 },
    blocks: { type: [blockSchema], default: [] }, // the draft
  },
  opts,
);
pageSchema.index({ business_id: 1, slug: 1 }, { unique: true });

// blog / news posts (web_blog) — live as soon as they're published (not part of the draft)
const postSchema = new Schema(
  {
    ...owned,
    slug: { type: String, required: true, trim: true, maxlength: 60 },
    title: tr,
    excerpt: tr,
    body: tr, // plain text, empty lines = new paragraph
    cover: { type: String, default: "" },
    category: { type: String, default: "", trim: true, maxlength: 40 },
    published: { type: Boolean, default: true },
    date: { type: Date, default: Date.now },
    views: { type: Number, default: 0 },
  },
  opts,
);
postSchema.index({ business_id: 1, slug: 1 }, { unique: true });
postSchema.index({ business_id: 1, published: 1, date: -1 });

// a message from the site's contact form
const messageSchema = new Schema(
  {
    ...owned,
    page: { type: String, default: "", maxlength: 60 },
    name: { type: String, default: "", maxlength: 80 },
    phone: { type: String, default: "", maxlength: 30 },
    email: { type: String, default: "", maxlength: 120 },
    text: { type: String, default: "", maxlength: 2000 },
    read: { type: Boolean, default: false },
  },
  opts,
);
messageSchema.index({ business_id: 1, created_date: -1 });

// visits per day (+ per page)
const statSchema = new Schema(
  {
    ...owned,
    day: { type: String, required: true }, // Cambodia day
    views: { type: Number, default: 0 },
    pages: { type: Schema.Types.Mixed, default: {} }, // { home: 12, about: 3 }
  },
  { versionKey: false },
);
statSchema.index({ business_id: 1, day: 1 }, { unique: true });

// one visit (Visits Pro / web_stats shows these): where from, which device, which page. Kept for 400 days.
// The IP is stored without its last part (203.0.113.x) — enough to tell visits apart, not to find a person.
const visitSchema = new Schema(
  {
    ...owned,
    at: { type: Date, default: Date.now },
    day: { type: String, required: true }, // Cambodia day
    page: { type: String, default: "", maxlength: 80 },
    visitor: { type: String, default: "" }, // a daily hash (unique visitors), no personal data
    ip: { type: String, default: "", maxlength: 60 },
    country: { type: String, default: "", maxlength: 2 },
    city: { type: String, default: "", maxlength: 80 },
    device: { type: String, default: "" }, // mobile | tablet | desktop
    os: { type: String, default: "", maxlength: 30 },
    browser: { type: String, default: "", maxlength: 30 },
    source: { type: String, default: "", maxlength: 80 }, // Facebook, Google, Telegram… or a web address; "" = typed / direct
  },
  { versionKey: false },
);
visitSchema.index({ business_id: 1, at: -1 });
visitSchema.index({ at: 1 }, { expireAfterSeconds: 400 * 86400 });

// the site's pictures (every picture field picks from here)
const mediaSchema = new Schema(
  {
    ...owned,
    url: { type: String, required: true },
    public_id: { type: String, default: "" },
    name: { type: String, default: "", maxlength: 120 },
    bytes: { type: Number, default: 0 },
  },
  opts,
);
mediaSchema.index({ business_id: 1, created_date: -1 });

module.exports = {
  WebSite: mongoose.model("WebSite", siteSchema),
  WebPage: mongoose.model("WebPage", pageSchema),
  WebPost: mongoose.model("WebPost", postSchema),
  WebMessage: mongoose.model("WebMessage", messageSchema),
  WebStat: mongoose.model("WebStat", statSchema),
  WebVisit: mongoose.model("WebVisit", visitSchema),
  WebMedia: mongoose.model("WebMedia", mediaSchema),
};
