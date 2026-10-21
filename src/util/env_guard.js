// Production safety check. On the production server set BIZHUB_ENV=prod (Vercel → project → Settings →
// Environment Variables). Then the server refuses to start unless it really points at the production
// database and NOT at the UAT Cloudinary storage — so production can never write into the UAT data by
// mistake (for example when a variable is missing on Vercel and the uploaded local .env has the UAT values).
//   database:   MONGO_DB must be "prod" (or MONGO_URI must end in /prod)
//   Cloudinary: production uses its own account (or at least its own folder) — the UAT account + UAT folder is refused
const PROD_DB = "prod";
const UAT_CLOUDINARY = { cloud: "dc6sunwvg", folder: "biz_hub" };

function checkEnv() {
  if (String(process.env.BIZHUB_ENV || "").toLowerCase() !== "prod") return;
  const bad = [];
  const uri = String(process.env.MONGO_URI || "");
  if (uri ? !/\/prod(\?|$)/.test(uri) : String(process.env.MONGO_DB || "") !== PROD_DB) bad.push(`the database must be "${PROD_DB}" (MONGO_DB is "${process.env.MONGO_DB || ""}")`);
  const cloud = String(process.env.CLOUDINARY_CLOUD_NAME || "");
  const folder = String(process.env.CLOUDINARY_FOLDER || "bizhub");
  if (!cloud) bad.push("CLOUDINARY_CLOUD_NAME is empty");
  else if (cloud === UAT_CLOUDINARY.cloud && folder === UAT_CLOUDINARY.folder) bad.push(`Cloudinary is the UAT account + folder (${cloud}/${folder})`);
  if (bad.length) {
    const msg = `[env] BIZHUB_ENV=prod but ${bad.join("; ")}. Refusing to start.`;
    console.error(msg);
    throw new Error(msg);
  }
}

module.exports = { checkEnv };
