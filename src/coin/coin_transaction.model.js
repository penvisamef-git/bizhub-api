const mongoose = require("mongoose");

// Coin history. Every coin movement adds one record. Records are never edited or deleted.
//   generate      super admin creates new coins in the treasury
//   transfer      coins move between wallets (treasury ↔ customer, customer ↔ customer)
//   signup_bonus  free coins a new customer gets at sign-up
//   spend         a customer pays for a service (later, src/biz/<service>)
//   card_create   super admin makes top-up cards: treasury → cards wallet
//   card_redeem   a customer uses a card: cards wallet → customer
//   card_cancel   super admin deletes an unused card: cards wallet → treasury
const TX_TYPES = ["generate", "transfer", "signup_bonus", "spend", "card_create", "card_redeem", "card_cancel"];
const PAYMENT_METHODS = ["KHQR", "ABA", "ACLEDA", "Wing", "Bank", "Card", "Cash", "Google Play", "App Store", "Other"]; // "Google Play" / "App Store" = an in-app coin pack (Android / iPhone)

const coinTransactionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: TX_TYPES, required: true },
    amount: { type: Number, required: true, min: 1 },

    from_wallet: { type: mongoose.Schema.Types.ObjectId, ref: "Wallet", default: null },
    to_wallet: { type: mongoose.Schema.Types.ObjectId, ref: "Wallet", default: null },
    // Customers on each side (null = treasury / none). Saved here so lists are fast.
    from_customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    to_customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    from_balance_after: { type: Number, default: null },
    to_balance_after: { type: Number, default: null },

    note: { type: String, default: "", maxlength: 300 },

    // When a customer bought coins (KHQR, ABA, Card…)
    payment: {
      method: { type: String, enum: [...PAYMENT_METHODS, null], default: null },
      reference: { type: String, default: "", maxlength: 120 },
      amount_usd: { type: Number, default: null, min: 0 },
    },

    // Who did it: a BizHub team user, or the customer (spend)
    by_user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    by_customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },

    // For spend (later)
    business_id: { type: mongoose.Schema.Types.ObjectId, ref: "Business", default: null },
    service: { type: String, default: null },

    // Top-up cards: how many cards and which ones
    card_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "TopupCard" }],
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: false },
  },
);

coinTransactionSchema.index({ created_date: -1 });
coinTransactionSchema.index({ from_customer: 1, created_date: -1 });
coinTransactionSchema.index({ to_customer: 1, created_date: -1 });
coinTransactionSchema.index({ type: 1, created_date: -1 });

module.exports = mongoose.model("CoinTransaction", coinTransactionSchema);
module.exports.TX_TYPES = TX_TYPES;
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
