const mongoose = require("mongoose");

// "Log in with QR code": someone logged in on the website shows a QR code (Account page), the BizHub app
// scans it and is logged in to the same account. Each code works once, for 60 seconds, and only the newest
// code of an account works. Only a hash of the code is kept.
const loginQrSchema = new mongoose.Schema(
  {
    code_hash: { type: String, required: true },
    account_type: { type: String, enum: ["customer", "team"], required: true },
    account_id: { type: mongoose.Schema.Types.ObjectId, required: true },
    expires_at: { type: Date, required: true }, // the code stops working
    used_at: Date, // scanned (the website shows "logged in on your phone")
    used_device: Object,
    delete_at: { type: Date, required: true }, // MongoDB removes the record (a few minutes later)
  },
  { timestamps: { createdAt: "created_date", updatedAt: false } },
);

loginQrSchema.index({ code_hash: 1 }, { unique: true });
loginQrSchema.index({ account_id: 1 });
loginQrSchema.index({ delete_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("LoginQr", loginQrSchema);
