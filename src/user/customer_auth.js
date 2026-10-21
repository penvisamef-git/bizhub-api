const jwt = require("jsonwebtoken");
const Customer = require("./customer.model");
const CustomerSession = require("./customer_session.model");
const { getToken } = require("../util/jwt_auth");
const cache = require("../util/auth_cache");

// Middleware for customer (business owner) routes: /api/user/*
// Sets req.customer and req.customerSession. Team tokens do not work here, and
// customer tokens do not work on /api/admin/* (different session collections).
async function customer_auth(req, res, next) {
  const unauthorized = () => res.status(401).json({ success: false, message: "Unauthorized Permission" });
  try {
    const token = getToken(req);
    if (!token) return unauthorized();

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return unauthorized();
    }
    if (decoded.type !== "customer") return unauthorized();

    // cached 30 s, cleared on any customer/session change (see util/auth_cache.js)
    let hit = cache.get(`customer:${token}`);
    if (hit === undefined) {
      const found = await CustomerSession.findOne({ access_token: token }).lean();
      const who = found ? await Customer.findById(found.customer_id).select("-password").lean() : null;
      hit = { session: found, customer: who };
      cache.set(`customer:${token}`, hit);
    }
    const { session, customer } = hit;
    if (!session) return unauthorized();

    if (!customer || customer.deleted || !customer.status) {
      return res.status(401).json({ success: false, message: "គណនីត្រូវបានផ្អាក ឬលុប!" });
    }

    req.token = token;
    req.customer = customer;
    req.customerSession = session;
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

module.exports = { customer_auth };
