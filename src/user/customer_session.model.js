const mongoose = require("mongoose");

// One record per customer login (a customer can be logged in on several devices).
// Records are removed automatically by MongoDB after `expires_at`.
const customerSessionSchema = new mongoose.Schema(
  {
    customer_id: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    access_token: { type: String, required: true },
    device: Object,
    time: String,
    expires_at: { type: Date, required: true },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

customerSessionSchema.index({ access_token: 1 });
customerSessionSchema.index({ customer_id: 1 });
customerSessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
require("../util/auth_cache").clearOnWrite(customerSessionSchema); // login cache stays correct

module.exports = mongoose.model("CustomerSession", customerSessionSchema);
