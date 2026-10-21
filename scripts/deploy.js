// Deploy the API to Vercel:  npm run deploy:uat   or   npm run deploy:prod
//   uat  → the project this folder is linked to (.vercel/project.json, "bizhub-api" → bizhub-api-eight.vercel.app)
//   prod → the production project, whose id is in deploy.prod.json (→ bizhub-api-eight-production.vercel.app)
// Before a production deploy it checks that the production project has the needed variables on Vercel,
// so nothing silently falls back to the local .env (MONGO_DB=uat).
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const target = process.argv[2];
if (!["uat", "prod", "env-prod", "setup-prod"].includes(target)) {
  console.error("Usage: node scripts/deploy.js uat|prod|env-prod|setup-prod");
  process.exit(1);
}
const root = path.join(__dirname, "..");
const vercel = (args, env = {}) => spawnSync("npx", ["vercel", ...args], { cwd: root, stdio: ["inherit", "pipe", "inherit"], env: { ...process.env, ...env }, encoding: "utf8" });

if (target === "uat") {
  const r = spawnSync("npx", ["vercel", "--prod"], { cwd: root, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------- production
const linkFile = path.join(root, ".vercel", "project.json");
const prodFile = path.join(root, "deploy.prod.json");
const link = fs.existsSync(linkFile) ? JSON.parse(fs.readFileSync(linkFile, "utf8")) : {};
const PROD_NAME = "bizhub-api-eight-production"; // → https://bizhub-api-eight-production.vercel.app
const SCOPE = "mef-itd"; // the Vercel team (same as UAT)

// ---------------------------------------------------------------- npm run setup:prod
// one time: create the production project (UAT is not touched), save its id in deploy.prod.json,
// then send .env.prod to it.
if (target === "setup-prod") {
  const old = fs.existsSync(prodFile) ? JSON.parse(fs.readFileSync(prodFile, "utf8")) : {};
  if (!old.projectId) {
    console.log(`Creating the Vercel project "${PROD_NAME}" in ${SCOPE} (if it doesn't exist yet)…`);
    const add = spawnSync("npx", ["vercel", "project", "add", PROD_NAME, "--scope", SCOPE], { cwd: root, encoding: "utf8" });
    const said = `${add.stdout || ""}${add.stderr || ""}`;
    if (add.status !== 0 && !/already exists/i.test(said)) {
      console.error(said.trim() || "vercel project add failed");
      console.error("Log in first if needed: npx vercel login");
      process.exit(1);
    }
    // link a throw-away folder to it, only to read the project id (this folder's UAT link stays as it is)
    const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "bizhub-prod-"));
    const ln = spawnSync("npx", ["vercel", "link", "--yes", "--project", PROD_NAME, "--scope", SCOPE, "--cwd", tmp], { cwd: root, encoding: "utf8" });
    const pj = path.join(tmp, ".vercel", "project.json");
    if (ln.status !== 0 || !fs.existsSync(pj)) {
      console.error(`${ln.stdout || ""}${ln.stderr || ""}`.trim() || "vercel link failed");
      process.exit(1);
    }
    const got = JSON.parse(fs.readFileSync(pj, "utf8"));
    if (got.projectId === link.projectId) {
      console.error("That is the UAT project. Stopping.");
      process.exit(1);
    }
    fs.writeFileSync(prodFile, JSON.stringify({ project: PROD_NAME, projectId: got.projectId, orgId: got.orgId }, null, 2) + "\n");
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`Saved deploy.prod.json (${got.projectId}).`);
  } else console.log(`deploy.prod.json already has the production project (${old.projectId}).`);
  // then the values
  const r = spawnSync(process.execPath, [__filename, "env-prod", ...process.argv.slice(3)], { cwd: root, stdio: "inherit" });
  if (r.status === 0) console.log("\nNext: npm run seed:prod (first time only), then npm run deploy:prod");
  process.exit(r.status ?? 1);
}

const prod = fs.existsSync(prodFile) ? JSON.parse(fs.readFileSync(prodFile, "utf8")) : {};
const orgId = prod.orgId || link.orgId;
if (!prod.projectId || !orgId) {
  console.error(`
deploy.prod.json is missing the production project id.
  1. Open Vercel → the production API project (bizhub-api-eight-production.vercel.app) → Settings → General.
  2. Copy "Project ID" (starts with prj_).
  3. Put it in bizhub-api/deploy.prod.json:  { "projectId": "prj_..." }
`);
  process.exit(1);
}
if (link.projectId && link.projectId === prod.projectId) {
  console.error("deploy.prod.json points at the same project as UAT (.vercel/project.json). Stopping.");
  process.exit(1);
}
const env = { VERCEL_ORG_ID: orgId, VERCEL_PROJECT_ID: prod.projectId };

// ---------------------------------------------------------------- npm run env:prod
// send every value of .env.prod to the production project (Production environment). Values already
// there are left alone, unless you run it with --replace.
if (target === "env-prod") {
  const file = path.join(root, ".env.prod");
  if (!fs.existsSync(file)) {
    console.error(".env.prod not found.");
    process.exit(1);
  }
  const vars = require("dotenv").parse(fs.readFileSync(file));
  const replace = process.argv.includes("--replace");
  const cur = vercel(["env", "ls", "production"], env);
  if (cur.status !== 0) {
    console.error("Could not read the production project's variables. Log in first: npx vercel login");
    process.exit(1);
  }
  const have = new Set((cur.stdout || "").split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  let added = 0;
  for (const [k, val] of Object.entries(vars)) {
    if (!String(val).trim()) {
      console.log(`skip ${k} (empty in .env.prod)`);
      continue;
    }
    if (have.has(k)) {
      if (!replace) {
        console.log(`keep ${k} (already on Vercel; use --replace to overwrite)`);
        continue;
      }
      spawnSync("npx", ["vercel", "env", "rm", k, "production", "-y"], { cwd: root, stdio: "ignore", env: { ...process.env, ...env } });
    }
    const r = spawnSync("npx", ["vercel", "env", "add", k, "production"], { cwd: root, input: val, stdio: ["pipe", "ignore", "inherit"], env: { ...process.env, ...env }, encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`failed: ${k}`);
      process.exit(1);
    }
    console.log(`set  ${k}`);
    added++;
  }
  console.log(`Done: ${added} set. Deploy again (npm run deploy:prod) so the server uses them.`);
  process.exit(0);
}

// the production project must have these set on Vercel itself
const NEEDED = ["BIZHUB_ENV", "MONGO_USER", "MONGO_PASS", "MONGO_DB", "JWT_SECRET", "API_AUTH_KEY", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_FOLDER", "WEB_URL", "FIREBASE_PROJECT_ID"];
const ls = vercel(["env", "ls", "production"], env);
if (ls.status !== 0) {
  console.error("Could not read the production project's variables (vercel env ls). Are you logged in? (npx vercel login)");
  process.exit(1);
}
const have = new Set((ls.stdout || "").split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
const missing = NEEDED.filter((k) => !have.has(k));
if (missing.length) {
  console.error(`\nThe production project on Vercel is missing: ${missing.join(", ")}\nAdd them in Vercel → project → Settings → Environment Variables (Production), then run again.\nNothing was deployed.\n`);
  process.exit(1);
}
console.log("Production variables OK. Deploying to the PRODUCTION project…");
const r = spawnSync("npx", ["vercel", "--prod"], { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
process.exit(r.status ?? 1);
