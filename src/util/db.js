const mongoose = require("mongoose");
const dns = require("dns");
require("dotenv").config();

dns.setServers(["1.1.1.1", "1.0.0.1"]);
// MONGO_URI (optional) overrides the Atlas address, e.g. a local MongoDB for development
const uri = process.env.MONGO_URI || `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@cluster0.zw8fy3n.mongodb.net/${process.env.MONGO_DB}?retryWrites=true&w=majority`;

// Connection pool settings (measured from Cambodia to Atlas Singapore):
// opening a new connection takes ~0.5–8 s (TLS + login), but a query on an open
// connection takes ~60 ms. By default the driver opens connections only when needed,
// 2 at a time, so a page with many queries waited seconds. Keep connections open:
const POOL = {
  minPoolSize: 20, // always keep 20 ready (the dashboard runs ~17 queries at once)
  maxPoolSize: 50,
  maxConnecting: 10, // open up to 10 at the same time when more are needed
  maxIdleTimeMS: 0, // never close idle connections
};

const connectDB = async () => {
  try {
    const started = Date.now();
    await mongoose.connect(uri, POOL);
    console.log(`✅ Connected to MongoDB (${Date.now() - started} ms)`);
    // open the pool now, not on the first visitor's request
    const db = mongoose.connection.db;
    Promise.all(Array.from({ length: POOL.minPoolSize }, () => db.admin().ping())).catch(() => {});
  } catch (err) {
    console.error("❌ Failed to connect to MongoDB:", err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
