const multer = require("multer");

// One image in a form-data request (e.g. an image field on create / update)
// Field name: "image".  JSON requests pass through untouched.
const MAX_FILE_MB = 4;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) return cb(null, true);
    const err = new Error("អាចបញ្ចូលបានតែរូបភាព (jpg, png, webp, gif, svg)");
    err.code = "INVALID_TYPE";
    cb(err);
  },
});

// form-data sends everything as text → convert back to real values
function parseFormValue(value) {
  if (typeof value !== "string") return value;
  const v = value.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if ((v.startsWith("[") && v.endsWith("]")) || (v.startsWith("{") && v.endsWith("}"))) {
    try {
      return JSON.parse(v);
    } catch {
      return value;
    }
  }
  return value;
}

function image_upload(field = "image") {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err) {
        const message =
          err.code === "LIMIT_FILE_SIZE"
            ? `រូបភាពធំពេក! (អតិបរមា ${MAX_FILE_MB}MB)`
            : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
              ? `អាចបញ្ចូលបានតែរូបភាព 1 (field: ${field})`
              : err.message;
        return res.status(400).json({ success: false, message });
      }

      // Only form-data needs converting (JSON is already typed)
      if (req.is("multipart/form-data") && req.body) {
        for (const key of Object.keys(req.body)) req.body[key] = parseFormValue(req.body[key]);
      }
      next();
    });
  };
}

module.exports = { image_upload };
