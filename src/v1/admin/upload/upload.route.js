const multer = require("multer");
const { uploadBuffer, deleteFile, signUpload, ping } = require("../../../util/cloudinary");
const { can_upload } = require("../../../util/permission");
const baseRoute = "upload";

// Keep files in memory, then stream them to Cloudinary
// (Vercel limits the request body to ~4.5MB → use /upload/signature for big files)
const MAX_FILE_MB = 4;
const MAX_FILES = 10;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) return cb(null, true);
    const err = new Error("អាចបញ្ចូលបានតែរូបភាព (jpg, png, webp, gif, svg)");
    err.code = "INVALID_TYPE";
    cb(err);
  },
});

// Allowed sub folders inside CLOUDINARY_FOLDER
const FOLDERS = ["homepage", "setting", "others"];

const route = (prop) => {
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_upload];

  // ===================================== TEST CONNECTION ================================================
  prop.app.get(`${urlAPI}/ping`, ...guard, async (req, res) => {
    try {
      const result = await ping();
      res.json({ success: true, message: "Cloudinary connected", data: result });
    } catch (err) {
      res.status(500).json({
        success: false,
        message: "Cloudinary not connected",
        error: err.message || err.error?.message,
      });
    }
  });

  // ===================================== UPLOAD (multiple images) ================================================
  // form-data: files = <file> (repeat for many), folder = homepage | setting | others
  // → returns image objects { url, public_id, ... }
  prop.app.post(
    `${urlAPI}`,
    ...guard,
    (req, res, next) => {
      upload.array("files", MAX_FILES)(req, res, (err) => {
        if (err) {
          const message =
            err.code === "LIMIT_FILE_SIZE"
              ? `ឯកសារធំពេក! (អតិបរមា ${MAX_FILE_MB}MB)`
              : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
                ? `អាចបញ្ចូលបានអតិបរមា ${MAX_FILES} ឯកសារ (field: files)`
                : err.message;
          return res.status(400).json({ success: false, message });
        }
        next();
      });
    },
    async (req, res) => {
      try {
        if (!req.files || req.files.length === 0) {
          return res.status(400).json({ success: false, message: "សូមជ្រើសរើសរូបភាព!" });
        }
        const folder = FOLDERS.includes(req.body.folder) ? req.body.folder : "others";
        const data = await Promise.all(req.files.map((f) => uploadBuffer(f, folder)));
        res.status(201).json({ success: true, count: data.length, data });
      } catch (err) {
        if (err?.isCloudinary) {
          return res.status(err.status).json({ success: false, message: err.message, error: err.detail });
        }
        res.status(500).json({
          success: false,
          message: serverError,
          error: err.message || err.error?.message,
        });
      }
    },
  );

  // ===================================== SIGNATURE (direct upload from browser) ================================================
  prop.app.get(`${urlAPI}/signature`, ...guard, (req, res) => {
    const folder = FOLDERS.includes(req.query.folder) ? req.query.folder : "others";
    res.json({ success: true, data: signUpload(folder) });
  });

  // ===================================== DELETE FILE ================================================
  // body: { public_id }
  prop.app.delete(`${urlAPI}`, ...guard, async (req, res) => {
    try {
      const { public_id } = req.body || {};
      if (!public_id) {
        return res.status(400).json({ success: false, message: "សូមបញ្ចូល public_id" });
      }
      const baseFolder = process.env.CLOUDINARY_FOLDER || "bizhub";
      if (!String(public_id).startsWith(`${baseFolder}/`)) {
        return res.status(400).json({ success: false, message: "public_id មិនត្រឹមត្រូវ" });
      }
      const result = await deleteFile(public_id, "image");
      res.json({ success: result.result === "ok", data: result });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
