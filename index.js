require("dotenv").config();
// production must point at the production database + Cloudinary folder (see src/util/env_guard.js)
require("./src/util/env_guard").checkEnv();

// Look up the database address through public DNS: some Wi-Fi routers / hotspots can't answer the
// "mongodb+srv" lookup (querySrv ETIMEOUT). Override with DNS_SERVERS=1.1.1.1,8.8.8.8 or DNS_SERVERS=off.
if (process.env.NODE_ENV !== "test" && process.env.DNS_SERVERS !== "off") {
  require("dns").setServers(
    (process.env.DNS_SERVERS || "8.8.8.8,1.1.1.1")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const connectDB = require("./src/util/db");
const { api_auth } = require("./src/util/api_auth");
const { jwt_auth } = require("./src/util/jwt_auth");
const request_user = require("./src/util/request_user");
const adminAPI_V1 = require("./src/v1/admin/index.route");

const PORT = process.env.api_port || process.env.PORT; // set api_port in .env
const app = express();

// ================= Middleware =================
// maxAge: the browser keeps the "OK to call" answer (preflight) for 2 h instead of asking again before most calls
app.use(cors({ maxAge: 7200 }));
app.use(helmet());
app.use(compression());

// Log only slow requests (> 500 ms)
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (ms > 500) console.log(`[slow] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
});

// JSON bodies: 2 MB, except Digital Note (a long note can be bigger). Vercel refuses anything over ~4.5 MB anyway.
const jsonBody = express.json({ limit: "2mb" });
const jsonNote = express.json({ limit: "4mb" });
const NOTE_PATHS = /^\/api\/(user\/businesses\/[^/]+\/note|public\/note|public\/note-group)(\/|$)/;
app.use((req, res, next) => (NOTE_PATHS.test(req.path) ? jsonNote : jsonBody)(req, res, next));

// ================= Connection =================
connectDB();

app.get("/", api_auth, (req, res) => {
  res.send({
    success: true,
    message: "BizHub API Connected",
  });
});

// ================= Routes =================
const prop = { app, jwt, api_auth, jwt_auth, request_user };
adminAPI_V1(prop);

// Public routes (no login) — /api/public/...
const publicAPI_V1 = require("./src/v1/public/index.route");
publicAPI_V1(prop);

// ================= Modules =================
// /src/homepage   website content (super admin edits, public reads)
// /src/user         customer (business owner) sign-up, login + super admin customer list
// /src/biz          businesses (each service later in /src/biz/<service>)
// /src/coin         treasury, wallets, coin history (generate / transfer)
// /src/super_admin  super admin dashboard numbers
// /src/license      what customers bought (forever or until a date) + renewals
// /src/telegram     BizHub Telegram bot (connect chat, send messages)
// /src/login_qr     log in to the app with a QR code from the website (Account page)
// /src/biz_category (later)
// Team access (v1.5): finds the caller's role in /api/user/businesses/:id/… (owner | admin | view) before any service runs
app.use("/api/user/businesses/:id", require("./src/biz/team/team.access").gate);

require("./src/homepage")(prop);
require("./src/user")(prop);
require("./src/biz")(prop);
require("./src/coin")(prop);
require("./src/super_admin")(prop);
require("./src/license")(prop);
require("./src/platform")(prop); // coin orders by bank transfer, Chat with BizHub, super admin Telegram
require("./src/telegram")(prop); // BizHub Telegram bot (owners connect a chat for reports)
require("./src/login_qr")(prop); // log in to the BizHub app by scanning a QR code on the website
require("./src/app_error")(prop); // crashes of the BizHub app → super admin (list + Telegram)

// 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// Invalid JSON body and other unhandled errors
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Invalid JSON body" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ success: false, message: "ទិន្នន័យធំពេកមិនអាចផ្ញើបាន!", code: "too_large" });
  }
  console.error(err);
  res.status(500).json({ success: false, message: "Internal Server Error" });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on ${PORT}`);
  });
}

// 🧼 Gracefully handle shutdown
process.on("SIGINT", async () => {
  await mongoose.connection.close();
  console.log("🛑 MongoDB disconnected cleanly");
  process.exit(0);
});

module.exports = app;
