const mongoose = require("mongoose");
const { LISTS, TEXTS, SKILLS, THEMES, FILES } = require("./portfolio.spec");

// Personal web portfolio (like a CV) of a digital name card. Needs the "portfolio" license (yearly).
// Public page: /public/portfolio/<card slug>
const lists = {};
for (const [key, spec] of Object.entries(LISTS)) {
  const fields = {};
  for (const [f, max] of Object.entries(spec.fields)) fields[f] = { type: String, default: "", trim: true, maxlength: max };
  for (const f of spec.bools || []) fields[f] = { type: Boolean, default: false };
  lists[key] = { type: [new mongoose.Schema(fields, { _id: false })], default: [] };
}
const texts = {};
for (const [key, max] of Object.entries(TEXTS)) texts[key] = { type: String, default: "", trim: true, maxlength: max };

const portfolioSchema = new mongoose.Schema(
  {
    business_id: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    owner_id: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    ...texts,
    skills: { type: [{ type: String, trim: true, maxlength: SKILLS.length }], default: [] },
    ...lists,
    theme: { type: String, enum: THEMES, default: "classic" },
    color: { type: String, default: "", match: /^(#[0-9a-fA-F]{6})?$/ }, // "" = same color as the name card
    files: {
      type: [
        new mongoose.Schema(
          {
            title: { type: String, default: "", trim: true, maxlength: FILES.titleLength },
            kind: { type: String, enum: ["pdf", "image"], required: true },
            url: { type: String, required: true },
            thumb: { type: String, default: "" },
            public_id: { type: String, default: "" },
            bytes: { type: Number, default: 0 },
            created_date: { type: Date, default: Date.now },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
    unlocked_themes: { type: [String], default: [] }, // premium themes bought for this portfolio
    published: { type: Boolean, default: true },
    views: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);

portfolioSchema.index({ business_id: 1 }, { unique: true });

module.exports = mongoose.model("Portfolio", portfolioSchema);
