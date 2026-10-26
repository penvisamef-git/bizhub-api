const mongoose = require("mongoose");

// One App Store coin-pack purchase (in-app, iPhone). The transaction id is unique, so the same purchase can never
// add coins twice.
//   status  new → crediting → credited → (reversing →) reversed      error = crediting failed, the next verify retries
const applePurchaseSchema = new mongoose.Schema(
  {
    transaction_id: { type: String, required: true },
    original_transaction_id: { type: String, default: "" },
    product_id: { type: String, required: true },
    customer_id: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    environment: { type: String, enum: ["Production", "Sandbox"], default: "Production" },
    coins: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    total_coins: { type: Number, default: 0 },
    usd: { type: Number, default: null }, // the web price of the same pack (null for sandbox = not paid)
    price: { type: Number, default: null }, // what Apple charged, in milli-units of `currency` (from the transaction)
    currency: { type: String, default: "" },
    storefront: { type: String, default: "" },
    purchased_at: { type: Date, default: null },
    status: { type: String, enum: ["new", "crediting", "credited", "error", "reversing", "reversed"], default: "new", index: true },
    tx_id: { type: mongoose.Schema.Types.ObjectId, default: null }, // the coin transaction that added the coins
    // refund (App Store Server Notification REFUND, or a revoked transaction)
    revoked_at: { type: Date, default: null },
    revocation_reason: { type: Number, default: null },
    reversed_coins: { type: Number, default: 0 }, // taken back from the wallet
    debt_coins: { type: Number, default: 0 }, // could not be taken back (already spent) — for the team to follow up
    reverse_tx_id: { type: mongoose.Schema.Types.ObjectId, default: null },
    error: { type: String, default: "" },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);

applePurchaseSchema.index({ transaction_id: 1 }, { unique: true });
applePurchaseSchema.index({ customer_id: 1, created_date: -1 });
applePurchaseSchema.index({ tx_id: 1 });
applePurchaseSchema.index({ debt_coins: 1 });

module.exports = { ApplePurchase: mongoose.model("ApplePurchase", applePurchaseSchema) };
