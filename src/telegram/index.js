// Telegram: one BizHub bot sends messages to business owners (daily report, website messages, test…).
//
// .env (only the first two are needed)
//   TELEGRAM_BOT_TOKEN       token from @BotFather
//   TELEGRAM_BOT_USERNAME    the bot's @name without @ (optional; read from Telegram when empty)
//   API_PUBLIC_URL           https address of this API (on Vercel it's found by itself) → the bot is pointed here
//   TELEGRAM_WEBHOOK_SECRET  optional; made from the token when empty
//   TELEGRAM_POLLING=true    force "ask Telegram for new messages" mode (local computer)
//
// How messages from Telegram reach us:
//   • server with a public https address → webhook POST /api/public/telegram/<secret> (set up by itself on start)
//   • local computer (no public address)  → polling, if no webhook is set for this bot
//     (use a separate test bot on your computer, so you never take the live bot's webhook away)
// Super admin: GET /api/admin/telegram (status) · POST /api/admin/telegram/webhook (point the bot at this API again)
//
// Connecting: the owner opens t.me/<bot>?start=<code>, presses Start → Telegram sends "/start <code>"
// to us → whoever registered onStart() links that chat. Groups work the same (t.me/<bot>?startgroup=<code>).
const crypto = require("crypto");

const API = "https://api.telegram.org";
const token = () => process.env.TELEGRAM_BOT_TOKEN || "";
const ready = () => !!token();
const secret = () => process.env.TELEGRAM_WEBHOOK_SECRET || (token() ? crypto.createHash("sha256").update(`bizhub:${token()}`).digest("hex").slice(0, 40) : "");
const publicUrl = () => {
  const own = (process.env.API_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (/^https:\/\//.test(own)) return own;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || "";
  return vercel ? `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}` : "";
};
const hookUrl = () => (publicUrl() ? `${publicUrl()}/api/public/telegram/${secret()}` : "");

class TelegramError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function call(method, body) {
  if (!ready()) throw new TelegramError("not_configured", 503);
  let res;
  try {
    res = await fetch(`${API}/bot${token()}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(method === "getUpdates" ? 40000 : 10000) });
  } catch {
    throw new TelegramError("unreachable");
  }
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    // 403 = the person blocked the bot / removed it from the group; 401 = wrong token
    const status = json.error_code === 403 ? 410 : json.error_code === 401 ? 503 : 502;
    throw new TelegramError(json.error_code === 403 ? "blocked" : json.error_code === 401 ? "bad_token" : json.description || "failed", status);
  }
  return json.result;
}

// send a message (HTML: <b>, <i>, <a href>)
const send = (chatId, text, extra = {}) => call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

// a file upload (multipart): photo / document given as a Buffer
async function callForm(method, fields) {
  if (!ready()) throw new TelegramError("not_configured", 503);
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (Buffer.isBuffer(v)) fd.append(k, new Blob([v]), k === "photo" ? "photo.png" : "file");
    else fd.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  let res;
  try {
    res = await fetch(`${API}/bot${token()}/${method}`, { method: "POST", body: fd, signal: AbortSignal.timeout(20000) });
  } catch {
    throw new TelegramError("unreachable");
  }
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new TelegramError(json.error_code === 403 ? "blocked" : json.description || "failed", json.error_code === 403 ? 410 : 502);
  return json.result;
}
// a picture: an https address or a PNG/JPG Buffer · caption HTML · extra: { reply_markup }
const sendPhoto = (chatId, photo, caption = "", extra = {}) =>
  Buffer.isBuffer(photo)
    ? callForm("sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML", ...extra })
    : call("sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML", ...extra });
// a document (PDF…) from an https address
const sendDocument = (chatId, document, caption = "", extra = {}) => call("sendDocument", { chat_id: chatId, document, caption, parse_mode: "HTML", ...extra });
// change a message we sent (after a button press)
const editText = (chatId, messageId, text, extra = {}) => call("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
const editCaption = (chatId, messageId, caption, extra = {}) => call("editMessageCaption", { chat_id: chatId, message_id: messageId, caption, parse_mode: "HTML", ...extra });
// buttons: [[{ text, url }|{ text, callback_data }], …]
const keyboard = (rows) => ({ reply_markup: { inline_keyboard: rows } });

let username = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "") || "";
async function botUsername() {
  if (!username) username = (await call("getMe")).username;
  return username;
}

const escape = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- incoming messages ----------
const startHandlers = [];
const onStart = (fn) => startHandlers.push(fn); // fn(code, chat) → reply text or null
// a button press (callback_data "<prefix>:…"): fn(data, query) → { toast, alert } or null when not ours
const callbackHandlers = [];
const onCallback = (fn) => callbackHandlers.push(fn);

async function handleCallback(q) {
  let out = null;
  for (const fn of callbackHandlers) {
    out = await fn(String(q.data || ""), q).catch((err) => {
      console.error("[telegram]", err);
      return { toast: "⚠️ Error, try again" };
    });
    if (out) break;
  }
  await call("answerCallbackQuery", { callback_query_id: q.id, text: out?.toast || "", show_alert: !!out?.alert }).catch(() => {});
}

// other commands (/mytickets…): fn(command, chat, args) → reply text (or { text, extra }) or null when not ours
const commandHandlers = [];
const onCommand = (fn) => commandHandlers.push(fn);
async function handleCommand(msg, text) {
  const [head, ...args] = text.trim().split(/\s+/);
  const cmd = head.slice(1).split("@")[0].toLowerCase();
  for (const fn of commandHandlers) {
    const out = await fn(cmd, msg.chat, args).catch((err) => {
      console.error("[telegram]", err);
      return null;
    });
    if (out) return send(msg.chat.id, out.text || out, out.extra).catch(() => {});
  }
}

async function handleUpdate(update) {
  if (update?.callback_query) return handleCallback(update.callback_query);
  const msg = update?.message;
  const text = msg?.text || "";
  if (msg?.chat?.id && /^\/[a-zA-Z]/.test(text) && !/^\/start(@\w+)?(\s|$)/.test(text)) return handleCommand(msg, text);
  if (!msg?.chat?.id || !/^\/start(@\w+)?(\s|$)/.test(text)) return;
  const code = text.split(/\s+/)[1] || "";
  let reply = null;
  for (const fn of startHandlers) {
    reply = await fn(code, msg.chat).catch((err) => {
      console.error("[telegram]", err);
      return null;
    });
    if (reply) break;
  }
  await send(msg.chat.id, reply || "👋 Hello from BizHub!\nTo connect, open BizHub → your restaurant → Telegram → Connect.\nដើម្បីភ្ជាប់ សូមបើក BizHub → ភោជនីយដ្ឋាន → តេឡេក្រាម → ភ្ជាប់។").catch(() => {});
}

// ---------- how updates arrive ----------
const state = { mode: "none", error: "" };
const UPDATES = ["message", "callback_query"];

async function ensureWebhook() {
  const url = hookUrl();
  if (!url) return false;
  const info = await call("getWebhookInfo");
  if (info.url !== url || !(info.allowed_updates || []).includes("callback_query")) await call("setWebhook", { url, secret_token: secret(), allowed_updates: UPDATES, drop_pending_updates: false });
  state.mode = "webhook";
  return true;
}

async function startPolling(force) {
  if (!ready() || startPolling.running) return;
  if (!force) {
    // a live server already owns this bot (webhook set) → don't take it away
    const info = await call("getWebhookInfo").catch(() => null);
    if (info?.url) {
      state.mode = "none";
      state.error = "This bot has a webhook (live server). Use a separate test bot on your computer, or TELEGRAM_POLLING=true.";
      console.log(`[telegram] not polling: ${state.error}`);
      return;
    }
  }
  startPolling.running = true;
  await call("deleteWebhook").catch(() => {});
  state.mode = "polling";
  let offset = 0;
  console.log("[telegram] polling for messages");
  for (;;) {
    try {
      const updates = await call("getUpdates", { offset, timeout: 30, allowed_updates: UPDATES });
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u);
      }
    } catch (err) {
      if (err.status === 503) {
        state.mode = "none";
        state.error = err.message;
        startPolling.running = false;
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function start() {
  if (!ready() || process.env.NODE_ENV === "test") return;
  try {
    if (process.env.TELEGRAM_POLLING === "true") return startPolling(true);
    if (await ensureWebhook()) return;
    if (!process.env.VERCEL) return startPolling(false); // local computer
  } catch (err) {
    state.error = err.message;
    console.log(`[telegram] ${err.message}`);
  }
}

async function status() {
  const out = { configured: ready(), mode: state.mode, error: state.error, public_url: publicUrl(), expected_webhook: hookUrl() ? `${publicUrl()}/api/public/telegram/…` : "" };
  if (!ready()) return out;
  try {
    const [me, info] = await Promise.all([call("getMe"), call("getWebhookInfo")]);
    Object.assign(out, {
      bot: me.username,
      webhook_ok: !!info.url && info.url === hookUrl(),
      webhook_set: !!info.url,
      pending: info.pending_update_count || 0,
      last_error: info.last_error_message || "",
      last_error_at: info.last_error_date ? new Date(info.last_error_date * 1000) : null,
    });
    if (info.url) out.mode = info.url === hookUrl() ? "webhook" : "other_webhook";
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

module.exports = (prop) => {
  // Telegram → us. The secret in the address (and header) proves it's Telegram.
  prop.app.post("/api/public/telegram/:secret", async (req, res) => {
    const s = secret();
    if (!s || req.params.secret !== s || (req.get("x-telegram-bot-api-secret-token") || s) !== s) return res.sendStatus(404);
    // finish the work before answering: on Vercel the function stops once it has answered
    await handleUpdate(req.body).catch(() => {});
    res.sendStatus(200);
  });

  // super admin: is the bot working?
  const { only_super_admin } = require("../util/permission");
  const admin = [prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin];
  prop.app.get("/api/admin/telegram", ...admin, async (req, res) => {
    res.json({ success: true, data: await status() });
  });
  prop.app.post("/api/admin/telegram/webhook", ...admin, async (req, res) => {
    try {
      if (!ready()) return res.status(400).json({ success: false, message: "TELEGRAM_BOT_TOKEN is not set" });
      if (!hookUrl()) return res.status(400).json({ success: false, message: "Set API_PUBLIC_URL (https address of the API) first" });
      await call("deleteWebhook").catch(() => {});
      await ensureWebhook();
      res.json({ success: true, data: await status() });
    } catch (err) {
      res.status(502).json({ success: false, message: err.message });
    }
  });

  start();
};
Object.assign(module.exports, { send, sendPhoto, sendDocument, editText, editCaption, keyboard, call, ready, botUsername, onStart, onCallback, onCommand, handleUpdate, escape, status, secret, TelegramError });
