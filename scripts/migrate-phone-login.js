// One-time, for phone sign-up: email becomes optional and checked phone numbers become unique.
//   npm run migrate:phone-login
// Replaces the old "email_1" index (every account needed an email) with
//   email_unique           — unique only when an email is given
//   phone_verified_unique  — one account per phone checked by SMS
// Old accounts keep working (they log in with their email). Safe to run again.
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/util/db");
const Customer = require("../src/user/customer.model");

async function main() {
  await connectDB();
  const col = mongoose.connection.db.collection("customers");
  const indexes = await col.indexes();
  const old = indexes.find((i) => i.name === "email_1");
  if (old) {
    await col.dropIndex("email_1");
    console.log("• removed old index email_1");
  }
  // accounts saved with an empty email: remove the field so they don't clash
  const r = await col.updateMany({ email: "" }, { $unset: { email: "" } });
  if (r.modifiedCount) console.log(`• ${r.modifiedCount} empty email(s) cleared`);
  await Customer.createIndexes();
  const now = (await col.indexes()).map((i) => i.name);
  console.log(`✅ customer indexes: ${now.join(", ")}`);
  await mongoose.disconnect();
  process.exit(0);
}
main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
