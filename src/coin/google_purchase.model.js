const mongoose = require("mongoose");

// One Google Play coin-pack purchase (in-app, Android). The purchase token is unique, so the same purchase can
// never add coins twice.
//   status  new → crediting → credited → (reversing →) reversed      error = crediting failed, the next verify retries
const googlePurchaseSchema = new mongoose.Schema(
  {
    token: { type: String, required: true },
    product_id: { type: String, required: true },
    order_id: { type: String, default: "" },
    customer_id: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    coins: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    total_coins: { type: Number, default: 0 },
    usd: { type: Number, default: null }, // the web price of the same pack (Google's local price isn't in this API)
    region: { type: String, default: "" },
    purchased_at: { type: Date, default: null },
    status: { type: String, enum: ["new", "crediting", "credited", "error", "reversing", "reversed"], default: "new", index: true },
    tx_id: { type: mongoose.Schema.Types.ObjectId, default: null }, // the coin transaction that added the coins
    consumed: { type: Boolean, default: false }, // told Google (so the pack can be bought again)
    // refund / chargeback (Google voided purchases)
    voided_at: { type: Date, default: null },
    voided_reason: { type: Number, default: null },
    reversed_coins: { type: Number, default: 0 }, // taken back from the wallet
    debt_coins: { type: Number, default: 0 }, // could not be taken back (already spent) — for the team to follow up
    reverse_tx_id: { type: mongoose.Schema.Types.ObjectId, default: null },
    error: { type: String, default: "" },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);

googlePurchaseSchema.index({ token: 1 }, { unique: true });
googlePurchaseSchema.index({ customer_id: 1, created_date: -1 });
googlePurchaseSchema.index({ tx_id: 1 });
googlePurchaseSchema.index({ debt_coins: 1 });

// where the refund check stopped last time (one document, key "voided")
const googleSyncSchema = new mongoose.Schema({ key: { type: String, unique: true }, since: { type: Date, default: null }, ran_at: { type: Date, default: null } });

module.exports = {
  GooglePurchase: mongoose.model("GooglePurchase", googlePurchaseSchema),
  GoogleSync: mongoose.model("GoogleSync", googleSyncSchema),
};
