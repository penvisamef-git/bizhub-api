// Bizi (v3.0.0): what each owner told the helper — one record per customer, made the first time it is changed.
//   mute    alert / tip keys Bizi should not tell them about ("low_stock", "tips" = every setup tip)
//   snooze  one tip in one business hidden until a date ("Not now")
//   weekly  the Monday report (on by default)
//   tg      Bizi on Telegram: the owner's own chat with the BizHub bot (morning summary, weekly report, alerts)
const mongoose = require("mongoose");

const { Schema } = mongoose;

const biziPrefsSchema = new Schema(
  {
    customer_id: { type: Schema.Types.ObjectId, ref: "Customer", required: true, unique: true },
    mute: { type: [String], default: [] },
    snooze: { type: [{ _id: false, key: String, business_id: String, until: Date }], default: [] },
    weekly: { type: Boolean, default: true },
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      lang: { type: String, enum: ["en", "km"], default: "km" }, // the language of the messages (the owner's, when linking)
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "" },
      link_expires: { type: Date, default: null },
      morning: { type: Boolean, default: true }, // the summary at 8:00
      alerts: { type: Boolean, default: true }, // "a new order waits 5 min", "a guest is past check-out"…
      weekly: { type: Boolean, default: true },
      checked_at: { type: Date, default: null }, // the scheduler's last look (the oldest go first)
      sent: { type: Schema.Types.Mixed, default: {} }, // what was already sent: { morning: "2026-10-29", weekly: "2026-10-26", alerts: { "tg_new:<id>": date } }
    },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
biziPrefsSchema.index({ "tg.link_code": 1 }, { sparse: true });
biziPrefsSchema.index({ "tg.chat_id": 1 }, { sparse: true });

module.exports = mongoose.models.BiziPrefs || mongoose.model("BiziPrefs", biziPrefsSchema);
