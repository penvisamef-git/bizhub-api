const mongoose = require("mongoose");

const activityLogCategorySchema = new mongoose.Schema(
  {
    name: String,
    title: String,
    status: {
      type: Boolean,
      default: true,
    },
    deleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

module.exports = mongoose.model("ActivityLogCategory", activityLogCategorySchema);
