const mongoose = require("mongoose");
const authKeySchema = new mongoose.Schema({
  api_auth_key: String,
});
authKeySchema.index({ api_auth_key: 1 });
require("../../../util/auth_cache").clearOnWrite(authKeySchema);
module.exports = mongoose.model("AuthKey", authKeySchema);
