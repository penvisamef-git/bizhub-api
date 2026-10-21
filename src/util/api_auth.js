const mongoose = require("mongoose");
const AuthKey = require("../v1/admin/auth/auth_api_key.model");
const cache = require("./auth_cache");

// Checks that the API key record exists. Cached (was one database query per request).
async function api_auth(req, res, next) {
  try {
    let key = cache.get("api_key");
    if (key === undefined) {
      key = await AuthKey.findOne({ api_auth_key: process.env.API_AUTH_KEY }).lean();
      if (key) cache.set("api_key", key, 5 * 60 * 1000); // only remember a found key
    }
    if (!key) {
      console.error(`api_auth: no key found in database "${mongoose.connection.name}"`); // shows in Vercel logs, not to users
      return res.status(401).json({ message: "Unauthorized Access", success: false });
    }
    req.apiKeyData = key;
    next();
  } catch (err) {
    res.status(500).json({ message: "Internal Server Error", success: false });
  }
}

module.exports = { api_auth };
