// Who works which shift on a day.
//   Usually: the staff's own shift (staff.shift_id), on its week days.
//   With the weekly roster (att_roster): a roster entry for that day wins — a shift (worked that day, whatever its
//   week days) or a day off. No entry → the usual shift.
const M = require("./attendance.models");
const C = require("./attendance.calc");
const License = require("../../license/license.model");

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
// a shift used on a rostered day counts as a work day that day
const rostered = (shift) => (shift ? { ...shift, days: ALL_DAYS, rostered: true } : null);

async function rosterOn(bid) {
  return !!(await License.exists({ business_id: bid, product: "att_roster", item: "", expires_at: { $gt: new Date() } }));
}

// plan for some staff over some days → { shiftOf, at(staff, day), entry(staff, day), on }
async function planOf(bid, staffList, days, { shifts = null, on = null } = {}) {
  const [list, active] = await Promise.all([shifts || M.AttShift.find({ business_id: bid }).lean(), on === null ? rosterOn(bid) : on]);
  const shiftOf = new Map(list.map((s) => [String(s._id), s]));
  const map = new Map();
  if (active && days.length && staffList.length) {
    const sorted = [...days].sort();
    const rows = await M.AttRoster.find({ business_id: bid, staff_id: { $in: staffList.map((s) => s._id) }, day: { $gte: sorted[0], $lte: sorted[sorted.length - 1] } }).lean();
    for (const r of rows) map.set(`${r.staff_id}|${r.day}`, r.shift_id ? String(r.shift_id) : null);
  }
  const base = (s) => (s.shift_id ? shiftOf.get(String(s.shift_id)) || null : null);
  return {
    on: active,
    shiftOf,
    base,
    // undefined = no roster entry; null = day off; otherwise the shift id
    entry: (s, day) => (map.has(`${s._id}|${day}`) ? map.get(`${s._id}|${day}`) : undefined),
    at(s, day) {
      const k = `${s._id}|${day}`;
      if (!map.has(k)) return base(s);
      const id = map.get(k);
      return id ? rostered(shiftOf.get(id)) : null;
    },
  };
}

// the shift + work day a press "now" belongs to (yesterday's night shift may still be running)
async function shiftNow(bid, staff, now = Date.now()) {
  const today = C.localDay(now);
  const yesterday = C.addDays(today, -1);
  const plan = await planOf(bid, [staff], [yesterday, today]);
  const ys = plan.at(staff, yesterday);
  if (ys && C.isWorkDay(ys, yesterday)) {
    const w = C.windowOf(ys, yesterday);
    if (w.end > w.start && now <= w.end + 2 * C.HOUR && C.workDayOf(now, ys) === yesterday) return { shift: ys, day: yesterday, plan };
  }
  const ts = plan.at(staff, today);
  return { shift: ts, day: ts ? C.workDayOf(now, ts) : today, plan };
}

// work days of one staff in some days (holidays included: they are paid days off)
function workDaysIn(plan, staff, days, since = "") {
  let n = 0;
  for (const d of days) {
    if (since && d < since) continue;
    const sh = plan.at(staff, d);
    if (sh && C.isWorkDay(sh, d)) n += 1;
  }
  return n;
}

module.exports = { planOf, shiftNow, rosterOn, workDaysIn, rostered };
