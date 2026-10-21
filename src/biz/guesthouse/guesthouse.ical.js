// Booking.com / Agoda / Airbnb calendar sync (gh_ical, yearly) — iCal links both ways, per room:
//   export: we give each room a link (.ics) → paste it in Booking.com / Agoda → they close the dates booked here
//   import: paste each OTA's calendar link here → their bookings appear as bookings here (and block the room)
// Base: /api/user/businesses/:id/guesthouse
//   GET    /ical                         rooms + export links + import links (feeds)
//   POST   /ical/feeds   { room_id, source, url }        (needs gh_ical)
//   PUT    /ical/feeds/:fid { source, url, active }
//   DELETE /ical/feeds/:fid                              (its future bookings are cancelled)
//   POST   /ical/sync                    read every link now
//   POST   /ical/token                   new export links (the old ones stop working)
// Public:  GET /api/public/stay/ical/:token/:rid.ics
// Scheduler: GET /api/cron/guesthouse-ical (also run by /api/cron/daily-report) — every link at most every 15 minutes
const crypto = require("crypto");
const M = require("./guesthouse.models");

const MAX_FEEDS_ROOM = 5;
const MAX_BYTES = 3 * 1024 * 1024;
const EVERY_MIN = 15;
const NAMES = { booking_com: "Booking.com", agoda: "Agoda", airbnb: "Airbnb", expedia: "Expedia", other: "OTA" };
const T = {
  needAddon: "សូមដោះសោ “ភ្ជាប់ប្រតិទិន Booking.com / Agoda” ជាមុនសិន!",
  badUrl: "តំណប្រតិទិនមិនត្រឹមត្រូវ (ត្រូវចាប់ផ្តើមដោយ https://)!",
  tooMany: `តំណច្រើនបំផុត ${MAX_FEEDS_ROOM} ក្នុងមួយបន្ទប់!`,
  same: "តំណនេះមានរួចហើយ!",
  own: "នេះជាតំណរបស់ BizHub ផ្ទាល់ — សូមដាក់តំណពី Booking.com / Agoda។",
};
const localDay = (t = Date.now()) => new Date(t + 7 * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const token = () => crypto.randomBytes(18).toString("base64url").replace(/[-_]/g, "").slice(0, 22);

// ---------- reading an .ics ----------
function icsDay(prop) {
  // DTSTART;VALUE=DATE:20261014  ·  DTSTART:20261014T070000Z  ·  DTSTART;TZID=Asia/Bangkok:20261014T140000
  const value = prop.slice(prop.indexOf(":") + 1).trim();
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return "";
  if (m[7] === "Z") return localDay(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])); // UTC time → the Cambodia day
  return `${m[1]}-${m[2]}-${m[3]}`;
}
function parseIcs(text) {
  const lines = String(text)
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const key = line.split(/[;:]/)[0].toUpperCase();
      if (key === "UID") cur.uid = line.slice(line.indexOf(":") + 1).trim();
      else if (key === "DTSTART") cur.from = icsDay(line);
      else if (key === "DTEND") cur.to = icsDay(line);
      else if (key === "SUMMARY")
        cur.summary = line
          .slice(line.indexOf(":") + 1)
          .replace(/\\([,;\\])/g, "$1")
          .replace(/\\n/gi, " ")
          .trim();
      else if (key === "STATUS")
        cur.status = line
          .slice(line.indexOf(":") + 1)
          .trim()
          .toUpperCase();
    }
  }
  return events
    .filter((e) => e.from && e.status !== "CANCELLED")
    .map((e) => {
      const to = e.to && e.to > e.from ? e.to : addDays(e.from, 1);
      return { ...e, to, uid: (e.uid || `${e.from}_${to}_${e.summary || ""}`).slice(0, 300) };
    });
}
const icsEscape = (s) => String(s || "").replace(/([,;\\])/g, "\\$1");
const icsDate = (d) => d.replace(/-/g, "");

// ---------- one link ----------
async function syncFeed(feed, { notify = true } = {}) {
  const result = { added: 0, updated: 0, removed: 0, conflicts: 0, error: "" };
  const today = localDay();
  let text = "";
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": "BizHub-Calendar/1.0", Accept: "text/calendar,*/*" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("too big");
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("not a calendar");
  } catch (err) {
    result.error = String(err?.message || err).slice(0, 200);
    await M.GhIcalFeed.updateOne({ _id: feed._id }, { $set: { last_sync_at: new Date(), last_error: result.error } });
    return result;
  }
  const bid = feed.business_id;
  const room = await M.GhRoom.findOne({ _id: feed.room_id, business_id: bid }).lean();
  if (!room) {
    result.error = "room not found";
    await M.GhIcalFeed.updateOne({ _id: feed._id }, { $set: { last_sync_at: new Date(), last_error: result.error } });
    return result;
  }
  const events = parseIcs(text).filter((e) => e.to > today && e.from < addDays(today, 500));
  const uids = events.map((e) => e.uid);
  const known = await M.GhStay.find({ business_id: bid, ical_feed: feed._id }).sort({ created_date: -1 });
  const byUid = new Map();
  for (const s of known) if (!byUid.has(s.ical_uid)) byUid.set(s.ical_uid, s);
  const clashOf = (from, to, except) => M.GhStay.findOne({ business_id: bid, room_id: room._id, status: { $in: M.LIVE }, from: { $lt: to }, to: { $gt: from }, ...(except ? { _id: { $ne: except } } : {}) }).lean();
  const conflicts = [];
  const fresh = [];
  const type = await M.GhRoomType.findById(room.type_id).select("price").lean();
  const name = NAMES[feed.source] || "OTA";
  for (const e of events) {
    const had = byUid.get(e.uid);
    if (had) {
      // already here: follow date changes while it is still only booked
      if (had.status === "booked" && (had.from !== e.from || had.to !== e.to)) {
        const clash = await clashOf(e.from, e.to, had._id);
        if (clash) conflicts.push({ uid: e.uid, from: e.from, to: e.to, with_no: clash.no });
        else {
          had.from = e.from;
          had.to = e.to;
          await had.save();
          result.updated += 1;
        }
      }
      continue;
    }
    const clash = await clashOf(e.from, e.to);
    if (clash) {
      conflicts.push({ uid: e.uid, from: e.from, to: e.to, with_no: clash.no });
      continue;
    }
    const counter = await M.GhSettings.findOneAndUpdate({ business_id: bid }, { $inc: { next_no: 1 } }, { returnDocument: "before", upsert: true });
    // "CLOSED - Not available" / "Reserved" say nothing; "Booked - John" keeps "John"
    const rest = String(e.summary || "")
      .replace(/^(closed|reserved|blocked|unavailable|booked|not available)\b\s*[-–:]*\s*/i, "")
      .trim();
    const note = /^(not available|unavailable|reserved|blocked|closed)?$/i.test(rest) ? "" : rest.slice(0, 200);
    const stay = await M.GhStay.create({
      business_id: bid,
      no: `B-${String(counter.next_no || 1).padStart(4, "0")}`,
      room_id: room._id,
      status: "booked",
      from: e.from,
      to: e.to,
      rate: type?.price || 0,
      guest: { name: `${name} guest` },
      source: feed.source === "other" ? "other" : feed.source,
      note: [`📥 ${name}`, note].filter(Boolean).join(" · "),
      by: name,
      ical_feed: feed._id,
      ical_uid: e.uid,
    });
    fresh.push(stay);
    result.added += 1;
  }
  // gone from their calendar → cancelled here (only bookings nobody has checked in)
  for (const s of known) {
    if (s.status !== "booked" || uids.includes(s.ical_uid)) continue;
    s.status = "cancelled";
    s.cancelled_at = new Date();
    s.note = [s.note, `✖ removed from the ${name} calendar`].filter(Boolean).join("\n").slice(0, 500);
    await s.save();
    result.removed += 1;
  }
  result.conflicts = conflicts.length;
  const before = new Set((feed.conflicts || []).map((c) => c.uid));
  await M.GhIcalFeed.updateOne({ _id: feed._id }, { $set: { last_sync_at: new Date(), last_ok_at: new Date(), last_error: "", last_count: events.length, conflicts: conflicts.slice(0, 50) } });
  // Telegram (gh_telegram): new OTA bookings + double bookings
  if (notify && (fresh.length || conflicts.some((c) => !before.has(c.uid)))) {
    const TG = require("./guesthouse.telegram");
    for (const s of fresh.slice(0, 5)) await TG.alert(bid, "new_booking", { request: { kind: "ota", name: `${name} guest`, contact: "", type_name: `🛏 ${room.name}`, from: s.from, to: s.to, guests: 1, ota: name } }).catch(() => {});
    for (const c of conflicts.filter((x) => !before.has(x.uid)).slice(0, 5))
      await TG.alert(bid, "new_booking", { request: { kind: "conflict", name, contact: "", type_name: `🛏 ${room.name}`, from: c.from, to: c.to, guests: 1, ota: name, with_no: c.with_no } }).catch(() => {});
  }
  return result;
}

// every due link (scheduler)
async function syncDue(limit = 60) {
  const due = await M.GhIcalFeed.find({ active: true, $or: [{ last_sync_at: null }, { last_sync_at: { $lt: new Date(Date.now() - EVERY_MIN * 60000) } }] })
    .sort({ last_sync_at: 1 })
    .limit(limit);
  const { licenseState } = require("./guesthouse.route");
  const states = new Map();
  let synced = 0;
  for (const f of due) {
    const k = String(f.business_id);
    if (!states.has(k)) states.set(k, await licenseState(f.business_id));
    const st = states.get(k);
    if (!st.addons.gh_ical?.active || st.license.locked) {
      await M.GhIcalFeed.updateOne({ _id: f._id }, { $set: { last_sync_at: new Date() } });
      continue;
    }
    await syncFeed(f);
    synced += 1;
  }
  return { due: due.length, synced };
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, Bad, MSG, text, bool, validId } = kit;
  const needAddon = (ctx) => {
    if (!ctx.addons.gh_ical?.active) throw new Bad(T.needAddon, 402, { product: "gh_ical" });
  };
  const apiUrl = (req) => (process.env.API_PUBLIC_URL || "").trim().replace(/\/+$/, "") || `${req.get("x-forwarded-proto")?.split(",")[0] || req.protocol}://${req.get("x-forwarded-host") || req.get("host")}`;
  const tokenOf = async (settings) => {
    if (!settings.ical_token) {
      settings.ical_token = token();
      await settings.save();
    }
    return settings.ical_token;
  };
  const feedOut = (f) => ({
    _id: f._id,
    room_id: f.room_id,
    source: f.source,
    name: NAMES[f.source],
    url: f.url,
    active: f.active,
    last_sync_at: f.last_sync_at,
    last_ok_at: f.last_ok_at,
    last_error: f.last_error,
    last_count: f.last_count,
    conflicts: f.conflicts || [],
  });
  const readUrl = (b, req) => {
    const url = text(b, "url", 1000, { required: true });
    if (!/^(https?|webcal):\/\/[^\s]+\.[^\s]+$/i.test(url)) throw new Bad(T.badUrl);
    if (url.includes("/api/public/stay/ical/") && url.includes(apiUrl(req).replace(/^https?:\/\//, ""))) throw new Bad(T.own);
    return url.replace(/^webcal:\/\//i, "https://");
  };

  prop.app.get(
    `${base}/ical`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const tok = await tokenOf(ctx.settings);
      const [rooms, types, feeds] = await Promise.all([
        M.GhRoom.find({ business_id: bid, active: true }).sort({ sort: 1, created_date: 1 }).lean(),
        M.GhRoomType.find({ business_id: bid }).select("name color").lean(),
        M.GhIcalFeed.find({ business_id: bid }).sort({ created_date: 1 }).lean(),
      ]);
      const typeOf = new Map(types.map((t) => [String(t._id), t]));
      const root = apiUrl(req);
      res.json({
        success: true,
        data: {
          on: !!ctx.addons.gh_ical?.active,
          sources: M.ICAL_SOURCES,
          rooms: rooms.map((r) => ({
            _id: r._id,
            name: r.name,
            type: typeOf.get(String(r.type_id))?.name || "",
            color: typeOf.get(String(r.type_id))?.color || "",
            export_url: `${root}/api/public/stay/ical/${tok}/${r._id}.ics`,
            feeds: feeds.filter((f) => String(f.room_id) === String(r._id)).map(feedOut),
          })),
        },
      });
    }),
  );
  prop.app.post(
    `${base}/ical/feeds`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      const b = req.body || {};
      if (!validId(String(b.room_id || ""))) throw new Bad(`${MSG.required}: room_id`);
      const room = await M.GhRoom.findOne({ _id: b.room_id, business_id: ctx.business._id }).lean();
      if (!room) throw new Bad(MSG.rowNotFound, 404);
      const url = readUrl(b, req);
      if ((await M.GhIcalFeed.countDocuments({ business_id: ctx.business._id, room_id: room._id })) >= MAX_FEEDS_ROOM) throw new Bad(T.tooMany);
      if (await M.GhIcalFeed.exists({ business_id: ctx.business._id, room_id: room._id, url })) throw new Bad(T.same, 409);
      const feed = await M.GhIcalFeed.create({ business_id: ctx.business._id, room_id: room._id, source: M.ICAL_SOURCES.includes(b.source) ? b.source : "other", url });
      const result = await syncFeed(feed, { notify: false });
      res.status(201).json({ success: true, data: feedOut(await M.GhIcalFeed.findById(feed._id).lean()), result, message: MSG.saved });
    }),
  );
  const loadFeed = async (ctx, fid) => {
    if (!validId(fid)) throw new Bad(MSG.badId);
    const f = await M.GhIcalFeed.findOne({ _id: fid, business_id: ctx.business._id });
    if (!f) throw new Bad(MSG.rowNotFound, 404);
    return f;
  };
  prop.app.put(
    `${base}/ical/feeds/:fid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      const f = await loadFeed(ctx, req.params.fid);
      const b = req.body || {};
      if (b.url !== undefined) f.url = readUrl(b, req);
      if (M.ICAL_SOURCES.includes(b.source)) f.source = b.source;
      const active = bool(b, "active");
      if (active !== undefined) f.active = active;
      await f.save();
      res.json({ success: true, data: feedOut(f), message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/ical/feeds/:fid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const f = await loadFeed(ctx, req.params.fid);
      const r = await M.GhStay.updateMany({ business_id: ctx.business._id, ical_feed: f._id, status: "booked" }, { $set: { status: "cancelled", cancelled_at: new Date() } });
      await f.deleteOne();
      res.json({ success: true, cancelled: r.modifiedCount || 0, message: MSG.saved });
    }),
  );
  prop.app.post(
    `${base}/ical/sync`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      const feeds = await M.GhIcalFeed.find({ business_id: ctx.business._id, active: true }).limit(200);
      const sum = { feeds: feeds.length, added: 0, updated: 0, removed: 0, conflicts: 0, errors: 0 };
      for (const f of feeds) {
        const r = await syncFeed(f);
        for (const k of ["added", "updated", "removed", "conflicts"]) sum[k] += r[k];
        if (r.error) sum.errors += 1;
      }
      res.json({ success: true, data: sum });
    }),
  );
  prop.app.post(
    `${base}/ical/token`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needAddon(ctx);
      ctx.settings.ical_token = token();
      await ctx.settings.save();
      res.json({ success: true, message: MSG.saved });
    }),
  );

  // the room's calendar for Booking.com / Agoda (no guest names — just "booked")
  prop.app.get("/api/public/stay/ical/:token/:file", async (req, res) => {
    try {
      const tok = String(req.params.token || "");
      const rid = String(req.params.file || "").replace(/\.ics$/i, "");
      if (!/^[A-Za-z0-9]{10,40}$/.test(tok) || !validId(rid)) return res.status(404).send("Not found");
      const s = await M.GhSettings.findOne({ ical_token: tok }).select("business_id").lean();
      if (!s) return res.status(404).send("Not found");
      const room = await M.GhRoom.findOne({ _id: rid, business_id: s.business_id }).select("name").lean();
      if (!room) return res.status(404).send("Not found");
      const { addons, license } = await require("./guesthouse.route").licenseState(s.business_id);
      const today = localDay();
      const stays =
        addons.gh_ical?.active && !license.locked
          ? await M.GhStay.find({ business_id: s.business_id, room_id: room._id, status: { $in: M.LIVE }, to: { $gt: addDays(today, -1) } })
              .select("from to updated_date")
              .lean()
          : [];
      const stamp = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
      const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//BizHub//Guest House//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsEscape(`Room ${room.name}`)}`];
      for (const st of stays) lines.push("BEGIN:VEVENT", `UID:${st._id}@bizhub`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${icsDate(st.from)}`, `DTEND;VALUE=DATE:${icsDate(st.to)}`, "SUMMARY:Booked", "TRANSP:OPAQUE", "END:VEVENT");
      lines.push("END:VCALENDAR");
      res.set({ "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache", "Content-Disposition": `inline; filename="room-${room.name}.ics"` });
      res.send(lines.join("\r\n") + "\r\n");
    } catch (err) {
      console.error("[ical]", err);
      res.status(500).send("Error");
    }
  });

  prop.app.get("/api/cron/guesthouse-ical", async (req, res) => {
    const secret = process.env.CRON_SECRET || "";
    const given = (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || String(req.query.key || "");
    if (!secret || given !== secret) return res.sendStatus(404);
    try {
      res.json({ success: true, ...(await syncDue()) });
    } catch (err) {
      console.error("[guesthouse-ical]", err);
      res.status(500).json({ success: false });
    }
  });
};
module.exports.parseIcs = parseIcs;
module.exports.syncFeed = syncFeed;
module.exports.syncDue = syncDue;
