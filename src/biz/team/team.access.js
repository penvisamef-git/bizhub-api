// Team access (v1.5): who may open a business that is not theirs, and what they may do.
//
//   gate        mounted on /api/user/businesses/:id (before every service). Finds the caller's role in that
//               business: owner | admin | view. A View-only member gets 403 view_only on anything that is not a
//               read (GET). Admins and viewers get 403 owner_only on buying (licenses, themes, unlocks).
//   bizOwner    used by each service where it loads "my business": owners as before; a team member
//               (checked by the gate for exactly this business) loads it too.
//   roleOf      the role, cached for 15 s (cleared when a team changes).
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Business = require("../business.model");
const License = require("../../license/license.model");
const { TeamMember } = require("./team.model");
const { customer_auth } = require("../../user/customer_auth");
const { getToken } = require("../../util/jwt_auth");

const MSG = {
  viewOnly: "អ្នកមានសិទ្ធិមើលតែប៉ុណ្ណោះ — មិនអាចបង្កើត កែ ឬលុបបានទេ។ / View only: you can't create, edit or delete.",
  ownerOnly: "មានតែម្ចាស់អាជីវកម្មទេដែលអាចទិញបាន។ / Only the business owner can buy this.",
};

const TTL = 15 * 1000;
const cache = new Map(); // `${customer}:${business}` → { at, role }
const forget = (businessId) => {
  const tail = `:${businessId}`;
  for (const k of cache.keys()) if (!businessId || k.endsWith(tail)) cache.delete(k);
};

const isActive = (lic) => !!lic && (lic.expires_at === null || new Date(lic.expires_at).getTime() > Date.now());

// is the Team add-on on for this business? (5 coins / year)
async function teamOn(businessId) {
  return isActive(await License.findOne({ business_id: businessId, product: "team", item: "" }).select("expires_at").lean());
}

// owner | admin | view | null
async function roleOf(customerId, businessId) {
  const key = `${customerId}:${businessId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.role;
  let role = null;
  const biz = await Business.findOne({ _id: businessId, deleted: false }).select("owner_id").lean();
  if (biz) {
    if (String(biz.owner_id) === String(customerId)) role = "owner";
    else {
      const m = await TeamMember.findOne({ business_id: businessId, customer_id: customerId, status: "active" }).select("role").lean();
      if (m && (await teamOn(businessId))) role = m.role;
    }
  }
  cache.set(key, { at: Date.now(), role });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return role;
}

const READ = new Set(["GET", "HEAD", "OPTIONS"]);
// buying with coins inside a service: licenses, paid looks, unlocks
const BUY = /\/(licenses|licence)(\/|$)|\/(buy|unlock|slots|file-packs)(\/|$)/;

async function gate(req, res, next) {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id) || String(new mongoose.Types.ObjectId(id)) !== id) return next();
    const token = getToken(req);
    if (!token) return next(); // POS devices etc. use their own headers
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return next();
    }
    if (decoded?.type !== "customer") return next();
    customer_auth(req, res, async () => {
      try {
        const role = await roleOf(req.customer._id, id);
        req.bizAccess = { id, role };
        if (role === "admin" || role === "view") {
          if (req.method === "POST" && BUY.test(req.path)) return res.status(403).json({ success: false, message: MSG.ownerOnly, code: "owner_only" });
          if (role === "view" && !READ.has(req.method)) return res.status(403).json({ success: false, message: MSG.viewOnly, code: "view_only" });
        }
        next();
      } catch (err) {
        console.error("[team gate]", err);
        res.status(500).json({ success: false, message: "Internal Server Error" });
      }
    });
  } catch (err) {
    console.error("[team gate]", err);
    next();
  }
}

// the owner filter for "my business" in a service: { owner_id: me } — or nothing extra for a team member the gate let in
function bizOwner(req) {
  const a = req.bizAccess;
  if (a && a.id === String(req.params.id) && (a.role === "admin" || a.role === "view")) return {};
  return { owner_id: req.customer._id };
}

// the caller's role in the business that a service just loaded (owner when not a team member)
function roleIn(req, business) {
  if (business && String(business.owner_id) === String(req.customer?._id)) return "owner";
  const a = req.bizAccess;
  return a && a.id === String(business?._id) ? a.role : "owner";
}

module.exports = { gate, bizOwner, roleIn, roleOf, teamOn, forget, MSG };
