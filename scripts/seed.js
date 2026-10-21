// One-time setup for a new database. Safe to run again (it skips what already exists).
//   npm run seed
// Creates: the API key record (API_AUTH_KEY), the first super admin
// (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD) and the homepage settings with defaults.
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const connectDB = require("../src/util/db");
const AuthKey = require("../src/v1/admin/auth/auth_api_key.model");
const User = require("../src/v1/admin/user/user.model");
const Homepage = require("../src/homepage/homepage.model");

async function main() {
  const { API_AUTH_KEY, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD } = process.env;
  if (!API_AUTH_KEY || !SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD) {
    console.error("Set API_AUTH_KEY, SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env first.");
    process.exit(1);
  }
  if (SEED_ADMIN_PASSWORD.length < 8) {
    console.error("SEED_ADMIN_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }

  await connectDB();

  if (!(await AuthKey.findOne({ api_auth_key: API_AUTH_KEY }))) {
    await AuthKey.create({ api_auth_key: API_AUTH_KEY });
    console.log("✅ API key saved");
  } else console.log("• API key already exists");

  const email = SEED_ADMIN_EMAIL.trim().toLowerCase();
  if (!(await User.findOne({ email, deleted: { $ne: true } }))) {
    const id = new mongoose.Types.ObjectId();
    await User.create({
      _id: id,
      firstname: "Super",
      lastname: "Admin",
      email,
      password: await bcrypt.hash(SEED_ADMIN_PASSWORD, 10),
      is_super_admin: true,
      is_first_login: true, // asked to change the password after the first login
      created_by: id,
      updated_by: id,
    });
    console.log(`✅ Super admin created: ${email}`);
  } else console.log(`• User ${email} already exists`);

  if (!(await Homepage.findOne({ key: "main" }))) {
    await Homepage.create({ key: "main" });
    console.log("✅ Homepage settings created with defaults");
  } else console.log("• Homepage settings already exist");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
