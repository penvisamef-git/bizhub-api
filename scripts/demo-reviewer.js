// Demo login for the Google Play (and later App Store) reviewers.
//
//   node scripts/demo-reviewer.js            → shows what it would do (nothing is written)
//   node scripts/demo-reviewer.js --yes      → creates or refreshes the account on PRODUCTION
//
// Reads .env.prod (never .env). Safe to run again: it keeps the same account, sets a new
// password, tops the coins back up and only adds the sample businesses that are missing.
// The coins are new coins made for this account (a "generate" into the treasury, then a
// transfer), so they show up honestly in the super admin coin history.
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.prod"), override: true });

const EMAIL = "playreview@bizhubcambodia.com";
const NAME = "Google Play review";
const KEEP_COINS = 1000; // spare coins after the sample businesses, so add-ons can be unlocked
const SAMPLES = [
  { category: "namecard", name: "Sokha Design Studio", phone: "012 345 678", address: "Street 240, Phnom Penh" },
  { category: "restaurant", name: "Mekong Kitchen", phone: "012 345 679", address: "Riverside, Phnom Penh" },
  { category: "mart", name: "Lucky Mini Mart", phone: "012 345 680", address: "Toul Kork, Phnom Penh" },
  { category: "guest_house", name: "Lotus Guest House", phone: "012 345 681", address: "Siem Reap" },
  { category: "event", name: "Khmer New Year Party", phone: "012 345 682", address: "Phnom Penh" },
  { category: "digital_note", name: "Team Notes", phone: "", address: "" },
];

const yes = process.argv.includes("--yes");
const dbName = process.env.MONGO_URI ? process.env.MONGO_URI.split("?")[0].split("/").pop() : process.env.MONGO_DB;
if (process.env.BIZHUB_ENV !== "prod" || dbName !== "prod") {
  console.error(`Refusing: .env.prod must have BIZHUB_ENV=prod and the prod database (found ${process.env.BIZHUB_ENV} / ${dbName}).`);
  process.exit(1);
}

const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const connectDB = require("../src/util/db");
const Customer = require("../src/user/customer.model");
const Business = require("../src/biz/business.model");
const License = require("../src/license/license.model");
const Homepage = require("../src/homepage/homepage.model");
const { DEFAULT_HOMEPAGE } = require("../src/homepage/homepage.defaults");
const { PRODUCTS, YEARLY_TYPES } = require("../src/license/license.products");
const { DAY } = require("../src/license/license.service");
const coin = require("../src/coin/coin.service");

// readable but strong: 4 groups of 4 letters/digits (no 0/O/1/l)
function newPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => Array.from({ length: 4 }, () => abc[crypto.randomInt(abc.length)]).join("");
  return `Bh-${pick()}-${pick()}-${pick()}`;
}

(async () => {
  await connectDB();
  const home = await Homepage.findOne({ key: "main" }).select("prices").lean();
  const priceOf = (t) => (Number.isInteger(home?.prices?.[t]) ? home.prices[t] : (DEFAULT_HOMEPAGE.prices[t] ?? 0));

  let customer = await Customer.findOne({ email: EMAIL, deleted: false });
  const owned = customer ? await Business.find({ owner_id: customer._id, deleted: false }).select("name category").lean() : [];
  const missing = SAMPLES.filter((s) => !owned.some((b) => b.category === s.category));
  const need = missing.reduce((n, s) => n + priceOf(s.category), 0);
  const wallet = customer ? await coin.getCustomerWallet(customer._id) : { balance: 0 };
  const topUp = Math.max(0, need + KEEP_COINS - wallet.balance);

  console.log(`Database: ${mongoose.connection.name}`);
  console.log(`Account:  ${EMAIL} (${customer ? "exists, password will be reset" : "new"})`);
  console.log(`Add:      ${missing.map((s) => `${s.category} (${priceOf(s.category)} coins)`).join(", ") || "nothing"}`);
  console.log(`Coins:    balance ${wallet.balance}, add ${topUp}, ${KEEP_COINS} left after the businesses`);
  if (!yes) {
    console.log("\nDry run. Run again with --yes to write this to production.");
    return mongoose.disconnect();
  }

  const password = newPassword();
  const hash = await bcrypt.hash(password, 10);
  if (customer) {
    customer.set({ password: hash, status: true, name: NAME });
    await customer.save();
  } else {
    customer = await Customer.create({ name: NAME, email: EMAIL, email_verified: true, password: hash, admin_note: "Demo login for the Google Play / App Store reviewers. Do not delete." });
  }

  if (topUp > 0) {
    await coin.generate({ amount: topUp, note: `Demo coins for ${EMAIL} (store review)` });
    await coin.transfer({ from: await coin.getTreasury(), to: await coin.getCustomerWallet(customer._id), amount: topUp, note: "Demo coins (store review)", customerId: customer._id });
  }

  // the same steps as POST /api/user/businesses: pay, create, first year for yearly types
  for (const s of missing) {
    const _id = new mongoose.Types.ObjectId();
    const price = priceOf(s.category);
    if (price > 0) {
      await coin.transfer({ from: await coin.getCustomerWallet(customer._id), to: await coin.getTreasury(), amount: price, note: `New business: ${s.name}`, customerId: customer._id, type: "spend", businessId: _id, service: s.category, max: 100000 });
    }
    await Business.create({ _id, ...s, owner_id: customer._id });
    if (YEARLY_TYPES.includes(s.category)) {
      const now = new Date();
      await License.create({ customer_id: customer._id, business_id: _id, product: s.category, started_at: now, expires_at: new Date(now.getTime() + PRODUCTS[s.category].days * DAY), total_paid: price, last_paid_at: price ? now : null });
    }
    console.log(`  + ${s.category}: ${s.name}`);
  }

  const after = await coin.getCustomerWallet(customer._id);
  console.log(`\nDone. Coins now: ${after.balance}`);
  console.log(`\n  Email:    ${EMAIL}\n  Password: ${password}\n\nPut these in Play Console → App content → App access. This password is shown only once.`);
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
