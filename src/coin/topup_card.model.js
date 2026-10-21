const mongoose = require("mongoose");

// Top-up card (like a phone top-up card): a 12-digit code + QR the super admin
// sends to a customer. The coins are taken from the treasury when the card is made
// and kept in the "cards" wallet until the card is used or deleted.
//   active     not used yet (can be redeemed, or deleted → coins back to treasury)
//   redeemed   a customer used it (coins went to that customer)
//   cancelled  super admin deleted it before it was used (coins went back)
const CARD_STATUS = ["active", "redeemed", "cancelled"];

const topupCardSchema = new mongoose.Schema(
  {
    code: { type: String, required: true }, // 12 digits, no spaces
    amount: { type: Number, required: true, min: 1 },
    status: { type: String, enum: CARD_STATUS, default: "active" },
    note: { type: String, default: "", maxlength: 300 },
    expires_at: { type: Date, default: null }, // null = never expires
    batch_id: { type: String, required: true }, // cards made together

    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    redeemed_by: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    redeemed_date: { type: Date, default: null },
    cancelled_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    cancelled_date: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

topupCardSchema.index({ code: 1 }, { unique: true });
topupCardSchema.index({ status: 1, created_date: -1 });
topupCardSchema.index({ batch_id: 1 });

module.exports = mongoose.model("TopupCard", topupCardSchema);
module.exports.CARD_STATUS = CARD_STATUS;
