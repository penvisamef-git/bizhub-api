const mongoose = require("mongoose");

const activityLogSchema = new mongoose.Schema(
  {
    title: String,
    description: String,
    activity_log_category_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ActivityLogCategory",
      required: true,
    },
    status: {
      type: Boolean,
      default: true,
    },
    deleted: {
      type: Boolean,
      default: false,
    },
    device: Object,
    time: String,
    create_by_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

activityLogSchema.index({ created_date: -1 });
activityLogSchema.index({ deleted: 1, created_date: -1, _id: -1 }); // the activity log list (newest first)

module.exports = mongoose.model("ActivityLog", activityLogSchema);
