const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const helper = require("../../../util/helper");
const User = require("../user/user.model");
const Session = require("../session/session.model");
const { logActivity } = require("../../../util/log");
const baseRoute = "auth";

// Log a team member in: token + session + activity log → what the website / app stores.
// One session per user and kind ("web" or "app"): a new login there replaces the old one.
async function startTeamSession(user, req, { kind = "web", how = "" } = {}) {
  const access_token = jwt.sign(
    { user_id: String(user._id), email: user.email, jti: crypto.randomBytes(9).toString("hex") }, // unique even within one second
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "720h" },
  );
  const userData = user.toObject();
  delete userData.password;
  const device = helper.extractDeviceInfo(req);

  // old sessions have no kind = website
  await Session.findOneAndUpdate(
    kind === "app" ? { user_id: user._id, kind: "app" } : { user_id: user._id, kind: { $ne: "app" } },
    {
      user_id: user._id,
      access_token,
      device,
      time: helper.cambodiaDate(),
      create_by: user._id,
      user_data: userData,
      ...(kind === "app" ? { kind: "app" } : {}),
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

  await logActivity({
    title: `ឧបករណ៍ ${device.device} បានចូលគណនី${how} (សារអេឡិចត្រូនិច : ${user.email})`,
    description: `ប្រើប្រាស់ ${device.browser} ចូលក្នុងប្រព័ន្ធ - ${helper.cambodiaDate()}`,
    categoryTitle: "auth",
    createdBy: user._id,
    req,
  });

  userData.access_token = access_token;
  userData.permission = user.is_super_admin ? "super_admin" : user.role || null;
  return { userData, device };
}

const route = (prop) => {
  // **************** Declaration ****************
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  const logTitle = "auth";

  // Error Content
  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
  const wrongLogin = "អ៊ីមែល ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ!";
  const suspended = "គណនីត្រូវបានផ្អាក!";
  const wrongOldPassword = "ពាក្យសម្ងាត់ចាស់មិនត្រឹមត្រូវ!";
  const shortPassword = "ពាក្យសម្ងាត់ត្រូវមានយ៉ាងតិច 8 តួអក្សរ!";
  const passwordChanged = "ពាក្យសម្ងាត់ត្រូវបានផ្លាស់ប្តូរ!";

  // ===================================== TEST =====================================
  prop.app.get(
    `${urlAPI}/test-logged-in`,
    prop.api_auth,
    prop.jwt_auth,
    prop.request_user,
    async (req, res) => {
      res.json({
        success: true,
        message: "API Connected : Permission and Access",
      });
    },
  );

  // ===================================== LOGIN =====================================
  // body: { email, password }
  prop.app.post(`${urlAPI}/login`, prop.api_auth, async (req, res) => {
    try {
      const requiredFields = [
        { key: "email", label: "សារអេឡិចត្រូនិច" },
        { key: "password", label: "ពាក្យសម្ងាត់" },
      ];
      if (!helper.checkValidtion(res, req, requiredFields)) return;

      const email = String(req.body.email).trim().toLowerCase();
      const password = String(req.body.password);

      // 1. Find user (same message for wrong email or password)
      const user = await User.findOne({ email, deleted: false });
      if (!user) {
        return res.status(401).json({ success: false, message: wrongLogin });
      }

      // 2. Check password using bcrypt
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: wrongLogin });
      }

      // 3. Suspended account
      if (!user.status) {
        return res.status(403).json({ success: false, message: suspended });
      }

      // 4–7. Token + session + activity log. client "app" = the BizHub app: its own session, so logging in
      // on the phone does not log the website out (and the other way round).
      const { userData, device } = await startTeamSession(user, req, { kind: req.body.client === "app" ? "app" : "web" });

      res.json({
        success: true,
        data: userData,
        log: { device },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== ME =====================================
  prop.app.get(
    `${urlAPI}/me`,
    prop.api_auth,
    prop.jwt_auth,
    prop.request_user,
    async (req, res) => {
      const user = { ...req.user };
      user.permission = user.is_super_admin ? "super_admin" : user.role || null;
      res.json({ success: true, data: user });
    },
  );

  // ===================================== LOGOUT =====================================
  prop.app.post(
    `${urlAPI}/logout`,
    prop.api_auth,
    prop.jwt_auth,
    prop.request_user,
    async (req, res) => {
      try {
        await Session.deleteOne({ _id: req.session._id });

        await logActivity({
          title: `គណនី ${req.user.email} បានចាកចេញ`,
          description: `ចាកចេញពីប្រព័ន្ធ - ${helper.cambodiaDate()}`,
          categoryTitle: logTitle,
          createdBy: req.user._id,
          req,
        });

        res.json({ success: true, message: "បានចាកចេញពីប្រព័ន្ធ!" });
      } catch (err) {
        res.status(500).json({ success: false, message: serverError, error: err.message });
      }
    },
  );

  // ===================================== CHANGE PASSWORD =====================================
  // For the logged-in user (also used after first login / admin reset)
  // body: { old_password, new_password }
  prop.app.put(
    `${urlAPI}/change-password`,
    prop.api_auth,
    prop.jwt_auth,
    prop.request_user,
    async (req, res) => {
      try {
        const requiredFields = [
          { key: "old_password", label: "ពាក្យសម្ងាត់ចាស់" },
          { key: "new_password", label: "ពាក្យសម្ងាត់ថ្មី" },
        ];
        if (!helper.checkValidtion(res, req, requiredFields)) return;

        const { old_password, new_password } = req.body;
        if (String(new_password).length < 8) {
          return res.status(400).json({ success: false, message: shortPassword });
        }

        const user = await User.findById(req.user._id);
        const isMatch = await bcrypt.compare(String(old_password), user.password);
        if (!isMatch) {
          return res.status(400).json({ success: false, message: wrongOldPassword });
        }

        user.password = await bcrypt.hash(String(new_password), 10);
        user.is_first_login = false;
        user.updated_by = user._id;
        await user.save();

        await logActivity({
          title: `គណនី ${user.email} បានផ្លាស់ប្តូរពាក្យសម្ងាត់`,
          description: `ផ្លាស់ប្តូរពាក្យសម្ងាត់ - ${helper.cambodiaDate()}`,
          categoryTitle: logTitle,
          createdBy: user._id,
          req,
        });

        res.json({ success: true, message: passwordChanged });
      } catch (err) {
        res.status(500).json({ success: false, message: serverError, error: err.message });
      }
    },
  );
};

module.exports = route;
module.exports.startTeamSession = startTeamSession;
