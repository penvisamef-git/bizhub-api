// Coin packs bought in the Android app with Google Play Billing (the only way to buy coins inside the Play app).
// Web / KHQR / bank top-ups stay on bizhubcambodia.com; coins from both go into the same wallet.
//   GET  /api/user/coins/google-packs                  the packs (product ids coins_<coins>) + account_ref for the purchase
//   POST /api/user/coins/google/verify { productId, purchaseToken, orderId }
//        checks the purchase with Google, adds the coins once (same token twice = once), then consumes it
// Refunds / chargebacks: syncVoided() runs from /api/cron/daily-report and takes the coins back once.
const crypto = require("crypto");
const mongoose = require("mongoose");
const coin = require("./coin.service");
const Wallet = require("./wallet.model");
const google = require("./google_play");
const { GooglePurchase, GoogleSync } = require("./google_purchase.model");
const { PlatformSettings, DEFAULT_PACKAGES } = require("../platform/platform.model");
const { customer_auth } = require("../user/customer_auth");

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  notSetup: "ការទិញតាម Google Play មិនទាន់បានរៀបចំនៅឡើយ។ / Google Play payments are not set up yet.",
  badProduct: "កញ្ចប់កាក់មិនត្រឹមត្រូវ! / Unknown coin pack.",
  badToken: "ការទិញមិនត្រឹមត្រូវ! / This purchase isn't valid.",
  pending: "ការទូទាត់កំពុងរង់ចាំ។ កាក់នឹងចូលពេលបានបង់រួច។ / The payment is pending. The coins are added when it's paid.",
  cancelled: "ការទិញត្រូវបានបោះបង់។ / This purchase was cancelled.",
  otherUser: "ការទិញនេះជារបស់គណនីផ្សេង! / This purchase belongs to another account.",
  busy: "កំពុងដំណើរការ… សូមព្យាយាមម្តងទៀតបន្តិចទៀត។ / Still working on it — try again in a moment.",
  added: "បានបញ្ចូលកាក់! / Coins added!",
};

const sendError = (res, err) => {
  if (err?.http) return res.status(err.http).json({ success: false, message: err.message, code: err.code });
  console.error("[google-play]", err);
  res.status(500).json({ success: false, message: MSG.server });
};
const bad = (message, http = 400, code = "") => Object.assign(new Error(message), { http, code });

// the packs = the coin packages the super admin sets (Super admin → Coin shop), as Google product ids coins_<coins>
async function packs() {
  const s = await PlatformSettings.findOne({ key: "main" }).select("packages").lean();
  const list = (s?.packages?.length ? s.packages : DEFAULT_PACKAGES).filter((p) => p.active !== false);
  const seen = new Set();
  return list
    .map((p) => ({ product_id: `coins_${p.coins}`, coins: p.coins, bonus: Math.floor((p.coins * (p.bonus_pct || 0)) / 100), bonus_pct: p.bonus_pct || 0, usd: p.usd }))
    .filter((p) => (seen.has(p.product_id) ? false : seen.add(p.product_id)))
    .map((p) => ({ ...p, total_coins: p.coins + p.bonus }));
}

// what the app passes to Google as obfuscatedAccountId (so a purchase can only be claimed by the account that paid)
const accountRef = (customerId) => crypto.createHash("sha256").update(`bizhub:${customerId}`).digest("hex").slice(0, 64);

async function credit(p) {
  // the coins come from the treasury, like an approved bank order; when it's short the missing coins are made first (recorded)
  const treasury = await coin.getTreasury();
  if (treasury.balance < p.total_coins) await coin.generate({ amount: p.total_coins - treasury.balance, note: `Google Play ${p.order_id || p.token.slice(0, 12)} (in-app coins)`, userId: null });
  return coin.transfer({
    from: await coin.getTreasury(),
    to: await coin.getCustomerWallet(p.customer_id),
    amount: p.total_coins,
    note: `Google Play coin pack ${p.coins}${p.bonus ? ` (+${p.bonus} free)` : ""}`.slice(0, 300),
    payment: { method: "Google Play", reference: (p.order_id || p.token).slice(0, 120), amount_usd: p.usd ?? null },
    customerId: p.customer_id,
  });
}

async function consume(p) {
  if (p.consumed) return true;
  try {
    await google.api.consume(p.product_id, p.token);
  } catch (err) {
    // already consumed is fine; anything else: the app's next verify tries again
    if (!/consum/i.test(String(err.message))) {
      console.warn("[google-play] consume failed", p.order_id, err.message);
      return false;
    }
  }
  await GooglePurchase.updateOne({ _id: p._id }, { $set: { consumed: true } });
  return true;
}

async function verify({ customerId, productId, purchaseToken, orderId }) {
  if (!google.ready()) throw bad(MSG.notSetup, 503, "not_setup");
  const pack = (await packs()).find((x) => x.product_id === productId);
  if (!pack) throw bad(MSG.badProduct, 400, "bad_product");
  const token = String(purchaseToken || "").trim();
  if (token.length < 10 || token.length > 4000) throw bad(MSG.badToken, 400, "bad_token");

  let row = await GooglePurchase.findOne({ token });
  if (row && String(row.customer_id) !== String(customerId)) throw bad(MSG.otherUser, 409, "other_user");
  if (row && row.product_id !== productId) throw bad(MSG.badToken, 400, "bad_token");

  if (!row || ["new", "error"].includes(row.status)) {
    // ask Google
    let g;
    try {
      g = await google.api.getProduct(productId, token);
    } catch (err) {
      if (err.code === "google_invalid") throw bad(MSG.badToken, 400, "bad_token");
      throw err;
    }
    if (g.purchaseState === 2) throw bad(MSG.pending, 202, "pending");
    if (g.purchaseState !== 0) throw bad(MSG.cancelled, 400, "cancelled");
    if (g.obfuscatedExternalAccountId && g.obfuscatedExternalAccountId !== accountRef(customerId)) throw bad(MSG.otherUser, 409, "other_user");
    if (!row) {
      try {
        row = await GooglePurchase.create({
          token,
          product_id: productId,
          order_id: String(g.orderId || orderId || "").slice(0, 120),
          customer_id: customerId,
          coins: pack.coins,
          bonus: pack.bonus,
          total_coins: pack.total_coins,
          usd: pack.usd,
          region: g.regionCode || "",
          purchased_at: g.purchaseTimeMillis ? new Date(Number(g.purchaseTimeMillis)) : new Date(),
        });
      } catch (err) {
        if (err.code !== 11000) throw err;
        row = await GooglePurchase.findOne({ token }); // the same purchase sent twice at once
        if (String(row.customer_id) !== String(customerId)) throw bad(MSG.otherUser, 409, "other_user");
      }
    }
    // only one request adds the coins
    const claimed = await GooglePurchase.findOneAndUpdate({ _id: row._id, status: { $in: ["new", "error"] } }, { $set: { status: "crediting", error: "" } }, { returnDocument: "after" });
    if (claimed) {
      try {
        const tx = await credit(claimed);
        row = await GooglePurchase.findOneAndUpdate({ _id: claimed._id }, { $set: { status: "credited", tx_id: tx._id } }, { returnDocument: "after" });
      } catch (err) {
        await GooglePurchase.updateOne({ _id: claimed._id }, { $set: { status: "error", error: String(err.message || err).slice(0, 300) } });
        throw err;
      }
    } else row = await GooglePurchase.findById(row._id);
  }
  if (row.status === "crediting") throw bad(MSG.busy, 409, "busy");
  if (["reversing", "reversed"].includes(row.status)) throw bad(MSG.cancelled, 400, "refunded");
  const consumed = await consume(row);
  const wallet = await Wallet.findOne({ key: `customer:${customerId}` }).lean();
  return { status: "credited", coins_added: row.total_coins, balance: wallet?.balance ?? 0, consumed, order_id: row.order_id };
}

// ---------------------------------------------------------------- refunds / chargebacks (cron)
async function reverse(p, voided) {
  const claimed = await GooglePurchase.findOneAndUpdate({ _id: p._id, status: "credited" }, { $set: { status: "reversing", voided_at: voided.at, voided_reason: voided.reason } }, { returnDocument: "after" });
  if (!claimed) return false; // already done (or never credited)
  try {
    const wallet = await coin.getCustomerWallet(claimed.customer_id);
    const take = Math.min(wallet.balance, claimed.total_coins);
    let tx = null;
    if (take > 0) {
      tx = await coin.transfer({
        from: wallet,
        to: await coin.getTreasury(),
        amount: take,
        note: `Google Play refund ${claimed.order_id || ""}${take < claimed.total_coins ? ` (${claimed.total_coins - take} coins already spent)` : ""}`.slice(0, 300),
        payment: { method: "Google Play", reference: (claimed.order_id || claimed.token).slice(0, 120), amount_usd: null },
        customerId: claimed.customer_id,
      });
    }
    const debt = claimed.total_coins - take;
    await GooglePurchase.updateOne({ _id: claimed._id }, { $set: { status: "reversed", reversed_coins: take, debt_coins: debt, reverse_tx_id: tx?._id || null } });
    if (debt > 0) console.warn(`[google-play] refund ${claimed.order_id}: ${debt} coins were already spent (customer ${claimed.customer_id})`);
    return true;
  } catch (err) {
    // the balance changed under us (transfer refused): try again next run
    await GooglePurchase.updateOne({ _id: claimed._id }, { $set: { status: "credited", error: `refund: ${String(err.message || err).slice(0, 280)}` } });
    return false;
  }
}

async function syncVoided({ maxPages = 5 } = {}) {
  if (!google.ready()) return { skipped: "not_setup" };
  const sync = await GoogleSync.findOneAndUpdate({ key: "voided" }, { $setOnInsert: { key: "voided" } }, { upsert: true, returnDocument: "after" });
  // Google keeps 30 days; look back from the last run with a day of overlap
  const floor = Date.now() - 29 * 86400000;
  const start = Math.max(floor, (sync.since ? sync.since.getTime() : floor) - 86400000);
  let page = null;
  let seen = 0;
  let reversed = 0;
  let newest = start;
  for (let i = 0; i < maxPages; i++) {
    const r = await google.api.voided(start, page);
    for (const v of r.voidedPurchases || []) {
      seen++;
      const at = Number(v.voidedTimeMillis) || Date.now();
      newest = Math.max(newest, at);
      const p = await GooglePurchase.findOne({ token: v.purchaseToken });
      if (p && (await reverse(p, { at: new Date(at), reason: v.voidedReason ?? null }))) reversed++;
    }
    page = r.tokenPagination?.nextPageToken;
    if (!page) break;
  }
  await GoogleSync.updateOne({ _id: sync._id }, { $set: { since: new Date(newest), ran_at: new Date() } });
  return { seen, reversed };
}

module.exports = (prop) => {
  const user = [prop.api_auth, customer_auth];
  prop.app.get("/api/user/coins/google-packs", ...user, async (req, res) => {
    try {
      res.json({ success: true, data: { ready: google.ready(), packs: await packs(), account_ref: accountRef(req.customer._id) } });
    } catch (err) {
      sendError(res, err);
    }
  });
  prop.app.post("/api/user/coins/google/verify", ...user, async (req, res) => {
    try {
      const data = await verify({ customerId: req.customer._id, productId: String(req.body?.productId || ""), purchaseToken: req.body?.purchaseToken, orderId: req.body?.orderId });
      res.json({ success: true, data, message: MSG.added });
    } catch (err) {
      sendError(res, err);
    }
  });
};
module.exports.verify = verify;
module.exports.syncVoided = syncVoided;
module.exports.packs = packs;
module.exports.accountRef = accountRef;
void mongoose;
