const mongoose = require("mongoose");

// Coin wallets.
//   kind "treasury"  the one BizHub wallet. Super admin generates coins into it.
//   kind "customer"  one wallet per customer (business owner).
//   kind "cards"     coins held by top-up cards that are not used yet.
// `key` is "treasury", "cards" or "customer:<customer_id>" so each wallet exists once.
const walletSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    kind: { type: String, enum: ["treasury", "customer", "cards"], required: true },
    customer_id: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    balance: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

walletSchema.index({ key: 1 }, { unique: true });
walletSchema.index({ customer_id: 1 });

module.exports = mongoose.model("Wallet", walletSchema);
