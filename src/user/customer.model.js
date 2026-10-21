const mongoose = require("mongoose");

// A customer = a business owner who signed up on the website.
// One customer can own many businesses (src/biz) and has one coin wallet (src/coin).
// (BizHub team accounts are different: src/v1/admin/user)
const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // optional since phone sign-up (absent = no email); unique when given
    email: { type: String, trim: true, lowercase: true, maxlength: 120 },
    email_verified: { type: Boolean, default: false }, // confirmed by Google (Google sign-in / email link)
    // "+85512345678" when checked by an SMS code (Firebase); older accounts may hold any text
    phone: { type: String, trim: true, default: "", maxlength: 30 },
    phone_verified: { type: Boolean, default: false },
    password: { type: String, required: true },

    // false = suspended by the BizHub team (cannot log in)
    status: { type: Boolean, default: true },
    deleted: { type: Boolean, default: false },

    // Note only the BizHub team can see
    admin_note: { type: String, default: "", maxlength: 500 },

    // profile picture (shown in "Chat with BizHub" to the BizHub team)
    photo: { url: { type: String, default: "" }, public_id: { type: String, default: "" } },

    last_login_date: { type: Date, default: null },
    signup_device: Object,
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

// one account per email and per checked phone (old accounts without a checked phone don't count)
// existing databases: run "npm run migrate:phone-login" once (replaces the old email index)
customerSchema.index({ email: 1 }, { unique: true, name: "email_unique", partialFilterExpression: { email: { $type: "string" } } });
customerSchema.index({ phone: 1 }, { unique: true, name: "phone_verified_unique", partialFilterExpression: { phone_verified: true } });
customerSchema.index({ created_date: -1 });
// login by email: the unique index above only covers rows where email is text, and a lookup by email can't use it
customerSchema.index({ email: 1 }, { name: "email_lookup" });
require("../util/auth_cache").clearOnWrite(customerSchema); // login cache stays correct

// Never send the password hash back
customerSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.password;
    return ret;
  },
});

module.exports = mongoose.model("Customer", customerSchema);
