const Session = require("../v1/admin/session/session.model");
const User = require("../v1/admin/user/user.model");
const { getToken } = require("./jwt_auth");
const cache = require("./auth_cache");

// Finds the session of this token → req.session (user_id, user_data, ...) and req.user.
// Cached for 30 s (cleared on any user/session change), so most requests skip 2 database queries.
async function request_user(req, res, next) {
  try {
    const token = req.token || getToken(req);
    if (!token) {
      return res.status(401).json({ success: false, message: "No token provided" });
    }

    let hit = cache.get(`team:${token}`);
    if (hit === undefined) {
      const session = await Session.findOne({ access_token: token }).lean();
      const user = session ? await User.findOne({ _id: session.user_id }).select("-password").lean() : null;
      hit = { session, user };
      cache.set(`team:${token}`, hit);
    }

    if (!hit.session) {
      return res.status(401).json({ success: false, message: "Session not found or expired" });
    }
    // Block users that were deleted or suspended after they logged in
    if (!hit.user || hit.user.deleted || !hit.user.status) {
      return res.status(401).json({ success: false, message: "គណនីត្រូវបានផ្អាក ឬលុប!" });
    }

    req.session = hit.session;
    req.user = { ...hit.user };
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

module.exports = request_user;
