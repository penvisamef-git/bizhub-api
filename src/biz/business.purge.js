// Delete a business for good: every file it put on Cloudinary + every record in the database.
// Nothing of a deleted business stays in our Cloudinary or in MongoDB, except the coin history
// (CoinTransaction: money records are never deleted) and the activity log.
//
// How: every model that has a business_id (all business types: restaurant, guest house, attendance,
// mini mart, name card, licenses…) is read once; each file found in it — { public_id } objects,
// *_public_id fields, or a Cloudinary address — is deleted from Cloudinary, then the records are deleted.
const mongoose = require("mongoose");
const { deleteFile } = require("../util/cloudinary");

const KEEP = new Set(["CoinTransaction", "ActivityLog"]); // history stays
const CLOUD_RE = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/(image|video|raw)\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(.+)$/;

// every file in one record → Map(public_id → resource_type)
function collect(value, out, key = "") {
  if (!value) return;
  if (typeof value === "string") {
    if (/public_id$/i.test(key) && value.trim()) {
      if (!out.has(value)) out.set(value, "image");
      return;
    }
    const m = value.match(CLOUD_RE);
    const own = process.env.CLOUDINARY_CLOUD_NAME;
    if (m && (!own || m[1] === own)) {
      // images / videos: the extension is not part of the id; raw files keep it
      const id = decodeURIComponent(m[2] === "raw" ? m[3] : m[3].replace(/\.[a-z0-9]+$/i, ""));
      if (!out.has(id)) out.set(id, m[2]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out, key);
    return;
  }
  if (typeof value === "object") {
    if (value instanceof Date || value instanceof mongoose.Types.ObjectId || Buffer.isBuffer(value)) return;
    if (typeof value.public_id === "string" && value.public_id) out.set(value.public_id, value.resource_type || (/\/raw\//.test(value.url || "") ? "raw" : /\/video\//.test(value.url || "") ? "video" : "image"));
    // { url, public_id: "" } = a picture another business owns (copied between branches): its address is not ours to delete
    const pic = typeof value.public_id === "string";
    for (const [k, v] of Object.entries(value)) if (k !== "public_id" && !(pic && k === "url")) collect(v, out, k);
  }
}

// the models that belong to businesses (loaded by the time anyone deletes anything)
function businessModels() {
  return Object.values(mongoose.models).filter((M) => !KEEP.has(M.modelName) && M.schema.path("business_id"));
}

async function purgeBusiness(businessId) {
  const bid = new mongoose.Types.ObjectId(String(businessId));
  const files = new Map();
  const counts = {};
  const Business = mongoose.model("Business");
  const biz = await Business.findById(bid).lean();
  if (biz) collect(biz, files);
  // records with business_id
  const models = businessModels();
  for (const M of models) {
    const cursor = M.find({ business_id: bid }).lean().cursor();
    let n = 0;
    for await (const doc of cursor) {
      collect(doc, files);
      n += 1;
    }
    if (n) counts[M.modelName] = n;
  }
  // records that point at the business another way (stock moved between branches)
  const other = [];
  if (mongoose.models.MartTransfer) other.push([mongoose.models.MartTransfer, { $or: [{ from_id: bid }, { to_id: bid }, { group_id: bid }] }]);
  if (mongoose.models.MartSettings) await mongoose.models.MartSettings.updateMany({ branches: bid }, { $pull: { branches: bid } }); // no longer a branch of another shop
  if (mongoose.models.BizGroup) await mongoose.models.BizGroup.updateMany({ branches: bid }, { $pull: { branches: bid } }); // restaurants / guest houses: the same
  // 1) the files
  let deleted = 0;
  const failed = [];
  const list = [...files.entries()];
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(
      list.slice(i, i + 8).map(([id, type]) =>
        deleteFile(id, type)
          .then(() => (deleted += 1))
          .catch((err) => failed.push({ id, error: err?.message || String(err) })),
      ),
    );
  }
  if (failed.length) console.error(`[purge] ${failed.length} file(s) not deleted from Cloudinary for business ${bid}`, failed.slice(0, 5));
  // 2) the records
  for (const M of models) await M.deleteMany({ business_id: bid });
  for (const [M, q] of other) await M.deleteMany(q);
  await Business.deleteOne({ _id: bid });
  return { files: files.size, deleted, failed: failed.length, records: counts };
}

module.exports = { purgeBusiness, collect };
