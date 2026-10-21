// Crashes of the BizHub app (Flutter) — so the team can fix them without screenshots
//   POST   /api/public/app-error            (api key, no login) the app sends an error → counted + Telegram to the super admin
//   GET    /api/admin/app-errors?page=&resolved=0|1     super admin: newest first
//   PUT    /api/admin/app-errors/:id        { resolved }   · DELETE /api/admin/app-errors/:id
const crypto = require("crypto");
const mongoose = require("mongoose");
const AppError = require("./app_error.model");
const P = require("../platform/platform.model");
const telegram = require("../telegram");
const { only_super_admin } = require("../util/permission");
const { rate_limit } = require("../util/rate_limit");

const cut = (v, n) => String(v ?? "").slice(0, n);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// the first line of the stack that is our code (lib/…) tells where it happened
const place = (stack) => (String(stack).split("\n").find((l) => /package:bizhub_admin\/|lib\//.test(l)) || String(stack).split("\n")[0] || "").trim();

async function alert(row, isNew) {
  try {
    if (!telegram.ready()) return;
    const s = await P.PlatformSettings.findOne({ key: "main" }).lean();
    if (!s?.tg?.chat_id || s.tg.app_errors === false) return;
    const lines = [
      `${isNew ? "🐞 <b>New app error</b>" : `🐞 <b>App error again</b> · ${row.count}×`}`,
      `📱 ${esc(row.platform)} ${esc(row.os)} · v${esc(row.version)}`,
      row.route ? `📍 ${esc(row.route)}` : "",
      `\n<code>${esc(cut(row.message, 600))}</code>`,
      row.context ? `\n${esc(cut(row.context, 200))}` : "",
      place(row.stack) ? `\n${esc(cut(place(row.stack), 200))}` : "",
      "\n➡️ BizHub app → More → App errors",
    ];
    await telegram.send(s.tg.chat_id, lines.filter(Boolean).join("\n"));
  } catch {
    /* never fail the report because of Telegram */
  }
}

module.exports = (prop) => {
  const admin = [prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin];

  prop.app.post("/api/public/app-error", prop.api_auth, rate_limit({ windowMs: 10 * 60 * 1000, max: 30 }), async (req, res) => {
    try {
      const b = req.body || {};
      const message = cut(b.message, 2000).trim();
      if (!message) return res.status(400).json({ success: false, message: "message" });
      const stack = cut(b.stack, 6000);
      const version = cut(b.version, 40);
      const fingerprint = crypto.createHash("sha1").update(`${message.split("\n")[0]}|${place(stack)}|${version}`).digest("hex");
      const who = b.user && typeof b.user === "object" ? cut(`${b.user.type || ""}:${b.user.email || b.user.id || ""}`, 120) : "";
      const now = new Date();
      const fields = { message, stack, library: cut(b.library, 120), context: cut(b.context, 400), route: cut(b.route, 300), platform: cut(b.platform, 20), os: cut(b.os, 80), last_at: now, resolved: false };
      const before = await AppError.findOneAndUpdate(
        { fingerprint },
        { $set: fields, $inc: { count: 1 }, $setOnInsert: { version, first_at: now }, ...(who ? { $addToSet: { users: who } } : {}) },
        { upsert: true, new: false },
      );
      const row = { ...fields, version, count: (before?.count || 0) + 1 };
      // Telegram: the first time, then at 10, 100, 1000… so a crash loop doesn't flood the chat
      if (!before || before.resolved || [10, 100, 1000].includes(row.count)) await alert(row, !before);
      res.json({ success: true });
    } catch (err) {
      console.error("app-error", err.message);
      res.status(500).json({ success: false });
    }
  });

  prop.app.get("/api/admin/app-errors", admin, async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const filter = req.query.resolved === "1" ? { resolved: true } : req.query.resolved === "0" ? { resolved: false } : {};
      const [rows, total, open] = await Promise.all([AppError.find(filter).sort({ last_at: -1 }).skip((page - 1) * limit).limit(limit).lean(), AppError.countDocuments(filter), AppError.countDocuments({ resolved: false })]);
      res.json({ success: true, data: rows, open, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  prop.app.put("/api/admin/app-errors/:id", admin, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "id" });
    const row = await AppError.findByIdAndUpdate(req.params.id, { $set: { resolved: !!req.body?.resolved } }, { new: true }).lean();
    if (!row) return res.status(404).json({ success: false, message: "not found" });
    res.json({ success: true, data: row });
  });

  prop.app.delete("/api/admin/app-errors/:id", admin, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "id" });
    await AppError.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  });
};
