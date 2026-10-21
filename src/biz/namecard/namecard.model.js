const mongoose = require("mongoose");

// Digital name card: one per business of type "namecard".
// Public page: /public/card/<slug>
const FREE_THEMES = ["classic", "modern", "minimal", "bold", "gradient", "elegant"];
// premium: unlocked per card with coins (price in Website settings → prices.premium_theme)
// + the 100 recipe themes (themeRecipes.json, shared with the web and the app)
const RECIPES = require("./themeRecipes.json");
const PREMIUM_THEMES = ["aurora", "neon", "glass", "luxury", "split", "wave", "polaroid", "sunset", "mono", "retro", "nature", "tech", ...RECIPES.card.themes.map((t) => t.key)];
const THEMES = [...FREE_THEMES, ...PREMIUM_THEMES];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const imageSchema = new mongoose.Schema(
  {
    url: { type: String, default: "" },
    public_id: { type: String, default: "" },
  },
  { _id: false },
);

const namecardSchema = new mongoose.Schema(
  {
    business_id: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    owner_id: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },

    // short name in the link: lowercase letters, numbers and "-"
    slug: { type: String, required: true, lowercase: true, trim: true },

    // basic
    name: { type: String, default: "", trim: true, maxlength: 80 },
    job_title: { type: String, default: "", trim: true, maxlength: 80 },
    company: { type: String, default: "", trim: true, maxlength: 80 },
    bio: { type: String, default: "", trim: true, maxlength: 500 },
    photo: { type: imageSchema, default: () => ({}) },

    // contact (all optional; shown as buttons on the card)
    phone1: { type: String, default: "", trim: true, maxlength: 30 },
    phone2: { type: String, default: "", trim: true, maxlength: 30 },
    email: { type: String, default: "", trim: true, lowercase: true, maxlength: 120 },
    website: { type: String, default: "", trim: true, maxlength: 200 },
    address: { type: String, default: "", trim: true, maxlength: 200 },
    telegram: { type: String, default: "", trim: true, maxlength: 60 },
    facebook: { type: String, default: "", trim: true, maxlength: 200 },
    // anything else: [{ label: "Opening hours", value: "7am – 9pm" }]
    extras: {
      type: [
        new mongoose.Schema(
          {
            label: { type: String, trim: true, maxlength: 40 },
            value: { type: String, trim: true, maxlength: 200 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    cover: { type: imageSchema, default: () => ({}) },

    // look
    theme: { type: String, enum: THEMES, default: "classic" },
    unlocked_themes: { type: [String], default: [] }, // premium themes bought for this card
    color: { type: String, default: "#E0581A", match: COLOR_RE },

    // false = only the owner sees it (public link shows "not available")
    published: { type: Boolean, default: true },
    views: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

namecardSchema.index({ business_id: 1 }, { unique: true });
namecardSchema.index({ slug: 1 }, { unique: true });
namecardSchema.index({ owner_id: 1 });

module.exports = mongoose.model("Namecard", namecardSchema);
module.exports.THEMES = THEMES;
module.exports.FREE_THEMES = FREE_THEMES;
module.exports.PREMIUM_THEMES = PREMIUM_THEMES;
module.exports.COLOR_RE = COLOR_RE;
