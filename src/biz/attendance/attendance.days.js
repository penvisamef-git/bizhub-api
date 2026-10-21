// Free parts of attendance that fix the days themselves:
//   Holidays     — Cambodia's public holidays (added by themselves each year) + the company's own days off.
//                  A holiday isn't a work day: nobody is absent; working on it pays payroll.holiday_rate.
//   Corrections  — "I forgot to clock in / out": staff ask from their phone, the owner approves → a record is added.
// Owner (base = /api/user/businesses/:id/attendance):
//   GET  /holidays?year=2026     POST /holidays { day, name }     PUT /holidays/:hid { name }     DELETE /holidays/:hid
//   POST /holidays/preset { year }   (put back Cambodia's list for that year)
//   POST /holidays/unlock { year }   (a coming year's national list: att_holidays, 45 coins; this year is free)
//   GET  /fixes?status=pending|all   POST /fixes/:fid/decide { status: approved|rejected, note }
// Staff (x-att-token): GET /api/att/fixes   POST /api/att/fixes { day, kind, time, reason }   DELETE /api/att/fixes/:fid
const M = require("./attendance.models");
const C = require("./attendance.calc");
const License = require("../../license/license.model");
const { buy, LicenseError } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { only_super_admin } = require("../../util/permission");

// Cambodia public holidays (Sub-Decree on 2026 public holidays: 21 days)
const KH_HOLIDAYS = {
  2026: [
    ["2026-01-01", "International New Year Day", "ទិវាចូលឆ្នាំសកល"],
    ["2026-01-07", "Victory over Genocide Day", "ទិវាជ័យជម្នះលើរបបប្រល័យពូជសាសន៍"],
    ["2026-03-08", "International Women's Day", "ទិវានារីអន្តរជាតិ"],
    ["2026-04-14", "Khmer New Year", "បុណ្យចូលឆ្នាំខ្មែរ"],
    ["2026-04-15", "Khmer New Year", "បុណ្យចូលឆ្នាំខ្មែរ"],
    ["2026-04-16", "Khmer New Year", "បុណ្យចូលឆ្នាំខ្មែរ"],
    ["2026-05-01", "Labour Day · Visak Bochea", "ទិវាពលកម្មអន្តរជាតិ · បុណ្យវិសាខបូជា"],
    ["2026-05-05", "Royal Ploughing Ceremony", "ព្រះរាជពិធីច្រត់ព្រះនង្គ័ល"],
    ["2026-05-14", "King's Birthday", "ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះមហាក្សត្រ"],
    ["2026-06-18", "Queen Mother's Birthday", "ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះវររាជមាតា"],
    ["2026-09-24", "Constitution Day", "ទិវាប្រកាសរដ្ឋធម្មនុញ្ញ"],
    ["2026-10-10", "Pchum Ben", "បុណ្យភ្ជុំបិណ្ឌ"],
    ["2026-10-11", "Pchum Ben", "បុណ្យភ្ជុំបិណ្ឌ"],
    ["2026-10-12", "Pchum Ben", "បុណ្យភ្ជុំបិណ្ឌ"],
    ["2026-10-15", "King Father Commemoration Day", "ទិវាគោរពព្រះវិញ្ញាណក្ខន្ធ ព្រះបរមរតនកោដ្ឋ"],
    ["2026-10-29", "Coronation Day", "ព្រះរាជពិធីគ្រងព្រះបរមរាជសម្បត្តិ"],
    ["2026-11-09", "Independence Day", "ពិធីបុណ្យឯករាជ្យជាតិ"],
    ["2026-11-23", "Water Festival", "ព្រះរាជពិធីបុណ្យអុំទូក"],
    ["2026-11-24", "Water Festival", "ព្រះរាជពិធីបុណ្យអុំទូក"],
    ["2026-11-25", "Water Festival", "ព្រះរាជពិធីបុណ្យអុំទូក"],
    ["2026-12-29", "Peace Day in Cambodia", "ទិវាសន្តិភាពនៅកម្ពុជា"],
  ],
  // Sub-decree signed 16 Sep 2026: 22 days
  2027: [
    ["2027-01-01", "International New Year Day", "ទិវាចូលឆ្នាំសកល"],
    ["2027-01-07", "Victory over Genocide Day", "ទិវាជ័យជម្នះលើរបបប្រល័យពូជសាសន៍"],
    ["2027-03-08", "International Women's Day", "ទិវានារីអន្តរជាតិ"],
    ["2027-04-14", "Khmer New Year", "បុណ្យចូលឆ្នាំខ្មែរ"],
    ["2027-04-15", "Khmer New Year", "បុណ្យចូលឆ្នាំខ្មែរ"],
    ["2027-04-16", "Khmer New Year", "បុណ្យចូលឆ្នាំខ្មែរ"],
    ["2027-05-01", "International Labour Day", "ទិវាពលកម្មអន្តរជាតិ"],
    ["2027-05-14", "King's Birthday", "ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះមហាក្សត្រ"],
    ["2027-05-20", "Visak Bochea", "បុណ្យវិសាខបូជា"],
    ["2027-05-24", "Royal Ploughing Ceremony", "ព្រះរាជពិធីច្រត់ព្រះនង្គ័ល"],
    ["2027-06-18", "Queen Mother's Birthday", "ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះវររាជមាតា"],
    ["2027-09-24", "Constitution Day", "ទិវាប្រកាសរដ្ឋធម្មនុញ្ញ"],
    ["2027-09-29", "Pchum Ben", "បុណ្យភ្ជុំបិណ្ឌ"],
    ["2027-09-30", "Pchum Ben", "បុណ្យភ្ជុំបិណ្ឌ"],
    ["2027-10-01", "Pchum Ben", "បុណ្យភ្ជុំបិណ្ឌ"],
    ["2027-10-15", "King Father Commemoration Day", "ទិវាគោរពព្រះវិញ្ញាណក្ខន្ធ ព្រះបរមរតនកោដ្ឋ"],
    ["2027-10-29", "Coronation Day", "ព្រះរាជពិធីគ្រងព្រះបរមរាជសម្បត្តិ"],
    ["2027-11-09", "Independence Day", "ពិធីបុណ្យឯករាជ្យជាតិ"],
    ["2027-11-12", "Water Festival", "ព្រះរាជពិធីបុណ្យអុំទូក"],
    ["2027-11-13", "Water Festival", "ព្រះរាជពិធីបុណ្យអុំទូក"],
    ["2027-11-14", "Water Festival", "ព្រះរាជពិធីបុណ្យអុំទូក"],
    ["2027-12-29", "Peace Day in Cambodia", "ទិវាសន្តិភាពនៅកម្ពុជា"],
  ],
};
// the days whose date never moves; Khmer New Year is usually 14–16 April. The moon-calendar days
// (Visak Bochea, Royal Ploughing, Pchum Ben, Water Festival) come with the sub-decree, typed in by the super admin.
function fixedDays(y) {
  return [
    [`${y}-01-01`, "International New Year Day", "ទិវាចូលឆ្នាំសកល"],
    [`${y}-01-07`, "Victory over Genocide Day", "ទិវាជ័យជម្នះលើរបបប្រល័យពូជសាសន៍"],
    [`${y}-03-08`, "International Women's Day", "ទិវានារីអន្តរជាតិ"],
    [`${y}-04-14`, "Khmer New Year", "បុណ្យចូលឆ្នាំខ្មែរ"],
    [`${y}-04-15`, "Khmer New Year", "បុណ្យចូលឆ្នាំខ្មែរ"],
    [`${y}-04-16`, "Khmer New Year", "បុណ្យចូលឆ្នាំខ្មែរ"],
    [`${y}-05-01`, "International Labour Day", "ទិវាពលកម្មអន្តរជាតិ"],
    [`${y}-05-14`, "King's Birthday", "ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះមហាក្សត្រ"],
    [`${y}-06-18`, "Queen Mother's Birthday", "ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះវររាជមាតា"],
    [`${y}-09-24`, "Constitution Day", "ទិវាប្រកាសរដ្ឋធម្មនុញ្ញ"],
    [`${y}-10-15`, "King Father Commemoration Day", "ទិវាគោរពព្រះវិញ្ញាណក្ខន្ធ ព្រះបរមរតនកោដ្ឋ"],
    [`${y}-10-29`, "Coronation Day", "ព្រះរាជពិធីគ្រងព្រះបរមរាជសម្បត្តិ"],
    [`${y}-11-09`, "Independence Day", "ពិធីបុណ្យឯករាជ្យជាតិ"],
    [`${y}-12-29`, "Peace Day in Cambodia", "ទិវាសន្តិភាពនៅកម្ពុជា"],
  ];
}
let yearNow = () => Number(C.localDay(Date.now()).slice(0, 4));
const thisYear = () => yearNow();
const isFreeYear = (y) => y <= thisYear();

// one year's national list: the super admin's (database) → the built-in one → next year's fixed days (draft)
// → { days: [[day, name, km]], official, source }
const yearCache = new Map();
async function listOf(y) {
  if (yearCache.has(y)) return yearCache.get(y);
  const doc = await M.AttHolidayYear.findOne({ year: y }).lean();
  let out;
  if (doc) out = { days: doc.days.map((d) => [d.day, d.name, d.km]), official: doc.official, source: "admin" };
  else if (KH_HOLIDAYS[y]) out = { days: KH_HOLIDAYS[y], official: true, source: "built-in" };
  else if (y <= thisYear() + 1) out = { days: fixedDays(y), official: false, source: "draft" };
  else out = { days: [], official: false, source: "none" };
  yearCache.set(y, out);
  return out;
}
// a coming year can be bought: next year always (the list grows as the government announces it), later ones once official
async function sellable(y) {
  if (isFreeYear(y)) return false;
  const l = await listOf(y);
  return l.days.length > 0 && (y === thisYear() + 1 || l.official);
}
const nameOf = (name, km) => (km ? `${name} · ${km}` : name);

async function addPreset(bid, year) {
  const { days } = await listOf(year);
  if (!days.length) return 0;
  const r = await M.AttHoliday.bulkWrite(
    days.map(([day, name, km]) => ({ updateOne: { filter: { business_id: bid, day }, update: { $setOnInsert: { business_id: bid, day, name: nameOf(name, km), preset: true } }, upsert: true } })),
    { ordered: false },
  );
  return r.upsertedCount || 0;
}
// this year (and earlier) is free; a coming year's national list is unlocked with att_holidays (item = year)
async function yearOpen(bid, y) {
  return isFreeYear(y) || !!(await License.exists({ business_id: bid, product: "att_holidays", item: String(y) }));
}
// a year's Cambodia holidays are added once, by themselves (the owner can remove any after)
const seeded = new Set(); // "bid:year" already checked in this process
async function seedYears(bid, years) {
  const want = [];
  for (const y of years) if (!seeded.has(`${bid}:${y}`) && (await listOf(y)).days.length && (await yearOpen(bid, y))) want.push(y);
  if (!want.length) return;
  const s = await M.AttSettings.findOne({ business_id: bid }).select("holiday_years").lean();
  const todo = want.filter((y) => !(s?.holiday_years || []).includes(y));
  for (const y of todo) {
    await addPreset(bid, y).catch(() => {});
    await M.AttSettings.updateOne({ business_id: bid }, { $addToSet: { holiday_years: y } });
  }
  want.forEach((y) => seeded.add(`${bid}:${y}`));
}
// holidays between two days → Map(day → name)
async function holidayMap(bid, from, to) {
  const years = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) years.push(y);
  await seedYears(bid, years);
  const rows = await M.AttHoliday.find({ business_id: bid, day: { $gte: from, $lte: to }, hidden: { $ne: true } })
    .select("day name")
    .lean();
  return new Map(rows.map((h) => [h.day, h.name]));
}
// the super admin changed a year's list → every business that has that year gets new days, loses removed ones
async function syncYear(y) {
  yearCache.delete(y);
  const { days } = await listOf(y);
  const keep = new Set(days.map((d) => d[0]));
  const list = await M.AttSettings.find({ holiday_years: y }).select("business_id").lean();
  for (const s of list) {
    await addPreset(s.business_id, y).catch(() => {});
    await M.AttHoliday.deleteMany({ business_id: s.business_id, preset: true, day: { $gte: `${y}-01-01`, $lte: `${y}-12-31`, $nin: [...keep] } });
  }
  return list.length;
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, staffCtx, Bad, MSG, text, validId, ownerName, DAY_RE, hooks } = kit;
  const T = {
    badDay: "ថ្ងៃមិនត្រឹមត្រូវ!",
    exists: "ថ្ងៃនេះមានក្នុងបញ្ជីរួចហើយ!",
    tooOld: "អាចស្នើកែបានតែ 31 ថ្ងៃចុងក្រោយ",
    future: "មិនអាចស្នើសម្រាប់ពេលខាងមុខបានទេ",
    tooMany: "អ្នកមានសំណើរង់ចាំច្រើនពេក (ច្រើនបំផុត 5)",
    same: "អ្នកបានស្នើសម្រាប់ថ្ងៃនេះរួចហើយ",
    needReason: "សូមសរសេរមូលហេតុ",
    done: "សំណើនេះបានសម្រេចរួចហើយ",
    sent: "បានផ្ញើសំណើហើយ!",
    locked: "សូមដោះសោថ្ងៃឈប់សម្រាកជាតិឆ្នាំនេះជាមុនសិន",
    noList: "មិនទាន់មានបញ្ជីថ្ងៃឈប់សម្រាកសម្រាប់ឆ្នាំនេះទេ",
    free: "ឆ្នាំនេះឥតគិតថ្លៃ",
    already: "បានដោះសោរួចហើយ!",
    noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
    busy: "កំពុងដំណើរការ សូមព្យាយាមម្តងទៀត!",
  };
  const year = (v) => {
    const y = Number(v);
    return Number.isInteger(y) && y >= 2020 && y <= 2100 ? y : Number(C.localDay(Date.now()).slice(0, 4));
  };

  // ===================================== HOLIDAYS =====================================
  prop.app.get(
    `${base}/holidays`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const y = year(req.query.year);
      await seedYears(ctx.business._id, [y]);
      const rows = await M.AttHoliday.find({ business_id: ctx.business._id, day: { $gte: `${y}-01-01`, $lte: `${y}-12-31` }, hidden: { $ne: true } })
        .sort({ day: 1 })
        .lean();
      const list = await listOf(y);
      const open = await yearOpen(ctx.business._id, y);
      const missing = open ? list.days.filter(([d]) => !rows.some((r) => r.day === d)).length : 0;
      const canBuy = await sellable(y);
      res.json({ success: true, data: rows, year: y, preset: list.days.length, official: list.official, missing, locked: list.days.length > 0 && !open, can_buy: canBuy && !open, free: isFreeYear(y), price: await priceOf("att_holidays") });
    }),
  );
  prop.app.post(
    `${base}/holidays`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      const day = String(b.day || "");
      if (!DAY_RE.test(day)) throw new Bad(T.badDay);
      const name = text(b, "name", 80, { required: true });
      const old = await M.AttHoliday.findOne({ business_id: ctx.business._id, day });
      if (old && !old.hidden) throw new Bad(T.exists, 409);
      if (old) {
        // a removed Cambodia day: bring it back under the owner's name
        old.set({ hidden: false, name });
        await old.save();
        return res.status(201).json({ success: true, data: old, message: MSG.saved });
      }
      try {
        const row = await M.AttHoliday.create({ business_id: ctx.business._id, day, name });
        res.status(201).json({ success: true, data: row, message: MSG.saved });
      } catch (err) {
        if (err.code === 11000) throw new Bad(T.exists, 409);
        throw err;
      }
    }),
  );
  prop.app.put(
    `${base}/holidays/:hid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.hid)) throw new Bad(MSG.badId);
      const name = text(req.body || {}, "name", 80, { required: true });
      const row = await M.AttHoliday.findOneAndUpdate({ _id: req.params.hid, business_id: ctx.business._id }, { $set: { name } }, { returnDocument: "after" }).lean();
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, data: row, message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/holidays/:hid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.hid)) throw new Bad(MSG.badId);
      const row = await M.AttHoliday.findOne({ _id: req.params.hid, business_id: ctx.business._id });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      // a Cambodia day is only hidden, so a list update from BizHub doesn't bring it back
      if (row.preset) {
        row.hidden = true;
        await row.save();
      } else await row.deleteOne();
      res.json({ success: true, message: MSG.deleted });
    }),
  );
  prop.app.post(
    `${base}/holidays/preset`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const y = year(req.body?.year);
      if (!(await yearOpen(ctx.business._id, y))) throw new Bad(T.locked, 402, { product: "att_holidays", item: String(y) });
      const added = await addPreset(ctx.business._id, y);
      const back = await M.AttHoliday.updateMany({ business_id: ctx.business._id, preset: true, hidden: true, day: { $gte: `${y}-01-01`, $lte: `${y}-12-31` } }, { $set: { hidden: false } });
      await M.AttSettings.updateOne({ business_id: ctx.business._id }, { $addToSet: { holiday_years: y } });
      res.json({ success: true, added: added + (back.modifiedCount || 0), message: MSG.saved });
    }),
  );

  // unlock a coming year's national holidays (45 coins, that year's list is yours)
  prop.app.post(
    `${base}/holidays/unlock`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const y = year(req.body?.year);
      if (isFreeYear(y)) throw new Bad(T.free, 409);
      if (!(await sellable(y))) throw new Bad(T.noList, 404);
      let r;
      try {
        r = await buy({ customer: req.customer, business: ctx.business, product: "att_holidays", item: String(y) });
      } catch (err) {
        if (err instanceof LicenseError) throw new Bad(T[err.message] || err.message, err.status, err.extra);
        throw err;
      }
      const added = await addPreset(ctx.business._id, y);
      await M.AttSettings.updateOne({ business_id: ctx.business._id }, { $addToSet: { holiday_years: y } });
      seeded.add(`${ctx.business._id}:${y}`);
      res.json({ success: true, added, charged: r.charged, balance: r.balance, message: MSG.saved });
    }),
  );

  // ===================================== SUPER ADMIN: the national lists =====================================
  const admin = [prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin];
  const yearInfo = async (y) => {
    const l = await listOf(y);
    const [buyers, using] = await Promise.all([License.countDocuments({ product: "att_holidays", item: String(y) }), M.AttSettings.countDocuments({ holiday_years: y })]);
    return { year: y, days: l.days.map(([day, name, km]) => ({ day, name, km })), official: l.official, source: l.source, buyers, using, free: isFreeYear(y), sellable: await sellable(y) };
  };
  prop.app.get(
    `/${prop.main_route}/holiday-years`,
    ...admin,
    handle(async (req, res) => {
      const now = thisYear();
      const y = Number(req.query.year);
      if (Number.isInteger(y) && y >= 2020 && y <= 2100) return res.json({ success: true, data: await yearInfo(y) });
      const years = [];
      for (let k = now - 1; k <= now + 2; k += 1) years.push(await yearInfo(k));
      res.json({ success: true, data: years, this_year: now });
    }),
  );
  prop.app.put(
    `/${prop.main_route}/holiday-years/:year`,
    ...admin,
    handle(async (req, res) => {
      const y = Number(req.params.year);
      if (!Number.isInteger(y) || y < 2020 || y > 2100) throw new Bad(T.badDay);
      const b = req.body || {};
      if (!Array.isArray(b.days) || b.days.length > 60) throw new Bad(`${MSG.badValue} (days)`);
      const seen = new Set();
      const days = b.days
        .map((d) => ({ day: String(d?.day || ""), name: text(d || {}, "name", 80) || "", km: text(d || {}, "km", 120) || "" }))
        .filter((d) => d.day || d.name)
        .map((d) => {
          if (!DAY_RE.test(d.day) || !d.day.startsWith(`${y}-`) || seen.has(d.day) || !d.name) throw new Bad(`${T.badDay} (${d.day || "?"})`);
          seen.add(d.day);
          return d;
        })
        .sort((a, c) => (a.day < c.day ? -1 : 1));
      await M.AttHolidayYear.findOneAndUpdate({ year: y }, { $set: { days, official: !!b.official, updated_by: req.user?.email || req.user?.firstname || "" } }, { upsert: true });
      const synced = await syncYear(y);
      res.json({ success: true, data: await yearInfo(y), synced, message: MSG.saved });
    }),
  );

  // ===================================== CORRECTIONS =====================================
  const fixOut = (f) => ({ _id: f._id, day: f.day, kind: f.kind, time: f.time, at: f.at, reason: f.reason, status: f.status, note: f.note, by: f.by, decided_at: f.decided_at, created_date: f.created_date });
  // staff: my requests
  prop.app.get(
    "/api/att/fixes",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      const rows = await M.AttFix.find({ business_id: ctx.staff.business_id, staff_id: ctx.staff._id }).sort({ created_date: -1 }).limit(40).lean();
      res.json({ success: true, data: rows.map(fixOut) });
    }),
  );
  prop.app.post(
    "/api/att/fixes",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      const { staff, settings } = ctx;
      const bid = staff.business_id;
      const b = req.body || {};
      const day = String(b.day || "");
      if (!DAY_RE.test(day)) throw new Bad(T.badDay);
      const today = C.localDay(Date.now());
      if (day > today) throw new Bad(T.future);
      if (day < C.addDays(today, -31)) throw new Bad(T.tooOld);
      const kind = ["in", "out"].includes(b.kind) ? b.kind : null;
      if (!kind) throw new Bad(`${MSG.required}: kind`);
      const time = String(b.time || "");
      if (!M.HHMM.test(time)) throw new Bad(`${MSG.badValue} (time)`);
      const reason = text(b, "reason", 300);
      if (!reason) throw new Bad(T.needReason, 400, { code: "need_reason" });
      // the moment: on that work day; a night shift's clock-out before its start is the next morning
      const shift = staff.shift_id ? await M.AttShift.findOne({ _id: staff.shift_id, business_id: bid }).lean() : null;
      let at = C.atOf(day, time);
      if (shift && C.toMin(shift.end) <= C.toMin(shift.start) && C.toMin(time) < C.toMin(shift.start)) at += C.DAY;
      if (at > Date.now() + 5 * C.MIN) throw new Bad(T.future);
      const [pending, same] = await Promise.all([M.AttFix.countDocuments({ business_id: bid, staff_id: staff._id, status: "pending" }), M.AttFix.exists({ business_id: bid, staff_id: staff._id, status: "pending", day, kind })]);
      if (same) throw new Bad(T.same, 409);
      if (pending >= 5) throw new Bad(T.tooMany, 429);
      const row = await M.AttFix.create({ business_id: bid, staff_id: staff._id, day, kind, time, at: new Date(at), reason });
      if (settings.telegram?.fix_alert !== false && hooks.notify) {
        const e = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        hooks.notify(bid, settings, `✏️ <b>${e(ctx.business.name)}</b>\n<b>${e(staff.name)}</b> asks to add a clock-${kind} at ${time} on ${day}\n“${e(reason)}”\nApprove in BizHub · សូមពិនិត្យក្នុង BizHub`, ctx).catch(() => {});
      }
      res.status(201).json({ success: true, data: fixOut(row), message: T.sent });
    }),
  );
  prop.app.delete(
    "/api/att/fixes/:fid",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      if (!validId(req.params.fid)) throw new Bad(MSG.badId);
      const row = await M.AttFix.findOneAndUpdate({ _id: req.params.fid, business_id: ctx.staff.business_id, staff_id: ctx.staff._id, status: "pending" }, { $set: { status: "cancelled" } }, { returnDocument: "after" }).lean();
      if (!row) throw new Bad(T.done, 409);
      res.json({ success: true, data: fixOut(row) });
    }),
  );

  // owner: the requests
  prop.app.get(
    `${base}/fixes`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const filter = { business_id: bid, ...(req.query.status === "all" ? { status: { $ne: "cancelled" } } : { status: "pending" }) };
      const rows = await M.AttFix.find(filter).sort({ created_date: -1 }).limit(100).lean();
      const staff = await M.AttStaff.find({ _id: { $in: rows.map((r) => r.staff_id) } })
        .select("name position photo")
        .lean();
      const byId = new Map(staff.map((s) => [String(s._id), s]));
      res.json({ success: true, data: rows.map((r) => ({ ...fixOut(r), staff: byId.get(String(r.staff_id)) || { name: "—" } })), pending: await M.AttFix.countDocuments({ business_id: bid, status: "pending" }) });
    }),
  );
  hooks.decide.fix = async (bid, fid, status, note, by) => {
    const fix = await M.AttFix.findOne({ _id: fid, business_id: bid });
    if (!fix) throw new Bad(MSG.rowNotFound, 404);
    if (fix.status !== "pending") throw new Bad(T.done, 409);
    // claim it first so two taps can't add two records
    const claimed = await M.AttFix.findOneAndUpdate({ _id: fix._id, status: "pending" }, { $set: { status, note, by: by, decided_at: new Date() } }, { returnDocument: "after" });
    if (!claimed) throw new Bad(T.done, 409);
    if (status === "approved") {
      const staff = await M.AttStaff.findOne({ _id: fix.staff_id, business_id: bid }).lean();
      const punch = await M.AttPunch.create({
        business_id: bid,
        staff_id: fix.staff_id,
        kind: fix.kind,
        at: fix.at,
        day: fix.day,
        branch_id: staff?.branch_ids?.[0] || null,
        source: "manual",
        review: "ok",
        note: `✏️ ${fix.reason}${note ? ` — ${note}` : ""}`.slice(0, 300),
        by: by,
        decided_at: new Date(),
      });
      claimed.punch_id = punch._id;
      await claimed.save();
    }
    return claimed;
  };
  prop.app.post(
    `${base}/fixes/:fid/decide`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const bid = ctx.business._id;
      if (!validId(req.params.fid)) throw new Bad(MSG.badId);
      const status = ["approved", "rejected"].includes(req.body?.status) ? req.body.status : null;
      if (!status) throw new Bad(`${MSG.required}: status`);
      const note = text(req.body || {}, "note", 300) || "";
      const claimed = await hooks.decide.fix(bid, req.params.fid, status, note, ownerName(req));
      res.json({ success: true, data: fixOut(claimed), pending: await M.AttFix.countDocuments({ business_id: bid, status: "pending" }), message: MSG.saved });
    }),
  );
};
module.exports.holidayMap = holidayMap;
module.exports.KH_HOLIDAYS = KH_HOLIDAYS;
// tests only: pretend it is another year
module.exports.__setYear = (y) => {
  yearNow = y ? () => y : () => Number(C.localDay(Date.now()).slice(0, 4));
  yearCache.clear();
};
