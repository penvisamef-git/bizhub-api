// One-time (2026-10): new prices.
//   • Website settings: restaurant = 100 coins per year, sign-up gift = 200 coins
//   • Restaurants made before this change get a 1-year license from the day they were created
//     (so they can see their end date and renew on the Licenses page)
// Safe to run again.
//   npm run migrate:restaurant-yearly
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/util/db");

const DAY = 24 * 3600 * 1000;

async function main() {
  await connectDB();
  const db = mongoose.connection.db;

  const h = await db.collection("homepages").updateOne({ key: "main" }, { $set: { "prices.restaurant": 100, "coin.signup_bonus": 200 } });
  console.log(`✅ Website settings: restaurant 100 coins/year, sign-up gift 200 coins (${h.matchedCount ? "updated" : "no settings saved yet — defaults already 100/200"})`);

  const restaurants = await db.collection("businesses").find({ category: "restaurant", deleted: { $ne: true } }).project({ owner_id: 1, created_date: 1 }).toArray();
  let made = 0;
  for (const b of restaurants) {
    const start = b.created_date ? new Date(b.created_date) : new Date();
    const r = await db.collection("licenses").updateOne(
      { business_id: b._id, product: "restaurant", item: "" },
      {
        $setOnInsert: {
          customer_id: b.owner_id,
          business_id: b._id,
          product: "restaurant",
          item: "",
          started_at: start,
          expires_at: new Date(start.getTime() + 365 * DAY),
          renewals: 0,
          total_paid: 0,
          last_paid_at: null,
          created_date: new Date(),
          updated_date: new Date(),
        },
      },
      { upsert: true },
    );
    if (r.upsertedCount) made += 1;
  }
  console.log(`✅ Restaurants: ${restaurants.length} found, ${made} got a 1-year license`);
  await mongoose.disconnect();
  process.exit(0);
}
main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
