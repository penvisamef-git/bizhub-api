// Digital Note: what the owner routes (note.route.js) and the public routes (note.public.js) share.
const mongoose = require("mongoose");
const crypto = require("crypto");
const M = require("./note.models");
const License = require("../../license/license.model");
const { statusOf, LicenseError, DAY } = require("../../license/license.service");
const cloud = require("../../util/cloudinary");

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const LIMITS = { storage: 5 * GB, storage_pack: 5 * GB, file: 20 * MB, packs: 200 }; // 5 GB in the plan, +5 GB per note_storage pack
const GRACE_DAYS = 7;
const VOICE_MAX = 15 * MB; // one voice note (5 minutes of opus / aac is far less)
const TZ = 7; // Asia/Phnom_Penh, no daylight saving
// "YYYY-MM-DD" and "HH:mm" in Cambodia time
const localDay = (d = new Date()) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 10);
const localHm = (d = new Date()) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(11, 16);
// a due value ("YYYY-MM-DD" / "YYYY-MM-DDTHH:mm", Cambodia time) → the moment it is due (a date alone = the end of that day)
// a real calendar day ("2026-02-31" is not one — JavaScript would roll it over to March)
const realDay = (day) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day;
};
const dueAt = (due) => {
  if (!due) return null;
  const [day, hm] = String(due).split("T");
  if (!realDay(day)) return null;
  if (hm !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hm)) return null;
  const t = Date.parse(`${day}T${hm || "23:59"}:00Z`);
  return Number.isNaN(t) ? null : new Date(t - TZ * 3600000);
};
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10); // after the year ends the owner can still write for 7 days, then the book is read-only

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  notNote: "អាជីវកម្មនេះមិនមែនជាកំណត់ត្រាឌីជីថលទេ!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  locked: "កំណត់ត្រាឌីជីថលផុតកំណត់ហើយ! សូមបន្តដើម្បីកែប្រែ ឬបង្កើតថ្មី។",
  noteNotFound: "រកមិនឃើញកំណត់ត្រា!",
  rowNotFound: "រកមិនឃើញទិន្នន័យ!",
  saved: "បានរក្សាទុក!",
  deleted: "បានលុប!",
  restored: "បានស្ដារ!",
  badValue: "តម្លៃមិនត្រឹមត្រូវ!",
  badPin: "លេខ PIN ត្រូវមាន 4 ដល់ 8 ខ្ទង់!",
  conflict: "មានអ្នកផ្សេងបានកែកំណត់ត្រានេះ។ សូមផ្ទុកឡើងវិញ។",
  fileTooBig: "ឯកសារធំពេក! (អតិបរមា 20MB)",
  storageFull: "ទំហំផ្ទុកពេញហើយ! សូមទិញទំហំផ្ទុកបន្ថែម។",
  noFile: "សូមជ្រើសរើសឯកសារ!",
  badFile: "ឯកសារមិនត្រឹមត្រូវ!",
  tooManyFiles: "ឯកសារច្រើនពេក! (អតិបរមា 5 ក្នុងមួយការផ្ញើ)",
  tooLarge: "ទិន្នន័យធំពេកមិនអាចផ្ញើបាន!",
  linkOff: "តំណនេះមិនដំណើរការទេ។",
  needPin: "សូមបញ្ចូលលេខ PIN។",
  wrongPin: "លេខ PIN មិនត្រឹមត្រូវ!",
  tooManyPin: "ព្យាយាមច្រើនដងពេក សូមរង់ចាំបន្តិច។",
  notAllowed: "កំណត់ត្រានេះមិនអនុញ្ញាតឱ្យធ្វើដូច្នេះទេ។",
  needName: "សូមបញ្ចូលឈ្មោះ!",
  needText: "សូមសរសេរអ្វីមួយ ឬភ្ជាប់ឯកសារ!",
  noFiles: "កំណត់ត្រានេះមិនអនុញ្ញាតឱ្យភ្ជាប់ឯកសារទេ។",
  notYours: "នេះមិនមែនជារបស់អ្នកទេ!",
  slow: "សូមព្យាយាមម្តងទៀតក្រោយមួយភ្លែត!",
  needSign: "សូមដោះសោ “ហត្ថលេខា និងប៊ិច” ជាមុនសិន!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់!",
  groupNotFound: "រកមិនឃើញក្រុម!",
  groupBusy: "កំពុងបង្កើតក្រុមនេះ សូមរង់ចាំបន្តិច!",
  needGroupName: "សូមដាក់ឈ្មោះក្រុម!",
  tooLateRestore: "ក្រុមនេះត្រូវបានលុបលើសពី 30 ថ្ងៃ មិនអាចស្ដារបានទេ។",
  tooManyPacks: "ទំហំផ្ទុកបន្ថែមច្រើនពេក!",
  packsBusy: "កំពុងទិញទំហំផ្ទុកនេះ សូមរង់ចាំបន្តិច!",
  badSign: "ហត្ថលេខាត្រូវតែជារូបភាព PNG (តិចជាង 2MB)!",
  needStyle: "សូមដោះសោ “កញ្ចប់រចនា” ជាមុនសិន!",
  needGroupIcon: "សូមដោះសោ “រូបភាពរបស់ក្រុម” សម្រាប់ក្រុមនេះជាមុនសិន!",
  needMedia: "សូមដោះសោ “អ្នកគ្រប់គ្រងឯកសារ” ជាមុនសិន!",
  badImage: "សូមដាក់រូបភាព JPG / PNG / WEBP (តិចជាង 2MB)!",
  already: "បានដោះសោរួចហើយ!",
  tooManyItems: "ច្រើនពេក! (អតិបរមា 100 ក្នុងមួយដង)",
  needTheme: "សូមដោះសោរចនាប័ទ្មនេះជាមុនសិន!",
  badTheme: "រចនាប័ទ្មមិនត្រឹមត្រូវ!",
  needLink: "សូមដោះសោ “តំណផ្ទាល់ខ្លួន” ជាមុនសិន!",
  slugTaken: "តំណនេះមានគេប្រើរួចហើយ! សូមជ្រើសរើសឈ្មោះផ្សេង។",
  slugReserved: "ឈ្មោះនេះមិនអាចប្រើបានទេ!",
  slugShort: "តំណត្រូវមាន 3 ដល់ 40 តួអក្សរ!",
  slugBad: "តំណអាចមានតែអក្សរ a-z លេខ 0-9 និងសញ្ញា “-” ប៉ុណ្ណោះ!",
  // v4 (NOTE_V4.md)
  needTelegram: "សូមដោះសោ “ការជូនដំណឹងតាម Telegram” ជាមុនសិន!",
  needAck: "សូមដោះសោ “ខ្ញុំបានអានហើយ” ជាមុនសិន!",
  needForm: "សូមដោះសោ “បញ្ជីចុះឈ្មោះមានប្រអប់ផ្ទាល់ខ្លួន” ជាមុនសិន!",
  needVoice: "សូមដោះសោ “សារជាសំឡេង” ជាមុនសិន!",
  needPdf: "សូមដោះសោ “នាំចេញជា PDF” ជាមុនសិន!",
  needExcel: "សូមដោះសោ “បញ្ជីចុះឈ្មោះមានប្រអប់ផ្ទាល់ខ្លួន” ដើម្បីនាំចេញជា Excel!",
  badField: "ប្រអប់មិនត្រឹមត្រូវ!",
  fieldRequired: "សូមបំពេញ “{label}”!",
  fieldBad: "“{label}” មិនត្រឹមត្រូវ!",
  noAck: "កំណត់ត្រានេះមិនសួររកការបញ្ជាក់ទេ។",
  notOpen: "កំណត់ត្រានេះមិនទាន់បើកនៅឡើយទេ។",
  badVoice: "សំឡេងត្រូវតែជាឯកសារសំឡេង (តិចជាង 15MB)!",
  tooManyTemplates: "គំរូច្រើនពេក! (អតិបរមា 50)",
  templateNotFound: "រកមិនឃើញគំរូ!",
  needTemplateName: "សូមដាក់ឈ្មោះគំរូ!",
  tgNotConfigured: "ក្រុមការងារ BizHub មិនទាន់រៀបចំ Telegram bot ទេ។",
  tgNotConnected: "មិនទាន់ភ្ជាប់ Telegram ទេ!",
  tgBlocked: "Telegram នេះបានបិទ bot ហើយ។ សូមភ្ជាប់ម្តងទៀត។",
  tgUnreachable: "មិនអាចទាក់ទង Telegram បានទេ សូមព្យាយាមម្តងទៀត។",
  tgSent: "បានផ្ញើសារសាកល្បង!",
};

class Bad extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const handle = (tag) => (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
    if (err instanceof LicenseError) return res.status(err.status).json({ success: false, message: MSG[err.message] || err.message, code: err.message, ...err.extra });
    if (err?.name === "ValidationError" || err?.name === "CastError") return res.status(400).json({ success: false, message: MSG.badValue });
    if (err?.isCloudinary) return res.status(err.status).json({ success: false, message: err.message });
    console.error(`[${tag}]`, err);
    res.status(500).json({ success: false, message: MSG.server });
  }
};

const validId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && String(v).length === 24;
const str = (v, max) =>
  String(v ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);
const bool = (v, d) => (v === undefined ? d : v === true || v === "true" || v === 1 || v === "1");
const dateIn = (v) => {
  if (v === null || v === "" || v === undefined) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2100 ? undefined : d;
};
const newToken = () => crypto.randomBytes(18).toString("base64url").replace(/[-_]/g, "").slice(0, 22).padEnd(22, "x");
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const guestKeyOf = (req) => {
  const k = String(req.headers["x-note-guest"] || "").trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(k) ? k : "";
};

// ---------- license: the book is yearly (5 GB); each note_storage pack adds 5 GB (its own yearly slot, item = "slot-N");
// note_sign (signature / pen) and note_group (one per group, item = group id) are forever
const slotNo = (item) => Number(String(item).split("-")[1]) || 0;
async function licenseState(businessId) {
  const rows = await License.find({ business_id: businessId, product: { $in: ["digital_note", "note_storage", "note_sign", "note_group", "note_style", "note_media", "note_group_icon", "note_theme", "note_link", "note_telegram", "note_ack", "note_form", "note_voice", "note_pdf"] } }).lean();
  const main = rows.find((r) => r.product === "digital_note" && !r.item);
  const license = statusOf(main);
  const endedAt = license.expires_at ? new Date(license.expires_at).getTime() : null;
  license.grace_until = endedAt ? new Date(endedAt + GRACE_DAYS * DAY) : null;
  license.locked = !!main && !license.active && endedAt !== null && Date.now() > endedAt + GRACE_DAYS * DAY;
  license.in_grace = !!main && !license.active && !license.locked;
  license.read_only = license.locked;
  const storageSlots = rows
    .filter((r) => r.product === "note_storage" && r.item)
    .map((r) => ({ item: r.item, ...statusOf(r) }))
    .sort((a, b) => slotNo(a.item) - slotNo(b.item));
  const packs = storageSlots.filter((x) => x.active).length;
  const addons = {
    note_sign: statusOf(rows.find((r) => r.product === "note_sign" && !r.item)),
    note_storage: { packs, slots: storageSlots.length, active: packs > 0, gb_each: LIMITS.storage_pack / GB },
    note_group: { owned: rows.filter((r) => r.product === "note_group" && r.item).length },
    note_style: statusOf(rows.find((r) => r.product === "note_style" && !r.item)),
    note_media: statusOf(rows.find((r) => r.product === "note_media" && !r.item)),
    note_link: statusOf(rows.find((r) => r.product === "note_link" && !r.item)),
    // v4: Telegram alerts (yearly) · "I've read it" · sign-up fields + Excel · voice notes · PDF export (forever)
    note_telegram: statusOf(rows.find((r) => r.product === "note_telegram" && !r.item)),
    note_ack: statusOf(rows.find((r) => r.product === "note_ack" && !r.item)),
    note_form: statusOf(rows.find((r) => r.product === "note_form" && !r.item)),
    note_voice: statusOf(rows.find((r) => r.product === "note_voice" && !r.item)),
    note_pdf: statusOf(rows.find((r) => r.product === "note_pdf" && !r.item)),
    // group ids whose picture icon is unlocked
    note_group_icon: { items: rows.filter((r) => r.product === "note_group_icon" && r.item).map((r) => r.item) },
    // public page themes owned (item = theme key)
    note_theme: { items: rows.filter((r) => r.product === "note_theme" && r.item).map((r) => r.item) },
  };
  const limits = { storage_limit: LIMITS.storage + packs * LIMITS.storage_pack, file_limit: LIMITS.file, storage_included: LIMITS.storage, storage_pack: LIMITS.storage_pack };
  return { license, addons, storage_slots: storageSlots, limits, sign: addons.note_sign.active, style: addons.note_style.active, media: addons.note_media.active, link: addons.note_link.active, themes: addons.note_theme.items, telegram: addons.note_telegram.active, ack: addons.note_ack.active, form: addons.note_form.active, voice: addons.note_voice.active, pdf: addons.note_pdf.active };
}

async function bookOf(businessId) {
  const found = await M.NoteBook.findOne({ business_id: businessId });
  if (found) return found;
  try {
    return await M.NoteBook.create({ business_id: businessId });
  } catch (err) {
    if (err.code === 11000) return M.NoteBook.findOne({ business_id: businessId });
    throw err;
  }
}

// take `size` bytes of the book's space (fails when the space is full)
async function reserve(businessId, size, limit) {
  if (size <= 0) return true;
  await bookOf(businessId);
  const r = await M.NoteBook.updateOne({ business_id: businessId, storage_used: { $lte: limit - size } }, { $inc: { storage_used: size } });
  return r.modifiedCount === 1;
}
async function release(businessId, size) {
  if (!(size > 0)) return;
  await M.NoteBook.updateOne({ business_id: businessId }, { $inc: { storage_used: -size } });
  await M.NoteBook.updateOne({ business_id: businessId, storage_used: { $lt: 0 } }, { $set: { storage_used: 0 } });
}
// delete files from Cloudinary (in the background) and give their space back
async function dropFiles(businessId, files) {
  const list = (files || []).filter((f) => f?.public_id);
  for (const f of list) cloud.deleteFile(f.public_id, f.resource_type || "image").catch(() => {});
  await release(
    businessId,
    list.reduce((a, f) => a + (f.size || 0), 0),
  );
}

// "seen by" upserts: two first visits at the same moment can both try to insert → the loser retries as an update
async function seenUpsert(filter, update, opts = {}) {
  const run = () => (opts.returnDoc ? M.NoteSeen.findOneAndUpdate(filter, update, { upsert: true, returnDocument: "after" }) : M.NoteSeen.updateOne(filter, update, { upsert: true }));
  try {
    return await run();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return run();
  }
}

// wrong PINs per link: 10 tries per 15 minutes (stored in MongoDB, so it holds across servers and restarts)
const PIN_TRIES = 10;
const PIN_WINDOW = 15 * 60 * 1000;
async function pinBlocked(token) {
  const f = await M.NotePinFail.findOne({ token }).lean();
  return !!f && f.n >= PIN_TRIES && new Date(f.reset).getTime() > Date.now();
}
async function pinFailed(token) {
  const now = new Date();
  const r = await M.NotePinFail.updateOne({ token, reset: { $gt: now } }, { $inc: { n: 1 } });
  if (r.matchedCount) return;
  try {
    await M.NotePinFail.updateOne({ token }, { $set: { n: 1, reset: new Date(now.getTime() + PIN_WINDOW) } }, { upsert: true });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    await M.NotePinFail.updateOne({ token }, { $inc: { n: 1 } });
  }
}

// image | pdf | doc | other, from the mime type / extension
// a voice clip (voice: true) is audio even when its container type says video (webm / mp4 / m4a)
const voiceMime = (mime) => {
  const m = String(mime || "").toLowerCase();
  return m.startsWith("video/") ? `audio/${m.slice(6)}` : m || "audio/webm";
};
function kindOf(mime = "", name = "") {
  const m = String(mime).toLowerCase();
  const ext = String(name).toLowerCase().split(".").pop();
  if (m.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "avif"].includes(ext)) return "image";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m.startsWith("audio/") || ["mp3", "m4a", "wav", "ogg", "aac", "flac", "opus", "weba"].includes(ext)) return "audio";
  if (/word|excel|spreadsheet|presentation|powerpoint|text\/|opendocument|rtf|csv/.test(m) || ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "odt", "ods", "rtf"].includes(ext)) return "doc";
  return "other";
}
const MIME_OF = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", txt: "text/plain", csv: "text/csv", zip: "application/zip", mp4: "video/mp4", mp3: "audio/mpeg", webm: "video/webm", weba: "audio/webm", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", aac: "audio/aac" };
const mimeOf = (name = "") => MIME_OF[String(name).toLowerCase().split(".").pop()] || "";

const fileOut = (f) => ({ _id: f._id, url: f.url, name: f.name, size: f.size, mime: f.mime, kind: f.kind, by: f.by, sign: !!f.sign, voice: !!f.voice, at: f.at });

// blocks from the client → clean blocks (file / draw blocks must point at a file of the note)
// opts.sign: the business owns note_sign. Without it, NEW draw blocks are refused (403 need_sign); draw blocks the
// note already had (opts.old) are kept, so a note that has signatures can still be saved.
// A draw block must point at a signature file (file.sign).
// opts.style: the business owns note_style (the style pack). Without it, NEW callout / divider / sticker blocks and
// NEW or changed block styles are refused (403 need_style); styled blocks the note already had (same id, same type,
// same look) are kept, and their text can still change.
function cleanStyle(v) {
  if (!v || typeof v !== "object") return undefined;
  const o = {};
  if (M.STYLE_COLORS.includes(v.color)) o.color = v.color;
  if (M.STYLE_COLORS.includes(v.bg)) o.bg = v.bg;
  if (M.STYLE_SIZES.includes(v.size) && v.size !== "md") o.size = v.size;
  if (M.STYLE_ALIGNS.includes(v.align) && v.align !== "left") o.align = v.align;
  if (v.bold === true) o.bold = true;
  if (v.italic === true) o.italic = true;
  return Object.keys(o).length ? o : undefined;
}
const looksKey = (b) => JSON.stringify([b.t, b.style ? cleanStyle(b.style) || null : null, b.icon || null, b.sticker || null]);
const isStyled = (b) => M.STYLE_BLOCKS.includes(b.t) || !!b.style;
function cleanBlocks(input, files = [], opts = {}) {
  if (!Array.isArray(input)) throw new Bad(MSG.badValue, 400, { code: "bad_blocks" });
  const fileIds = new Set(files.map((f) => String(f._id)));
  const signIds = new Set(files.filter((f) => f.sign).map((f) => String(f._id)));
  const oldDraw = new Set((opts.old || []).filter((b) => b.t === "draw").map((b) => String(b.file_id)));
  const oldAudio = new Set((opts.old || []).filter((b) => b.t === "audio").map((b) => String(b.file_id)));
  const audioIds = new Set(files.filter((f) => f.voice || fineKind(f) === "audio").map((f) => String(f._id)));
  const oldLook = new Map((opts.old || []).filter(isStyled).map((b) => [String(b.id), looksKey(b.toObject ? b.toObject() : b)]));
  const seen = new Set();
  const out = [];
  for (const b of input.slice(0, M.LIMITS.blocks)) {
    if (!b || typeof b !== "object") continue;
    const t = M.BLOCK_TYPES.includes(b.t) ? b.t : "p";
    let id = str(b.id, 40) || Math.random().toString(36).slice(2, 10);
    if (seen.has(id)) id = `${id}${Math.random().toString(36).slice(2, 5)}`;
    seen.add(id);
    const hasFile = t === "file" || t === "draw" || t === "audio";
    const fileId = hasFile ? str(b.file_id, 40) : "";
    if (hasFile && !fileIds.has(fileId)) continue;
    if (t === "draw" && !signIds.has(fileId)) continue;
    if (t === "draw" && opts.sign === false && !oldDraw.has(fileId)) throw new Bad(MSG.needSign, 403, { code: "need_sign", product: "note_sign" });
    // a voice note: points at an audio file; a NEW one needs note_voice (ones the note already had stay)
    if (t === "audio" && !audioIds.has(fileId)) continue;
    if (t === "audio" && opts.voice === false && !oldAudio.has(fileId)) throw new Bad(MSG.needVoice, 403, { code: "need_voice", product: "note_voice" });
    const block = { id, t, text: t === "divider" || t === "sticker" ? "" : str(b.text, M.LIMITS.text), done: t === "check" ? !!b.done : false, file_id: fileId };
    const style = cleanStyle(b.style);
    if (style) block.style = t === "sticker" ? (style.size || style.align ? { ...(["sm", "lg"].includes(style.size) ? { size: style.size } : {}), ...(style.align ? { align: style.align } : {}) } : undefined) : style;
    if (block.style && !Object.keys(block.style).length) delete block.style;
    if (t === "callout") block.icon = str(b.icon, 16) || "💡";
    // checklist: when it is due + who does it (free)
    if (t === "check") {
      const due = String(b.due || "").trim();
      if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(due) && dueAt(due)) block.due = due;
      const who = str(b.who, M.LIMITS.who);
      if (who) block.who = who;
    }
    if (t === "sticker") {
      const key = String(b.sticker || "").trim();
      if (!/^[a-z0-9_-]{1,40}$/.test(key)) continue;
      block.sticker = key;
    }
    if (isStyled(block) && opts.style === false && oldLook.get(id) !== looksKey(block)) throw new Bad(MSG.needStyle, 403, { code: "need_style", product: "note_style" });
    out.push(block);
  }
  return out;
}
const cleanTags = (v) =>
  Array.isArray(v)
    ? [...new Set(v.map((x) => str(x, M.LIMITS.tag)).filter(Boolean))].slice(0, M.LIMITS.tags)
    : [];
const textOf = (title, blocks) => [title, ...(blocks || []).map((b) => b.text)].filter(Boolean).join(" ").slice(0, 20000);
const previewOf = (blocks) =>
  (blocks || [])
    .filter((b) => !["file", "draw", "divider", "sticker", "audio"].includes(b.t) && b.text)
    .map((b) => (b.t === "check" ? `${b.done ? "☑" : "☐"} ${b.text}` : b.text))
    .join(" · ")
    .slice(0, 140);

// a history row after a save; rapid saves by the same person (within 2 minutes) are merged into one row
async function saveRev(note, by, fresh = false) {
  const last = fresh ? null : await M.NoteRev.findOne({ note_id: note._id }).sort({ at: -1 });
  const snap = { version: note.version, title: note.title, blocks: note.blocks, by, at: new Date() };
  if (last && last.by === by && Date.now() - new Date(last.at).getTime() < 2 * 60 * 1000) {
    Object.assign(last, snap);
    await last.save();
  } else {
    await M.NoteRev.create({ business_id: note.business_id, note_id: note._id, ...snap });
    const old = await M.NoteRev.find({ note_id: note._id }).sort({ at: -1 }).skip(M.LIMITS.revs).select("_id").lean();
    if (old.length) await M.NoteRev.deleteMany({ _id: { $in: old.map((r) => r._id) } });
  }
}

// change title / blocks only if nobody saved in between (base_version = the version the editor started from)
// sign: whether the business owns note_sign (undefined = don't check, e.g. restoring an old version)
// style: whether the business owns note_style (the same rule as sign)
// voice: whether the business owns note_voice (the same rule, for audio blocks)
async function saveContent(note, { title, blocks, base_version }, by, freshRev = false, sign, style, voice) {
  const set = { updated_by: by };
  if (title !== undefined) set.title = str(title, M.LIMITS.title);
  if (blocks !== undefined) set.blocks = cleanBlocks(blocks, note.files, { sign, style, voice, old: note.blocks });
  const nextTitle = set.title ?? note.title;
  const nextBlocks = set.blocks ?? note.blocks;
  set.text = textOf(nextTitle, nextBlocks);
  const base = Number(base_version);
  const where = { _id: note._id, deleted: false, ...(Number.isInteger(base) ? { version: base } : {}) };
  const saved = await M.Note.findOneAndUpdate(where, { $set: set, $inc: { version: 1 } }, { returnDocument: "after" });
  if (!saved) {
    const current = await M.Note.findById(note._id);
    throw new Bad(MSG.conflict, 409, { code: "conflict", data: current ? noteOut(current) : null });
  }
  await saveRev(saved, by, freshRev);
  return saved;
}

const shareOut = (s = {}) => ({
  token: s.token,
  slug: s.slug || "",
  path: `/n/${s.slug || s.token}`,
  token_path: `/n/${s.token}`,
  level: s.level,
  has_pin: !!s.pin_hash,
  expires_at: s.expires_at || null,
  allow_files: s.allow_files !== false,
  show_entries: s.show_entries !== false,
  ask_name: s.ask_name !== false,
  hide_owner: !!s.hide_owner,
  no_copy: !!s.no_copy,
  ack: !!s.ack,
  opens_at: s.opens_at || null,
});
function noteOut(n) {
  const o = n.toObject ? n.toObject() : { ...n };
  return {
    _id: o._id,
    title: o.title,
    blocks: o.blocks || [],
    color: o.color,
    paper: o.paper || "plain",
    theme: themeOut(o.theme),
    pinned: !!o.pinned,
    tags: o.tags || [],
    files: (o.files || []).map(fileOut),
    share: shareOut(o.share),
    form: formOut(o.form),
    version: o.version,
    updated_by: o.updated_by,
    views: o.views || 0,
    entry_count: o.entry_count || 0,
    deleted: !!o.deleted,
    deleted_at: o.deleted_at,
    created_date: o.created_date,
    updated_date: o.updated_date,
  };
}
const rowOut = (o) => ({
  _id: o._id,
  title: o.title,
  preview: previewOf(o.blocks),
  color: o.color,
  paper: o.paper || "plain",
  pinned: !!o.pinned,
  tags: o.tags || [],
  share: { level: o.share?.level, has_pin: !!o.share?.pin_hash, expires_at: o.share?.expires_at || null, token: o.share?.token, slug: o.share?.slug || "", path: `/n/${o.share?.slug || o.share?.token}` },
  entry_count: o.entry_count || 0,
  views: o.views || 0,
  files_count: (o.files || []).length,
  deleted: !!o.deleted,
  updated_date: o.updated_date,
  updated_by: o.updated_by,
});

// a new note with a link nobody else has
async function createNote(data) {
  for (let i = 0; i < 5; i += 1) {
    try {
      return await M.Note.create({ ...data, share: { ...(data.share || {}), token: newToken() } });
    } catch (err) {
      if (err.code !== 11000 || !String(err.message).includes("token")) throw err;
    }
  }
  throw new Error("could not make a note link");
}

// ---------- groups ----------
const groupShareOut = (s = {}) => ({ token: s.token, slug: s.slug || "", path: `/n/g/${s.slug || s.token}`, token_path: `/n/g/${s.token}`, level: s.level, has_pin: !!s.pin_hash, expires_at: s.expires_at || null, ask_name: s.ask_name !== false, hide_owner: !!s.hide_owner, no_copy: !!s.no_copy, ack: !!s.ack, opens_at: s.opens_at || null });
function groupOut(g) {
  const o = g.toObject ? g.toObject() : { ...g };
  return { _id: o._id, name: o.name, color: o.color, icon: o.icon, icon_image: o.icon_image?.url || "", theme: themeOut(o.theme), sort: o.sort, note_ids: (o.note_ids || []).map(String), notes_count: (o.note_ids || []).length, share: groupShareOut(o.share), views: o.views || 0, deleted: !!o.deleted, deleted_at: o.deleted_at, created_date: o.created_date, updated_date: o.updated_date };
}
async function createGroup(data) {
  for (let i = 0; i < 5; i += 1) {
    try {
      return await M.NoteGroup.create({ ...data, share: { ...(data.share || {}), token: newToken() } });
    } catch (err) {
      if (err.code !== 11000 || !String(err.message).includes("token")) throw err;
    }
  }
  throw new Error("could not make a group link");
}

// ---------- public page themes (note_theme): keys from the web's list (noteThemes.json, copied here from
// bizhub/src/note/noteThemes.json); "default" is free
function themeKeys() {
  let list;
  try {
    list = require("./noteThemes.json");
  } catch {
    list = require("./noteThemes.fallback.json");
  }
  const rows = Array.isArray(list) ? list : list.themes || [];
  return [...new Set(rows.map((t) => String(t?.key || "")).filter((k) => /^[a-z0-9_-]{1,40}$/.test(k) && k !== "default"))];
}
const THEME_KEYS = themeKeys();
const themeOut = (t) => ({ key: t?.key || "default", color: t?.color || "" });
// { key, color } from the client → a clean theme. A paid key needs note_theme for that key, unless the note / group
// already had it (a theme saved before a license went away stays). The colour is always free.
function themeIn(v, current, owned) {
  if (!v || typeof v !== "object") throw new Bad(MSG.badTheme, 400, { code: "bad_theme" });
  const cur = themeOut(current);
  const key = v.key === undefined ? cur.key : String(v.key);
  if (key !== "default" && !THEME_KEYS.includes(key)) throw new Bad(MSG.badTheme, 400, { code: "bad_theme" });
  let color = v.color === undefined ? cur.color : String(v.color || "").trim();
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Bad(MSG.badTheme, 400, { code: "bad_theme" });
  color = color.toUpperCase();
  if (key !== "default" && key !== cur.key && !(owned || []).includes(key)) throw new Bad(MSG.needTheme, 403, { code: "need_theme", product: "note_theme", item: key });
  return { key, color };
}

// ---------- the fine file type (media filter), worked out from mime + name (no migration of the stored kind)
const FINE_KINDS = ["image", "video", "audio", "pdf", "word", "excel", "slides", "text", "zip", "sign", "other"];
function fineKind(f = {}) {
  if (f.sign) return "sign";
  const m = String(f.mime || "").toLowerCase();
  const ext = String(f.name || "").toLowerCase().includes(".") ? String(f.name).toLowerCase().split(".").pop() : "";
  if (m.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "avif", "svg", "bmp"].includes(ext)) return "image";
  if (m.startsWith("audio/") || f.voice) return "audio"; // a voice note in .webm is audio, not video
  if (m.startsWith("video/") || ["mp4", "mov", "webm", "mkv", "avi", "m4v", "3gp"].includes(ext)) return "video";
  if (m.startsWith("audio/") || ["mp3", "m4a", "wav", "ogg", "aac", "flac", "opus"].includes(ext)) return "audio";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (["doc", "docx", "odt", "rtf"].includes(ext) || /msword|wordprocessingml|opendocument\.text|rtf/.test(m)) return "word";
  if (["xls", "xlsx", "ods", "csv"].includes(ext) || /excel|spreadsheetml|opendocument\.spreadsheet|text\/csv/.test(m)) return "excel";
  if (["ppt", "pptx", "odp"].includes(ext) || /powerpoint|presentationml|opendocument\.presentation/.test(m)) return "slides";
  if (["txt", "md"].includes(ext) || m === "text/plain" || m === "text/markdown") return "text";
  if (["zip", "rar", "7z"].includes(ext) || /zip|rar|7z/.test(m)) return "zip";
  return "other";
}

// ---------- the files in a set of notes (a group's "Files" view): the notes' own files, not replies' files.
// skipLocked: leave out notes with their own PIN (a public group link without a group PIN).
// → rows { _id, where: "note", note_id, note_title, name, kind, size, mime, url, at, by, sign } in the notes' order
async function notesFiles(bid, noteIds, { skipLocked = false } = {}) {
  const ids = [...new Set((noteIds || []).map(String).filter(validId))];
  if (!ids.length) return [];
  const notes = await M.Note.find({ _id: { $in: ids }, business_id: bid, deleted: false, "files.0": { $exists: true } }).select("title files share.pin_hash").lean();
  const byId = new Map(notes.map((n) => [String(n._id), n]));
  const rows = [];
  for (const id of ids) {
    const n = byId.get(id);
    if (!n || (skipLocked && n.share?.pin_hash)) continue;
    for (const f of n.files || []) rows.push({ _id: String(f._id), where: "note", note_id: id, note_title: n.title || "", name: f.name, kind: fineKind(f), size: f.size || 0, mime: f.mime, url: f.url, at: f.at, by: f.by, sign: !!f.sign });
  }
  return rows;
}
// counts + bytes per fine kind for a list of rows (rows carry .kind already)
function filesTotals(rows) {
  const kinds = Object.fromEntries(FINE_KINDS.map((k) => [k, { count: 0, bytes: 0 }]));
  for (const r of rows) {
    const k = kinds[r.kind] || kinds.other;
    k.count += 1;
    k.bytes += r.size || 0;
  }
  return { count: rows.length, bytes: rows.reduce((a, r) => a + (r.size || 0), 0), kinds };
}
// search / type / sort / page over such rows (the group Files views)
function filesPage(rows, query = {}, perPage = 60) {
  const kind = FINE_KINDS.includes(query.kind) ? query.kind : "all";
  const q = String(query.q || "").trim().slice(0, 80).toLowerCase();
  let list = rows.filter((r) => (kind === "all" || r.kind === kind) && (!q || `${r.name} ${r.note_title}`.toLowerCase().includes(q)));
  const sort = ["size", "name"].includes(query.sort) ? query.sort : "date";
  list.sort(sort === "size" ? (a, b) => (b.size || 0) - (a.size || 0) : sort === "name" ? (a, b) => String(a.name).localeCompare(String(b.name)) : (a, b) => new Date(b.at) - new Date(a.at));
  const page = Math.max(1, Math.min(1000, Number(query.page) || 1));
  const total = list.length;
  return { data: list.slice((page - 1) * perPage, page * perPage), page, pages: Math.max(1, Math.ceil(total / perPage)), total };
}

// a short-lived signed download link for a stored file. The Cloudinary account refuses plain delivery of PDF / ZIP
// files (401 "deny or ACL failure"); the API download link works for every type. inline = open in the browser.
function downloadUrl(f, inline = false) {
  const type = f.resource_type || "image";
  const fromUrl = String(f.url || "").split("?")[0].split("/").pop() || "";
  const ext = fromUrl.includes(".") ? fromUrl.split(".").pop() : String(f.name || "").split(".").pop();
  const format = type === "raw" ? "" : String(ext || "").toLowerCase();
  const expires = Math.floor(Date.now() / 1000) + 60 * 60;
  const url = cloud.cloudinary.utils.private_download_url(f.public_id, format, { resource_type: type, type: "upload", attachment: !inline, expires_at: expires });
  return { url, name: f.name || "file", expires_at: new Date(expires * 1000) };
}
// GET …/download: { url, name, expires_at } (the client opens it), or a redirect with ?redirect=1
function sendDownload(req, res, f) {
  const d = downloadUrl(f, req.query.inline === "1");
  res.set("Cache-Control", "no-store");
  if (req.query.redirect === "1") return res.redirect(302, d.url);
  res.json({ success: true, data: d });
}

// ---------- custom links (note_link): /n/<slug> and /n/g/<slug>. One namespace for every note AND group of every
// business (the NoteSlug collection's unique key makes a duplicate impossible, even with two saves at once).
const SLUG_MIN = 3;
const SLUG_MAX = 40;
const RESERVED = new Set(["g", "n", "new", "edit", "admin", "api", "login", "logout", "register", "signup", "sign-up", "app", "help", "bizhub", "biz-hub", "public", "note", "notes", "group", "groups", "dashboard", "settings", "account", "www", "static", "assets", "s", "d", "p", "f", "m", "e", "x", "support", "about", "terms", "privacy", "root", "null", "undefined", "index", "home"]);
// lowercase, spaces → "-", anything else (Khmer, symbols) dropped; dropped = something was removed
function normSlug(v) {
  const raw = String(v ?? "").trim().toLowerCase();
  const dashed = raw.replace(/[\s_.]+/g, "-");
  const kept = dashed.replace(/[^a-z0-9-]/g, "");
  const slug = kept.replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, SLUG_MAX).replace(/-$/, "");
  return { slug, dropped: kept.length !== dashed.length };
}
// "" when the slug may be used (not checking if it is taken), else short | bad | reserved
function slugProblem(slug) {
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) return "short";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return "bad";
  if (RESERVED.has(slug)) return "reserved";
  return "";
}
// who uses it now: null | { kind, ref_id, business_id } (also a random token that happens to look the same)
async function slugOwner(slug) {
  const row = await M.NoteSlug.findOne({ slug }).lean();
  if (row) return { kind: row.kind, ref_id: String(row.ref_id), business_id: String(row.business_id) };
  const [n, g] = await Promise.all([M.Note.findOne({ $or: [{ "share.slug": slug }, { "share.token": slug }] }).select("_id business_id").lean(), M.NoteGroup.findOne({ $or: [{ "share.slug": slug }, { "share.token": slug }] }).select("_id business_id").lean()]);
  if (n) return { kind: "note", ref_id: String(n._id), business_id: String(n.business_id) };
  if (g) return { kind: "group", ref_id: String(g._id), business_id: String(g.business_id) };
  return null;
}
async function slugSuggest(slug, count = 3) {
  const base = (slug || "my-note").slice(0, SLUG_MAX - 5).replace(/-$/, "") || "note";
  const tries = [];
  for (let i = 2; i <= 9; i += 1) tries.push(`${base}-${i}`);
  const year = new Date().getFullYear();
  tries.push(`${base}-${year}`);
  for (let i = 0; i < 6; i += 1) tries.push(`${base}-${crypto.randomBytes(2).toString("hex")}`);
  const out = [];
  for (const t of tries) {
    if (out.length >= count) break;
    if (!slugProblem(t) && !(await slugOwner(t))) out.push(t);
  }
  return out;
}
// give `kind` `ref` (a Note / NoteGroup doc) the slug "" = remove. Throws Bad 409 slug_taken. Old slug is freed.
async function setSlug(kind, doc, wanted) {
  const Model = kind === "note" ? M.Note : M.NoteGroup;
  const old = doc.share?.slug || "";
  if (!wanted) {
    if (!old) return doc;
    const saved = await Model.findByIdAndUpdate(doc._id, { $unset: { "share.slug": 1 } }, { returnDocument: "after" });
    await M.NoteSlug.deleteOne({ slug: old, ref_id: doc._id });
    return saved;
  }
  if (wanted === old) return doc;
  const owner = await slugOwner(wanted);
  if (owner && owner.ref_id !== String(doc._id)) throw new Bad(MSG.slugTaken, 409, { code: "slug_taken", suggestions: await slugSuggest(wanted) });
  try {
    await M.NoteSlug.create({ slug: wanted, kind, ref_id: doc._id, business_id: doc.business_id });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const row = await M.NoteSlug.findOne({ slug: wanted }).lean();
    if (!row || String(row.ref_id) !== String(doc._id)) throw new Bad(MSG.slugTaken, 409, { code: "slug_taken", suggestions: await slugSuggest(wanted) });
  }
  let saved;
  try {
    saved = await Model.findByIdAndUpdate(doc._id, { $set: { "share.slug": wanted } }, { returnDocument: "after" });
  } catch (err) {
    await M.NoteSlug.deleteOne({ slug: wanted, ref_id: doc._id });
    if (err?.code === 11000) throw new Bad(MSG.slugTaken, 409, { code: "slug_taken", suggestions: await slugSuggest(wanted) });
    throw err;
  }
  if (old) await M.NoteSlug.deleteOne({ slug: old, ref_id: doc._id });
  return saved;
}
// a note / group gone for good: its slug is free again
async function dropSlugsOf(refIds) {
  const ids = (Array.isArray(refIds) ? refIds : [refIds]).filter(Boolean);
  if (ids.length) await M.NoteSlug.deleteMany({ ref_id: { $in: ids } });
}

// ================================================================ v4 (NOTE_V4.md)
// ---------- sign-up list fields (note_form)
const fieldOut = (f) => ({ id: f.id, label: f.label, type: f.type, required: !!f.required, ...(f.type === "choice" ? { options: f.options || [] } : {}), ...(f.type === "text" ? { max: f.max || 200 } : {}) });
const formOut = (form) => ({ fields: (form?.fields || []).map((f) => fieldOut(f.toObject ? f.toObject() : f)) });
// { fields } from the client → clean fields. New or changed fields need note_form (owned); taking fields away is free,
// and a note keeps the fields it already has when the license goes away.
function cleanForm(input, current, owned) {
  const list = Array.isArray(input?.fields) ? input.fields : Array.isArray(input) ? input : null;
  if (!list) throw new Bad(MSG.badField, 400, { code: "bad_field" });
  if (list.length > M.LIMITS.formFields) throw new Bad(MSG.badField, 400, { code: "too_many_fields" });
  const seen = new Set();
  const out = [];
  for (const f of list) {
    if (!f || typeof f !== "object") continue;
    const type = M.FIELD_TYPES.includes(f.type) ? f.type : "text";
    const label = str(f.label, 80);
    if (!label) throw new Bad(MSG.badField, 400, { code: "need_label" });
    let id = str(f.id, 40).replace(/[^A-Za-z0-9_-]/g, "") || Math.random().toString(36).slice(2, 10);
    while (seen.has(id)) id = `${id}${Math.random().toString(36).slice(2, 4)}`;
    seen.add(id);
    const field = { id, label, type, required: !!f.required };
    if (type === "choice") {
      const options = [...new Set((Array.isArray(f.options) ? f.options : []).map((x) => str(x, 60)).filter(Boolean))].slice(0, 30);
      if (!options.length) throw new Bad(MSG.badField, 400, { code: "need_options", field: id });
      field.options = options;
    }
    if (type === "text") field.max = Math.max(1, Math.min(1000, Math.round(Number(f.max) || 200)));
    out.push(field);
  }
  if (!owned) {
    const key = (x) => JSON.stringify(fieldOut(x));
    const had = new Set((current?.fields || []).map((x) => key(x.toObject ? x.toObject() : x)));
    if (out.some((x) => !had.has(key(x)))) throw new Bad(MSG.needForm, 403, { code: "need_form", product: "note_form" });
  }
  return { fields: out };
}
// the answers a person typed → { fieldId: value } (throws 400 field_required / field_bad with the field's label)
function cleanAnswers(form, input) {
  const fields = form?.fields || [];
  if (!fields.length) return undefined;
  let data = input;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = {};
    }
  }
  if (!data || typeof data !== "object") data = {};
  const out = {};
  for (const f of fields) {
    const raw = data[f.id];
    const empty = raw === undefined || raw === null || (typeof raw === "string" && !raw.trim()) || (f.type === "checkbox" && raw !== true && raw !== "true" && raw !== 1 && raw !== "1");
    if (empty) {
      if (f.required) throw new Bad(MSG.fieldRequired.replace("{label}", f.label), 400, { code: "field_required", field: f.id });
      if (f.type === "checkbox") out[f.id] = false;
      continue;
    }
    const bad = () => new Bad(MSG.fieldBad.replace("{label}", f.label), 400, { code: "field_bad", field: f.id });
    const v = typeof raw === "string" ? raw.trim() : raw;
    if (f.type === "checkbox") out[f.id] = true;
    else if (f.type === "number") {
      const n = Number(String(v).replace(/,/g, ""));
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw bad();
      out[f.id] = n;
    } else if (f.type === "phone") {
      const p = String(v).slice(0, 30);
      if (!/^\+?[0-9 ()-]{6,30}$/.test(p)) throw bad();
      out[f.id] = p;
    } else if (f.type === "email") {
      const e = String(v).slice(0, 120).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad();
      out[f.id] = e;
    } else if (f.type === "date") {
      const d = String(v).slice(0, 10);
      if (!realDay(d)) throw bad(); // also refuses impossible days like 2026-02-31
      out[f.id] = d;
    } else if (f.type === "choice") {
      if (!(f.options || []).includes(String(v))) throw bad();
      out[f.id] = String(v);
    } else out[f.id] = str(v, f.max || 200);
  }
  return out;
}

// ---------- checklist due dates (free): the open items of some blocks, grouped as overdue / today / week
// overdue = past its time (a date alone: past that day) · today = due today, not past yet · week = the next 6 days
function dueOf(blocks, now = new Date()) {
  const today = localDay(now);
  const weekEnd = addDays(today, 6);
  const out = { overdue: [], today: [], week: [] };
  for (const b of blocks || []) {
    if (b.t !== "check" || b.done || !b.due) continue;
    const at = dueAt(b.due);
    if (!at) continue;
    const day = b.due.slice(0, 10);
    const item = { id: b.id, text: b.text, due: b.due, who: b.who || "" };
    if (at.getTime() < now.getTime()) out.overdue.push(item);
    else if (day === today) out.today.push(item);
    else if (day > today && day <= weekEnd) out.week.push(item);
  }
  return out;
}

// ---------- views per day (free): +1 view; +1 person the first time this guest key shows up that day
async function countView(businessId, kind, refId, guestKey) {
  const day = localDay();
  await M.NoteView.updateOne({ ref_id: refId, day }, { $inc: { views: 1 }, $setOnInsert: { business_id: businessId, kind } }, { upsert: true }).catch(async (err) => {
    if (err?.code !== 11000) throw err;
    await M.NoteView.updateOne({ ref_id: refId, day }, { $inc: { views: 1 } });
  });
  if (!guestKey) return;
  try {
    await M.NoteViewKey.create({ ref_id: refId, day, guest_key: guestKey });
    await M.NoteView.updateOne({ ref_id: refId, day }, { $inc: { people: 1 } });
  } catch (err) {
    if (err?.code !== 11000) throw err; // seen today already
  }
}
// the last `days` days (oldest first, every day present) + totals + the best day
async function statsOf(refId, days = 30) {
  const n = Math.max(1, Math.min(365, Math.round(Number(days) || 30)));
  const today = localDay();
  const from = addDays(today, -(n - 1));
  const rows = await M.NoteView.find({ ref_id: refId, day: { $gte: from, $lte: today } }).lean();
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const list = [];
  for (let i = 0; i < n; i += 1) {
    const day = addDays(from, i);
    const r = byDay.get(day);
    list.push({ day, views: r?.views || 0, people: r?.people || 0 });
  }
  const best = list.reduce((a, r) => (r.views > (a?.views || 0) ? r : a), null);
  return { days: list, total: { views: list.reduce((a, r) => a + r.views, 0), people: list.reduce((a, r) => a + r.people, 0) }, best: best ? { day: best.day, views: best.views } : null };
}

// ---------- "Open from" (free): before opens_at a link shows only a countdown
const notOpen = (share) => !!share?.opens_at && new Date(share.opens_at).getTime() > Date.now();

module.exports = {
  VOICE_MAX,
  TZ,
  localDay,
  localHm,
  dueAt,
  addDays,
  fieldOut,
  formOut,
  cleanForm,
  cleanAnswers,
  dueOf,
  countView,
  statsOf,
  notOpen,
  normSlug,
  slugProblem,
  slugOwner,
  slugSuggest,
  setSlug,
  dropSlugsOf,
  SLUG_MIN,
  SLUG_MAX,
  M,
  MSG,
  LIMITS,
  Bad,
  handle,
  validId,
  str,
  bool,
  dateIn,
  newToken,
  escRe,
  guestKeyOf,
  licenseState,
  bookOf,
  reserve,
  release,
  dropFiles,
  seenUpsert,
  pinBlocked,
  pinFailed,
  PIN_TRIES,
  kindOf,
  voiceMime,
  realDay,
  mimeOf,
  fileOut,
  cleanBlocks,
  cleanTags,
  textOf,
  saveRev,
  saveContent,
  shareOut,
  noteOut,
  rowOut,
  createNote,
  groupShareOut,
  groupOut,
  createGroup,
  slotNo,
  GB,
  cleanStyle,
  isStyled,
  downloadUrl,
  sendDownload,
  THEME_KEYS,
  themeOut,
  themeIn,
  FINE_KINDS,
  fineKind,
  notesFiles,
  filesTotals,
  filesPage,
};
