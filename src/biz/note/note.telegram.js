// Digital Note on Telegram (note_telegram, yearly) — one BizHub bot (src/telegram). NOTE_V4.md § 1.
// The owner links a chat once (like Debt Book: a /start code, 15 minutes), then gets:
//   replies (at once, or merged every 15 minutes) · new sign-up rows · guest edits · "I've read it" confirmations
//   a daily summary at 08:00 (Cambodia) · checklist reminders: on the due day at 08:00 and 1 hour before a due time
// A busy note never spams: at most one message a minute per note + kind; the rest are merged into the next one.
// Scheduler: tick() — run by /api/cron/daily-report (every 15–60 minutes) and /api/cron/note-telegram.
const crypto = require("crypto");
const telegram = require("../../telegram");
const Business = require("../business.model");
const License = require("../../license/license.model");
const S = require("./note.shared");

const { M } = S;
const DEFAULT_SITE = "https://bizhub-cambodia.web.app";
const GAP = 60 * 1000; // one message a minute per note + kind
const BATCH_GAP = 15 * 60 * 1000; // "merged every 15 minutes" for replies
const DAILY_AT = "08:00";
const esc = telegram.escape;
const site = () => String(process.env.WEB_URL || DEFAULT_SITE).replace(/\/+$/, "");
const noteLink = (bid, nid) => `${site()}/app/business/${bid}?tab=notes&note=${nid}`;
const bookLink = (bid) => `${site()}/app/business/${bid}?tab=notes`;
const TOGGLE = { reply: "replies", signup: "signups", edit: "edits", ack: "acks" };
const cut = (v, n = 80) => {
  const t = String(v || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// the words, per language (the owner picks km / en; Khmer by default)
const W = {
  km: {
    reply: (n) => `💬 <b>${n === 1 ? "ការឆ្លើយតបថ្មី" : `ការឆ្លើយតបថ្មី ${n}`}</b>`,
    signup: (n) => `📝 <b>${n === 1 ? "មានអ្នកចុះឈ្មោះថ្មី" : `អ្នកចុះឈ្មោះថ្មី ${n}`}</b>`,
    edit: (names) => `✏️ <b>${esc(names)}</b> បានកែកំណត់ត្រា`,
    ack: (n) => `✅ <b>${n === 1 ? "មានអ្នកបញ្ជាក់ថាបានអាន" : `${n} នាក់បានបញ្ជាក់ថាបានអាន`}</b>`,
    open: "បើកកំណត់ត្រា",
    openAll: "បើកកំណត់ត្រាឌីជីថល",
    more: (n) => `… និង ${n} ទៀត`,
    guest: "ភ្ញៀវ",
    untitled: "គ្មានចំណងជើង",
    daily: (name, day) => `📒 <b>${esc(name)}</b> · សង្ខេបប្រចាំថ្ងៃ ${day}`,
    dReplies: "ការឆ្លើយតប",
    dSignups: "ការចុះឈ្មោះ",
    dAcks: "បានបញ្ជាក់ថាបានអាន",
    dueToday: "📅 <b>ត្រូវធ្វើថ្ងៃនេះ</b>",
    overdue: "⏰ <b>ហួសកំណត់</b>",
    inHour: "⏰ <b>ក្នុងរយៈពេល 1 ម៉ោងទៀត</b>",
    quiet: "គ្មានអ្វីថ្មីកាលពីម្សិលមិញ។",
    test: (name) => `🔔 <b>${esc(name)}</b>\nសារសាកល្បងពី BizHub — ដំណើរការល្អ។`,
    linked: (name) => `✅ <b>${esc(name)}</b> បានភ្ជាប់ហើយ។\nអ្នកនឹងទទួលការជូនដំណឹងពីកំណត់ត្រាឌីជីថលនៅទីនេះ។`,
    expired: "⌛️ តំណនេះផុតកំណត់ហើយ។ សូមចុច “ភ្ជាប់ Telegram” ម្តងទៀត។",
    bye: "🔌 បានផ្តាច់ពី BizHub ហើយ។",
  },
  en: {
    reply: (n) => `💬 <b>${n === 1 ? "New reply" : `${n} new replies`}</b>`,
    signup: (n) => `📝 <b>${n === 1 ? "New sign-up" : `${n} new sign-ups`}</b>`,
    edit: (names) => `✏️ <b>${esc(names)}</b> changed the note`,
    ack: (n) => `✅ <b>${n === 1 ? "Someone confirmed they read it" : `${n} people confirmed they read it`}</b>`,
    open: "Open the note",
    openAll: "Open Digital Note",
    more: (n) => `… and ${n} more`,
    guest: "Guest",
    untitled: "Untitled",
    daily: (name, day) => `📒 <b>${esc(name)}</b> · daily summary ${day}`,
    dReplies: "replies",
    dSignups: "sign-ups",
    dAcks: "confirmed",
    dueToday: "📅 <b>Due today</b>",
    overdue: "⏰ <b>Overdue</b>",
    inHour: "⏰ <b>In 1 hour</b>",
    quiet: "Nothing new yesterday.",
    test: (name) => `🔔 <b>${esc(name)}</b>\nTest message from BizHub — everything works.`,
    linked: (name) => `✅ <b>${esc(name)}</b> is connected.\nYou'll get Digital Note alerts here.`,
    expired: "⌛️ This link has expired. Open BizHub → Digital Note → Telegram → Connect again.",
    bye: "🔌 BizHub disconnected from this chat.",
  },
};
const words = (book) => W[book?.tg?.lang === "en" ? "en" : "km"];

// what the dashboard shows
function stateOut(book, state) {
  const tg = book?.tg || {};
  return {
    configured: telegram.ready(),
    active: !!state?.addons?.note_telegram?.active,
    expires_at: state?.addons?.note_telegram?.expires_at || null,
    connected: !!tg.chat_id,
    chat_name: tg.chat_name || "",
    connected_at: tg.connected_at || null,
    lang: tg.lang === "en" ? "en" : "km",
    replies: tg.replies !== false,
    replies_batch: !!tg.replies_batch,
    signups: tg.signups !== false,
    edits: !!tg.edits,
    acks: tg.acks !== false,
    daily: tg.daily !== false,
    reminders: tg.reminders !== false,
  };
}

async function send(book, text, extra = {}) {
  try {
    await telegram.send(book.tg.chat_id, text, extra);
    return true;
  } catch (err) {
    // the chat blocked the bot: forget it (the owner connects again)
    if (err instanceof telegram.TelegramError && err.message === "blocked") await M.NoteBook.updateOne({ _id: book._id }, { $set: { "tg.chat_id": "" } });
    return false;
  }
}
const button = (label, url) => telegram.keyboard([[{ text: label, url }]]);

// may this business get alerts now? (linked chat, the add-on, the plan not locked)
async function ready(businessId, state) {
  if (!telegram.ready()) return null;
  const book = await M.NoteBook.findOne({ business_id: businessId }).lean();
  if (!book?.tg?.chat_id) return null;
  const st = state || (await S.licenseState(businessId));
  if (!st.addons.note_telegram?.active || st.license.read_only) return null;
  return book;
}

// take the one-message-a-minute gate for a note + kind (false = it sent less than `gap` ago)
async function gate(key, gap) {
  const now = new Date();
  const r = await M.NoteAlertGate.updateOne({ key, $or: [{ last_at: null }, { last_at: { $lt: new Date(now.getTime() - gap) } }] }, { $set: { last_at: now } });
  if (r.matchedCount) return true;
  try {
    await M.NoteAlertGate.create({ key, last_at: now });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false; // it exists and is closed
    throw err;
  }
}
const gateOpen = async (key, gap) => {
  const g = await M.NoteAlertGate.findOne({ key }).lean();
  return !g?.last_at || Date.now() - new Date(g.last_at).getTime() >= gap;
};

// send everything waiting for a note + kind as one message (claims the rows first, so two senders never repeat them)
async function flush(book, noteId, kind, { gap = GAP } = {}) {
  const key = `${noteId}:${kind}`;
  if (!(await gate(key, gap))) return false;
  const batch = crypto.randomBytes(8).toString("hex");
  await M.NoteAlert.updateMany({ business_id: book.business_id, note_id: noteId, kind, batch: "" }, { $set: { batch } });
  const rows = await M.NoteAlert.find({ batch }).sort({ at: 1 }).lean();
  if (!rows.length) return false;
  const note = await M.Note.findById(noteId).select("title").lean();
  const w = words(book);
  const title = `📄 <i>${esc(cut(note?.title || w.untitled, 60))}</i>`;
  const names = [...new Set(rows.map((r) => r.name || w.guest))];
  let head;
  if (kind === "reply") head = w.reply(rows.length);
  else if (kind === "signup") head = w.signup(rows.length);
  else if (kind === "edit") head = w.edit(names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : ""));
  else head = w.ack(rows.length);
  const lines = [head, title];
  if (kind !== "edit") {
    const shown = rows.slice(-5);
    for (const r of shown) lines.push(`• <b>${esc(cut(r.name || w.guest, 40))}</b>${r.text ? `: ${esc(cut(r.text, 90))}` : ""}`);
    if (rows.length > shown.length) lines.push(w.more(rows.length - shown.length));
  }
  return send(book, lines.join("\n"), button(w.open, noteLink(book.business_id, noteId)));
}

// a thing happened on a shared note: queue it, and send now unless the owner wants replies merged (the cron sends those)
// kind: reply | signup | edit | ack · state: licenseState (optional, saves a query)
async function alert(businessId, noteId, kind, { name = "", text = "" } = {}, state) {
  try {
    const book = await ready(businessId, state);
    if (!book) return;
    const toggle = TOGGLE[kind];
    if (toggle === "edits" ? !book.tg.edits : book.tg[toggle] === false) return;
    await M.NoteAlert.create({ business_id: businessId, note_id: noteId, kind, name: S.str(name, M.LIMITS.name), text: S.str(text, 200) });
    if (kind === "reply" && book.tg.replies_batch) return;
    await flush(book, noteId, kind);
  } catch (err) {
    console.error("[note-telegram] alert", err?.message || err);
  }
}

// the open checklist items of a business's notes (not deleted)
async function dueItems(businessId) {
  const notes = await M.Note.find({ business_id: businessId, deleted: false, "blocks.due": { $exists: true, $ne: "" } }).select("title blocks").lean();
  return notes.map((n) => ({ note: n, items: (n.blocks || []).filter((b) => b.t === "check" && !b.done && b.due) }));
}
// mark a reminder as sent; false when it was sent already
async function once(noteId, blockId, due, kind) {
  try {
    await M.NoteRemind.create({ note_id: noteId, block_id: blockId, due, kind });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}
const itemLine = (b, title, w) => `• ${esc(cut(b.text || "…", 70))}${b.due.includes("T") ? ` · ${b.due.slice(11)}` : ""}${b.who ? ` · 👤 ${esc(cut(b.who, 30))}` : ""}${title ? ` — <i>${esc(cut(title || w.untitled, 40))}</i>` : ""}`;

// once a day after 08:00: yesterday's replies / sign-ups / confirmations per note + what is due today
// (the "due today" reminders ride along when the summary is on; otherwise they go as their own message)
async function morning(book, business, now, due) {
  const w = words(book);
  const day = S.localDay(now);
  const todayStart = new Date(Date.parse(`${day}T00:00:00Z`) - S.TZ * 3600000);
  const since = book.tg.last_daily_at && book.tg.last_daily_at > new Date(todayStart.getTime() - 864e5) ? book.tg.last_daily_at : new Date(todayStart.getTime() - 864e5);
  let sent = 0;
  // the due-today list (each item once)
  const dueToday = [];
  const overdue = [];
  if (book.tg.reminders !== false) {
    for (const { note, items } of due) {
      for (const b of items) {
        const at = S.dueAt(b.due);
        if (!at) continue;
        if (b.due.slice(0, 10) === day && at > now && (await once(note._id, b.id, b.due, "day"))) dueToday.push(itemLine(b, note.title, w));
        else if (at && at < now && b.due.slice(0, 10) >= S.addDays(day, -7) && (await once(note._id, b.id, b.due, "day"))) overdue.push(itemLine(b, note.title, w)); // late in the last week, told once
      }
    }
  }
  const dueLines = [...(dueToday.length ? ["", w.dueToday, ...dueToday.slice(0, 15)] : []), ...(overdue.length ? ["", w.overdue, ...overdue.slice(0, 10)] : [])];
  if (book.tg.daily !== false) {
    const [entries, acks] = await Promise.all([
      M.NoteEntry.find({ business_id: book.business_id, by_owner: false, created_date: { $gte: since, $lt: now } }).select("note_id kind").lean(),
      M.NoteAck.find({ business_id: book.business_id, at: { $gte: since, $lt: now } }).select("note_id").lean(),
    ]);
    const per = new Map();
    const row = (id) => per.get(String(id)) || per.set(String(id), { replies: 0, signups: 0, acks: 0 }).get(String(id));
    for (const e of entries) row(e.note_id)[e.kind === "collect" ? "signups" : "replies"] += 1;
    for (const a of acks) row(a.note_id).acks += 1;
    const titles = new Map((await M.Note.find({ _id: { $in: [...per.keys()] } }).select("title").lean()).map((n) => [String(n._id), n.title]));
    const noteLines = [...per.entries()]
      .sort((a, b) => b[1].replies + b[1].signups + b[1].acks - (a[1].replies + a[1].signups + a[1].acks))
      .slice(0, 12)
      .map(([id, c]) => `• <i>${esc(cut(titles.get(id) || w.untitled, 40))}</i>: ${[c.replies && `${c.replies} ${w.dReplies}`, c.signups && `${c.signups} ${w.dSignups}`, c.acks && `${c.acks} ${w.dAcks}`].filter(Boolean).join(" · ")}`);
    const lines = [w.daily(business.name || "Digital Note", day), ...(noteLines.length ? ["", ...noteLines] : dueLines.length ? [] : ["", w.quiet]), ...dueLines];
    if (await send(book, lines.join("\n"), button(w.openAll, bookLink(book.business_id)))) sent += 1;
  } else if (dueLines.length) {
    if (await send(book, dueLines.slice(1).join("\n"), button(w.openAll, bookLink(book.business_id)))) sent += 1;
  }
  return sent; // tg.last_daily_at was set by the tick when it claimed this morning
}

// items with a due time, about an hour before (the cron runs every 15–60 minutes, so "about")
async function hourBefore(book, now, due) {
  if (book.tg.reminders === false) return 0;
  const w = words(book);
  const lines = [];
  for (const { note, items } of due) {
    for (const b of items) {
      if (!b.due.includes("T")) continue;
      const at = S.dueAt(b.due);
      if (!at) continue; // bad data never stops the others
      const left = at.getTime() - now.getTime();
      if (left > 0 && left <= 75 * 60 * 1000 && (await once(note._id, b.id, b.due, "hour"))) lines.push(itemLine(b, note.title, w));
    }
  }
  if (!lines.length) return 0;
  return (await send(book, [w.inHour, ...lines.slice(0, 15)].join("\n"), button(w.openAll, bookLink(book.business_id)))) ? 1 : 0;
}

// the scheduler: leftover alerts (merged ones), the morning message, the hour-before reminders
async function tick(now = new Date()) {
  if (!telegram.ready()) return { skipped: "telegram_not_configured" };
  const out = { books: 0, alerts: 0, mornings: 0, reminders: 0 };
  const hm = S.localHm(now);
  const todayStart = new Date(Date.parse(`${S.localDay(now)}T00:00:00Z`) - S.TZ * 3600000);
  // only books whose note_telegram is (still) running — with a week's slack for the grace days; the exact check is
  // per book below. Every such book is handled (no cap), in a fixed order, a page at a time.
  const live = await License.distinct("business_id", { product: "note_telegram", item: "", $or: [{ expires_at: null }, { expires_at: { $gt: new Date(now.getTime() - 8 * 864e5) } }] });
  if (!live.length) return out;
  const cursor = M.NoteBook.find({ business_id: { $in: live }, "tg.chat_id": { $gt: "" } }).sort({ _id: 1 }).lean().cursor({ batchSize: 200 });
  for await (const book of cursor) {
    out.books += 1;
    try {
      const [state, business] = await Promise.all([S.licenseState(book.business_id), Business.findOne({ _id: book.business_id, deleted: false, status: true }).select("name category").lean()]);
      if (!business || business.category !== "digital_note" || !state.addons.note_telegram?.active || state.license.read_only) continue;
      // alerts still waiting (merged replies, or ones that hit the one-a-minute gate)
      const waiting = await M.NoteAlert.aggregate([{ $match: { business_id: book.business_id, batch: "" } }, { $group: { _id: { note_id: "$note_id", kind: "$kind" } } }]);
      for (const { _id } of waiting) {
        const gap = _id.kind === "reply" && book.tg.replies_batch ? BATCH_GAP : GAP;
        if (!(await gateOpen(`${_id.note_id}:${_id.kind}`, gap))) continue;
        if (await flush(book, _id.note_id, _id.kind, { gap })) out.alerts += 1;
      }
      // the checklist items, loaded once for both the morning and the hour-before reminders
      const due = book.tg.reminders === false && book.tg.daily === false ? [] : await dueItems(book.business_id);
      // the morning message: claimed atomically, so two ticks at once never both send it
      if (hm >= DAILY_AT && (!book.tg.last_daily_at || new Date(book.tg.last_daily_at) < todayStart)) {
        const claim = await M.NoteBook.updateOne({ _id: book._id, $or: [{ "tg.last_daily_at": null }, { "tg.last_daily_at": { $exists: false } }, { "tg.last_daily_at": { $lt: todayStart } }] }, { $set: { "tg.last_daily_at": now } });
        if (claim.modifiedCount === 1) out.mornings += await morning(book, business, now, due);
      }
      out.reminders += await hourBefore(book, now, due);
    } catch (err) {
      console.error("[note-telegram] tick", String(book.business_id), err?.message || err);
    }
  }
  return out;
}

// /start nt_<code> from the "Connect" link
telegram.onStart(async (code, chat) => {
  if (!/^nt_[A-Za-z0-9]{12,40}$/.test(code)) return null;
  const book = await M.NoteBook.findOne({ "tg.link_code": code });
  if (!book) return W.km.expired;
  const w = words(book);
  if (!book.tg.link_expires || book.tg.link_expires < new Date()) return w.expired;
  const name = (chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "Telegram")).slice(0, 80);
  await M.NoteBook.updateOne({ _id: book._id }, { $set: { "tg.chat_id": String(chat.id), "tg.chat_name": name, "tg.connected_at": new Date(), "tg.link_code": "", "tg.link_expires": null } });
  const business = await Business.findById(book.business_id).select("name").lean();
  return w.linked(business?.name || "Digital Note");
});

module.exports = { stateOut, alert, tick, flush, words, W, noteLink, send };
