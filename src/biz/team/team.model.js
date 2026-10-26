const mongoose = require("mongoose");

// Team access: other BizHub accounts that can open one business (v1.5).
//   role  admin = can do everything inside the business (not buy, not delete / rename it, not manage the team)
//         view  = can see everything, cannot create, edit or delete
//   status invited = waiting for them to accept (added by BizHub ID) · active = in the team
// Works only while the business has the "team" license (5 coins / year, bought by the owner).
const ROLES = ["admin", "view"];

const memberSchema = new mongoose.Schema(
  {
    business_id: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    customer_id: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    role: { type: String, enum: ROLES, default: "view" },
    status: { type: String, enum: ["invited", "active"], default: "invited" },
    via: { type: String, enum: ["id", "link"], default: "id" },
    invited_by: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    joined_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
memberSchema.index({ business_id: 1, customer_id: 1 }, { unique: true });
memberSchema.index({ customer_id: 1, status: 1 });

// An invite link: bizhubcambodia.com/join/<code>. One person, 7 days.
const linkSchema = new mongoose.Schema(
  {
    business_id: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    code: { type: String, required: true },
    role: { type: String, enum: ROLES, default: "view" },
    expires_at: { type: Date, required: true },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    used_by: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    used_at: { type: Date, default: null },
    revoked: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
linkSchema.index({ code: 1 }, { unique: true });
linkSchema.index({ business_id: 1, used_by: 1, revoked: 1 });

module.exports = {
  TeamMember: mongoose.model("TeamMember", memberSchema),
  TeamLink: mongoose.model("TeamLink", linkSchema),
  ROLES,
};
