// One-time: old business categories → the 2 types we support now.
//   restaurant, cafe → restaurant      everything else → namecard
// Also removes the old "services" list from businesses. Safe to run again.
//   npm run migrate:business-types
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/util/db");

async function main() {
  await connectDB();
  const col = mongoose.connection.db.collection("businesses");
  const r1 = await col.updateMany({ category: "cafe" }, { $set: { category: "restaurant" } });
  const r2 = await col.updateMany({ category: { $nin: ["namecard", "restaurant"] } }, { $set: { category: "namecard" } });
  const r3 = await col.updateMany({ services: { $exists: true } }, { $unset: { services: "" } });
  console.log(`✅ cafe → restaurant: ${r1.modifiedCount} · others → namecard: ${r2.modifiedCount} · services removed: ${r3.modifiedCount}`);
  await mongoose.disconnect();
  process.exit(0);
}
main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
