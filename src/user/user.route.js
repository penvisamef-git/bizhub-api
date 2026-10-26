// Customer (business owner) account: sign up, log in, profile.
// Google confirms the email (Google button or email link) — or the phone (SMS code, when switched on) —
// through Firebase; we check Firebase's signed token (util/firebase_auth.js).
//   POST /api/user/check            { phone?, email? } → { phone: { valid, taken }, email: { valid, taken } }
//   POST /api/user/sign-up          { name, firebase_token, password, phone?, email? } → logged in, gets the sign-up bonus
//   POST /api/user/login            { login: email or checked phone, password }   (old apps may still send { email })
//   POST /api/user/login-google     { firebase_token } → logged in, or 404 no_account (finish signing up)
//   POST /api/user/reset-password   { firebase_token, new_password }  forgot password: email link (or SMS code)
//   POST /api/user/email/start      { password } → { ticket }   change email, step 1: prove it's you (15 minutes)
//   PUT  /api/user/email            { ticket, firebase_token }  step 2: the new email, confirmed by Google / email link
//   GET  /api/user/me
//   POST /api/user/logout
//   PUT  /api/user/profile          { name, phone }
//   PUT  /api/user/change-password  { old_password, new_password }
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const Customer = require("./customer.model");
const CustomerSession = require("./customer_session.model");
const { customer_auth } = require("./customer_auth");
const helper = require("../util/helper");
const { rate_limit } = require("../util/rate_limit");
const Homepage = require("../homepage/homepage.model");
const { DEFAULT_HOMEPAGE } = require("../homepage/homepage.defaults");
const { grantSignupBonus, getCustomerWallet } = require("../coin/coin.service");
const { verifyFirebaseToken, normalizePhone } = require("../util/firebase_auth");
const { cancelOnLogin } = require("./account_delete");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ]{8,20}$/;

const MSG = {
  badPhoto: "សូមដាក់រូបភាព JPG / PNG / WEBP (តិចជាង 5MB)!",
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  fill: "សូមបំពេញព័ត៌មានឲ្យគ្រប់!",
  badEmail: "អ៊ីមែលមិនត្រឹមត្រូវ!",
  badPhone: "លេខទូរស័ព្ទមិនត្រឹមត្រូវ!",
  badName: "ឈ្មោះត្រូវមាន 2 ដល់ 80 តួអក្សរ!",
  shortPassword: "ពាក្យសម្ងាត់ត្រូវមានយ៉ាងតិច 8 តួអក្សរ!",
  emailUsed: "អ៊ីមែលនេះមានគណនីរួចហើយ!",
  phoneUsed: "លេខទូរស័ព្ទនេះមានគណនីរួចហើយ!",
  phoneUnknown: "រកមិនឃើញគណនីដែលប្រើលេខទូរស័ព្ទនេះទេ!",
  phoneNotChecked: "សូមផ្ទៀងផ្ទាត់លេខទូរស័ព្ទដោយលេខកូដ SMS ជាមុនសិន!",
  notChecked: "សូមផ្ទៀងផ្ទាត់អ៊ីមែល ឬលេខទូរស័ព្ទជាមុនសិន!",
  noAccount: "មិនទាន់មានគណនីសម្រាប់អ៊ីមែលនេះទេ។",
  wrongPassword: "ពាក្យសម្ងាត់មិនត្រឹមត្រូវ!",
  ticketOld: "សូមបញ្ចូលពាក្យសម្ងាត់ម្តងទៀត (ហួសពេល)។",
  sameEmail: "នេះជាអ៊ីមែលបច្ចុប្បន្នរបស់អ្នករួចហើយ។",
  emailChanged: "បានប្តូរអ៊ីមែល!",
  phoneCheckOld: "ការផ្ទៀងផ្ទាត់ SMS ហួសពេលហើយ សូមផ្ញើលេខកូដម្តងទៀត!",
  phoneNotReady: "ការចុះឈ្មោះដោយលេខទូរស័ព្ទមិនទាន់បានរៀបចំនៅលើម៉ាស៊ីនមេទេ (FIREBASE_PROJECT_ID)។",
  phoneLocked: "លេខទូរស័ព្ទដែលបានផ្ទៀងផ្ទាត់ មិនអាចកែនៅទីនេះបានទេ។",
  wrongLogin: "លេខទូរស័ព្ទ/អ៊ីមែល ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ!",
  passwordReset: "បានកំណត់ពាក្យសម្ងាត់ថ្មី!",
  suspended: "គណនីត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  wrongOld: "ពាក្យសម្ងាត់ចាស់មិនត្រឹមត្រូវ!",
  passwordChanged: "ពាក្យសម្ងាត់ត្រូវបានផ្លាស់ប្តូរ!",
  saved: "បានរក្សាទុក!",
  deletionCancelled: "សូមស្វាគមន៍ការត្រឡប់មកវិញ! ការលុបគណនីរបស់អ្នកត្រូវបានបោះបង់។",
};

const TOKEN_DAYS = 30;

// What the web app stores after login (never the password)
function loginData(customer, wallet, token) {
  return {
    _id: customer._id,
    name: customer.name,
    firstname: customer.name, // the dashboard greets with firstname
    email: customer.email || "",
    email_verified: !!customer.email_verified,
    phone: customer.phone,
    phone_verified: !!customer.phone_verified,
    account_type: "customer",
    permission: "customer",
    coin_balance: wallet ? wallet.balance : 0,
    created_date: customer.created_date,
    photo: customer.photo?.url || "",
    bizhub_id: customer.bizhub_id || "", // for Team access (made the first time it's needed: GET /api/user/team/my-id)
    delete_at: customer.delete_at || null, // "Delete my account" is pending until this date
    ...(token ? { access_token: token } : {}),
  };
}

async function startSession(customer, req) {
  // jti: two logins in the same second must not get the same token
  const access_token = jwt.sign({ customer_id: String(customer._id), type: "customer", jti: crypto.randomBytes(9).toString("hex") }, process.env.JWT_SECRET, {
    expiresIn: `${TOKEN_DAYS}d`,
  });
  await CustomerSession.create({
    customer_id: customer._id,
    access_token,
    device: helper.extractDeviceInfo(req),
    time: helper.cambodiaDate(),
    expires_at: new Date(Date.now() + TOKEN_DAYS * 24 * 3600 * 1000),
  });
  // keep at most 10 devices per customer (oldest are logged out)
  const old = await CustomerSession.find({ customer_id: customer._id }).sort({ created_date: -1 }).skip(10).select("_id");
  if (old.length) await CustomerSession.deleteMany({ _id: { $in: old.map((s) => s._id) } });
  return access_token;
}

const route = (prop) => {
  const url = "/api/user";
  const formLimit = rate_limit({ max: 20 });

  // Google's check (Firebase ID token) → { phone, email } it confirmed, or an error answer (then null)
  async function checkedFrom(req, res) {
    try {
      const r = await verifyFirebaseToken(req.body?.firebase_token);
      const out = { phone: r.phone || "", email: r.email && r.email_verified ? r.email : "" };
      if (!out.phone && !out.email) throw Object.assign(new Error("nothing checked"), { code: "bad_token" });
      return out;
    } catch (err) {
      const code = err.code || "bad_token";
      const message = code === "not_configured" ? MSG.phoneNotReady : code === "expired" ? MSG.phoneCheckOld : MSG.notChecked;
      res.status(code === "not_configured" ? 503 : 401).json({ success: false, message, code: `phone_${code}` });
      return null;
    }
  }
  const phoneTaken = (phone) => Customer.exists({ phone, phone_verified: true, deleted: false });
  const emailTaken = (email) => Customer.exists({ email, deleted: false });

  // ===================================== CHECK (before sending a code / link) =====================================
  const checkLimit = rate_limit({ max: 60 });
  prop.app.post(`${url}/check`, prop.api_auth, checkLimit, async (req, res) => {
    try {
      const out = {};
      if (req.body?.phone !== undefined) {
        const phone = normalizePhone(req.body.phone);
        out.phone = { valid: !!phone, value: phone, taken: phone ? !!(await phoneTaken(phone)) : false };
      }
      if (req.body?.email !== undefined) {
        const email = String(req.body.email || "")
          .trim()
          .toLowerCase();
        const valid = EMAIL_RE.test(email) && email.length <= 120;
        out.email = { valid, taken: valid ? !!(await emailTaken(email)) : false };
      }
      res.json({ success: true, data: out });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== SIGN UP =====================================
  // firebase_token from: Google button / email link (→ confirmed email) or SMS code (→ confirmed phone).
  // The other one is a plain contact: email (when the phone was checked) or phone (when the email was checked).
  prop.app.post(`${url}/sign-up`, prop.api_auth, formLimit, async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      const typedEmail = String(req.body?.email || "")
        .trim()
        .toLowerCase();
      const typedPhone = String(req.body?.phone || "").trim();
      const password = String(req.body?.password || "");

      if (!name || !password) return res.status(400).json({ success: false, message: MSG.fill });
      if (name.length < 2 || name.length > 80) return res.status(400).json({ success: false, message: MSG.badName });
      if (typedEmail && (!EMAIL_RE.test(typedEmail) || typedEmail.length > 120)) return res.status(400).json({ success: false, message: MSG.badEmail });
      if (password.length < 8 || password.length > 100) return res.status(400).json({ success: false, message: MSG.shortPassword });

      const checked = await checkedFrom(req, res);
      if (!checked) return;
      let doc;
      if (checked.email) {
        // email confirmed by Google; phone (optional) is just a contact
        const phone = typedPhone ? normalizePhone(typedPhone) : "";
        if (typedPhone && !phone) return res.status(400).json({ success: false, message: MSG.badPhone });
        if (await emailTaken(checked.email)) return res.status(409).json({ success: false, message: MSG.emailUsed, code: "email_taken" });
        doc = { email: checked.email, email_verified: true, phone, phone_verified: false };
      } else {
        if (await phoneTaken(checked.phone)) return res.status(409).json({ success: false, message: MSG.phoneUsed, code: "phone_taken" });
        if (typedEmail && (await emailTaken(typedEmail))) return res.status(409).json({ success: false, message: MSG.emailUsed, code: "email_taken" });
        doc = { ...(typedEmail ? { email: typedEmail } : {}), phone: checked.phone, phone_verified: true };
      }

      let customer;
      try {
        customer = await Customer.create({
          name,
          ...doc,
          password: await bcrypt.hash(password, 10),
          last_login_date: new Date(),
          signup_device: helper.extractDeviceInfo(req),
        });
      } catch (err) {
        if (err.code === 11000) {
          const phoneDup = /phone/.test(err.message);
          return res.status(409).json({ success: false, message: phoneDup ? MSG.phoneUsed : MSG.emailUsed, code: phoneDup ? "phone_taken" : "email_taken" });
        }
        throw err;
      }

      // Free coins (amount set by the super admin on the website settings)
      const settings = await Homepage.findOne({ key: "main" }).select("coin").lean();
      const bonus = settings?.coin?.signup_bonus ?? DEFAULT_HOMEPAGE.coin.signup_bonus;
      const wallet = await grantSignupBonus(customer._id, bonus);

      const token = await startSession(customer, req);
      res.status(201).json({ success: true, data: loginData(customer, wallet, token) });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  async function logIn(customer, req, res) {
    if (!customer.status) return res.status(403).json({ success: false, message: MSG.suspended });
    // logging in again cancels a pending "Delete my account"
    const cancelled = await cancelOnLogin(customer);
    customer.last_login_date = new Date();
    await customer.save();
    const wallet = await getCustomerWallet(customer._id);
    const token = await startSession(customer, req);
    res.json({ success: true, data: { ...loginData(customer, wallet, token), ...(cancelled ? { deletion_cancelled: true } : {}) }, ...(cancelled ? { deletion_cancelled: true, message: MSG.deletionCancelled } : {}) });
  }

  // ===================================== LOGIN =====================================
  // email (or a phone checked by SMS) + password
  prop.app.post(`${url}/login`, prop.api_auth, formLimit, async (req, res) => {
    try {
      const login = String(req.body?.login ?? req.body?.email ?? "").trim();
      const password = String(req.body?.password || "");
      if (!login || !password) return res.status(400).json({ success: false, message: MSG.fill });

      let customer = null;
      if (login.includes("@")) customer = await Customer.findOne({ email: login.toLowerCase(), deleted: false });
      else {
        const phone = normalizePhone(login);
        if (phone) customer = await Customer.findOne({ phone, phone_verified: true, deleted: false });
      }
      if (!customer || !(await bcrypt.compare(password, customer.password))) {
        return res.status(401).json({ success: false, message: MSG.wrongLogin });
      }
      await logIn(customer, req, res);
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== LOGIN WITH GOOGLE =====================================
  // Google button (or email link) → the account with that confirmed email. 404 no_account → finish signing up.
  prop.app.post(`${url}/login-google`, prop.api_auth, formLimit, async (req, res) => {
    try {
      const checked = await checkedFrom(req, res);
      if (!checked) return;
      const customer = checked.email ? await Customer.findOne({ email: checked.email, deleted: false }) : await Customer.findOne({ phone: checked.phone, phone_verified: true, deleted: false });
      if (!customer) return res.status(404).json({ success: false, message: MSG.noAccount, code: "no_account", email: checked.email });
      if (checked.email && !customer.email_verified) {
        customer.email_verified = true; // Google just confirmed it
      }
      await logIn(customer, req, res);
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== FORGOT PASSWORD =====================================
  // email link (→ the account with that email) or SMS code (→ the account with that phone)
  prop.app.post(`${url}/reset-password`, prop.api_auth, formLimit, async (req, res) => {
    try {
      const newPassword = String(req.body?.new_password || "");
      if (newPassword.length < 8 || newPassword.length > 100) return res.status(400).json({ success: false, message: MSG.shortPassword });
      const checked = await checkedFrom(req, res);
      if (!checked) return;
      const customer = checked.email ? await Customer.findOne({ email: checked.email, deleted: false }) : await Customer.findOne({ phone: checked.phone, phone_verified: true, deleted: false });
      if (!customer) return res.status(404).json({ success: false, message: checked.email ? MSG.noAccount : MSG.phoneUnknown, code: checked.email ? "no_account" : "phone_unknown" });
      if (!customer.status) return res.status(403).json({ success: false, message: MSG.suspended });
      customer.password = await bcrypt.hash(newPassword, 10);
      if (checked.email) customer.email_verified = true;
      const cancelled = await cancelOnLogin(customer); // a new password = logged in again: cancels "Delete my account"
      customer.last_login_date = new Date();
      await customer.save();
      await CustomerSession.deleteMany({ customer_id: customer._id }); // every device logs in again
      const wallet = await getCustomerWallet(customer._id);
      const token = await startSession(customer, req);
      res.json({ success: true, data: { ...loginData(customer, wallet, token), ...(cancelled ? { deletion_cancelled: true } : {}) }, message: MSG.passwordReset, ...(cancelled ? { deletion_cancelled: true } : {}) });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== ME =====================================
  prop.app.get(`${url}/me`, prop.api_auth, customer_auth, async (req, res) => {
    try {
      const wallet = await getCustomerWallet(req.customer._id);
      res.json({ success: true, data: loginData(req.customer, wallet) });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== LOGOUT =====================================
  prop.app.post(`${url}/logout`, prop.api_auth, customer_auth, async (req, res) => {
    await CustomerSession.deleteOne({ _id: req.customerSession._id }).catch(() => {});
    res.json({ success: true });
  });

  // ===================================== PROFILE =====================================
  prop.app.put(`${url}/profile`, prop.api_auth, customer_auth, async (req, res) => {
    try {
      const set = {};
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (name.length < 2 || name.length > 80) return res.status(400).json({ success: false, message: MSG.badName });
        set.name = name;
      }
      if (req.body?.phone !== undefined && req.customer.phone_verified) {
        if (String(req.body.phone).trim() !== req.customer.phone) return res.status(400).json({ success: false, message: MSG.phoneLocked });
      } else if (req.body?.phone !== undefined) {
        const phone = String(req.body.phone).trim();
        if (phone && !PHONE_RE.test(phone)) return res.status(400).json({ success: false, message: MSG.badPhone });
        set.phone = phone;
      }
      const customer = await Customer.findByIdAndUpdate(req.customer._id, { $set: set }, { returnDocument: "after" });
      const wallet = await getCustomerWallet(customer._id);
      res.json({ success: true, data: loginData(customer, wallet), message: MSG.saved });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== PROFILE PHOTO =====================================
  const multer = require("multer");
  const cloud = require("../util/cloudinary");
  const photoUp = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, f, cb) => (["image/jpeg", "image/png", "image/webp"].includes(f.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
  });
  prop.app.post(
    `${url}/profile/photo`,
    prop.api_auth,
    customer_auth,
    (req, res, next) => photoUp.single("photo")(req, res, (err) => (err ? res.status(400).json({ success: false, message: MSG.badPhoto }) : next())),
    async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ success: false, message: MSG.badPhoto });
        const up = await cloud.uploadBuffer(req.file, "avatars");
        const old = req.customer.photo?.public_id;
        const customer = await Customer.findByIdAndUpdate(req.customer._id, { $set: { photo: { url: up.url, public_id: up.public_id || "" } } }, { returnDocument: "after" });
        if (old) cloud.deleteFile(old).catch(() => {});
        res.json({ success: true, data: loginData(customer, await getCustomerWallet(customer._id)), message: MSG.saved });
      } catch (err) {
        res.status(500).json({ success: false, message: MSG.server });
      }
    },
  );
  prop.app.delete(`${url}/profile/photo`, prop.api_auth, customer_auth, async (req, res) => {
    try {
      const old = req.customer.photo?.public_id;
      const customer = await Customer.findByIdAndUpdate(req.customer._id, { $set: { photo: { url: "", public_id: "" } } }, { returnDocument: "after" });
      if (old) cloud.deleteFile(old).catch(() => {});
      res.json({ success: true, data: loginData(customer, await getCustomerWallet(customer._id)), message: MSG.saved });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== CHANGE EMAIL =====================================
  // 1. password again → a ticket for 15 minutes (the email link may open the page again, so it's kept on the device)
  const TICKET_MIN = 15;
  prop.app.post(`${url}/email/start`, prop.api_auth, customer_auth, formLimit, async (req, res) => {
    try {
      const password = String(req.body?.password || "");
      const customer = await Customer.findById(req.customer._id).select("password");
      if (!password || !customer || !(await bcrypt.compare(password, customer.password))) return res.status(400).json({ success: false, message: MSG.wrongPassword, code: "wrong_password" });
      const ticket = jwt.sign({ customer_id: String(req.customer._id), type: "email_change", jti: crypto.randomBytes(6).toString("hex") }, process.env.JWT_SECRET, { expiresIn: `${TICKET_MIN}m` });
      res.json({ success: true, data: { ticket, minutes: TICKET_MIN } });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });
  // 2. the new email, confirmed by Google (Google button or email link) → saved; other devices log out
  prop.app.put(`${url}/email`, prop.api_auth, customer_auth, formLimit, async (req, res) => {
    try {
      let t;
      try {
        t = jwt.verify(String(req.body?.ticket || ""), process.env.JWT_SECRET);
      } catch {
        t = null;
      }
      if (!t || t.type !== "email_change" || t.customer_id !== String(req.customer._id)) return res.status(401).json({ success: false, message: MSG.ticketOld, code: "ticket_old" });
      const checked = await checkedFrom(req, res);
      if (!checked) return;
      if (!checked.email) return res.status(401).json({ success: false, message: MSG.notChecked, code: "phone_bad_token" });
      if (checked.email === req.customer.email) return res.status(400).json({ success: false, message: MSG.sameEmail, code: "same_email" });
      if (await Customer.exists({ email: checked.email, _id: { $ne: req.customer._id } })) return res.status(409).json({ success: false, message: MSG.emailUsed, code: "email_taken" });
      let customer;
      try {
        customer = await Customer.findByIdAndUpdate(req.customer._id, { $set: { email: checked.email, email_verified: true } }, { returnDocument: "after" });
      } catch (err) {
        if (err.code === 11000) return res.status(409).json({ success: false, message: MSG.emailUsed, code: "email_taken" });
        throw err;
      }
      await CustomerSession.deleteMany({ customer_id: customer._id, _id: { $ne: req.customerSession._id } }); // other devices log in again
      const wallet = await getCustomerWallet(customer._id);
      res.json({ success: true, data: loginData(customer, wallet), message: MSG.emailChanged });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== CHANGE PASSWORD =====================================
  prop.app.put(`${url}/change-password`, prop.api_auth, customer_auth, async (req, res) => {
    try {
      const oldPassword = String(req.body?.old_password || "");
      const newPassword = String(req.body?.new_password || "");
      if (!oldPassword || !newPassword) return res.status(400).json({ success: false, message: MSG.fill });
      if (newPassword.length < 8 || newPassword.length > 100) return res.status(400).json({ success: false, message: MSG.shortPassword });

      const customer = await Customer.findById(req.customer._id);
      if (!(await bcrypt.compare(oldPassword, customer.password))) {
        return res.status(400).json({ success: false, message: MSG.wrongOld });
      }
      customer.password = await bcrypt.hash(newPassword, 10);
      await customer.save();
      // log out the other devices
      await CustomerSession.deleteMany({ customer_id: customer._id, _id: { $ne: req.customerSession._id } });
      res.json({ success: true, message: MSG.passwordChanged });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });
};

module.exports = route;
module.exports.EMAIL_RE = EMAIL_RE;
module.exports.startSession = startSession;
module.exports.loginData = loginData;
module.exports.MSG = MSG;
