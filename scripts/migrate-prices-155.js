// v1.5.5 (2026-10): lower Flip Book prices in the saved Website settings (the prices page of the super admin).
//   • fb_book_slot  5 → 1   (one more book place: 5 more books = 5 coins, was 25)
//   • fb_links     60 → 25  (clickable pages, once)
// A price the super admin already changed to something else is left alone. Safe to run again.
//   npm run migrate:prices-155                       (UAT: .env)
//   node scripts/with-env.js .env.prod node scripts/migrate-prices-155.js   (production, at the v1.5.5 release)
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/util/db");

const CHANGES = [
  { key: "fb_book_slot", from: 5, to: 1 },
  { key: "fb_links", from: 60, to: 25 },
];

async function main() {
  await connectDB();
  const col = mongoose.connection.db.collection("homepages");
  const doc = await col.findOne({ key: "main" }, { projection: { prices: 1 } });
  if (!doc) {
    console.log("✅ No Website settings saved yet — the new defaults (1 and 25) are used already.");
    return;
  }
  for (const c of CHANGES) {
    const now = doc.prices?.[c.key];
    if (now === undefined || now === null) {
      console.log(`✅ ${c.key}: not saved — the new default ${c.to} is used`);
    } else if (now === c.to) {
      console.log(`✅ ${c.key}: already ${c.to}`);
    } else if (now === c.from) {
      await col.updateOne({ key: "main", [`prices.${c.key}`]: c.from }, { $set: { [`prices.${c.key}`]: c.to } });
      console.log(`✅ ${c.key}: ${c.from} → ${c.to}`);
    } else {
      console.log(`⏭️  ${c.key}: is ${now} (set by hand) — left as it is`);
    }
  }
  console.log("The API picks the new prices up within 30 seconds.");
}

main()
  .catch((e) => {
    console.error("❌", e.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
