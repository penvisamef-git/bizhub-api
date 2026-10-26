const mongoose = require("mongoose");

// Business type = the BizHub service the business runs. We start with these two;
// add more here (and in the web text) when a new service is ready.
const BUSINESS_TYPES = ["namecard", "restaurant", "attendance", "guest_house", "mart", "menu_qr", "flipbook", "qr_gen", "website", "debt_book", "stamp_card", "event", "digital_note", "tg_store"];
// Old values from before (still readable, not selectable any more)
const LEGACY_TYPES = ["cafe", "shop", "beauty", "service", "warehouse", "other"];

// A business owned by a customer. One business = one type.
const businessSchema = new mongoose.Schema(
  {
    owner_id: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    category: { type: String, enum: [...BUSINESS_TYPES, ...LEGACY_TYPES], default: "namecard" }, // the type
    phone: { type: String, trim: true, default: "", maxlength: 30 },
    address: { type: String, trim: true, default: "", maxlength: 300 },
    logo_url: { type: String, default: "" },

    // false = suspended by the BizHub team
    status: { type: Boolean, default: true },
    deleted: { type: Boolean, default: false },
    admin_note: { type: String, default: "", maxlength: 500 },
    position: { type: Number, default: null }, // the owner's own order in "My businesses" (null = after the others, by date)
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

businessSchema.index({ owner_id: 1, deleted: 1 });
businessSchema.index({ created_date: -1 });
businessSchema.index({ name: 1 });
businessSchema.index({ category: 1 });
businessSchema.index({ deleted: 1, status: 1 }); // super admin counts

module.exports = mongoose.model("Business", businessSchema);
module.exports.BUSINESS_TYPES = BUSINESS_TYPES;
module.exports.BUSINESS_CATEGORIES = BUSINESS_TYPES; // old name
