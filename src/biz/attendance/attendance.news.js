// Announcements (att_news, yearly): the owner posts a message (to everyone or some branches); staff read it in their app.
// The owner sees "read by n of m".
// Owner: GET /news   POST /news { title, body, pinned, branch_ids }   PUT /news/:nid   DELETE /news/:nid
// Staff (x-att-token): GET /api/att/news   POST /api/att/news/:nid/read
const mongoose = require("mongoose");
const M = require("./attendance.models");

const MAX_NEWS = 200;
// does this announcement reach this staff?
const reaches = (n, s) => !n.branch_ids?.length || !s.branch_ids?.length || n.branch_ids.some((b) => s.branch_ids.some((x) => String(x) === String(b)));

// the announcements a staff can see, newest first (pinned on top) + how many they haven't read
async function newsFor(staff, limit = 30) {
  const rows = await M.AttNews.find({ business_id: staff.business_id }).sort({ pinned: -1, created_date: -1 }).limit(MAX_NEWS).lean();
  const mine = rows.filter((n) => reaches(n, staff));
  const read = (n) => (n.reads || []).some((r) => String(r.staff_id) === String(staff._id));
  return { rows: mine.slice(0, limit).map((n) => ({ _id: n._id, title: n.title, body: n.body, pinned: n.pinned, by: n.by, created_date: n.created_date, read: read(n) })), unread: mine.filter((n) => !read(n)).length };
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, staffCtx, Bad, MSG, text, bool, validId, ownerName, hooks } = kit;
  const T = { need: "សូមដោះសោ “សេចក្តីជូនដំណឹង” ជាមុនសិន!", off: "សេចក្តីជូនដំណឹងមិនទាន់បើក" };
  const need = (ctx) => {
    if (!ctx.addons.att_news?.active) throw new Bad(T.need, 402, { product: "att_news" });
  };
  const read = async (ctx, b, partial) => {
    const set = {};
    const title = text(b, "title", 100, { required: !partial });
    if (title !== undefined) set.title = title;
    const body = text(b, "body", 2000);
    if (body !== undefined) set.body = body;
    const pinned = bool(b, "pinned");
    if (pinned !== undefined) set.pinned = pinned;
    if (b.branch_ids !== undefined) {
      if (!Array.isArray(b.branch_ids) || b.branch_ids.length > 100 || !b.branch_ids.every(validId)) throw new Bad(`${MSG.badValue} (branch_ids)`);
      const ids = [...new Set(b.branch_ids.map(String))];
      if (ids.length && (await M.AttBranch.countDocuments({ _id: { $in: ids }, business_id: ctx.business._id })) !== ids.length) throw new Bad(`${MSG.badValue} (branch_ids)`);
      set.branch_ids = ids.map((x) => new mongoose.Types.ObjectId(x));
    }
    return set;
  };

  prop.app.get(
    `${base}/news`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const [rows, staff] = await Promise.all([M.AttNews.find({ business_id: bid }).sort({ pinned: -1, created_date: -1 }).limit(MAX_NEWS).lean(), M.AttStaff.find({ business_id: bid, active: true }).select("name branch_ids").lean()]);
      const name = new Map(staff.map((s) => [String(s._id), s.name]));
      res.json({
        success: true,
        data: {
          on: !!ctx.addons.att_news?.active,
          rows: rows.map((n) => {
            const to = staff.filter((s) => reaches(n, s));
            const readIds = new Set((n.reads || []).map((r) => String(r.staff_id)));
            return {
              _id: n._id,
              title: n.title,
              body: n.body,
              pinned: n.pinned,
              branch_ids: n.branch_ids,
              by: n.by,
              created_date: n.created_date,
              total: to.length,
              read: to.filter((s) => readIds.has(String(s._id))).length,
              readers: to.filter((s) => readIds.has(String(s._id))).map((s) => s.name),
              waiting: to.filter((s) => !readIds.has(String(s._id))).map((s) => name.get(String(s._id))),
            };
          }),
        },
      });
    }),
  );
  prop.app.post(
    `${base}/news`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      const set = await read(ctx, req.body || {}, false);
      if ((await M.AttNews.countDocuments({ business_id: ctx.business._id })) >= MAX_NEWS) throw new Bad(MSG.tooMany);
      const row = await M.AttNews.create({ ...set, business_id: ctx.business._id, by: ownerName(req) });
      if (hooks.onNews) hooks.onNews(ctx, row).catch(() => {});
      res.status(201).json({ success: true, data: row, message: MSG.saved });
    }),
  );
  prop.app.put(
    `${base}/news/:nid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      if (!validId(req.params.nid)) throw new Bad(MSG.badId);
      const row = await M.AttNews.findOneAndUpdate({ _id: req.params.nid, business_id: ctx.business._id }, { $set: await read(ctx, req.body || {}, true) }, { returnDocument: "after" }).lean();
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, data: row, message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/news/:nid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.nid)) throw new Bad(MSG.badId);
      const r = await M.AttNews.deleteOne({ _id: req.params.nid, business_id: ctx.business._id });
      if (!r.deletedCount) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, message: MSG.saved });
    }),
  );

  // ---- staff ----
  prop.app.get(
    "/api/att/news",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      if (!ctx.addons.att_news?.active) throw new Bad(T.off, 402, { code: "news_off" });
      res.json({ success: true, data: await newsFor(ctx.staff) });
    }),
  );
  prop.app.post(
    "/api/att/news/:nid/read",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      if (!validId(req.params.nid)) throw new Bad(MSG.badId);
      const n = await M.AttNews.findOne({ _id: req.params.nid, business_id: ctx.staff.business_id }).lean();
      if (!n || !reaches(n, ctx.staff)) throw new Bad(MSG.rowNotFound, 404);
      await M.AttNews.updateOne({ _id: n._id, "reads.staff_id": { $ne: ctx.staff._id } }, { $push: { reads: { staff_id: ctx.staff._id, at: new Date() } } });
      res.json({ success: true, data: await newsFor(ctx.staff) });
    }),
  );
};
module.exports.newsFor = newsFor;
