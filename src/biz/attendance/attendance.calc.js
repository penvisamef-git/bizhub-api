// Attendance maths — pure functions, no database. Times are Cambodia time (UTC+7) unless tzHours says otherwise.
//
// A work day ("YYYY-MM-DD") + the staff's shift + that day's clock-in / clock-out records → the day's status:
//   off          not a work day and nothing recorded
//   upcoming     a later day (or today before the shift starts)
//   not_yet      today, the shift has started, no clock-in yet
//   absent       the shift is over and nobody clocked in
//   working      clocked in, not out yet (still inside the shift + 4 hours)
//   present      clocked in and out
//   missing_out  clocked in, never out → counted until the shift end and flagged for review
//   extra        worked on a day off (or without a shift)
//   before       a day before the staff was added (not counted)
//   leave        an approved leave on a work day (leave_type: annual | sick | personal | unpaid)
// plus minutes: late_min, early_min (left early), ot_min (overtime), worked_min.
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OPEN_HOURS = 4; // a missing clock-out is "working" until the shift end + this, then "missing_out"
const NO_SHIFT_OPEN_HOURS = 16; // without a shift: an open clock-in turns into "missing_out" after this
const MAX_SHIFT_HOURS = 20; // an "out" closes an "in" from at most this long ago

const pad = (n) => String(n).padStart(2, "0");
const toMin = (hhmm) => {
  const [h, m] = String(hhmm || "0:0")
    .split(":")
    .map(Number);
  return h * 60 + m;
};

// "YYYY-MM-DD" of a moment, in local time
function localDay(at, tzHours = 7) {
  const x = new Date(new Date(at).getTime() + tzHours * HOUR);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}
// the moment a local day + "HH:MM" happens
function atOf(day, hhmm, tzHours = 7) {
  const [y, mo, d] = day.split("-").map(Number);
  return Date.UTC(y, mo - 1, d) + toMin(hhmm) * MIN - tzHours * HOUR;
}
const addDays = (day, n) => {
  const [y, mo, d] = day.split("-").map(Number);
  const x = new Date(Date.UTC(y, mo - 1, d) + n * DAY);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
};
const weekday = (day) => {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0 = Sunday
};
const daysOfMonth = (month) => {
  const [y, mo] = month.split("-").map(Number);
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${pad(i + 1)}`);
};

// scheduled start / end of a shift on a day (end on the next day for a night shift)
function windowOf(shift, day, tzHours = 7) {
  if (!shift) return null;
  const start = atOf(day, shift.start, tzHours);
  let end = atOf(day, shift.end, tzHours);
  if (end <= start) end += DAY;
  return { start, end };
}
const isWorkDay = (shift, day) => !!shift && shift.active !== false && (shift.days || []).includes(weekday(day));

// which work day a clock-in at `at` belongs to: the day whose shift start is closest
// (a 23:50 clock-in for a 00:00 shift belongs to the next day). Without a shift: the local date.
function workDayOf(at, shift, tzHours = 7) {
  const today = localDay(at, tzHours);
  if (!shift) return today;
  const t = new Date(at).getTime();
  let best = today;
  let bestGap = Infinity;
  for (const d of [addDays(today, -1), today, addDays(today, 1)]) {
    const w = windowOf(shift, d, tzHours);
    // inside that day's shift wins outright; otherwise the nearest start
    const gap = t >= w.start && t <= w.end ? -1 : Math.abs(t - w.start);
    if (gap < bestGap) {
      bestGap = gap;
      best = d;
    }
  }
  return best;
}

// the times a shift allows a clock in / out on a work day → { from, to } (ms), or null = any time.
// Each time is read near its anchor (start for "in", end for "out"), so 23:30 for a 00:30 start is the evening before.
function punchWindow(shift, day, kind, tzHours = 7) {
  if (!shift) return null;
  const [a, b] = kind === "in" ? [shift.in_from, shift.in_to] : [shift.out_from, shift.out_to];
  if (!a && !b) return null;
  const w = windowOf(shift, day, tzHours);
  const anchor = kind === "in" ? w.start : w.end;
  const anchorMin = toMin(kind === "in" ? shift.start : shift.end);
  const near = (hhmm) => {
    let off = toMin(hhmm) - anchorMin;
    if (off > 720) off -= 1440;
    if (off <= -720) off += 1440;
    return anchor + off * MIN;
  };
  const from = a ? near(a) : -Infinity;
  let to = b ? near(b) : Infinity;
  if (to < from) to += DAY;
  return { from, to };
}

// records (one staff, one day; rejected ones are ignored) → [{ in, out }] pairs in time order
function pairsOf(punches) {
  const list = punches.filter((p) => p.review !== "rejected").sort((a, b) => new Date(a.at) - new Date(b.at));
  const pairs = [];
  for (const p of list) {
    const t = new Date(p.at).getTime();
    const last = pairs[pairs.length - 1];
    if (p.kind === "in") {
      if (last && last.out === null) continue; // a second "in" while already in: keep the first
      pairs.push({ in: t, out: null });
    } else if (last && last.out === null && t - last.in <= MAX_SHIFT_HOURS * HOUR) last.out = t;
    // an "out" with no open "in" is ignored
  }
  return pairs;
}

// one staff, one day → status + minutes
// holiday: the public / company holiday's name on that day ("" = none) — not a work day, nobody is absent
function dayStatus({ day, shift, punches = [], rules = {}, now = Date.now(), tzHours = 7, since = "", leave = null, holiday = "" }) {
  const r = { late_grace_min: 10, early_grace_min: 0, ot_after_min: 30, auto_out_hours: OPEN_HOURS, ...rules };
  const shiftDay = isWorkDay(shift, day);
  const work = shiftDay && !holiday;
  const w = work ? windowOf(shift, day, tzHours) : null;
  const pairs = pairsOf(punches);
  const pending = punches.filter((p) => p.review === "pending").length;
  const out = {
    day,
    status: "off",
    leave_type: "",
    work_day: work,
    start: w ? new Date(w.start) : null,
    end: w ? new Date(w.end) : null,
    first_in: null,
    last_out: null,
    late_min: 0,
    early_min: 0,
    ot_min: 0,
    worked_min: 0,
    pending,
    auto_out: false,
    holiday: holiday || "",
  };

  if (!pairs.length) {
    if (since && day < since) {
      out.status = "before";
      out.work_day = false;
    } else if (holiday && shiftDay) out.status = "holiday";
    else if (!work) out.status = "off";
    else if (leave) {
      out.status = "leave";
      out.leave_type = leave.type;
    } else if (now < w.start) out.status = "upcoming";
    else if (now < w.end) out.status = "not_yet";
    else out.status = "absent";
    return out;
  }

  const first = pairs[0];
  const lastPair = pairs[pairs.length - 1];
  out.first_in = new Date(first.in);
  let open = false;
  if (lastPair.out === null) {
    const closeBy = w ? w.end + (Number(r.auto_out_hours) || OPEN_HOURS) * HOUR : lastPair.in + NO_SHIFT_OPEN_HOURS * HOUR;
    if (now < closeBy) open = true;
    else {
      // forgot to clock out: count until the shift end (or nothing without a shift), flag it
      lastPair.out = w ? Math.max(lastPair.in, w.end) : lastPair.in;
      out.auto_out = true;
    }
  }
  const closed = pairs.filter((p) => p.out !== null);
  let worked = closed.reduce((a, p) => a + (p.out - p.in), 0);
  if (open) worked += Math.max(0, now - lastPair.in);
  if (closed.length) out.last_out = new Date(closed[closed.length - 1].out);

  if (w) {
    const lateBy = Math.round((first.in - w.start) / MIN);
    if (lateBy > r.late_grace_min) out.late_min = lateBy;
    if (!open && out.last_out && !out.auto_out) {
      const earlyBy = Math.round((w.end - out.last_out.getTime()) / MIN);
      if (earlyBy > r.early_grace_min) out.early_min = earlyBy;
      const otBy = Math.round((out.last_out.getTime() - w.end) / MIN);
      if (otBy > r.ot_after_min) out.ot_min = otBy;
    }
    // the break comes off once someone has worked longer than it
    const breakMs = (shift.break_min || 0) * MIN;
    if (worked > breakMs * 2) worked -= breakMs;
  }
  out.worked_min = Math.max(0, Math.round(worked / MIN));
  out.status = open ? "working" : out.auto_out ? "missing_out" : work ? "present" : "extra";
  return out;
}

// a month of days for one staff → per-day list + totals
function monthSummary(days) {
  const t = {
    work_days: 0,
    holiday: 0,
    holiday_worked: 0,
    holiday_min: 0,
    present: 0,
    late: 0,
    late_min: 0,
    early: 0,
    early_min: 0,
    absent: 0,
    missing_out: 0,
    extra: 0,
    ot_min: 0,
    worked_min: 0,
    pending: 0,
    leave: 0,
    leave_paid: 0,
    leave_unpaid: 0,
  };
  for (const d of days) {
    if (d.work_day && d.status !== "upcoming") t.work_days += 1; // days still to come are not counted yet
    if (["present", "working", "missing_out", "extra"].includes(d.status)) t.present += 1;
    if (d.late_min) {
      t.late += 1;
      t.late_min += d.late_min;
    }
    if (d.early_min) {
      t.early += 1;
      t.early_min += d.early_min;
    }
    if (d.status === "absent") t.absent += 1;
    if (d.status === "missing_out") t.missing_out += 1;
    if (d.status === "extra") t.extra += 1;
    if (d.status === "holiday") t.holiday += 1;
    if (d.status === "extra" && d.holiday) {
      t.holiday_worked += 1;
      t.holiday_min += d.worked_min;
    }
    if (d.status === "leave") {
      t.leave += 1;
      if (d.leave_type === "unpaid") t.leave_unpaid += 1;
      else t.leave_paid += 1;
    }
    t.ot_min += d.ot_min;
    t.worked_min += d.worked_min;
    t.pending += d.pending;
  }
  return t;
}

// distance in metres between two GPS points
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// where was the phone? → { branch, distance_m, flags[] }  (flags empty = all checks passed)
// branches: the ones this staff may use, with lat/lng set
function placeCheck({ lat, lng, accuracy }, branches, rules = {}) {
  const maxAcc = rules.max_accuracy_m ?? 100;
  const located = branches.filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lng));
  const hasGps = Number.isFinite(lat) && Number.isFinite(lng);
  if (!located.length) return { branch: branches[0] || null, distance_m: null, flags: ["no_branch"] };
  if (!hasGps) return { branch: located.length === 1 ? located[0] : null, distance_m: null, flags: ["no_gps"] };
  let best = null;
  let bestD = Infinity;
  for (const b of located) {
    const d = distanceM(lat, lng, b.lat, b.lng);
    // nearest by how far outside its circle (so a big branch next to a small one is judged fairly)
    if (d - b.radius_m < bestD - (best?.radius_m || 0)) {
      best = b;
      bestD = d;
    }
  }
  const flags = [];
  if (bestD > best.radius_m) flags.push("outside");
  if (Number.isFinite(accuracy) && accuracy > maxAcc) flags.push("low_accuracy");
  return { branch: best, distance_m: bestD, flags };
}

// which approved leave covers a day (leaves = [{ from, to, type, status }])
const leaveOn = (leaves, day) => (leaves || []).find((l) => l.status === "approved" && l.from <= day && l.to >= day) || null;

// work days of a shift between two days (both included), not before `since`
// skip: days not to count (holidays), a Set or Map of "YYYY-MM-DD"
function workDaysBetween(shift, from, to, since = "", skip = null) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if ((!since || d >= since) && isWorkDay(shift, d) && !skip?.has(d)) n += 1;
  return n;
}

const round = (v, currency) => (currency === "KHR" ? Math.round(v / 100) * 100 : Math.round(v * 100) / 100);
// one staff's pay for a month (payroll add-on): monthly salary, minus absent days / late time / unpaid leave,
// plus overtime (× ot_rate) and days worked on a day off, plus the owner's +/− lines
// pay_type: monthly (salary per month) · daily (salary per day worked) · hourly (salary per hour worked)
// work_days / my_days: the month's work days (all / from `since`) when a roster decides them
function payOf({ salary = 0, pay_type = "monthly", shift = null, month, days = [], since = "", adjustments = [], settings = {}, work_days = null, my_days = null }) {
  const p = { currency: "USD", ot_rate: 1.5, holiday_rate: 2, deduct_late: true, deduct_absent: true, pay_extra_days: true, ...settings };
  const all = daysOfMonth(month);
  const full = work_days ?? (shift ? workDaysBetween(shift, all[0], all[all.length - 1]) : 0);
  const mine = my_days ?? (shift ? workDaysBetween(shift, all[0], all[all.length - 1], since) : 0);
  let hours = 8;
  if (shift) {
    const w = windowOf(shift, all[0]);
    hours = Math.max(1, (w.end - w.start) / HOUR - (shift.break_min || 0) / 60);
  }
  const t = monthSummary(days);
  const hr = Number(p.holiday_rate) || 1;
  let daily,
    hourly,
    base,
    absentDed,
    lateDed,
    unpaidDed,
    otPay,
    extraPay,
    paidLeave = 0;
  if (pay_type === "hourly") {
    // paid for the hours worked; overtime and holiday hours pay the extra part on top
    hourly = salary;
    daily = salary * hours;
    base = (t.worked_min / 60) * hourly;
    absentDed = 0;
    lateDed = 0;
    unpaidDed = 0;
    otPay = (t.ot_min / 60) * hourly * Math.max(0, p.ot_rate - 1);
    extraPay = p.pay_extra_days ? (t.holiday_min / 60) * hourly * Math.max(0, hr - 1) : 0;
    paidLeave = t.leave_paid * daily;
  } else if (pay_type === "daily") {
    // paid per day worked (work days + extra days); a worked holiday pays holiday_rate × a day
    daily = salary;
    hourly = daily / hours;
    base = (t.present - t.holiday_worked) * daily;
    absentDed = 0;
    lateDed = p.deduct_late ? (t.late_min / 60) * hourly : 0;
    unpaidDed = 0;
    otPay = (t.ot_min / 60) * hourly * p.ot_rate;
    extraPay = t.holiday_worked * daily * hr;
    paidLeave = t.leave_paid * daily;
  } else {
    daily = full ? salary / full : 0;
    hourly = daily / hours;
    base = full ? (salary * mine) / full : salary; // joined mid-month → a part of the month
    absentDed = p.deduct_absent ? t.absent * daily : 0;
    lateDed = p.deduct_late ? (t.late_min / 60) * hourly : 0;
    unpaidDed = t.leave_unpaid * daily;
    otPay = (t.ot_min / 60) * hourly * p.ot_rate;
    // a holiday is paid as a normal day (it stays in the month's days); working on one pays holiday_rate × a day
    extraPay = p.pay_extra_days ? (t.extra - t.holiday_worked) * daily + t.holiday_worked * daily * hr : 0;
  }
  const adj = adjustments.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const net = base + paidLeave - absentDed - lateDed - unpaidDed + otPay + extraPay + adj;
  const r = (v) => round(v, p.currency);
  return {
    currency: p.currency,
    pay_type,
    salary: r(salary),
    paid_leave_pay: r(paidLeave),
    work_days: full,
    daily_rate: r(daily),
    hourly_rate: r(hourly),
    base: r(base),
    absent_days: t.absent,
    absent_ded: r(absentDed),
    late_min: t.late_min,
    late_ded: r(lateDed),
    unpaid_days: t.leave_unpaid,
    unpaid_ded: r(unpaidDed),
    paid_leave_days: t.leave_paid,
    ot_min: t.ot_min,
    ot_pay: r(otPay),
    extra_days: t.extra,
    holiday_days: t.holiday,
    holiday_worked: t.holiday_worked,
    holiday_rate: Number(p.holiday_rate) || 1,
    extra_pay: r(extraPay),
    adjustments: adjustments.map((x) => ({ _id: x._id, label: x.label, amount: r(x.amount) })),
    adj_total: r(adj),
    net: r(Math.max(0, net)),
    present: t.present,
    worked_min: t.worked_min,
  };
}

module.exports = {
  punchWindow,
  leaveOn,
  workDaysBetween,
  payOf,
  localDay,
  atOf,
  addDays,
  weekday,
  daysOfMonth,
  windowOf,
  isWorkDay,
  workDayOf,
  pairsOf,
  dayStatus,
  monthSummary,
  distanceM,
  placeCheck,
  toMin,
  MAX_SHIFT_HOURS,
  HOUR,
  MIN,
  DAY,
};
