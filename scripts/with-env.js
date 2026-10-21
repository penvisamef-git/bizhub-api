// Run a command with the values of another env file loaded first (they win over .env).
//   node scripts/with-env.js .env.prod node scripts/seed.js
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const [file, cmd, ...args] = process.argv.slice(2);
if (!file || !cmd) {
  console.error("Usage: node scripts/with-env.js <env file> <command> [args…]");
  process.exit(1);
}
const vars = require("dotenv").parse(fs.readFileSync(path.resolve(file)));
const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...vars } });
process.exit(r.status ?? 1);
