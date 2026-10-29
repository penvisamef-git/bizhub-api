// Bizi on Telegram (v3.0.0, free): the owner's own chat with the BizHub bot gets what Bizi would say in the app —
//   ☀️ after 08:00 (Cambodia) the morning summary: yesterday's money, this week vs last week, what needs them, tips
//   📊 the first morning of a week: last week's report (the same as the Monday note)
//   ⏰ alerts while the app is closed: new Telegram orders waiting > 5 min, guests past check-out, ticket payments to
//      check… — each one once (again only when the number grows or 3 hours later), muted alerts stay muted
// Base: /api/user/bizi/telegram
//   POST   /link  { lang }    → { url, expires_at }  open it in Telegram, press Start → linked (poll GET /bizi/prefs)
//   POST   /test              send a test message
//   DELETE /                  disconnect
//   (morning / alerts / weekly on-off: PUT /api/user/bizi/prefs { tg: { … } })
// Scheduler: tick() — run by /api/cron/daily-report (every 15–60 minutes).
const crypto = require("crypto");
const telegram = require("../telegram");
const BiziPrefs = require("./bizi.model");
const { customer_auth } = require("../user/customer_auth");

const LINK_MINUTES = 15;
const MORNING = "08:00";
const ALERT_AGAIN_MS = 3 * 3600e3;
const ALERT_KEYS = ["tg_new", "waiting", "ev_review", "checkout_late"]; // the ones worth a message (they wait for someone)
const site = () => String(process.env.WEB_URL || "https://bizhubcambodia.com").replace(/\/+$/, "");
const esc = (s) => telegram.escape(s);
const khNow = () => new Date(Date.now() + 7 * 3600e3);
const khDay = () => khNow().toISOString().slice(0, 10);

// the words (the same as the website's Bizi words)
const T = {
  en: {
    hello: "☀️ <b>Good morning, {name}</b>",
    yesterday: "💰 Yesterday: <b>{money}</b>",
    noSales: "💰 No sales yesterday",
    week: "📈 This week: {pct} vs last week",
    needYou: "🔔 <b>{n} things need you</b>",
    needYou1: "🔔 <b>1 thing needs you</b>",
    allGood: "✅ All quiet — nothing waits for you.",
    tips: "🛠 {n} things to set up — open Bizi in BizHub",
    open: "Open BizHub",
    weekHead: "📊 <b>Last week</b> ({from} → {to})",
    weekTotal: "💰 {money}",
    weekChange: "{pct} vs the week before",
    weekBest: "🏆 Best day: {day} · {money}",
    weekTops: "🔥 Best sellers: {list}",
    weekUp: "⬆️ {name} {pct}",
    weekDown: "⬇️ {name} {pct}",
    waited: "waiting {min} min",
    linked: "✅ <b>Bizi is connected.</b>\nYou'll get a short summary every morning, last week's report on Monday, and a message when something waits for you.\nChange it in BizHub → Bizi → ⚙️.",
    expired: "⌛️ This link has expired. Open BizHub → Bizi → ⚙️ → Telegram → Connect again.",
    test: "👋 Hi from Bizi! This is a test — messages will come here.",
    days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    alerts: {
      tg_new: "{n} new Telegram orders waiting",
      waiting: "{n} online orders / bookings waiting",
      ev_review: "{n} ticket payments to check",
      checkout_late: "{n} guests past their check-out",
      arrivals: "{n} guests arriving today",
      open_bills: "{n} bills still open",
      sold_out: "{n} products sold out",
      low_stock: "{n} products low on stock",
      renewals: "{n} years / add-ons ending soon",
      staff_late: "{n} staff came late today",
    },
    alerts1: {
      tg_new: "1 new Telegram order waiting",
      waiting: "1 online order / booking waiting",
      ev_review: "1 ticket payment to check",
      checkout_late: "1 guest past their check-out",
      arrivals: "1 guest arriving today",
      open_bills: "1 bill still open",
      sold_out: "1 product sold out",
      low_stock: "1 product low on stock",
      renewals: "1 year / add-on ending soon",
      staff_late: "1 staff member came late today",
    },
  },
  km: {
    hello: "☀️ <b>អរុណសួស្តី {name}</b>",
    yesterday: "💰 ម្សិលមិញ៖ <b>{money}</b>",
    noSales: "💰 ម្សិលមិញគ្មានការលក់",
    week: "📈 សប្តាហ៍នេះ៖ {pct} ធៀបនឹងសប្តាហ៍មុន",
    needYou: "🔔 <b>មាន {n} ដែលត្រូវការអ្នក</b>",
    needYou1: "🔔 <b>មាន 1 ដែលត្រូវការអ្នក</b>",
    allGood: "✅ ស្ងប់ស្ងាត់ — គ្មានអ្វីរង់ចាំអ្នកទេ។",
    tips: "🛠 មាន {n} ដែលត្រូវរៀបចំ — បើក Bizi ក្នុង BizHub",
    open: "បើក BizHub",
    weekHead: "📊 <b>សប្តាហ៍មុន</b> ({from} → {to})",
    weekTotal: "💰 {money}",
    weekChange: "{pct} ធៀបនឹងសប្តាហ៍មុននោះ",
    weekBest: "🏆 ថ្ងៃល្អបំផុត៖ {day} · {money}",
    weekTops: "🔥 លក់ដាច់ជាងគេ៖ {list}",
    weekUp: "⬆️ {name} {pct}",
    weekDown: "⬇️ {name} {pct}",
    waited: "រង់ចាំ {min} នាទី",
    linked: "✅ <b>Bizi បានភ្ជាប់ហើយ។</b>\nអ្នកនឹងទទួលសេចក្តីសង្ខេបខ្លីរៀងរាល់ព្រឹក របាយការណ៍សប្តាហ៍មុននៅថ្ងៃច័ន្ទ និងសារពេលមានអ្វីរង់ចាំអ្នក។\nប្តូរបាននៅ BizHub → Bizi → ⚙️។",
    expired: "⌛️ តំណនេះផុតកំណត់ហើយ។ បើក BizHub → Bizi → ⚙️ → Telegram → ភ្ជាប់ ម្តងទៀត។",
    test: "👋 សួស្តីពី Bizi! នេះជាសារសាកល្បង — សារនឹងមកទីនេះ។",
    days: ["ច័ន្ទ", "អង្គារ", "ពុធ", "ព្រហស្បតិ៍", "សុក្រ", "សៅរ៍", "អាទិត្យ"],
    alerts: {
      tg_new: "ការកម្ម៉ង់ Telegram ថ្មី {n} កំពុងរង់ចាំ",
      waiting: "ការកម្ម៉ង់ / ការកក់តាមអនឡាញ {n} កំពុងរង់ចាំ",
      ev_review: "ការបង់សំបុត្រ {n} ត្រូវពិនិត្យ",
      checkout_late: "ភ្ញៀវ {n} នាក់ហួសម៉ោងចេញ",
      arrivals: "ភ្ញៀវ {n} នាក់មកដល់ថ្ងៃនេះ",
      open_bills: "វិក្កយបត្រ {n} នៅបើក",
      sold_out: "ទំនិញ {n} អស់ស្តុក",
      low_stock: "ទំនិញ {n} ស្តុកតិច",
      renewals: "ឆ្នាំ / មុខងារបន្ថែម {n} ជិតផុតកំណត់",
      staff_late: "បុគ្គលិក {n} នាក់មកយឺតថ្ងៃនេះ",
    },
    alerts1: {},
  },
};
const fill = (s, v = {}) => Object.entries(v).reduce((a, [k, x]) => a.split(`{${k}}`).join(String(x)), s);
const money = (v, cur) => (cur === "KHR" ? `${new Intl.NumberFormat("en-US").format(Math.round(Number(v) || 0))}៛` : `$${(Number(v) || 0).toFixed(2)}`);
const pct = (n) => `${n > 0 ? "+" : ""}${n}%`;
const dayName = (day, t) => {
  const d = new Date(`${day}T00:00:00Z`);
  return `${t.days[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()}`;
};
const alertText = (a, t) => fill((a.n === 1 && t.alerts1[a.key]) || t.alerts[a.key] || a.key, { n: a.n });
const linkOf = (a) => (a.href ? `${site()}${a.href}` : a.business_id ? `${site()}/app/business/${a.business_id}${a.tab ? `?tab=${a.tab}` : ""}` : `${site()}/app/dashboard`);

// the morning summary from a brief
function morningText(b, name, t) {
  const s = b.summary || {};
  const lines = [fill(t.hello, { name: esc(name) }), "", s.yesterday > 0 ? fill(t.yesterday, { money: money(s.yesterday, s.currency) }) : t.noSales];
  if (s.change_pct !== null && s.change_pct !== undefined) lines.push(fill(t.week, { pct: pct(s.change_pct) }));
  const alerts = b.alerts || [];
  lines.push("", alerts.length === 1 ? t.needYou1 : alerts.length ? fill(t.needYou, { n: alerts.length }) : t.allGood);
  for (const a of alerts.slice(0, 6)) lines.push(`• ${esc(alertText(a, t))}${a.business ? ` — ${esc(a.business)}` : ""}`);
  if ((b.tips || []).length) lines.push("", fill(t.tips, { n: b.tips.length }));
  return lines.join("\n");
}

// last week's report
function weeklyText(wk, t) {
  const lines = [fill(t.weekHead, { from: dayName(wk.from, t), to: dayName(wk.to, t) }), fill(t.weekTotal, { money: money(wk.total, wk.currency) }) + (wk.change_pct !== null && wk.change_pct !== undefined ? ` · ${fill(t.weekChange, { pct: pct(wk.change_pct) })}` : "")];
  if (wk.best_day) lines.push(fill(t.weekBest, { day: dayName(wk.best_day.day, t), money: money(wk.best_day.sales, wk.currency) }));
  if ((wk.top || []).length) lines.push(fill(t.weekTops, { list: wk.top.map((x) => `${esc(x.name)} ×${x.qty}`).join(" · ") }));
  for (const x of wk.up || []) lines.push(fill(t.weekUp, { name: esc(x.name), pct: pct(x.change_pct) }));
  for (const x of wk.down || []) lines.push(fill(t.weekDown, { name: esc(x.name), pct: pct(x.change_pct) }));
  return lines.join("\n");
}

// one owner: what is due now → messages; returns the new "sent" record (or null when nothing changed)
async function dueFor(p, { brief, ownerName, now = new Date() }) {
  const tg = p.tg || {};
  const t = T[tg.lang] || T.km;
  const sent = { ...(tg.sent || {}), alerts: { ...(tg.sent?.alerts || {}) } };
  const local = new Date(now.getTime() + 7 * 3600e3);
  const day = local.toISOString().slice(0, 10);
  const hhmm = local.toISOString().slice(11, 16);
  const out = [];
  const open = telegram.keyboard([[{ text: t.open, url: `${site()}/app/dashboard` }]]);
  const b = await brief();
  if (hhmm >= MORNING && sent.morning !== day) {
    if (tg.weekly !== false && b.weekly?.week && sent.weekly !== b.weekly.week) {
      out.push({ text: weeklyText(b.weekly, t), extra: open });
      sent.weekly = b.weekly.week;
    }
    if (tg.morning !== false) out.push({ text: morningText(b, ownerName, t), extra: open });
    sent.morning = day;
  }
  if (tg.alerts !== false) {
    for (const a of (b.alerts || []).filter((x) => x.level === "warn" && ALERT_KEYS.includes(x.key))) {
      const k = `${a.key}:${a.business_id || ""}`;
      const last = sent.alerts[k];
      const again = !last || a.n > (last.n || 0) || now - new Date(last.at) > ALERT_AGAIN_MS;
      if (!again) continue;
      const min = a.at ? Math.round((now - new Date(a.at)) / 60e3) : 0;
      out.push({ text: `⏰ <b>${esc(alertText(a, t))}</b>${min >= 5 ? ` (${fill(t.waited, { min })})` : ""}${a.business ? `\n${esc(a.business)}` : ""}`, extra: telegram.keyboard([[{ text: t.open, url: linkOf(a) }]]) });
      sent.alerts[k] = { n: a.n, at: now };
    }
    // alerts that ended are forgotten (so a new one later is told again)
    for (const k of Object.keys(sent.alerts)) if (!(b.alerts || []).some((a) => `${a.key}:${a.business_id || ""}` === k)) delete sent.alerts[k];
  }
  return { out, sent };
}

// the scheduler: every linked owner, a few at a time
async function tick({ limit = 200 } = {}) {
  if (!telegram.ready()) return { skipped: "not_configured" };
  const { brief } = require("./bizi.route");
  const Customer = require("../user/customer.model");
  const list = await BiziPrefs.find({ "tg.chat_id": { $gt: "" } })
    .sort({ "tg.checked_at": 1 })
    .limit(limit)
    .lean();
  let sent = 0;
  let gone = 0;
  for (const p of list) {
    try {
      const owner = await Customer.findById(p.customer_id).select("name").lean();
      if (!owner) continue;
      const { out, sent: next } = await dueFor(p, { brief: () => brief(p.customer_id), ownerName: owner.name || "" });
      let blocked = false;
      for (const m of out) {
        try {
          await telegram.send(p.tg.chat_id, m.text, m.extra);
          sent += 1;
        } catch (err) {
          if (err.message === "blocked") blocked = true;
          else console.error("[bizi telegram]", err.message);
          break;
        }
      }
      // the person blocked the bot → unlink (they can link again)
      if (blocked) {
        gone += 1;
        await BiziPrefs.updateOne({ _id: p._id }, { $set: { "tg.chat_id": "", "tg.chat_name": "", "tg.sent": {} } });
      } else await BiziPrefs.updateOne({ _id: p._id }, { $set: { "tg.sent": next, "tg.checked_at": new Date() } });
    } catch (err) {
      console.error("[bizi telegram]", err.message);
    }
  }
  return { owners: list.length, sent, unlinked: gone };
}

module.exports = (prop) => {
  const path = "/api/user/bizi/telegram";
  const fail = (res, err) => {
    if (err instanceof telegram.TelegramError) return res.status(err.status || 502).json({ success: false, code: err.message, message: err.message === "not_configured" ? "Telegram is not set up yet." : err.message === "blocked" ? "This Telegram blocked the bot — connect again." : "Can't reach Telegram, please try again." });
    console.error("[bizi telegram]", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  };

  // someone pressed Start in Telegram with our code ("bz_" + 24 letters / numbers)
  telegram.onStart(async (code, chat) => {
    if (!/^bz_[A-Za-z0-9]{24}$/.test(code)) return null;
    const p = await BiziPrefs.findOne({ "tg.link_code": code, "tg.link_expires": { $gt: new Date() } });
    if (!p) return T.km.expired + "\n" + T.en.expired;
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "Telegram");
    p.set({ "tg.chat_id": String(chat.id), "tg.chat_name": name.slice(0, 80), "tg.connected_at": new Date(), "tg.link_code": "", "tg.link_expires": null, "tg.sent": { morning: khDay() } });
    await p.save();
    return (T[p.tg.lang] || T.km).linked;
  });

  prop.app.post(`${path}/link`, prop.api_auth, customer_auth, async (req, res) => {
    try {
      if (!telegram.ready()) throw new telegram.TelegramError("not_configured", 503);
      const bot = await telegram.botUsername();
      const code = `bz_${crypto.randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, "").padEnd(24, "x").slice(0, 24)}`;
      const expires = new Date(Date.now() + LINK_MINUTES * 60e3);
      const lang = req.body?.lang === "en" ? "en" : "km";
      await BiziPrefs.updateOne({ customer_id: req.customer._id }, { $set: { "tg.link_code": code, "tg.link_expires": expires, "tg.lang": lang } }, { upsert: true });
      res.json({ success: true, data: { url: `https://t.me/${bot}?start=${code}`, expires_at: expires } });
    } catch (err) {
      fail(res, err);
    }
  });
  prop.app.post(`${path}/test`, prop.api_auth, customer_auth, async (req, res) => {
    try {
      const p = await BiziPrefs.findOne({ customer_id: req.customer._id }).lean();
      if (!p?.tg?.chat_id) return res.status(400).json({ success: false, code: "not_connected", message: "Telegram is not connected." });
      await telegram.send(p.tg.chat_id, (T[p.tg.lang] || T.km).test);
      res.json({ success: true });
    } catch (err) {
      if (err instanceof telegram.TelegramError && err.message === "blocked") await BiziPrefs.updateOne({ customer_id: req.customer._id }, { $set: { "tg.chat_id": "", "tg.chat_name": "" } });
      fail(res, err);
    }
  });
  prop.app.delete(path, prop.api_auth, customer_auth, async (req, res) => {
    try {
      await BiziPrefs.updateOne({ customer_id: req.customer._id }, { $set: { "tg.chat_id": "", "tg.chat_name": "", "tg.connected_at": null, "tg.sent": {} } });
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });
};
module.exports.tick = tick;
module.exports.dueFor = dueFor;
module.exports.morningText = morningText;
module.exports.weeklyText = weeklyText;
