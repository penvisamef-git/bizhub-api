require("dotenv").config();
const mongoose = require("mongoose");
require("dns").setServers(["1.1.1.1", "1.0.0.1"]);
const uri = process.env.MONGO_URI || `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@cluster0.zw8fy3n.mongodb.net/${process.env.MONGO_DB}?retryWrites=true&w=majority`;
(async () => {
  await mongoose.connect(uri, { readPreference: "secondaryPreferred" });
  const d = await mongoose.connection.db.collection("homepages").findOne({ key: "main" }, { projection: { "prices.note_group": 1, "prices.note_sign": 1, "prices.note_storage": 1, "prices.digital_note": 1 } });
  console.log(mongoose.connection.db.databaseName, JSON.stringify(d?.prices || null));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
