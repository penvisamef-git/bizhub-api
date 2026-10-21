const mongoose = require("mongoose");

// Image info returned by POST /api/admin/upload (save it as-is)
const imageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    public_id: String,
    resource_type: String,
    format: String,
    width: Number,
    height: Number,
    bytes: Number,
    original_name: String,
  },
  { _id: false },
);

module.exports = imageSchema;
