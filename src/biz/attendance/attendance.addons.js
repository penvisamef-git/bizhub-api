// Attendance add-ons (yearly, bought on POST /api/user/businesses/:id/licenses/<key>):
//   att_telegram  daily report + alerts to a Telegram chat
//   att_leave     staff ask for leave on their phone, the owner approves
//   att_selfie    a selfie at every clock in / out (kept 60 days)
//   att_kiosk     a tablet at the door shows a QR that changes every 20 s; staff scan it to clock in (no GPS)
//   att_payroll   monthly pay from salary, absences, late time, overtime, unpaid leave, +/− lines
// (att_staff = +5 staff per yearly slot, bought on POST …/attendance/slots { kind: "staff" })
//
// Owner, base /api/user/businesses/:id/attendance
//   GET|PUT|DELETE /telegram   POST /telegram/link   POST /telegram/test
//   GET /leave?status=&month=   POST /leave   POST /leave/:lid/decide { status, note }   DELETE /leave/:lid   PUT /leave-settings { annual_days }
//   PUT /selfie { required }
//   GET /kiosk   POST /kiosk/:rid/reset
//   GET /payroll?month=[&format=csv]   PUT /payroll/settings   PUT /payroll/salary/:rid { salary }   POST /payroll/adjust   DELETE /payroll/adjust/:aid
// Staff (x-att-token):  GET|POST /api/att/leave   DELETE /api/att/leave/:lid
// Door kiosk (public):  GET /api/att/kiosk/:token
// Cron:                 GET /api/cron/attendance-report (also run by /api/cron/daily-report)
const crypto = require("crypto");
const M = require("./attendance.models");
const C = require("./attendance.calc");
const { holidayMap } = require("./attendance.days");
const { planOf, workDaysIn } = require("./attendance.plan");
const { khLines } = require("./attendance.khpay");
const { monthStats } = require("./attendance.rewards");
const Business = require("../business.model");
const telegram = require("../../telegram");
const { deleteFile } = require("../../util/cloudinary");
const { rate_limit } = require("../../util/rate_limit");

const LINK_MINUTES = 15;
const X = {
  needTelegram: "សូមដោះសោ “របាយការណ៍តេឡេក្រាម” ជាមុនសិន!",
  needLeave: "សូមដោះសោ “សំណើច្បាប់ឈប់” ជាមុនសិន!",
  needSelfie: "សូមដោះសោ “ថតរូបផ្ទៀងផ្ទាត់” ជាមុនសិន!",
  needKiosk: "សូមដោះសោ “QR នៅមាត់ទ្វារ” ជាមុនសិន!",
  needPayroll: "សូមដោះសោ “បើកប្រាក់ខែ” ជាមុនសិន!",
  notConfigured: "ក្រុមការងារ BizHub មិនទាន់រៀបចំ Telegram bot ទេ។ សូមព្យាយាមពេលក្រោយ។",
  notConnected: "មិនទាន់ភ្ជាប់ Telegram ទេ!",
  blocked: "Telegram នេះបានបិទ bot ហើយ។ សូមភ្ជាប់ម្តងទៀត។",
  unreachable: "មិនអាចទាក់ទង Telegram បានទេ សូមព្យាយាមម្តងទៀត។",
  sent: "បានផ្ញើសារសាកល្បង!",
  disconnected: "បានផ្តាច់ Telegram!",
  badDates: "ថ្ងៃមិនត្រឹមត្រូវ!",
  tooLong: "អាចស្នើបានច្រើនបំផុត 60 ថ្ងៃម្តង។",
  overlap: "មានសំណើច្បាប់នៅថ្ងៃទាំងនេះរួចហើយ។",
  cantCancel: "អាចបោះបង់បានតែសំណើដែលកំពុងរង់ចាំ។",
  kioskOff: "QR នៅមាត់ទ្វារ មិនដំណើរការទេ។",
  payHidden: "ម្ចាស់មិនបានបើកឱ្យមើលប្រាក់ខែទេ។",
};
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const esc = (v) => telegram.escape(String(v ?? ""));

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, staffCtx, settingsOf, statusesOf, licenseState, hooks, Bad, MSG, text, num, bool, oneOf, validId, staffOut } = kit;
  const need = (ctx, key, msg) => {
    if (!ctx.addons[key]?.active) throw new Bad(msg, 402, { product: key });
  };
  const ownerName = (req) => req.customer?.name || "owner";

  // ===================================== TELEGRAM =====================================
  const tgStatus = (s, ctx) => ({
    configured: telegram.ready(),
    active: !!ctx.addons.att_telegram?.active,
    connected: !!s.telegram?.chat_id,
    chat_name: s.telegram?.chat_name || "",
    chat_type: s.telegram?.chat_type || "",
    connected_at: s.telegram?.connected_at || null,
    daily_report: s.telegram?.daily_report !== false,
    report_time: s.telegram?.report_time || "18:00",
    late_alert: s.telegram?.late_alert !== false,
    review_alert: s.telegram?.review_alert !== false,
    leave_alert: s.telegram?.leave_alert !== false,
    out_alert: s.telegram?.out_alert !== false,
    fix_alert: s.telegram?.fix_alert !== false,
    monthly: s.telegram?.monthly !== false,
  });
  const tgFail = (err) => {
    if (err instanceof telegram.TelegramError) throw new Bad(err.message === "not_configured" ? X.notConfigured : err.message === "blocked" ? X.blocked : X.unreachable, err.status);
    throw err;
  };
  const setTg = (doc, values) => Object.entries(values).forEach(([k, v]) => doc.set(`telegram.${k}`, v));
  // send to the business chat if the add-on is on and a chat is linked
  async function tgSend(bid, settings, html, state) {
    if (!settings.telegram?.chat_id) return false;
    const st = state || (await licenseState(bid));
    if (!st.addons.att_telegram?.active || st.license.locked) return false;
    try {
      await telegram.send(settings.telegram.chat_id, html);
      return true;
    } catch (err) {
      if (err instanceof telegram.TelegramError && err.message === "blocked") await M.AttSettings.updateOne({ _id: settings._id }, { $set: { "telegram.chat_id": "" } });
      return false;
    }
  }

  // codes start with "att_" so the restaurant's handler leaves them alone
  telegram.onStart(async (code, chat) => {
    if (!/^att_[A-Za-z0-9]{12,40}$/.test(code)) return null;
    const s = await M.AttSettings.findOne({ "telegram.link_code": code, "telegram.link_expires": { $gt: new Date() } });
    if (!s) return "⌛️ This link has expired. Open BizHub → Attendance → Telegram → Connect again.\nតំណនេះផុតកំណត់ហើយ។ សូមចុច “ភ្ជាប់” ម្តងទៀត។";
    const business = await Business.findById(s.business_id).select("name").lean();
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "Telegram");
    setTg(s, { chat_id: String(chat.id), chat_name: name.slice(0, 80), chat_type: chat.type || "private", connected_at: new Date(), link_code: "", link_expires: null });
    await s.save();
    return `✅ <b>${esc(business?.name || "Attendance")}</b> attendance is connected to this chat.\nវត្តមានបុគ្គលិកបានភ្ជាប់ជាមួយ BizHub ហើយ។\n\n📊 Daily report: ${s.telegram.daily_report ? s.telegram.report_time : "off"}`;
  });

  const tgPath = `${base}/telegram`;
  prop.app.get(
    tgPath,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      res.json({ success: true, data: tgStatus(await settingsOf(ctx.business._id), ctx) });
    }),
  );
  prop.app.post(
    `${tgPath}/link`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx, "att_telegram", X.needTelegram);
      if (!telegram.ready()) throw new Bad(X.notConfigured, 503);
      const bot = await telegram.botUsername().catch(tgFail);
      const s = await settingsOf(ctx.business._id);
      const code = `att_${crypto.randomBytes(18).toString("base64url").replace(/[-_]/g, "").slice(0, 20)}`;
      const expires = new Date(Date.now() + LINK_MINUTES * 60000);
      setTg(s, { link_code: code, link_expires: expires });
      await s.save();
      res.json({ success: true, data: { url: `https://t.me/${bot}?start=${code}`, group_url: `https://t.me/${bot}?startgroup=${code}`, bot, expires_at: expires } });
    }),
  );
  prop.app.put(
    tgPath,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx, "att_telegram", X.needTelegram);
      const s = await settingsOf(ctx.business._id);
      const b = req.body || {};
      for (const k of ["daily_report", "late_alert", "review_alert", "leave_alert", "out_alert", "fix_alert", "monthly"]) if (b[k] !== undefined) s.set(`telegram.${k}`, bool(b, k));
      if (b.report_time !== undefined) {
        if (!M.HHMM.test(String(b.report_time))) throw new Bad(`${MSG.badValue} (report_time)`);
        s.set("telegram.report_time", b.report_time);
      }
      await s.save();
      res.json({ success: true, data: tgStatus(s, ctx), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${tgPath}/test`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx, "att_telegram", X.needTelegram);
      const s = await settingsOf(ctx.business._id);
      if (!s.telegram?.chat_id) throw new Bad(X.notConnected);
      try {
        await telegram.send(s.telegram.chat_id, `🔔 <b>${esc(ctx.business.name)}</b>\nTest message from BizHub Attendance — everything works.\nសារសាកល្បងពី BizHub — ដំណើរការល្អ។`);
      } catch (err) {
        if (err instanceof telegram.TelegramError && err.message === "blocked") {
          s.set("telegram.chat_id", "");
          await s.save();
        }
        tgFail(err);
      }
      res.json({ success: true, message: X.sent });
    }),
  );
  prop.app.delete(
    tgPath,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const s = await settingsOf(ctx.business._id);
      const chat = s.telegram?.chat_id;
      setTg(s, { chat_id: "", chat_name: "", chat_type: "", connected_at: null, link_code: "", link_expires: null });
      await s.save();
      if (chat) telegram.send(chat, "🔌 BizHub Attendance disconnected from this chat.\nបានផ្តាច់ពី BizHub ហើយ។").catch(() => {});
      res.json({ success: true, data: tgStatus(s, ctx), message: X.disconnected });
    }),
  );

  // alerts right after a clock in / out
  hooks.notify = (bid, settings, html, state) => tgSend(bid, settings, html, state);
  hooks.onPunch = async (ctx, punch, shift) => {
    const s = ctx.settings;
    if (!s.telegram?.chat_id || !ctx.addons.att_telegram?.active) return;
    const name = esc(ctx.staff.name);
    const time = new Date(punch.at.getTime() + 7 * C.HOUR).toISOString().slice(11, 16);
    const lines = [];
    if (punch.kind === "in" && s.telegram.late_alert !== false && shift) {
      const st = C.dayStatus({ day: punch.day, shift, punches: [punch], rules: s.rules });
      if (st.late_min > 0) lines.push(`⏰ <b>${name}</b> clocked in late at ${time} (${st.late_min} min) · មកយឺត`);
    }
    if (punch.review === "pending" && s.telegram.review_alert !== false) {
      const why = punch.flags
        .map((f) => ({ outside: `outside the branch${punch.distance_m ? ` (${punch.distance_m} m)` : ""}`, no_gps: "no location", low_accuracy: "weak GPS", no_branch: "branch has no location", no_photo: "no selfie" })[f] || f)
        .join(", ");
      lines.push(`⚠️ <b>${name}</b> ${punch.kind === "in" ? "clocked in" : "clocked out"} at ${time} — needs review: ${esc(why)} · ត្រូវពិនិត្យ`);
    }
    if (lines.length) await tgSend(ctx.staff.business_id, s, `<b>${esc(ctx.business.name)}</b>\n${lines.join("\n")}`, ctx);
  };

  // the day's report: who came, late, absent, on leave, forgot to clock out
  async function dayReport(settings, business, day) {
    const staff = await M.AttStaff.find({ business_id: business._id, active: true }).sort({ sort: 1 }).lean();
    if (!staff.length) return null;
    const { out } = await statusesOf(business._id, staff, [day], settings);
    const rows = staff.map((s) => ({ s, st: out[s._id][day] }));
    const pick = (fn) => rows.filter(fn);
    const came = pick((r) => ["present", "working", "missing_out", "extra"].includes(r.st.status));
    const late = pick((r) => r.st.late_min > 0);
    const absent = pick((r) => r.st.status === "absent" || r.st.status === "not_yet");
    const leave = pick((r) => r.st.status === "leave");
    const missing = pick((r) => r.st.status === "missing_out" || r.st.status === "working");
    const pending = rows.reduce((a, r) => a + r.st.pending, 0);
    const scheduled = rows.filter((r) => r.st.work_day).length;
    const t = (d) => (d ? new Date(new Date(d).getTime() + 7 * C.HOUR).toISOString().slice(11, 16) : "—");
    const L = [`📋 <b>${esc(business.name)}</b> · Attendance ${day}`, `✅ Came: <b>${came.length}</b> / ${scheduled || staff.length}`];
    const holiday = rows.find((r) => r.st.holiday)?.st.holiday;
    if (holiday) L.splice(1, 0, `🎉 Holiday: ${esc(holiday)}`);
    if (late.length) L.push("", `⏰ Late (${late.length})`, ...late.map((r) => `• ${esc(r.s.name)} — ${t(r.st.first_in)} (+${r.st.late_min} min)`));
    if (absent.length) L.push("", `❌ Absent (${absent.length})`, ...absent.map((r) => `• ${esc(r.s.name)}`));
    if (leave.length) L.push("", `🌴 On leave (${leave.length})`, ...leave.map((r) => `• ${esc(r.s.name)} (${r.st.leave_type})`));
    if (missing.length) L.push("", `🕘 Not clocked out yet (${missing.length})`, ...missing.map((r) => `• ${esc(r.s.name)} — in ${t(r.st.first_in)}`));
    if (pending) L.push("", `⚠️ ${pending} record(s) need review in BizHub`);
    const hr = hooks.hrLines ? await hooks.hrLines(business._id, staff, (await licenseState(business._id)).addons).catch(() => []) : [];
    if (hr.length) L.push("", ...hr);
    return L.join("\n");
  }

  // "still clocked in" — once per person per day, 30 minutes after their shift ended
  async function outAlerts() {
    const now = Date.now();
    const today = C.localDay(now);
    const list = await M.AttSettings.find({ "telegram.chat_id": { $gt: "" }, "telegram.out_alert": { $ne: false } }).limit(500);
    let sent = 0;
    for (const s of list) {
      const business = await Business.findOne({ _id: s.business_id, deleted: false, status: true }).lean();
      if (!business) continue;
      const staff = await M.AttStaff.find({ business_id: business._id, active: true }).lean();
      if (!staff.length) continue;
      const days = [C.addDays(today, -1), today];
      const { out } = await statusesOf(business._id, staff, days, s);
      const done = s.telegram?.out_alerted?.day === today ? s.telegram.out_alerted.ids : [];
      const late = [];
      for (const st of staff)
        for (const d of days) {
          const x = out[st._id][d];
          if (x.status === "working" && x.end && now > new Date(x.end).getTime() + 30 * C.MIN && !done.includes(String(st._id))) late.push({ st, x });
        }
      if (!late.length) continue;
      const t = (v) => new Date(new Date(v).getTime() + 7 * C.HOUR).toISOString().slice(11, 16);
      const html = [`🕘 <b>${esc(business.name)}</b> · Still clocked in after the shift`, ...late.map(({ st, x }) => `• ${esc(st.name)} — in ${t(x.first_in)}, shift ended ${t(x.end)}`), "", "Remind them to clock out · សូមរំលឹកឱ្យចុះចេញ"].join("\n");
      s.set("telegram.out_alerted", { day: today, ids: [...done, ...late.map(({ st }) => String(st._id))] });
      await s.save();
      if (await tgSend(business._id, s, html)) sent += 1;
    }
    return sent;
  }

  // last month in one message (sent on the 1st–3rd, once per month)
  async function monthReport(settings, business, month) {
    const staff = await M.AttStaff.find({ business_id: business._id, active: true }).sort({ sort: 1 }).lean();
    if (!staff.length) return null;
    const days = C.daysOfMonth(month);
    const { out } = await statusesOf(business._id, staff, days, settings);
    const rows = staff.map((s) => {
      const list = days.map((d) => out[s._id][d]);
      return { s, t: C.monthSummary(list), r: monthStats(list) };
    });
    const h = (min) => `${Math.floor(min / 60)}h${min % 60 ? String(min % 60).padStart(2, "0") : ""}`;
    const label = new Date(`${month}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    const L = [`📅 <b>${esc(business.name)}</b> · ${label}`, ""];
    for (const { s, t } of rows) {
      const bits = [`${t.present}/${t.work_days} days`, h(t.worked_min)];
      if (t.late) bits.push(`⏰ ${t.late} late`);
      if (t.absent) bits.push(`❌ ${t.absent} absent`);
      if (t.leave) bits.push(`🌴 ${t.leave} leave`);
      if (t.ot_min) bits.push(`➕ ${h(t.ot_min)} OT`);
      L.push(`• <b>${esc(s.name)}</b> — ${bits.join(" · ")}`);
    }
    const perfect = rows.filter((x) => x.r.perfect);
    const sum = rows.reduce((a, x) => ({ late: a.late + x.t.late, absent: a.absent + x.t.absent, min: a.min + x.t.worked_min }), { late: 0, absent: 0, min: 0 });
    L.push("", `Total: ${h(sum.min)} worked · ${sum.late} late · ${sum.absent} absent`);
    if (perfect.length) L.push(`🏆 Never late: ${perfect.map((x) => esc(x.s.name)).join(", ")}`);
    return L.join("\n");
  }
  async function monthReports() {
    const local = C.localDay(Date.now());
    if (Number(local.slice(8)) > 3) return 0;
    const [y, m] = local.slice(0, 7).split("-").map(Number);
    const month = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    const list = await M.AttSettings.find({ "telegram.chat_id": { $gt: "" }, "telegram.monthly": { $ne: false }, "telegram.last_month": { $ne: month } }).limit(200);
    let sent = 0;
    for (const s of list) {
      const business = await Business.findOne({ _id: s.business_id, deleted: false, status: true }).lean();
      s.set("telegram.last_month", month);
      await s.save();
      if (!business || !(await licenseState(business._id)).addons?.att_telegram?.active) continue;
      const html = await monthReport(s, business, month);
      if (html && (await tgSend(business._id, s, html))) sent += 1;
    }
    return sent;
  }

  async function dailyReports() {
    const out_alerts = await outAlerts().catch((err) => (console.error("[attendance-out-alerts]", err), 0));
    const month_reports = await monthReports().catch((err) => (console.error("[attendance-month-reports]", err), 0));
    const now = new Date();
    const local = new Date(now.getTime() + 7 * C.HOUR);
    const hhmm = local.toISOString().slice(11, 16);
    const day = local.toISOString().slice(0, 10);
    const dayStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 7 * C.HOUR);
    const list = await M.AttSettings.find({
      "telegram.chat_id": { $gt: "" },
      "telegram.daily_report": { $ne: false },
      "telegram.report_time": { $lte: hhmm },
      $or: [{ "telegram.last_report_at": null }, { "telegram.last_report_at": { $lt: dayStart } }],
    }).limit(200);
    let sent = 0;
    for (const s of list) {
      const business = await Business.findOne({ _id: s.business_id, deleted: false, status: true }).lean();
      s.set("telegram.last_report_at", now);
      await s.save();
      if (!business) continue;
      const html = await dayReport(s, business, day);
      if (html && (await tgSend(business._id, s, html))) sent += 1;
    }
    return { checked: list.length, sent, out_alerts, month_reports };
  }
  module.exports.dailyReports = dailyReports;
  prop.app.get("/api/cron/attendance-report", async (req, res) => {
    const secret = process.env.CRON_SECRET || "";
    const given = (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || String(req.query.key || "");
    if (!secret || given !== secret) return res.sendStatus(404);
    try {
      res.json({ success: true, ...(await dailyReports()) });
    } catch (err) {
      console.error("[attendance-report]", err);
      res.status(500).json({ success: false });
    }
  });

  // ===================================== LEAVE =====================================
  // work days a leave takes: holidays and days off don't count
  async function leaveDays(bid, staff, from, to) {
    const days = [];
    for (let d = from; d <= to && days.length < 400; d = C.addDays(d, 1)) days.push(d);
    const [plan, hol] = await Promise.all([planOf(bid, [staff], days), holidayMap(bid, from, to)]);
    const open = days.filter((d) => !hol.has(d));
    // no shift at all: every day counts
    if (!staff.shift_id && !open.some((d) => plan.entry(staff, d) !== undefined)) return open.length;
    return workDaysIn(plan, staff, open);
  }
  function readDates(b) {
    const from = String(b.from || "");
    const to = String(b.to || b.from || "");
    if (!YMD.test(from) || !YMD.test(to) || to < from) throw new Bad(X.badDates, 400, { code: "bad_dates" });
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / C.DAY + 1;
    if (span > 60) throw new Bad(X.tooLong, 400, { code: "too_long" });
    const today = C.localDay(Date.now());
    if (from < C.addDays(today, -31) || from > C.addDays(today, 366)) throw new Bad(X.badDates, 400, { code: "bad_dates" });
    return { from, to };
  }
  async function overlaps(bid, staffId, from, to, except) {
    return M.AttLeave.exists({ business_id: bid, staff_id: staffId, status: { $in: ["pending", "approved"] }, from: { $lte: to }, to: { $gte: from }, ...(except ? { _id: { $ne: except } } : {}) });
  }
  // annual leave used this year (approved) vs allowed
  async function balanceOf(bid, staffId, settings) {
    const year = C.localDay(Date.now()).slice(0, 4);
    const rows = await M.AttLeave.find({ business_id: bid, staff_id: staffId, type: "annual", status: "approved", from: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }).lean();
    const used = rows.reduce((a, r) => a + (r.days || 0), 0);
    const allowed = settings.leave?.annual_days ?? 18;
    return { year, allowed, used, left: Math.max(0, allowed - used) };
  }
  hooks.decide.leave = async (bid, lid, status, note, by) => {
    const row = await M.AttLeave.findOne({ _id: lid, business_id: bid });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    if (status === "approved" && (await overlaps(bid, row.staff_id, row.from, row.to, row._id))) throw new Bad(X.overlap, 409, { code: "overlap" });
    row.set({ status, note, decided_by: by, decided_at: new Date() });
    await row.save();
    return row;
  };
  const leaveOut = (l, names) => ({ ...l, staff_name: names ? names.get(String(l.staff_id)) || "?" : undefined });

  prop.app.get(
    `${base}/leave`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const q = { business_id: bid };
      if (M.LEAVE_STATUS.includes(req.query.status)) q.status = req.query.status;
      if (/^\d{4}-\d{2}$/.test(String(req.query.month || ""))) {
        const days = C.daysOfMonth(String(req.query.month));
        Object.assign(q, { from: { $lte: days[days.length - 1] }, to: { $gte: days[0] } });
      }
      const [rows, staff, settings] = await Promise.all([M.AttLeave.find(q).sort({ status: 1, from: -1 }).limit(300).lean(), M.AttStaff.find({ business_id: bid }).select("name").lean(), settingsOf(bid)]);
      const names = new Map(staff.map((s) => [String(s._id), s.name]));
      const pending = await M.AttLeave.countDocuments({ business_id: bid, status: "pending" });
      res.json({ success: true, data: { rows: rows.map((l) => leaveOut(l, names)), pending, annual_days: settings.leave?.annual_days ?? 18, active: !!ctx.addons.att_leave?.active } });
    }),
  );
  // the owner adds leave for someone (approved at once)
  prop.app.post(
    `${base}/leave`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx, "att_leave", X.needLeave);
      const b = req.body || {};
      const bid = ctx.business._id;
      if (!validId(b.staff_id)) throw new Bad(`${MSG.badValue} (staff_id)`);
      const staff = await M.AttStaff.findOne({ _id: b.staff_id, business_id: bid }).lean();
      if (!staff) throw new Bad(MSG.rowNotFound, 404);
      const { from, to } = readDates(b);
      const type = oneOf(b, "type", M.LEAVE_TYPES) || "annual";
      if (await overlaps(bid, staff._id, from, to)) throw new Bad(X.overlap, 409, { code: "overlap" });
      const row = await M.AttLeave.create({ business_id: bid, staff_id: staff._id, type, from, to, days: await leaveDays(bid, staff, from, to), reason: text(b, "reason", 300) || "", status: "approved", by: ownerName(req), decided_at: new Date() });
      res.status(201).json({ success: true, data: leaveOut(row.toObject()), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${base}/leave/:lid/decide`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx, "att_leave", X.needLeave);
      if (!validId(req.params.lid)) throw new Bad(MSG.badId);
      const status = oneOf(req.body || {}, "status", ["approved", "rejected"]);
      if (!status) throw new Bad(`${MSG.required}: status`);
      const row = await hooks.decide.leave(ctx.business._id, req.params.lid, status, text(req.body || {}, "note", 300) || "", ownerName(req));
      res.json({ success: true, data: row, message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/leave/:lid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.lid)) throw new Bad(MSG.badId);
      const r = await M.AttLeave.deleteOne({ _id: req.params.lid, business_id: ctx.business._id });
      if (!r.deletedCount) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, message: MSG.deleted });
    }),
  );
  prop.app.put(
    `${base}/leave-settings`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx, "att_leave", X.needLeave);
      const s = await settingsOf(ctx.business._id);
      const n = num(req.body || {}, "annual_days", 0, 60, { int: true });
      if (n !== undefined) s.set("leave.annual_days", n);
      await s.save();
      res.json({ success: true, data: { annual_days: s.leave.annual_days }, message: MSG.saved });
    }),
  );

  // staff: my leave
  const leaveLimit = rate_limit({ windowMs: 60 * 60 * 1000, max: 30 });
  prop.app.get(
    "/api/att/leave",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      const bid = ctx.staff.business_id;
      const rows = await M.AttLeave.find({ business_id: bid, staff_id: ctx.staff._id }).sort({ from: -1 }).limit(60).lean();
      res.json({ success: true, data: { rows, balance: await balanceOf(bid, ctx.staff._id, ctx.settings), active: !!ctx.addons.att_leave?.active } });
    }),
  );
  prop.app.post(
    "/api/att/leave",
    prop.api_auth,
    leaveLimit,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, true);
      need(ctx, "att_leave", X.needLeave);
      const b = req.body || {};
      const bid = ctx.staff.business_id;
      const { from, to } = readDates(b);
      const type = oneOf(b, "type", M.LEAVE_TYPES) || "annual";
      if (await overlaps(bid, ctx.staff._id, from, to)) throw new Bad(X.overlap, 409, { code: "overlap" });
      const days = await leaveDays(bid, ctx.staff, from, to);
      const row = await M.AttLeave.create({ business_id: bid, staff_id: ctx.staff._id, type, from, to, days, reason: text(b, "reason", 300) || "", status: "pending", by: "staff" });
      if (ctx.settings.telegram?.leave_alert !== false)
        tgSend(
          bid,
          ctx.settings,
          `🌴 <b>${esc(ctx.business.name)}</b>\n<b>${esc(ctx.staff.name)}</b> asks for ${type} leave: ${from}${to !== from ? ` → ${to}` : ""} (${days} day${days === 1 ? "" : "s"})${row.reason ? `\n“${esc(row.reason)}”` : ""}\nApprove in BizHub · សូមពិនិត្យក្នុង BizHub`,
          ctx,
        ).catch(() => {});
      res.status(201).json({ success: true, data: row, balance: await balanceOf(bid, ctx.staff._id, ctx.settings) });
    }),
  );
  prop.app.delete(
    "/api/att/leave/:lid",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      if (!validId(req.params.lid)) throw new Bad(MSG.badId);
      const row = await M.AttLeave.findOne({ _id: req.params.lid, business_id: ctx.staff.business_id, staff_id: ctx.staff._id });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      if (row.status !== "pending") throw new Bad(X.cantCancel, 409, { code: "cant_cancel" });
      row.status = "cancelled";
      await row.save();
      res.json({ success: true, data: row });
    }),
  );

  // ===================================== SELFIE =====================================
  prop.app.put(
    `${base}/selfie`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx, "att_selfie", X.needSelfie);
      const s = await settingsOf(ctx.business._id);
      if (req.body?.required !== undefined) s.set("selfie.required", !!req.body.required);
      await s.save();
      res.json({ success: true, data: { required: s.selfie.required }, message: MSG.saved });
    }),
  );
  // photos older than 60 days are deleted (checked at most once an hour per business)
  const lastClean = new Map();
  hooks.cleanSelfies = async (bid) => {
    const k = String(bid);
    if (process.env.NODE_ENV !== "test" && Date.now() - (lastClean.get(k) || 0) < 3600000) return;
    lastClean.set(k, Date.now());
    const old = await M.AttPunch.find({ business_id: bid, "photo.public_id": { $gt: "" }, at: { $lt: new Date(Date.now() - kit.SELFIE_DAYS * C.DAY) } })
      .select("photo")
      .limit(200)
      .lean();
    for (const p of old) await deleteFile(p.photo.public_id).catch(() => {});
    if (old.length) await M.AttPunch.updateMany({ _id: { $in: old.map((p) => p._id) } }, { $set: { photo: { url: "", public_id: "" } } });
  };

  // ===================================== DOOR KIOSK =====================================
  const kioskToken = () => crypto.randomBytes(18).toString("base64url").replace(/[-_]/g, "").slice(0, 22);
  prop.app.get(
    `${base}/kiosk`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const branches = await M.AttBranch.find({ business_id: ctx.business._id }).sort({ sort: 1, created_date: 1 });
      if (ctx.addons.att_kiosk?.active)
        for (const b of branches)
          if (!b.kiosk_token) {
            b.kiosk_token = kioskToken();
            await b.save();
          }
      res.json({ success: true, data: { active: !!ctx.addons.att_kiosk?.active, seconds: kit.KIOSK_SEC, branches: branches.map((b) => ({ _id: b._id, name: b.name, active: b.active, token: ctx.addons.att_kiosk?.active ? b.kiosk_token : "" })) } });
    }),
  );
  prop.app.post(
    `${base}/kiosk/:rid/reset`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx, "att_kiosk", X.needKiosk);
      if (!validId(req.params.rid)) throw new Bad(MSG.badId);
      const b = await M.AttBranch.findOneAndUpdate({ _id: req.params.rid, business_id: ctx.business._id }, { $set: { kiosk_token: kioskToken() } }, { returnDocument: "after" });
      if (!b) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, data: { _id: b._id, token: b.kiosk_token }, message: MSG.saved });
    }),
  );
  // the tablet asks every few seconds: the code to show + who clocked in lately
  const kioskLimit = rate_limit({ windowMs: 60 * 1000, max: 60 });
  prop.app.get(
    "/api/att/kiosk/:token",
    prop.api_auth,
    kioskLimit,
    handle(async (req, res) => {
      const token = String(req.params.token || "");
      if (!/^[A-Za-z0-9]{16,40}$/.test(token)) throw new Bad(X.kioskOff, 404, { code: "kiosk_off" });
      const branch = await M.AttBranch.findOne({ kiosk_token: token, active: true }).lean();
      if (!branch) throw new Bad(X.kioskOff, 404, { code: "kiosk_off" });
      const [business, state, settings] = await Promise.all([Business.findOne({ _id: branch.business_id, deleted: false }).lean(), licenseState(branch.business_id), settingsOf(branch.business_id)]);
      if (!business || !business.status || state.license.locked || !state.addons.att_kiosk?.active) throw new Bad(X.kioskOff, 402, { code: "kiosk_off" });
      const w = kit.kioskWindow();
      const today = C.localDay(Date.now());
      const recent = await M.AttPunch.find({ business_id: branch.business_id, branch_id: branch._id, day: today }).sort({ at: -1 }).limit(8).lean();
      const staff = await M.AttStaff.find({ _id: { $in: recent.map((p) => p.staff_id) } })
        .select("name")
        .lean();
      const names = new Map(staff.map((s) => [String(s._id), s.name]));
      const left = kit.KIOSK_SEC - Math.floor((Date.now() / 1000) % kit.KIOSK_SEC);
      res.json({
        success: true,
        data: {
          business: { name: business.name, logo_url: settings.logo?.url || business.logo_url || "" },
          color: settings.kiosk_color || "#0F766E",
          theme: await kit.liveKioskTheme(business._id, settings),
          branch: { _id: branch._id, name: branch.name },
          today_in: (await M.AttPunch.distinct("staff_id", { business_id: branch.business_id, branch_id: branch._id, day: today, kind: "in", review: { $ne: "rejected" } })).length,
          staff_total: await M.AttStaff.countDocuments({ business_id: branch.business_id, active: true }),
          code: settings.code,
          k: `${branch._id}.${kit.kioskCode(token, w)}`,
          seconds_left: left,
          seconds: kit.KIOSK_SEC,
          server_time: new Date(),
          recent: recent.map((p) => ({ name: (names.get(String(p.staff_id)) || "").split(/\s+/).slice(-1)[0], kind: p.kind, at: p.at })),
        },
      });
    }),
  );

  // ===================================== PAYROLL =====================================
  const payPath = `${base}/payroll`;
  // only: one staff (their own "My pay"); otherwise everyone active + anyone with records this month
  async function payrollOf(ctx, month, only = null) {
    const bid = ctx.business._id;
    const settings = await settingsOf(bid);
    const days = C.daysOfMonth(month);
    let staff;
    if (only) staff = [only];
    else {
      const withRecords = await M.AttPunch.distinct("staff_id", { business_id: bid, day: { $in: days } });
      staff = await M.AttStaff.find({ business_id: bid, $or: [{ active: true }, { _id: { $in: withRecords } }] })
        .sort({ sort: 1, created_date: 1 })
        .lean();
    }
    const [{ out, shiftOf, plan }, adjustments, overtime] = await Promise.all([
      statusesOf(bid, staff, days, settings),
      M.AttPayAdjust.find({ business_id: bid, month }).sort({ created_date: 1 }).lean(),
      M.AttOvertime.find({ business_id: bid, status: "approved", day: { $in: days } }).lean(),
    ]);
    const pset = settings.payroll?.toObject ? settings.payroll.toObject() : settings.payroll || {};
    const khOn = !!ctx.addons?.att_khpay?.active;
    const rwBonus = ctx.addons?.att_rewards?.active ? Number(settings.rewards?.bonus) || 0 : 0;
    // only approved overtime is paid: a day's overtime stops at the approved "until"
    const okOt = new Map();
    for (const o of overtime) okOt.set(`${o.staff_id}|${o.day}`, o.until);
    const trimOt = (s, d, st) => {
      if (!pset.ot_approval || !st.ot_min) return st;
      const until = okOt.get(`${s._id}|${d}`);
      if (!until || !st.end) return { ...st, ot_min: 0, ot_trimmed: st.ot_min };
      const endMs = new Date(st.end).getTime();
      let u = C.atOf(d, until);
      while (u < endMs) u += C.DAY;
      const allowed = Math.max(0, Math.round((u - endMs) / C.MIN));
      return allowed >= st.ot_min ? st : { ...st, ot_min: allowed, ot_trimmed: st.ot_min - allowed };
    };
    const rows = staff.map((s) => {
      const shift = s.shift_id ? shiftOf.get(String(s.shift_id)) || null : null;
      const list = days.map((d) => trimOt(s, d, out[s._id][d]));
      const since = s.created_date ? C.localDay(s.created_date) : "";
      // with a roster, the month's work days come from the plan (rostered shifts and days off)
      const byPlan = plan.on && days.some((d) => plan.entry(s, d) !== undefined);
      const pay = C.payOf({
        salary: s.salary || 0,
        pay_type: s.pay_type || "monthly",
        shift: shift || (byPlan ? days.map((d) => plan.at(s, d)).find(Boolean) || null : null),
        month,
        days: list,
        since,
        adjustments: adjustments.filter((a) => String(a.staff_id) === String(s._id)),
        settings: pset,
        work_days: byPlan ? workDaysIn(plan, s, days) : null,
        my_days: byPlan ? workDaysIn(plan, s, days, since) : null,
      });
      // on-time rewards: a perfect month adds the bonus (before tax)
      if (rwBonus > 0 && monthStats(list).perfect) {
        pay.reward = rwBonus;
        pay.net = pset.currency === "KHR" ? Math.round(pay.net + rwBonus) : Math.round((pay.net + rwBonus) * 100) / 100;
      }
      const row = { staff: staffOut(s), shift: shift ? { name: shift.name, start: shift.start, end: shift.end } : null, ...pay, ot_unpaid_min: list.reduce((a, d) => a + (d.ot_trimmed || 0), 0) };
      // Cambodia payroll: seniority, NSSF and tax on salary on top of the month's pay
      if (khOn && (s.salary || 0) > 0) {
        row.kh = khLines({ gross: pay.net, daily: pay.daily_rate, month, currency: pay.currency, staff: s, settings: pset.kh || {} });
        row.gross = pay.net;
        row.net = row.kh.net;
      }
      return row;
    });
    const total = rows.reduce((a, r) => a + r.net, 0);
    const rnd = (v) => (pset.currency === "KHR" ? Math.round(v) : Math.round(v * 100) / 100);
    const kh = khOn
      ? {
          on: true,
          tax: rnd(rows.reduce((a, r) => a + (r.kh?.tax || 0), 0)),
          nssf_staff: rnd(rows.reduce((a, r) => a + (r.kh?.pension_ee || 0), 0)),
          nssf_employer: rnd(rows.reduce((a, r) => a + (r.kh?.employer.total || 0), 0)),
          seniority: rnd(rows.reduce((a, r) => a + (r.kh?.seniority || 0), 0)),
        }
      : { on: false };
    return { month, settings: pset, rows, total: rnd(total), kh };
  }
  prop.app.get(
    payPath,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      need(ctx, "att_payroll", X.needPayroll);
      const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || "")) ? String(req.query.month) : C.localDay(Date.now()).slice(0, 7);
      const p = await payrollOf(ctx, month);
      if (req.query.format === "bank") {
        // bank transfer list: who gets how much, to which account
        const km = req.query.lang === "km";
        const H = km ? ["ល.រ", "ឈ្មោះ", "ធនាគារ", "លេខគណនី", "ឈ្មោះគណនី", "ចំនួនទឹកប្រាក់", "រូបិយប័ណ្ណ", "ពិពណ៌នា"] : ["No", "Name", "Bank", "Account number", "Account name", "Amount", "Currency", "Description"];
        const lines = [H.map(kit.csvCell).join(",")];
        let n = 0;
        for (const r of p.rows)
          if (r.net > 0) lines.push([++n, r.staff.name, r.staff.bank_name || "", r.staff.bank_account ? `'${r.staff.bank_account}` : "", r.staff.account_name || r.staff.name, r.net, r.currency, `Salary ${month}`].map(kit.csvCell).join(","));
        lines.push(["", "", "", "", km ? "សរុប" : "Total", p.total, p.settings.currency, ""].map(kit.csvCell).join(","));
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="bank-transfer-${month}.csv"`);
        return res.send(`\uFEFF${lines.join("\r\n")}`);
      }
      if (req.query.format === "csv") {
        const km = req.query.lang === "km";
        const H = km
          ? [
              "ឈ្មោះ",
              "តួនាទី",
              "ប្រាក់ខែ",
              "ថ្ងៃធ្វើការ",
              "ប្រាក់ខែមូលដ្ឋាន",
              "អវត្តមាន (ថ្ងៃ)",
              "កាត់អវត្តមាន",
              "យឺត (នាទី)",
              "កាត់យឺត",
              "ច្បាប់គ្មានប្រាក់ (ថ្ងៃ)",
              "កាត់ច្បាប់",
              "ច្បាប់មានប្រាក់ (ថ្ងៃ)",
              "ថែមម៉ោង (នាទី)",
              "ប្រាក់ថែមម៉ោង",
              "ថ្ងៃបន្ថែម",
              "ប្រាក់ថ្ងៃបន្ថែម",
              "បូក/ដក",
              "សរុបទទួល",
              "រូបិយប័ណ្ណ",
            ]
          : [
              "Name",
              "Position",
              "Salary",
              "Work days",
              "Base",
              "Absent days",
              "Absent deduction",
              "Late (min)",
              "Late deduction",
              "Unpaid leave days",
              "Unpaid leave deduction",
              "Paid leave days",
              "Overtime (min)",
              "Overtime pay",
              "Extra days",
              "Extra day pay",
              "Adjustments",
              "Net pay",
              "Currency",
            ];
        const lines = [H.map(kit.csvCell).join(",")];
        for (const r of p.rows)
          lines.push(
            [
              r.staff.name,
              r.staff.position,
              r.salary,
              r.work_days,
              r.base,
              r.absent_days,
              r.absent_ded,
              r.late_min,
              r.late_ded,
              r.unpaid_days,
              r.unpaid_ded,
              r.paid_leave_days,
              r.ot_min,
              r.ot_pay,
              r.extra_days,
              r.extra_pay,
              r.adj_total,
              r.net,
              r.currency,
            ]
              .map(kit.csvCell)
              .join(","),
          );
        lines.push(["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", km ? "សរុប" : "Total", p.total, p.settings.currency].map(kit.csvCell).join(","));
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="payroll-${month}.csv"`);
        return res.send(`﻿${lines.join("\r\n")}`);
      }
      res.json({ success: true, data: p });
    }),
  );
  prop.app.put(
    `${payPath}/settings`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx, "att_payroll", X.needPayroll);
      const b = req.body || {};
      const s = await settingsOf(ctx.business._id);
      const cur = oneOf(b, "currency", ["USD", "KHR"]);
      if (cur) s.set("payroll.currency", cur);
      const rate = num(b, "ot_rate", 1, 5);
      if (rate !== undefined) s.set("payroll.ot_rate", rate);
      const hrate = num(b, "holiday_rate", 1, 5);
      if (hrate !== undefined) s.set("payroll.holiday_rate", hrate);
      for (const k of ["deduct_late", "deduct_absent", "pay_extra_days", "show_staff", "ot_approval"]) if (b[k] !== undefined) s.set(`payroll.${k}`, !!b[k]);
      // Cambodia payroll lines and rates
      if (b.kh && typeof b.kh === "object") {
        for (const k of ["tax", "nssf", "seniority"]) if (b.kh[k] !== undefined) s.set(`payroll.kh.${k}`, !!b.kh[k]);
        const lim = { khr_rate: [1000, 10000], pension_ee: [0, 20], pension_er: [0, 20], risk_er: [0, 20], health_er: [0, 20], nssf_min: [0, 100000000], nssf_max: [0, 100000000] };
        for (const [k, [lo, hi]] of Object.entries(lim)) {
          const v = num(b.kh, k, lo, hi);
          if (v !== undefined) s.set(`payroll.kh.${k}`, v);
        }
      }
      await s.save();
      res.json({ success: true, data: s.payroll, message: MSG.saved });
    }),
  );
  prop.app.put(
    `${payPath}/salary/:rid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx, "att_payroll", X.needPayroll);
      if (!validId(req.params.rid)) throw new Bad(MSG.badId);
      const salary = num(req.body || {}, "salary", 0, 1000000000, { required: true });
      const payType = oneOf(req.body || {}, "pay_type", M.PAY_TYPES);
      const row = await M.AttStaff.findOneAndUpdate({ _id: req.params.rid, business_id: ctx.business._id }, { $set: { salary, ...(payType ? { pay_type: payType } : {}) } }, { returnDocument: "after" });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, data: staffOut(row), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${payPath}/adjust`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx, "att_payroll", X.needPayroll);
      const b = req.body || {};
      if (!validId(b.staff_id) || !(await M.AttStaff.exists({ _id: b.staff_id, business_id: ctx.business._id }))) throw new Bad(`${MSG.badValue} (staff_id)`);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(b.month || ""))) throw new Bad(`${MSG.badValue} (month)`);
      const label = text(b, "label", 60, { required: true });
      const amount = num(b, "amount", -1000000000, 1000000000, { required: true });
      if (!amount) throw new Bad(`${MSG.badValue} (amount)`);
      const row = await M.AttPayAdjust.create({ business_id: ctx.business._id, staff_id: b.staff_id, month: b.month, label, amount });
      res.status(201).json({ success: true, data: row, message: MSG.saved });
    }),
  );
  // staff: my pay this month (if the owner lets staff see it)
  prop.app.get(
    "/api/att/pay",
    prop.api_auth,
    handle(async (req, res) => {
      const sctx = await staffCtx(req, false);
      if (!sctx.addons.att_payroll?.active || sctx.settings.payroll?.show_staff === false) throw new Bad(X.payHidden, 403, { code: "pay_hidden" });
      const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || "")) ? String(req.query.month) : C.localDay(Date.now()).slice(0, 7);
      const p = await payrollOf({ business: sctx.business, addons: sctx.addons }, month, sctx.staff.toObject ? sctx.staff.toObject() : sctx.staff);
      const row = p.rows[0];
      res.json({
        success: true,
        data: { month, currency: p.settings.currency, ot_rate: p.settings.ot_rate, deduct_late: p.settings.deduct_late !== false, deduct_absent: p.settings.deduct_absent !== false, ...row, staff: undefined, updated_at: new Date() },
      });
    }),
  );
  prop.app.delete(
    `${payPath}/adjust/:aid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx, "att_payroll", X.needPayroll);
      if (!validId(req.params.aid)) throw new Bad(MSG.badId);
      const r = await M.AttPayAdjust.deleteOne({ _id: req.params.aid, business_id: ctx.business._id });
      if (!r.deletedCount) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, message: MSG.deleted });
    }),
  );
};
