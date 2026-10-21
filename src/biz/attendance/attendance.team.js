// Manager login (att_manager, yearly): a staff with the "manager" role sees their team in the staff app and decides
// leave, "I forgot to clock in / out" requests, overtime and records that failed a check — only for staff who share
// one of their branches (a manager with no branches, or a staff with no branches, belongs to every branch).
// Staff profiles (free) + documents (att_docs, yearly) + HR reminders (contract end, birthdays, documents running out).
//
// Staff (x-att-token, manager): GET  /api/att/team                         team today + inbox
//                               POST /api/att/team/:kind/:id/decide        kind: leave | fix | overtime | punch  { approve, note }
// Owner: GET    /staff/:rid/docs                POST /staff/:rid/docs (multipart file + kind, name, expires)
//        PUT    /staff/:rid/docs/:did { kind, name, expires }               DELETE /staff/:rid/docs/:did
//        GET    /hr                              reminders (also in the Telegram day report)
const M = require("./attendance.models");
const C = require("./attendance.calc");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");

const MAX_DOCS = 20; // per staff
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / C.DAY);

// HR reminders for a business: contracts ending, birthdays this week, documents running out
async function hrOf(bid, staffList, docsOn, today = C.localDay(Date.now())) {
  const items = [];
  for (const s of staffList) {
    if (s.contract_end) {
      const n = daysBetween(today, s.contract_end);
      if (n <= 30 && n >= -30) items.push({ type: "contract", staff_id: s._id, staff_name: s.name, day: s.contract_end, in_days: n });
    }
    if (s.birthday && /^\d{4}-\d{2}-\d{2}$/.test(s.birthday)) {
      const md = s.birthday.slice(5);
      let next = `${today.slice(0, 4)}-${md}`;
      if (md === "02-29" && !isLeap(Number(today.slice(0, 4)))) next = `${today.slice(0, 4)}-02-28`;
      if (next < today) next = `${Number(today.slice(0, 4)) + 1}-${md === "02-29" ? "02-28" : md}`;
      const n = daysBetween(today, next);
      if (n <= 7) items.push({ type: "birthday", staff_id: s._id, staff_name: s.name, day: next, in_days: n, age: Number(next.slice(0, 4)) - Number(s.birthday.slice(0, 4)) });
    }
  }
  if (docsOn && staffList.length) {
    const names = new Map(staffList.map((s) => [String(s._id), s.name]));
    const docs = await M.AttDoc.find({ business_id: bid, staff_id: { $in: staffList.map((s) => s._id) }, expires: { $gte: C.addDays(today, -30), $lte: C.addDays(today, 30) } }).lean();
    for (const d of docs) items.push({ type: "document", staff_id: d.staff_id, staff_name: names.get(String(d.staff_id)) || "?", doc_id: d._id, kind: d.kind, name: d.name, day: d.expires, in_days: daysBetween(today, d.expires) });
  }
  return items.sort((a, b) => a.in_days - b.in_days);
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, staffCtx, settingsOf, statusesOf, Bad, MSG, text, validId, DAY_RE, hooks, withUpload, ownerName } = kit;
  const T = {
    needManager: "សូមឱ្យម្ចាស់ដោះសោ “អ្នកគ្រប់គ្រងក្នុងកម្មវិធី” ជាមុនសិន!",
    notManager: "សម្រាប់តែអ្នកគ្រប់គ្រងប៉ុណ្ណោះ",
    notTeam: "បុគ្គលិកនេះមិនមែនក្នុងក្រុមរបស់អ្នកទេ",
    own: "អ្នកមិនអាចសម្រេចសំណើរបស់ខ្លួនឯងបានទេ",
    needLeave: "ច្បាប់ឈប់មិនទាន់បើក",
    needDocs: "សូមដោះសោ “ឯកសារបុគ្គលិក” ជាមុនសិន!",
    tooManyDocs: `ឯកសារអតិបរមា ${MAX_DOCS} ក្នុងមួយបុគ្គលិក`,
  };
  const sameBranch = (a, b) => !a.branch_ids?.length || !b.branch_ids?.length || a.branch_ids.some((x) => b.branch_ids.some((y) => String(x) === String(y)));

  // the manager calling + their team (active staff sharing a branch, the manager included)
  async function managerCtx(req) {
    const ctx = await staffCtx(req, false);
    if (!ctx.addons.att_manager?.active) throw new Bad(T.needManager, 402, { code: "need_manager", product: "att_manager" });
    if (ctx.staff.role !== "manager") throw new Bad(T.notManager, 403, { code: "not_manager" });
    const all = await M.AttStaff.find({ business_id: ctx.staff.business_id, active: true }).sort({ sort: 1, created_date: 1 }).lean();
    const team = all.filter((s) => String(s._id) === String(ctx.staff._id) || sameBranch(ctx.staff, s));
    return { ...ctx, team, ids: new Set(team.map((s) => String(s._id))) };
  }

  prop.app.get(
    "/api/att/team",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await managerCtx(req);
      const bid = ctx.staff.business_id;
      const today = C.localDay(Date.now());
      const others = ctx.team.filter((s) => String(s._id) !== String(ctx.staff._id)).map((s) => s._id);
      const leaveOn = !!ctx.addons.att_leave?.active;
      const [{ out }, leave, fixes, overtime, punches] = await Promise.all([
        statusesOf(bid, ctx.team, [today], ctx.settings),
        leaveOn
          ? M.AttLeave.find({ business_id: bid, staff_id: { $in: others }, status: "pending" })
              .sort({ from: 1 })
              .limit(100)
              .lean()
          : [],
        M.AttFix.find({ business_id: bid, staff_id: { $in: others }, status: "pending" })
          .sort({ created_date: -1 })
          .limit(100)
          .lean(),
        M.AttOvertime.find({ business_id: bid, staff_id: { $in: others }, status: "pending" })
          .sort({ day: 1 })
          .limit(100)
          .lean(),
        M.AttPunch.find({ business_id: bid, staff_id: { $in: others }, review: "pending", day: { $gte: C.addDays(today, -31) } })
          .sort({ at: -1 })
          .limit(100)
          .lean(),
      ]);
      const name = new Map(ctx.team.map((s) => [String(s._id), s.name]));
      const who = (r) => ({ staff_id: r.staff_id, staff_name: name.get(String(r.staff_id)) || "?" });
      res.json({
        success: true,
        data: {
          day: today,
          team: ctx.team.map((s) => {
            const st = out[s._id][today];
            return {
              _id: s._id,
              name: s.name,
              position: s.position,
              me: String(s._id) === String(ctx.staff._id),
              status: st.status,
              holiday: st.holiday,
              leave_type: st.leave_type,
              first_in: st.first_in,
              last_out: st.last_out,
              late_min: st.late_min,
              work_day: st.work_day,
            };
          }),
          leave_on: leaveOn,
          inbox: {
            leave: leave.map((l) => ({ _id: l._id, ...who(l), type: l.type, from: l.from, to: l.to, days: l.days, reason: l.reason })),
            fix: fixes.map((f) => ({ _id: f._id, ...who(f), day: f.day, kind: f.kind, time: f.time, reason: f.reason })),
            overtime: overtime.map((o) => ({ _id: o._id, ...who(o), day: o.day, until: o.until, reason: o.reason })),
            punch: punches.map((p) => ({ _id: p._id, ...who(p), day: p.day, kind: p.kind, at: p.at, flags: p.flags, distance_m: p.distance_m, photo_url: p.photo?.url || "" })),
          },
        },
      });
    }),
  );

  const MODELS = { leave: M.AttLeave, fix: M.AttFix, overtime: M.AttOvertime, punch: M.AttPunch };
  prop.app.post(
    "/api/att/team/:kind/:id/decide",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await managerCtx(req);
      const bid = ctx.staff.business_id;
      const { kind, id } = req.params;
      if (!MODELS[kind] || !validId(id)) throw new Bad(MSG.badId);
      if (kind === "leave" && !ctx.addons.att_leave?.active) throw new Bad(T.needLeave, 402);
      if (typeof req.body?.approve !== "boolean") throw new Bad(`${MSG.required}: approve`);
      const approve = req.body.approve;
      const note = text(req.body || {}, "note", 300) || "";
      const row = await MODELS[kind].findOne({ _id: id, business_id: bid }).select("staff_id").lean();
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      if (String(row.staff_id) === String(ctx.staff._id)) throw new Bad(T.own, 403, { code: "own" });
      if (!ctx.ids.has(String(row.staff_id))) throw new Bad(T.notTeam, 403, { code: "not_team" });
      const by = `${ctx.staff.name} (manager)`;
      const data = kind === "punch" ? await hooks.decide.punch(bid, id, approve ? "ok" : "rejected", note, by) : await hooks.decide[kind](bid, id, approve ? "approved" : "rejected", note, by);
      res.json({ success: true, data: { _id: data._id, status: data.status || data.review }, message: MSG.saved });
    }),
  );

  // ---------------- owner: documents ----------------
  const docOut = (d) => ({ _id: d._id, staff_id: d.staff_id, kind: d.kind, name: d.name, url: d.url, expires: d.expires, by: d.by, created_date: d.created_date });
  const readDoc = (b) => {
    const set = {};
    if (b.kind !== undefined) {
      if (!M.DOC_KINDS.includes(b.kind)) throw new Bad(`${MSG.badValue} (kind)`);
      set.kind = b.kind;
    }
    const name = text(b, "name", 80);
    if (name !== undefined) set.name = name;
    if (b.expires !== undefined) {
      const v = String(b.expires ?? "");
      if (v && !DAY_RE.test(v)) throw new Bad(`${MSG.badValue} (expires)`);
      set.expires = v;
    }
    return set;
  };
  const staffOfReq = async (ctx, rid) => {
    if (!validId(rid)) throw new Bad(MSG.badId);
    const s = await M.AttStaff.findOne({ _id: rid, business_id: ctx.business._id }).select("_id name").lean();
    if (!s) throw new Bad(MSG.rowNotFound, 404);
    return s;
  };

  prop.app.get(
    `${base}/staff/:rid/docs`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const s = await staffOfReq(ctx, req.params.rid);
      const rows = await M.AttDoc.find({ business_id: ctx.business._id, staff_id: s._id }).sort({ created_date: -1 }).lean();
      res.json({ success: true, data: { on: !!ctx.addons.att_docs?.active, rows: rows.map(docOut), max: MAX_DOCS } });
    }),
  );
  prop.app.post(
    `${base}/staff/:rid/docs`,
    ...guard,
    withUpload,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!ctx.addons.att_docs?.active) throw new Bad(T.needDocs, 402, { product: "att_docs" });
      const s = await staffOfReq(ctx, req.params.rid);
      if (!req.file) throw new Bad(MSG.noFile);
      const set = readDoc(req.body || {});
      if ((await M.AttDoc.countDocuments({ business_id: ctx.business._id, staff_id: s._id })) >= MAX_DOCS) throw new Bad(T.tooManyDocs, 400, { code: "too_many" });
      const saved = await uploadBuffer(req.file, "attendance-docs");
      const row = await M.AttDoc.create({ kind: "other", ...set, business_id: ctx.business._id, staff_id: s._id, url: saved.url, public_id: saved.public_id || "", by: ownerName(req) });
      res.status(201).json({ success: true, data: docOut(row), message: MSG.saved });
    }),
  );
  prop.app.put(
    `${base}/staff/:rid/docs/:did`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const s = await staffOfReq(ctx, req.params.rid);
      if (!validId(req.params.did)) throw new Bad(MSG.badId);
      const row = await M.AttDoc.findOneAndUpdate({ _id: req.params.did, business_id: ctx.business._id, staff_id: s._id }, { $set: readDoc(req.body || {}) }, { returnDocument: "after" }).lean();
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, data: docOut(row), message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/staff/:rid/docs/:did`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const s = await staffOfReq(ctx, req.params.rid);
      if (!validId(req.params.did)) throw new Bad(MSG.badId);
      const row = await M.AttDoc.findOneAndDelete({ _id: req.params.did, business_id: ctx.business._id, staff_id: s._id }).lean();
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      if (row.public_id) deleteFile(row.public_id).catch(() => {});
      res.json({ success: true, message: MSG.saved });
    }),
  );

  // ---------------- owner: HR reminders ----------------
  prop.app.get(
    `${base}/hr`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const staff = await M.AttStaff.find({ business_id: ctx.business._id, active: true }).lean();
      res.json({ success: true, data: { items: await hrOf(ctx.business._id, staff, !!ctx.addons.att_docs?.active), docs_on: !!ctx.addons.att_docs?.active } });
    }),
  );

  // Telegram day report: only on the days that matter (birthday today; 30 / 7 / 1 / 0 days before an end date)
  hooks.hrLines = async (bid, staff, addons) => {
    const items = (await hrOf(bid, staff, !!addons?.att_docs?.active)).filter((i) => (i.type === "birthday" ? i.in_days === 0 : [30, 7, 1, 0].includes(i.in_days)));
    const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return items.map((i) => {
      if (i.type === "birthday") return `🎂 ${esc(i.staff_name)} — birthday today`;
      const what = i.type === "contract" ? "contract ends" : `${esc(i.name || i.kind)} runs out`;
      return `📄 ${esc(i.staff_name)} — ${what} ${i.in_days === 0 ? "today" : i.in_days === 1 ? "tomorrow" : `in ${i.in_days} days`} (${i.day})`;
    });
  };
};
module.exports.hrOf = hrOf;
