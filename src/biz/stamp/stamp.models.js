// Loyalty Stamp Card: one card program per business, its customers (members) and every stamp / reward.
const mongoose = require("mongoose");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const owned = { business_id: { type: ObjectId, ref: "Business", required: true, index: true } };
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };

// one per business: the design, the rule (10 stamps = 1 free coffee), the staff desk, the owner's Telegram
const programSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    shop_name: { type: String, default: "", maxlength: 80 },
    phone: { type: String, default: "", maxlength: 40 },
    address: { type: String, default: "", maxlength: 200 },
    logo: { type: String, default: "" },
    logo_public_id: { type: String, default: "" },
    slug: { type: String, required: true, unique: true }, // the shop QR: /stamp/<slug>
    theme: { type: String, default: "classic" },
    poster: { type: String, default: "basic" }, // the shop QR poster design
    // what the owner adds on the poster: own title, own line (hours, promo…), show phone / address
    poster_info: {
      title: { type: String, default: "" }, // big title
      sub: { type: String, default: "" }, // second line under it
      rule: { type: String, default: "" }, // "8 stamps = Free latte"
      scan: { type: String, default: "" }, // "Scan to get your card"
      note: { type: String, default: "" }, // bottom line ("No app needed")
      phone: { type: Boolean, default: true },
      address: { type: Boolean, default: false },
    },
    color: { type: String, default: "" }, // own accent colour (empty = the design's)
    icon: { type: String, default: "coffee" },
    goal: { type: Number, default: 10, min: 3, max: 20 }, // stamps for the (last) reward
    reward_en: { type: String, default: "1 free drink", maxlength: 80 },
    reward_km: { type: String, default: "ភេសជ្ជៈឥតគិតថ្លៃ 1", maxlength: 120 },
    // several rewards on one card (sc_levels): [{ at: 5, en, km }] — the goal is always the last one
    levels: [{ _id: false, at: { type: Number, min: 1, max: 20 }, en: { type: String, maxlength: 80 }, km: { type: String, maxlength: 120 } }],
    terms_en: { type: String, default: "", maxlength: 300 },
    terms_km: { type: String, default: "", maxlength: 400 },
    welcome: { type: Number, default: 0, min: 0, max: 3 }, // free stamps when someone joins
    gap: { type: Number, default: 0, min: 0, max: 1440 }, // (not used any more: stamps can be added any time)
    max_per_visit: { type: Number, default: 5, min: 1, max: 20 },
    expiry_months: { type: Number, default: 0, min: 0, max: 24 }, // sc_expiry: stamps end after N months without a visit (0 = never)
    join_on: { type: Boolean, default: true }, // new customers can join from the shop QR
    // staff desk: a page for the counter phone, opened with a PIN
    desk: {
      on: { type: Boolean, default: true },
      pin_hash: { type: String, default: "" },
      ver: { type: Number, default: 1 }, // changing the PIN logs every desk out
      can_reset: { type: Boolean, default: false }, // the owner lets the staff reset a customer's stamps to 0
    },
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "", index: true },
      link_expires: { type: Date, default: null },
      reward: { type: Boolean, default: true }, // a customer filled the card
      joined: { type: Boolean, default: false }, // a new customer joined
      daily: { type: Boolean, default: true },
      time: { type: String, default: "20:00" },
      last_daily_at: { type: Date, default: null },
    },
    last_expiry_at: { type: Date, default: null },
    web: { type: String, default: "", maxlength: 200 }, // the web address the owner uses (card links in messages)
    seq: { type: Number, default: 0 }, // card numbers
  },
  opts,
);

const memberSchema = new Schema(
  {
    ...owned,
    no: { type: Number, required: true }, // card number shown on the card (staff can type it)
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, default: "", trim: true, maxlength: 20 }, // digits only (0xx…)
    note: { type: String, default: "", maxlength: 300 },
    token: { type: String, required: true, unique: true }, // the card link /stamp/c/<token>
    stamps: { type: Number, default: 0, min: 0 }, // on the card now
    claimed: { type: [Number], default: [] }, // levels already given on this round
    total_stamps: { type: Number, default: 0 },
    rewards: { type: Number, default: 0 },
    rounds: { type: Number, default: 0 }, // full cards
    last_stamp_at: { type: Date, default: null },
    last_visit_at: { type: Date, default: null },
    via: { type: String, enum: ["shop", "staff", "desk"], default: "staff" },
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      code: { type: String, default: "", index: true }, // t.me/<bot>?start=sc_<code>
      linked_at: { type: Date, default: null },
    },
    deleted: { type: Boolean, default: false },
    deleted_at: { type: Date, default: null },
  },
  opts,
);
memberSchema.index({ business_id: 1, deleted: 1, last_visit_at: -1 });
memberSchema.index({ business_id: 1, phone: 1 });
memberSchema.index({ business_id: 1, no: 1 });

// one line of the history
const eventSchema = new Schema(
  {
    ...owned,
    member_id: { type: ObjectId, ref: "StampMember", required: true },
    kind: { type: String, enum: ["join", "stamp", "reward", "adjust", "expire"], required: true },
    n: { type: Number, default: 0 }, // stamps added (+) / taken (-)
    after: { type: Number, default: 0 }, // stamps on the card after this line
    reward: { type: String, default: "", maxlength: 120 }, // what they got (kind reward)
    note: { type: String, default: "", maxlength: 200 },
    by: { kind: { type: String, default: "owner" }, name: { type: String, default: "" } }, // owner · desk · shop (self) · system
    at: { type: Date, default: Date.now },
  },
  opts,
);
eventSchema.index({ business_id: 1, at: -1 });
eventSchema.index({ business_id: 1, member_id: 1, at: -1 });

module.exports = {
  StampProgram: mongoose.model("StampProgram", programSchema),
  StampMember: mongoose.model("StampMember", memberSchema),
  StampEvent: mongoose.model("StampEvent", eventSchema),
};
