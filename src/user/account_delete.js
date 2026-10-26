// "Delete my account" for customers (business owners) — needed for Google Play / App Store.
//   POST   /api/user/account/delete  { password } or { firebase_token }   ask: erased in 30 days
//   GET    /api/user/account/delete                                         { pending, requested_at, delete_at, days }
//   DELETE /api/user/account/delete                                         cancel
// Logging in again (password, Google, phone, reset password) before delete_at cancels it (cancelOnLogin).
// purgeDueAccounts() — run by /api/cron/daily-report — erases the accounts whose 30 days have passed:
//   every business they own (files on Cloudinary + records, business.purge.js), chat with BizHub + its files,
//   sessions, coin-order screenshots; remaining coins go back to the BizHub treasury (lost for the customer);
//   the customer row is anonymised (coin history keeps pointing at it) — name / email / phone / photo cleared.
// BizHub team accounts (super admin, staff) are separate (src/v1/admin/user) and can't use this.
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const Customer = require("./customer.model");
const CustomerSession = require("./customer_session.model");
const { customer_auth } = require("./customer_auth");
const { rate_limit } = require("../util/rate_limit");
const { verifyFirebaseToken } = require("../util/firebase_auth");

const GRACE_DAYS = 30;
const DAY = 24 * 3600 * 1000;
const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  wrongPassword: "ពាក្យសម្ងាត់មិនត្រឹមត្រូវ!",
  needConfirm: "សូមបញ្ចូលពាក្យសម្ងាត់ ឬចូលដោយ Google ម្តងទៀត ដើម្បីបញ្ជាក់!",
  notYou: "គណនី Google នេះមិនមែនជាគណនីរបស់អ្នកទេ!",
  asked: "គណនីរបស់អ្នកនឹងត្រូវលុបក្នុងរយៈពេល 30 ថ្ងៃ។ ចូលម្តងទៀតមុនថ្ងៃនោះ ដើម្បីបោះបង់។",
  cancelled: "បានបោះបង់ការលុបគណនី!",
  notPending: "គណនីនេះមិនមានការស្នើសុំលុបទេ។",
};

const statusOf = (c) => {
  const at = c?.delete_at ? new Date(c.delete_at) : null;
  return {
    pending: !!at,
    requested_at: c?.delete_requested_at || null,
    delete_at: at,
    days: at ? Math.max(0, Math.ceil((at.getTime() - Date.now()) / DAY)) : null,
    grace_days: GRACE_DAYS,
  };
};

// called by every login path; true when a pending deletion was just cancelled
async function cancelOnLogin(customer) {
  if (!customer?.delete_at) return false;
  await Customer.updateOne({ _id: customer._id, deleted: false }, { $set: { delete_at: null, delete_requested_at: null } });
  customer.delete_at = null;
  customer.delete_requested_at = null;
  return true;
}

function routes(prop) {
  const url = "/api/user/account/delete";
  const limit = rate_limit({ max: 10 });

  prop.app.get(url, prop.api_auth, customer_auth, async (req, res) => {
    try {
      const c = await Customer.findById(req.customer._id).select("delete_at delete_requested_at").lean();
      res.json({ success: true, data: statusOf(c) });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  prop.app.post(url, prop.api_auth, customer_auth, limit, async (req, res) => {
    try {
      const c = await Customer.findById(req.customer._id).select("password email email_verified phone phone_verified delete_at deleted");
      if (!c || c.deleted) return res.status(404).json({ success: false, message: MSG.server });
      // prove it's you: the password, or Google / SMS again (an account made with Google still has a password,
      // but people may not remember it)
      const password = String(req.body?.password || "");
      const fbToken = String(req.body?.firebase_token || "");
      if (password) {
        if (!(await bcrypt.compare(password, c.password))) return res.status(400).json({ success: false, message: MSG.wrongPassword, code: "wrong_password" });
      } else if (fbToken) {
        let r;
        try {
          r = await verifyFirebaseToken(fbToken);
        } catch {
          return res.status(401).json({ success: false, message: MSG.needConfirm, code: "bad_token" });
        }
        const email = r.email && r.email_verified ? String(r.email).toLowerCase() : "";
        const mine = (email && email === c.email) || (r.phone && c.phone_verified && r.phone === c.phone);
        if (!mine) return res.status(403).json({ success: false, message: MSG.notYou, code: "not_you" });
      } else return res.status(400).json({ success: false, message: MSG.needConfirm, code: "need_confirm" });

      if (!c.delete_at) {
        c.delete_requested_at = new Date();
        c.delete_at = new Date(Date.now() + GRACE_DAYS * DAY);
        await c.save();
      }
      // other devices are logged out; this one stays so the owner can still see the date and cancel
      await CustomerSession.deleteMany({ customer_id: c._id, _id: { $ne: req.customerSession._id } });
      res.json({ success: true, data: statusOf(c), message: MSG.asked });
    } catch (err) {
      console.error("[account delete]", err);
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  prop.app.delete(url, prop.api_auth, customer_auth, async (req, res) => {
    try {
      const c = await Customer.findOneAndUpdate({ _id: req.customer._id, delete_at: { $ne: null } }, { $set: { delete_at: null, delete_requested_at: null } }, { returnDocument: "after" });
      if (!c) return res.status(400).json({ success: false, message: MSG.notPending, code: "not_pending" });
      res.json({ success: true, data: statusOf(c), message: MSG.cancelled });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });
}

// ---------------------------------------------------------------- the daily erase
// Bounded: at most `limit` accounts per run (each can own many businesses). Safe to run again: every step
// can be repeated, and an account is only marked erased (deleted: true) after all steps worked.
async function eraseAccount(id) {
  const { purgeBusiness, collect } = require("../biz/business.purge");
  const cloud = require("../util/cloudinary");
  const Business = mongoose.model("Business");
  const cid = new mongoose.Types.ObjectId(String(id));
  const done = { businesses: 0, files: 0 };
  // 1) every business (also ones already in the bin)
  const biz = await Business.find({ owner_id: cid }).select("_id").lean();
  for (const b of biz) {
    const r = await purgeBusiness(b._id);
    done.businesses += 1;
    done.files += r.deleted || 0;
  }
  // 2) "Chat with BizHub" + its files; coin-order screenshots (the orders stay: money records)
  const P = require("../platform/platform.model");
  const files = new Map();
  const thread = await P.SupportThread.findOne({ customer_id: cid }).lean();
  if (thread) {
    for await (const m of P.SupportMessage.find({ thread_id: thread._id }).lean().cursor()) collect(m, files);
  }
  const orders = await P.CoinOrder.find({ customer_id: cid }).lean();
  for (const o of orders) collect(o.proof, files);
  const c = await Customer.findById(cid).lean();
  if (c?.photo?.public_id) files.set(c.photo.public_id, "image");
  for (const [pid, type] of files) await cloud.deleteFile(pid, type).catch(() => {});
  done.files += files.size;
  if (thread) {
    await P.SupportMessage.deleteMany({ thread_id: thread._id });
    await P.SupportThread.deleteOne({ _id: thread._id });
  }
  if (orders.length) await P.CoinOrder.updateMany({ customer_id: cid }, { $set: { proof: null, note: "", reference: "" } });
  // 3) remaining coins → back to the BizHub treasury (written in the coin history), the wallet stays at 0
  const coin = require("../coin/coin.service");
  const wallet = await mongoose.model("Wallet").findOne({ customer_id: cid });
  if (wallet && wallet.balance > 0) {
    const treasury = await coin.getTreasury();
    await coin.transfer({ from: wallet, to: treasury, amount: wallet.balance, note: "Account deleted: coins not used", max: Number.MAX_SAFE_INTEGER });
  }
  // 4) every login + anything else that only points at the person
  await CustomerSession.deleteMany({ customer_id: cid });
  const License = mongoose.models.License;
  if (License) await License.deleteMany({ customer_id: cid });
  // 5) the person: anonymised (coin history still points at this id), never able to log in again
  await Customer.updateOne(
    { _id: cid },
    {
      $set: {
        name: "Deleted account",
        phone: "",
        phone_verified: false,
        email_verified: false,
        password: await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10),
        photo: { url: "", public_id: "" },
        admin_note: "",
        signup_device: null,
        status: false,
        deleted: true,
        deleted_at: new Date(),
        delete_at: null,
      },
      $unset: { email: 1 },
    },
  );
  return done;
}

async function purgeDueAccounts({ limit = 5, now = new Date() } = {}) {
  const due = await Customer.find({ delete_at: { $ne: null, $lte: now }, deleted: false }).sort({ delete_at: 1 }).limit(limit).select("_id").lean();
  const out = { due: due.length, erased: 0, failed: 0, businesses: 0 };
  for (const c of due) {
    try {
      const r = await eraseAccount(c._id);
      out.erased += 1;
      out.businesses += r.businesses;
    } catch (err) {
      out.failed += 1;
      console.error("[account erase]", String(c._id), err?.message || err);
    }
  }
  return out;
}

module.exports = { routes, cancelOnLogin, purgeDueAccounts, eraseAccount, statusOf, GRACE_DAYS };
