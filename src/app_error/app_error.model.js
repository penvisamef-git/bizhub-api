const mongoose = require("mongoose");

// One row per different crash of the BizHub app (same message + place + version = same row, counted)
const AppErrorSchema = new mongoose.Schema(
  {
    fingerprint: { type: String, required: true, unique: true },
    message: { type: String, default: "" },
    stack: { type: String, default: "" },
    library: { type: String, default: "" }, // "widgets library", "rendering library"…
    context: { type: String, default: "" }, // "while building MenuTab"…
    route: { type: String, default: "" }, // the screen: /biz/website/123
    version: { type: String, default: "" }, // 1.0.0+1
    platform: { type: String, default: "" }, // android / ios / web
    os: { type: String, default: "" },
    count: { type: Number, default: 1 },
    users: { type: [String], default: [] }, // who saw it (first 20): "customer:email" / "team:email"
    resolved: { type: Boolean, default: false },
    first_at: { type: Date, default: Date.now },
    last_at: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
AppErrorSchema.index({ last_at: -1 });

module.exports = mongoose.models.AppError || mongoose.model("AppError", AppErrorSchema);
