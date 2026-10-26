// Log in with a QR code (website → BizHub app)
//   POST /api/user/login-qr              owner, logged in on the website → { id, code, seconds }   new code (older ones stop working)
//   GET  /api/user/login-qr/:id          owner → { state: waiting | used | expired }                 the website asks "scanned yet?"
//   POST /api/admin/auth/login-qr        super admin (team) → same as above
//   GET  /api/admin/auth/login-qr/:id    super admin (team) → same as above
//   POST /api/user/login-qr/scan         { code } (no login) → logged in: { data, account_type }  the app scanned the QR
// The QR holds "bizhub-login:<code>". A code works once, for 60 seconds.
const crypto = require("crypto");
const mongoose = require("mongoose");
const LoginQr = require("./login_qr.model");
const Customer = require("../user/customer.model");
const User = require("../v1/admin/user/user.model");
const { customer_auth } = require("../user/customer_auth");
const { startSession, loginData, MSG } = require("../user/user.route");
const { startTeamSession } = require("../v1/admin/auth/auth.route");
const { getCustomerWallet } = require("../coin/coin.service");
const { rate_limit } = require("../util/rate_limit");
const helper = require("../util/helper");

const SECONDS = 60;
const KEEP_MINUTES = 10; // the record stays a little longer, so the website can still see "used"
const PREFIX = "bizhub-login:";

const TEXT = {
  expired: "QR កូដនេះហួសពេល ឬបានប្រើរួចហើយ។ សូមចុចបង្កើតកូដថ្មីនៅលើវេបសាយ។",
  bad: "នេះមិនមែនជា QR កូដចូលគណនី BizHub ទេ។",
  teamOnly: "មានតែ Super Admin ទេដែលអាចប្រើកម្មវិធី BizHub បាន។",
  suspended: "គណនីត្រូវបានផ្អាក!",
  server: MSG.server,
};

const hash = (code) => crypto.createHash("sha256").update(code).digest("hex");

async function newCode(account_type, account_id) {
  await LoginQr.deleteMany({ account_id, used_at: null }); // only the newest code works
  const code = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  const row = await LoginQr.create({
    code_hash: hash(code),
    account_type,
    account_id,
    expires_at: new Date(now + SECONDS * 1000),
    delete_at: new Date(now + KEEP_MINUTES * 60 * 1000),
  });
  return { id: row._id, code: PREFIX + code, seconds: SECONDS };
}

async function stateOf(account_id, id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return { state: "expired" };
  const row = await LoginQr.findOne({ _id: id, account_id }).lean();
  if (!row) return { state: "expired" };
  if (row.used_at) return { state: "used", device: row.used_device?.os || "" };
  return { state: row.expires_at > new Date() ? "waiting" : "expired" };
}

module.exports = (prop) => {
  const user = "/api/user/login-qr";
  const team = "/api/admin/auth/login-qr";
  const teamGuard = [prop.api_auth, prop.jwt_auth, prop.request_user];
  const superOnly = (req, res, next) => (req.user?.is_super_admin ? next() : res.status(403).json({ success: false, message: TEXT.teamOnly, code: "team_only" }));
  const fail = (res) => res.status(500).json({ success: false, message: TEXT.server });
  const newLimit = rate_limit({ max: 60 }); // the website makes a new code every minute while the QR is open
  const scanLimit = rate_limit({ max: 30 });

  // ---------- owner ----------
  prop.app.post(user, prop.api_auth, customer_auth, newLimit, async (req, res) => {
    try {
      res.json({ success: true, data: await newCode("customer", req.customer._id) });
    } catch {
      fail(res);
    }
  });
  prop.app.get(`${user}/:id`, prop.api_auth, customer_auth, async (req, res) => {
    try {
      res.json({ success: true, data: await stateOf(req.customer._id, req.params.id) });
    } catch {
      fail(res);
    }
  });

  // ---------- super admin ----------
  prop.app.post(team, ...teamGuard, superOnly, newLimit, async (req, res) => {
    try {
      res.json({ success: true, data: await newCode("team", req.user._id) });
    } catch {
      fail(res);
    }
  });
  prop.app.get(`${team}/:id`, ...teamGuard, superOnly, async (req, res) => {
    try {
      res.json({ success: true, data: await stateOf(req.user._id, req.params.id) });
    } catch {
      fail(res);
    }
  });

  // ---------- the app scanned a code ----------
  prop.app.post(`${user}/scan`, prop.api_auth, scanLimit, async (req, res) => {
    try {
      const raw = String(req.body?.code || "").trim();
      if (!raw.startsWith(PREFIX) || raw.length > 200) return res.status(400).json({ success: false, message: TEXT.bad, code: "qr_bad" });
      const device = helper.extractDeviceInfo(req);
      if (req.body?.device) device.os = String(req.body.device).slice(0, 60); // the app says "Android 15" / "iOS 18"

      // use it up in one step: two phones scanning the same code → only one gets in
      const now = new Date();
      const row = await LoginQr.findOneAndUpdate(
        { code_hash: hash(raw.slice(PREFIX.length)), used_at: null, expires_at: { $gt: now } },
        { $set: { used_at: now, used_device: device } },
        { returnDocument: "after" },
      );
      if (!row) return res.status(410).json({ success: false, message: TEXT.expired, code: "qr_expired" });

      if (row.account_type === "customer") {
        const customer = await Customer.findOne({ _id: row.account_id, deleted: false });
        if (!customer) return res.status(410).json({ success: false, message: TEXT.expired, code: "qr_expired" });
        if (!customer.status) return res.status(403).json({ success: false, message: MSG.suspended });
        // logging in again cancels a pending "Delete my account"
        const cancelled = await require("../user/account_delete").cancelOnLogin(customer);
        customer.last_login_date = new Date();
        await customer.save();
        const wallet = await getCustomerWallet(customer._id);
        const token = await startSession(customer, req);
        return res.json({ success: true, account_type: "customer", data: { ...loginData(customer, wallet, token), ...(cancelled ? { deletion_cancelled: true } : {}) }, ...(cancelled ? { deletion_cancelled: true } : {}) });
      }

      const member = await User.findOne({ _id: row.account_id, deleted: false });
      if (!member) return res.status(410).json({ success: false, message: TEXT.expired, code: "qr_expired" });
      if (!member.status) return res.status(403).json({ success: false, message: TEXT.suspended });
      if (!member.is_super_admin) return res.status(403).json({ success: false, message: TEXT.teamOnly, code: "team_only" });
      const { userData } = await startTeamSession(member, req, { kind: "app", how: " ដោយ QR កូដ" });
      res.json({ success: true, account_type: "team", data: { ...userData, account_type: "team" } });
    } catch {
      fail(res);
    }
  });
};
