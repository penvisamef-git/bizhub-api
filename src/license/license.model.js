const mongoose = require("mongoose");
const { PRODUCT_KEYS } = require("./license.products");

// What a customer bought for one business. One row per (business, product, item).
// expires_at = null → forever. Renewing moves expires_at forward.
const licenseSchema = new mongoose.Schema(
  {
    customer_id: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    business_id: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    product: { type: String, enum: PRODUCT_KEYS, required: true },
    item: { type: String, default: "" }, // e.g. theme name, if a product has several items
    started_at: { type: Date, default: Date.now },
    expires_at: { type: Date, default: null },
    renewals: { type: Number, default: 0 },
    total_paid: { type: Number, default: 0 },
    last_paid_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);

licenseSchema.index({ business_id: 1, product: 1, item: 1 }, { unique: true });
licenseSchema.index({ customer_id: 1 });
licenseSchema.index({ expires_at: 1 });

module.exports = mongoose.model("License", licenseSchema);
