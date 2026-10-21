// On-time rewards (att_rewards, yearly): streaks and badges in the staff app, the team's top 5,
// and an optional bonus added to payroll for a perfect month (no late, no absent, no missing clock-out).
// Staff (x-att-token): GET /api/att/rewards
// Owner: GET /rewards?month=YYYY-MM   PUT /rewards/settings { bonus, board }
const M = require("./attendance.models");
const C = require("./attendance.calc");

// one day → good (on time) | bad (late, absent, no clock-out) | null (doesn't count: day off, leave, holiday, not yet…)
function dayKind(st) {
  if (!st) return null;
  if (st.status === "absent" || st.status === "missing_out") return "bad";
  if (["present", "working"].includes(st.status)) return st.late_min > 0 ? "bad" : "good";
  return null;
}
// a list of day statuses (any order) → the month's numbers
function monthStats(list) {
  const t = { on_time: 0, late: 0, absent: 0, missing_out: 0, work: 0 };
  for (const st of list) {
    const k = dayKind(st);
    if (!k) continue;
    t.work += 1;
    if (k === "good") t.on_time += 1;
    else if (st.status === "absent") t.absent += 1;
    else if (st.status === "missing_out") t.missing_out += 1;
    else t.late += 1;
  }
  t.rate = t.work ? Math.round((t.on_time / t.work) * 100) : 0;
  t.perfect = t.work > 0 && t.on_time === t.work;
  return t;
}
// days newest first → the current run of on-time days + the best run inside the list
function streaks(daysDesc) {
  let current = 0;
  let best = 0;
  let run = 0;
  let open = true;
  for (const st of daysDesc) {
    const k = dayKind(st);
    if (!k) continue;
    if (k === "good") {
      run += 1;
      if (open) current = run;
    } else {
      open = false;
      run = 0;
    }
    best = Math.max(best, run);
  }
  return { current, best };
}
const BADGES = [
  ["streak_5", (x) => x.streak >= 5],
  ["streak_10", (x) => x.streak >= 10],
  ["streak_20", (x) => x.streak >= 20],
  ["perfect_month", (x) => x.month.perfect && x.month.work >= 5],
  ["last_perfect", (x) => x.last.perfect],
  ["top", (x) => x.rank === 1],
];

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, staffCtx, settingsOf, statusesOf, Bad, MSG, num, bool, MONTH_RE } = kit;
  const T = { need: "សូមដោះសោ “រង្វាន់មកទាន់ម៉ោង” ជាមុនសិន!", off: "រង្វាន់មិនទាន់បើក" };
  const today = () => C.localDay(Date.now());
  const monthDays = (month) => {
    const t = today();
    return C.daysOfMonth(month).filter((d) => d <= t);
  };
  const prevMonth = (month) => {
    const [y, m] = month.split("-").map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  };
  // every active staff's month numbers, best first
  async function boardOf(bid, staff, month, settings, pre = null) {
    const days = monthDays(month);
    if (!days.length || !staff.length) return [];
    const { out } = pre || (await statusesOf(bid, staff, days, settings));
    return staff
      .map((s) => ({ staff_id: s._id, name: s.name, position: s.position, ...monthStats(days.map((d) => out[s._id][d])) }))
      .sort((a, b) => b.rate - a.rate || b.on_time - a.on_time || a.name.localeCompare(b.name))
      .map((r, i) => ({ ...r, rank: r.work ? i + 1 : null }));
  }

  prop.app.get(
    "/api/att/rewards",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      if (!ctx.addons.att_rewards?.active) throw new Bad(T.off, 402, { code: "rewards_off" });
      const { staff, settings } = ctx;
      const bid = staff.business_id;
      const t = today();
      const month = t.slice(0, 7);
      const last = prevMonth(month);
      const days = Array.from({ length: 90 }, (_, i) => C.addDays(t, -i)); // newest first
      const lastDays = C.daysOfMonth(last);
      const all = [...new Set([...days, ...lastDays])];
      const [{ out }, team] = await Promise.all([statusesOf(bid, [staff], all, settings), M.AttStaff.find({ business_id: bid, active: true }).lean()]);
      const mine = out[staff._id];
      const s = streaks(days.map((d) => mine[d]));
      const board = await boardOf(bid, team, month, settings); // also gives my rank
      const me = board.find((r) => String(r.staff_id) === String(staff._id));
      const x = { streak: s.current, best: s.best, month: monthStats(monthDays(month).map((d) => mine[d])), last: monthStats(lastDays.map((d) => mine[d])), rank: me?.rank || null };
      const bonus = settings.rewards?.bonus || 0;
      res.json({
        success: true,
        data: {
          ...x,
          badges: BADGES.filter(([, ok]) => ok(x)).map(([k]) => k),
          bonus: ctx.addons.att_payroll?.active ? bonus : 0,
          currency: settings.payroll?.currency || "USD",
          team_size: team.length,
          board:
            settings.rewards?.board !== false
              ? board
                  .filter((r) => r.work)
                  .slice(0, 5)
                  .map((r) => ({ name: r.name, rate: r.rate, on_time: r.on_time, rank: r.rank, me: String(r.staff_id) === String(staff._id) }))
              : null,
        },
      });
    }),
  );

  prop.app.get(
    `${base}/rewards`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const month = MONTH_RE.test(String(req.query.month || "")) ? String(req.query.month) : today().slice(0, 7);
      const [settings, staff] = await Promise.all([settingsOf(bid), M.AttStaff.find({ business_id: bid, active: true }).sort({ sort: 1, created_date: 1 }).lean()]);
      // the current streak of each staff (last 60 days) + the month board: one read for both days lists
      const t = today();
      const days = Array.from({ length: 60 }, (_, i) => C.addDays(t, -i));
      const all = [...new Set([...days, ...monthDays(month)])];
      const pre = staff.length && all.length ? await statusesOf(bid, staff, all, settings) : { out: {} };
      const board = await boardOf(bid, staff, month, settings, pre);
      const { out } = pre;
      const rows = board.map((r) => ({ ...r, streak: streaks(days.map((d) => out[r.staff_id]?.[d])).current }));
      res.json({
        success: true,
        data: {
          on: !!ctx.addons.att_rewards?.active,
          month,
          rows,
          settings: { bonus: settings.rewards?.bonus || 0, board: settings.rewards?.board !== false },
          currency: settings.payroll?.currency || "USD",
          payroll: !!ctx.addons.att_payroll?.active,
        },
      });
    }),
  );
  prop.app.put(
    `${base}/rewards/settings`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!ctx.addons.att_rewards?.active) throw new Bad(T.need, 402, { product: "att_rewards" });
      const b = req.body || {};
      const settings = await settingsOf(ctx.business._id);
      const bonus = num(b, "bonus", 0, 100000000);
      const board = bool(b, "board");
      if (bonus !== undefined) settings.set("rewards.bonus", bonus);
      if (board !== undefined) settings.set("rewards.board", board);
      await settings.save();
      res.json({ success: true, data: { bonus: settings.rewards.bonus, board: settings.rewards.board }, message: MSG.saved });
    }),
  );
};
module.exports.monthStats = monthStats;
module.exports.streaks = streaks;
module.exports.dayKind = dayKind;
