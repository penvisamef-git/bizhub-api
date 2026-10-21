// Cloudinary connection + helpers
// Needs in .env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// Optional:      CLOUDINARY_FOLDER (default "bizhub")
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const BASE_FOLDER = process.env.CLOUDINARY_FOLDER || "bizhub";

// multer (busboy) reads names as latin1 → fix to UTF-8 only when that gives a valid result
function fixFileName(name = "") {
  const utf8 = Buffer.from(name, "latin1").toString("utf8");
  return utf8.includes("�") ? name : utf8;
}

// ---------------- Errors ----------------
// Turn any Cloudinary / network failure into { status, message (Khmer), detail } and log the real cause.
const NETWORK_CODES = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"];

function cloudinaryError(err) {
  const e = err?.error || err || {};
  const httpCode = e.http_code || e.status;
  const detail = e.body || e.message || String(err);

  let message = "មិនអាចបញ្ចូលរូបភាពទៅ Cloudinary បានទេ!";
  if (NETWORK_CODES.includes(e.code) || /timeout/i.test(e.message || "")) {
    message = "មិនអាចភ្ជាប់ទៅ Cloudinary បានទេ (សូមពិនិត្យអ៊ីនធឺណិត)!";
  } else if (httpCode === 401) {
    message = "Cloudinary មិនទទួលស្គាល់ API Key / Secret ឬ Cloud name!";
  } else if (httpCode === 403) {
    message = "Cloudinary បដិសេធការបញ្ចូលរូបភាព (គណនី ឬ API Key មិនមានសិទ្ធិ)!";
  } else if (httpCode === 420 || httpCode === 429) {
    message = "Cloudinary អស់កូតា ឬស្នើច្រើនពេក សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
  }

  console.error(`[cloudinary] upload failed — status: ${httpCode || e.code || "-"} — ${detail}`);
  return { isCloudinary: true, status: httpCode === 401 || httpCode === 403 ? 502 : 503, message, detail, http_code: httpCode };
}

// The SDK drops the response body on a 403. Repeat the same signed upload with plain https
// so we can see (and log) Cloudinary's real reason. If it succeeds this time, use it.
function rawUpload(buffer, params, fileName) {
  const https = require("https");
  const crypto = require("crypto");
  const signed = { ...params, timestamp: Math.round(Date.now() / 1000) };
  const fields = {
    ...signed,
    api_key: process.env.CLOUDINARY_API_KEY,
    signature: cloudinary.utils.api_sign_request(signed, process.env.CLOUDINARY_API_SECRET),
  };
  const boundary = "----lb" + crypto.randomBytes(8).toString("hex");
  const head = Object.entries(fields)
    .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    .join("");
  const body = Buffer.concat([
    Buffer.from(head),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(fileName)}"\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.cloudinary.com",
        path: `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
        timeout: 60000,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            // not JSON (e.g. an HTML page from a firewall / proxy)
          }
          if (res.statusCode === 200 && json) return resolve(json);
          const reason = json?.error?.message || data.slice(0, 300).replace(/\s+/g, " ");
          reject({ http_code: res.statusCode, message: `HTTP ${res.statusCode}`, body: reason });
        });
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(body);
  });
}

// Upload one file buffer (from multer memoryStorage) → file info to save in DB
// resourceType: "image" (default) or "video" (Cloudinary keeps audio files under video)
function uploadBuffer(file, subFolder = "others", resourceType = "image") {
  const originalName = fixFileName(file.originalname);
  const dot = originalName.lastIndexOf(".");
  const ext = dot > 0 ? originalName.slice(dot + 1).toLowerCase() : null;
  const options = {
    folder: `${BASE_FOLDER}/${subFolder}`,
    use_filename: true,
    unique_filename: true,
    filename_override: originalName,
  };
  const toImage = (result) => ({
    url: result.secure_url,
    public_id: result.public_id,
    resource_type: result.resource_type,
    format: result.format || ext,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    original_name: originalName,
  });

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ ...options, resource_type: resourceType }, (err, result) => {
      if (!err) return resolve(toImage(result));

      // 403 → find out why (and use the result if the second try works)
      if ((err.http_code || err.error?.http_code) === 403 && resourceType === "image") {
        return rawUpload(file.buffer, options, originalName)
          .then((raw) => resolve(toImage(raw)))
          .catch((rawErr) => reject(cloudinaryError(rawErr)));
      }
      reject(cloudinaryError(err));
    });
    stream.end(file.buffer);
  });
}

// Delete a file by public_id
function deleteFile(public_id, resource_type = "image") {
  return cloudinary.uploader.destroy(public_id, { resource_type });
}

// Signature for uploading straight from the browser (skips the API size limit)
function signUpload(subFolder = "others") {
  const timestamp = Math.round(Date.now() / 1000);
  const folder = `${BASE_FOLDER}/${subFolder}`;
  const signature = cloudinary.utils.api_sign_request(
    { timestamp, folder },
    process.env.CLOUDINARY_API_SECRET,
  );
  return {
    timestamp,
    folder,
    signature,
    api_key: process.env.CLOUDINARY_API_KEY,
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    upload_url: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
  };
}

// A PDF uploaded straight from the browser: pages, size, format (Cloudinary renders each page as a picture)
async function pdfInfo(public_id) {
  const r = await cloudinary.api.resource(public_id, { resource_type: "image", pages: true });
  return { public_id: r.public_id, url: r.secure_url, format: r.format, bytes: r.bytes, pages: r.pages || 1, width: r.width, height: r.height, folder: r.folder || r.asset_folder || "" };
}
// one page of a PDF as a picture (page starts at 1); "{page}" in the result is left for the reader to fill
function pdfPageUrl(public_id, page, width = 1400) {
  return cloudinary.url(public_id, { resource_type: "image", type: "upload", secure: true, format: "jpg", transformation: [{ page, width, crop: "limit", quality: "auto" }] });
}

async function ping() {
  return cloudinary.api.ping();
}

module.exports = { cloudinary, uploadBuffer, deleteFile, signUpload, ping, cloudinaryError, pdfInfo, pdfPageUrl };
