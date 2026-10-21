// Set a new password for a user (e.g. a super admin who forgot it).
//   npm run reset-password -- someone@example.com
// You type the new password (hidden). It is hashed and saved; nothing is printed or logged.
// The user's other sessions are logged out.
require("dotenv").config();
const readline = require("readline");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const connectDB = require("../src/util/db");
const User = require("../src/v1/admin/user/user.model");
const Session = require("../src/v1/admin/session/session.model");

// One readline for both questions; typed characters show as * in a terminal
function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  let hiding = false;
  let pending = null;
  // input ended (Ctrl+D / closed pipe): answer "" so the script stops instead of waiting forever
  rl.on("close", () => pending && pending(""));
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => {
    if (!hiding || s.includes("\n") || s.includes("\r")) return write(s);
    return write("*".repeat(s.length));
  };
  const ask = (question) =>
    new Promise((resolve) => {
      hiding = false;
      process.stdout.write(question);
      hiding = true;
      pending = resolve;
      rl.question("", (answer) => {
        hiding = false;
        pending = null;
        resolve(answer);
      });
    });
  return { ask, close: () => rl.close() };
}

async function main() {
  const email = String(process.argv[2] || "").trim().toLowerCase();
  if (!email) {
    console.error("Usage: npm run reset-password -- <email>");
    process.exit(1);
  }

  await connectDB();
  const user = await User.findOne({ email, deleted: { $ne: true } });
  if (!user) {
    console.error(`No active user with email ${email}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const prompt = createPrompt();
  const password = await prompt.ask(`New password for ${email}: `);
  const confirm = await prompt.ask("\nType it again: ");
  prompt.close();
  process.stdout.write("\n");
  if (password.length < 8) {
    console.error("Password must be at least 8 characters. Nothing changed.");
  } else if (password !== confirm) {
    console.error("Passwords don't match. Nothing changed.");
  } else {
    user.password = await bcrypt.hash(password, 10);
    user.is_first_login = false;
    await user.save();
    const { deletedCount } = await Session.deleteMany({ user_id: user._id });
    console.log(`✅ Password updated for ${email}${user.is_super_admin ? " (super admin)" : ""}. ${deletedCount} old session(s) logged out.`);
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Reset failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
