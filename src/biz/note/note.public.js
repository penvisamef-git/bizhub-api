// Digital Note — people who open a shared note (no login). Contract: NOTE_SPEC.md.
// Headers on every call: x-note-pin (when the note has a PIN), x-note-guest (a random key the browser / app keeps).
//   GET    /api/public/note/:token                → note, business, share (the level that applies now), entries, me
//   POST   /api/public/note/:token/seen { name }
//   PUT    /api/public/note/:token { title, blocks, base_version, name }      (edit level)
//   POST   /api/public/note/:token/entries        multipart: text, name, files (≤ 5)   (reply / edit / collect)
//   PUT    /api/public/note/:token/entries/:eid { text, name }   DELETE …/entries/:eid   (only the guest who wrote it)
// A group link (NOTE_ADDONS.md): the group's level / PIN / end date / safety apply to every note opened through it.
//   GET    /api/public/note-group/:gtoken          → group, business, share, notes [{ _id, title, preview, color, updated_date }], me
//   POST   /api/public/note-group/:gtoken/seen { name }
//   GET    /api/public/note-group/:gtoken/files?q&kind&sort&page   every file in the group's notes ("All files")
//   then the same calls as a single note under /api/public/note-group/:gtoken/notes/:nid  (GET, /seen, PUT, /entries…)
//   a note that is not in the group → 404 off
// Entries may carry a signature: multipart field "sign" (one PNG ≤ 2 MB, from the pen pop-up; needs note_sign).
// Downloads (NOTE_V3.md; Cloudinary refuses plain PDF links, these are signed, 1 hour):
//   GET …/files/:fid/download              a file of the note
//   GET …/entries/:eid/files/:fid/download a file under an entry this person can see (the same rule as the entries list)
//   → { url, name, expires_at }   ?inline=1 opens instead of saving, ?redirect=1 answers with a redirect
// (… = /api/public/note/:token or /api/public/note-group/:gtoken/notes/:nid; PIN / guest headers as above)
// v4 (NOTE_V4.md): POST …/ack { name } ("I've read it") · sign-up fields (multipart "fields", JSON) · a voice clip
// (multipart "voice", needs note_voice) · "Open from": before opens_at every call answers 403 not_open (no content)
// · views per day (a read without ?poll=1) · Telegram alerts to the owner (note_telegram)
const multer = require("multer");
const bcrypt = require("bcrypt");
const Business = require("../business.model");
const Customer = require("../../user/customer.model");
const cloud = require("../../util/cloudinary");
const { rate_limit } = require("../../util/rate_limit");
const S = require("./note.shared");
const TG = require("./note.telegram");

const { M, MSG, Bad } = S;
const handle = S.handle("note-public");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: S.LIMITS.file, files: M.LIMITS.entryFiles } });
const SIGN_MAX = 2 * 1024 * 1024;
const entryUpload = (req, res, next) =>
  upload.fields([
    { name: "files", maxCount: M.LIMITS.entryFiles },
    { name: "sign", maxCount: 1 },
    { name: "voice", maxCount: 1 },
  ])(req, res, (err) => {
    if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, message: MSG.fileTooBig, code: "file_too_big" });
    if (err?.code === "LIMIT_FILE_COUNT" || err?.code === "LIMIT_UNEXPECTED_FILE") return res.status(400).json({ success: false, message: MSG.tooManyFiles, code: "too_many_files" });
    if (err) return res.status(400).json({ success: false, message: MSG.badFile, code: "bad_file" });
    req.signFile = req.files?.sign?.[0] || null;
    req.voiceFile = req.files?.voice?.[0] || null;
    req.files = req.files?.files || [];
    next();
  });

// How much one request may carry: the API runs on Vercel, which refuses bodies over ~4.5 MB before they reach us.
// The page checks the files' total against this before sending (0 = no limit when running elsewhere).
const SEND_MAX = process.env.VERCEL ? 4 * 1024 * 1024 : 0;

module.exports = (prop) => {
  const base = "/api/public/note/:token";
  const groupUrl = "/api/public/note-group/:gtoken";
  const writeLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 120, message: MSG.slow });

  // the business behind a link must be live and still a Digital Note
  async function liveBusiness(businessId) {
    const business = await Business.findOne({ _id: businessId, deleted: false }).lean();
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!business || !business.status || !owner?.status || business.category !== "digital_note") throw new Bad(MSG.linkOff, 404, { code: "off" });
    return business;
  }
  // PIN check; failures counted per link (key), 10 per 15 minutes, then everyone waits (a client can fake its IP)
  async function checkPin(req, hash, key) {
    if (!hash) return;
    if (await S.pinBlocked(key)) throw new Bad(MSG.tooManyPin, 429, { code: "pin_wait" });
    const pin = String(req.headers["x-note-pin"] || "").trim();
    if (!pin) throw new Bad(MSG.needPin, 401, { code: "pin" });
    if (!(await bcrypt.compare(pin, hash))) {
      await S.pinFailed(key);
      throw new Bad(MSG.wrongPin, 401, { code: "pin", wrong: true });
    }
  }

  // :token is the random link (22 characters) or a custom link (note_link: 3–40 of a-z 0-9 -). The random one wins.
  const LINK_RE = /^[A-Za-z0-9-]{3,40}$/;
  async function findByLink(Model, v, extra = {}) {
    const t = S.str(v, 40);
    if (!LINK_RE.test(t)) return null;
    const byToken = t.length >= 16 ? await Model.findOne({ "share.token": t, deleted: false, ...extra }) : null;
    if (byToken) return byToken;
    return /^[a-z0-9-]+$/.test(t) ? Model.findOne({ "share.slug": t, deleted: false, ...extra }) : null;
  }
  // "Open from": before that time only a countdown (no content, no PIN asked)
  const notOpenErr = (share, business, hide) => new Bad(MSG.notOpen, 403, { code: "not_open", opens_at: share.opens_at, now: new Date().toISOString(), business: businessView(business, hide), title: "" });
  // the note behind a single-note link + what this person may do with it now
  async function noteCtx(req) {
    const note = await findByLink(M.Note, req.params.token);
    if (!note || note.share.level === "off") throw new Bad(MSG.linkOff, 404, { code: "off" });
    const business = await liveBusiness(note.business_id);
    if (S.notOpen(note.share)) throw notOpenErr(note.share, business, !!note.share.hide_owner);
    // one wrong-PIN counter per note (its random link and its custom link count together)
    await checkPin(req, note.share.pin_hash, `n:${note._id}`);
    const state = await S.licenseState(business._id);
    const sh = note.share;
    const expired = !!sh.expires_at && new Date(sh.expires_at).getTime() < Date.now();
    const paused = !!state.license.read_only;
    const share = { level: sh.level, ask_name: sh.ask_name !== false, allow_files: sh.allow_files !== false, show_entries: sh.show_entries !== false, hide_owner: !!sh.hide_owner, no_copy: !!sh.no_copy, expires_at: sh.expires_at || null };
    return { note, business, state, share, level: expired || paused ? "view" : sh.level, expired, paused, guest: S.guestKeyOf(req) };
  }

  // a group link: the group (+ one of its notes when :nid is given). The group's level, PIN, end date and safety
  // apply. A group PIN covers its notes; a group without a PIN still asks for a note's own PIN.
  async function groupBase(req) {
    const group = await findByLink(M.NoteGroup, req.params.gtoken, { paid: true });
    if (!group || group.share.level === "off") throw new Bad(MSG.linkOff, 404, { code: "off" });
    const business = await liveBusiness(group.business_id);
    if (S.notOpen(group.share)) throw notOpenErr(group.share, business, !!group.share.hide_owner);
    await checkPin(req, group.share.pin_hash, `g:${group._id}`);
    const state = await S.licenseState(business._id);
    const gs = group.share;
    const expired = !!gs.expires_at && new Date(gs.expires_at).getTime() < Date.now();
    const paused = !!state.license.read_only;
    return { group, business, state, expired, paused, level: expired || paused ? "view" : gs.level, guest: S.guestKeyOf(req) };
  }
  async function groupNoteCtx(req) {
    const g = await groupBase(req);
    const nid = String(req.params.nid || "");
    const inGroup = S.validId(nid) && g.group.note_ids.some((id) => String(id) === nid);
    const note = inGroup ? await M.Note.findOne({ _id: nid, business_id: g.business._id, deleted: false }) : null;
    if (!note) throw new Bad(MSG.linkOff, 404, { code: "off" });
    // a note with its own "Open from" stays closed until then, also inside a group
    if (S.notOpen(note.share)) throw notOpenErr(note.share, g.business, !!g.group.share.hide_owner || !!note.share.hide_owner);
    if (!g.group.share.pin_hash && note.share.pin_hash) await checkPin(req, note.share.pin_hash, `n:${note._id}`);
    const gs = g.group.share;
    const share = { level: gs.level, ask_name: gs.ask_name !== false, allow_files: note.share.allow_files !== false, show_entries: note.share.show_entries !== false, hide_owner: !!gs.hide_owner || !!note.share.hide_owner, no_copy: !!gs.no_copy || !!note.share.no_copy, expires_at: gs.expires_at || null };
    return { ...g, note, share };
  }

  const can = (ctx, ...levels) => {
    if (!levels.includes(ctx.level)) throw new Bad(MSG.notAllowed, 403, { code: "not_allowed", level: ctx.level });
  };
  const nameIn = (ctx, v) => {
    const name = S.str(v, M.LIMITS.name);
    if (!name && ctx.share.ask_name) throw new Bad(MSG.needName, 400, { code: "need_name" });
    return name || "Guest";
  };

  // hide: "hide the owner" is on, so the owner's replies go out without the business name
  // form answers (fields) only ever go back to the person who wrote them
  const entryOut = (e, me, hide) => {
    const mine = !!me && e.guest_key === me;
    return { _id: e._id, kind: e.kind, name: hide && e.by_owner ? "" : e.name, text: e.text, files: (e.files || []).map(S.fileOut), ...(e.fields && mine ? { fields: e.fields } : {}), by_owner: !!e.by_owner, mine, created_date: e.created_date, updated_date: e.updated_date };
  };
  // sign-up rows (kind "collect") are private to their author at every level and through every link — a collect
  // note put in a group, or switched to reply / view later, must not show everyone's rows (names, phones, files…)
  const privateCollect = (ctx) => (ctx.guest ? { $or: [{ kind: { $ne: "collect" } }, { guest_key: ctx.guest }] } : { kind: { $ne: "collect" } });
  // collect: only my row · otherwise: everyone's (when the owner shows them) or only mine
  async function entriesFor(ctx) {
    const s = ctx.share;
    const where = { note_id: ctx.note._id, hidden: false };
    const everyone = s.level !== "collect" && s.show_entries;
    if (!everyone) {
      if (!ctx.guest) return [];
      Object.assign(where, { $or: [{ guest_key: ctx.guest }, ...(s.level === "collect" ? [] : [{ by_owner: true }])] });
    } else Object.assign(where, privateCollect(ctx));
    const rows = await M.NoteEntry.find(where).sort({ created_date: -1 }).limit(200).lean();
    return rows.reverse().map((e) => entryOut(e, ctx.guest, ctx.share.hide_owner));
  }
  const noteView = (n) => ({ title: n.title, blocks: n.blocks || [], files: (n.files || []).map(S.fileOut), color: n.color, paper: n.paper || "plain", form: S.formOut(n.form), version: n.version, updated_date: n.updated_date, updated_by: n.updated_by });
  // "I've read it": through a group link the group's setting, else the note's
  const ackOn = (ctx) => (ctx.group ? !!ctx.group.share.ack : !!ctx.note.share.ack);
  // an entry this person may see: what entriesFor lists (not hidden; collect = only mine; otherwise everyone's when
  // shown, else mine + the owner's)
  async function visibleEntry(ctx, eid) {
    if (!S.validId(eid)) throw new Bad(MSG.badId);
    const s = ctx.share;
    const where = { _id: eid, note_id: ctx.note._id, hidden: false };
    const everyone = s.level !== "collect" && s.show_entries;
    if (!everyone) {
      if (!ctx.guest) throw new Bad(MSG.rowNotFound, 404);
      Object.assign(where, { $or: [{ guest_key: ctx.guest }, ...(s.level === "collect" ? [] : [{ by_owner: true }])] });
    } else Object.assign(where, privateCollect(ctx)); // another guest's sign-up row (and its files) stays private
    const e = await M.NoteEntry.findOne(where).lean();
    if (!e) throw new Bad(MSG.rowNotFound, 404);
    return e;
  }
  const shareView = (ctx) => ({ ack: ackOn(ctx), level: ctx.level, set_level: ctx.share.level, ask_name: ctx.share.ask_name, allow_files: ctx.share.allow_files, show_entries: ctx.share.show_entries, hide_owner: ctx.share.hide_owner, no_copy: ctx.share.no_copy, expired: ctx.expired, paused: ctx.paused, expires_at: ctx.share.expires_at });
  // safety: "hide the owner" leaves the business name / logo out
  const businessView = (business, hide) => (hide ? { name: "", logo: "", hidden: true } : { name: business.name, logo: business.logo_url || "", hidden: false });
  const limitsView = (ctx) => ({ file_limit: SEND_MAX ? Math.min(ctx.state.limits.file_limit, SEND_MAX) : ctx.state.limits.file_limit, files_per_entry: M.LIMITS.entryFiles, send_max: SEND_MAX, sign_max: SIGN_MAX, voice_max: SEND_MAX ? Math.min(S.VOICE_MAX, SEND_MAX) : S.VOICE_MAX });

  // ---------------------------------------------------------------- write below: files (reply / edit / collect)
  // files + an optional signature PNG (the pen pop-up; needs note_sign). The signature counts as one of the 5 files.
  // voiceFile: one voice clip (needs note_voice; audio only, ≤ 15 MB); it counts as one of the 5 files too
  async function uploadFiles(ctx, files, signFile, by, voiceFile) {
    const list = [...(files || [])];
    if (signFile) {
      if (!ctx.state.sign) throw new Bad(MSG.needSign, 403, { code: "need_sign" });
      if (signFile.size > SIGN_MAX || !/png$/i.test(signFile.mimetype || signFile.originalname || "")) throw new Bad(MSG.badSign, 400, { code: "bad_sign" });
    }
    if (voiceFile) {
      voiceFile.mimetype = S.voiceMime(voiceFile.mimetype); // some browsers record audio in a "video/webm" container
      if (!ctx.state.voice) throw new Bad(MSG.needVoice, 403, { code: "need_voice" });
      if (voiceFile.size > S.VOICE_MAX || S.fineKind({ mime: voiceFile.mimetype, name: voiceFile.originalname }) !== "audio") throw new Bad(MSG.badVoice, 400, { code: "bad_voice" });
    }
    // "allow files" off only stops attachments. A signature (note_sign) or a voice clip (note_voice) are separate
    // features the owner unlocked and switched on for the page, not file attachments — they stay allowed.
    if (files?.length && !ctx.share.allow_files) throw new Bad(MSG.noFiles, 403, { code: "no_files" });
    if (!list.length && !signFile && !voiceFile) return [];
    const all = [...list, ...(signFile ? [signFile] : []), ...(voiceFile ? [voiceFile] : [])];
    const size = all.reduce((a, f) => a + f.size, 0);
    if (!(await S.reserve(ctx.business._id, size, ctx.state.limits.storage_limit))) throw new Bad(MSG.storageFull, 413, { code: "storage_full" });
    const done = [];
    try {
      for (const f of all) {
        const sign = f === signFile;
        const voice = f === voiceFile;
        const up = await cloud.uploadBuffer(f, `note/${ctx.business._id}/guest`, sign ? "image" : "auto");
        const name = sign ? `signature-${Date.now()}.png` : S.str(up.original_name || f.originalname, 200) || (voice ? `voice-${Date.now()}.webm` : "file");
        const mime = sign ? "image/png" : f.mimetype || S.mimeOf(name);
        done.push({ public_id: up.public_id, resource_type: up.resource_type || "image", url: up.url, name, size: f.size, mime, kind: sign ? "image" : voice ? "audio" : S.kindOf(mime, name), by, sign, voice, at: new Date() });
      }
    } catch (err) {
      for (const d of done) cloud.deleteFile(d.public_id, d.resource_type).catch(() => {});
      await S.release(ctx.business._id, size);
      throw err;
    }
    return done;
  }

  const myEntry = async (ctx, eid) => {
    if (!S.validId(eid)) throw new Bad(MSG.badId);
    const e = await M.NoteEntry.findOne({ _id: eid, note_id: ctx.note._id, by_owner: false });
    if (!e) throw new Bad(MSG.rowNotFound, 404);
    if (!ctx.guest || e.guest_key !== ctx.guest) throw new Bad(MSG.notYours, 403, { code: "not_yours" });
    return e;
  };

  // the same calls for a single-note link and for a note opened through a group link
  function routes(base, ctxOf) {
    // ---------------------------------------------------------------- read
    prop.app.get(
      base,
      handle(async (req, res) => {
        const ctx = await ctxOf(req);
        const now = new Date();
        // a view + "seen by" (one row per person; polling calls with ?poll=1 don't count as new views)
        const poll = req.query.poll === "1";
        let me = null;
        if (ctx.guest) {
          const seen = await S.seenUpsert(
            { note_id: ctx.note._id, guest_key: ctx.guest },
            { $set: { last_at: now }, $setOnInsert: { business_id: ctx.business._id, first_at: now, name: "" }, ...(poll ? {} : { $inc: { count: 1 } }) },
            { returnDoc: true },
          );
          me = { name: seen.name || "" };
        }
        if (!poll) {
          await M.Note.updateOne({ _id: ctx.note._id }, { $inc: { views: 1 } });
          await S.countView(ctx.business._id, "note", ctx.note._id, ctx.guest).catch(() => {});
        }
        const ackMine = ackOn(ctx) && ctx.guest ? await M.NoteAck.findOne({ note_id: ctx.note._id, guest_key: ctx.guest }).lean() : null;
        res.set("Cache-Control", "no-store");
        res.json({
          success: true,
          data: {
            note: noteView(ctx.note),
            business: businessView(ctx.business, ctx.share.hide_owner),
            share: shareView(ctx),
            entries: await entriesFor(ctx),
            me,
            limits: limitsView(ctx),
            features: { sign: !!ctx.state.sign, style: !!ctx.state.style, voice: !!ctx.state.voice },
            ack: { on: ackOn(ctx), mine: ackMine ? { name: ackMine.name, at: ackMine.at } : null },
            // the look: a group link shows the group's theme for every note in it, a single link the note's own
            theme: S.themeOut(ctx.group ? ctx.group.theme : ctx.note.theme),
            ...(ctx.group ? { group: { name: ctx.group.name, color: ctx.group.color, icon: ctx.group.icon, icon_image: ctx.group.icon_image?.url || "" } } : {}),
          },
        });
      }),
    );

    prop.app.post(
      `${base}/seen`,
      writeLimit,
      handle(async (req, res) => {
        const ctx = await ctxOf(req);
        if (!ctx.guest) throw new Bad(MSG.badValue, 400, { code: "no_guest" });
        const name = S.str(req.body?.name, M.LIMITS.name);
        if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
        const now = new Date();
        await S.seenUpsert({ note_id: ctx.note._id, guest_key: ctx.guest }, { $set: { name, last_at: now }, $setOnInsert: { business_id: ctx.business._id, first_at: now, count: 1 } });
        res.json({ success: true, data: { name } });
      }),
    );

    // ---------------------------------------------------------------- "I've read it" (note_ack)
    prop.app.post(
      `${base}/ack`,
      writeLimit,
      handle(async (req, res) => {
        const ctx = await ctxOf(req);
        if (!ackOn(ctx)) throw new Bad(MSG.noAck, 403, { code: "no_ack" });
        if (ctx.paused) throw new Bad(MSG.notAllowed, 403, { code: "paused" });
        if (!ctx.guest) throw new Bad(MSG.badValue, 400, { code: "no_guest" });
        const name = nameIn(ctx, req.body?.name);
        const had = await M.NoteAck.findOne({ note_id: ctx.note._id, guest_key: ctx.guest }).lean();
        if (had) return res.json({ success: true, data: { name: had.name, at: had.at, already: true } });
        let row;
        try {
          row = await M.NoteAck.create({ business_id: ctx.business._id, note_id: ctx.note._id, group_id: ctx.group?._id || null, guest_key: ctx.guest, name });
        } catch (err) {
          if (err?.code !== 11000) throw err;
          row = await M.NoteAck.findOne({ note_id: ctx.note._id, guest_key: ctx.guest }).lean();
          return res.json({ success: true, data: { name: row.name, at: row.at, already: true } });
        }
        const now = new Date();
        await S.seenUpsert({ note_id: ctx.note._id, guest_key: ctx.guest }, { $set: { name, last_at: now }, $setOnInsert: { business_id: ctx.business._id, first_at: now, count: 1 } });
        await TG.alert(ctx.business._id, ctx.note._id, "ack", { name }, ctx.state);
        res.json({ success: true, data: { name: row.name, at: row.at } });
      }),
    );

    // ---------------------------------------------------------------- downloads
    prop.app.get(
      `${base}/files/:fid/download`,
      handle(async (req, res) => {
        const ctx = await ctxOf(req);
        const f = (ctx.note.files || []).find((x) => String(x._id) === String(req.params.fid));
        if (!f) throw new Bad(MSG.rowNotFound, 404);
        S.sendDownload(req, res, f);
      }),
    );
    prop.app.get(
      `${base}/entries/:eid/files/:fid/download`,
      handle(async (req, res) => {
        const ctx = await ctxOf(req);
        const e = await visibleEntry(ctx, req.params.eid);
        const f = (e.files || []).find((x) => String(x._id) === String(req.params.fid));
        if (!f) throw new Bad(MSG.rowNotFound, 404);
        S.sendDownload(req, res, f);
      }),
    );

    // ---------------------------------------------------------------- edit (level "edit")
    prop.app.put(
      base,
      writeLimit,
      handle(async (req, res) => {
        const ctx = await ctxOf(req);
        can(ctx, "edit");
        const b = req.body || {};
        const by = nameIn(ctx, b.name);
        const saved = await S.saveContent(ctx.note, { title: b.title, blocks: b.blocks, base_version: b.base_version ?? -1 }, by, false, !!ctx.state.sign, !!ctx.state.style, !!ctx.state.voice);
        await TG.alert(ctx.business._id, ctx.note._id, "edit", { name: by }, ctx.state);
        res.json({ success: true, data: noteView(saved), message: MSG.saved });
      }),
    );

    // ---------------------------------------------------------------- write below (reply / edit / collect)
    prop.app.post(
      `${base}/entries`,
      writeLimit,
      entryUpload,
      handle(async (req, res) => {
        const ctx = await ctxOf(req);
        can(ctx, "reply", "edit", "collect");
        if (!ctx.guest) throw new Bad(MSG.badValue, 400, { code: "no_guest" });
        const by = nameIn(ctx, req.body?.name);
        const text = S.str(req.body?.text, M.LIMITS.entry);
        const count = (req.files?.length || 0) + (req.signFile ? 1 : 0) + (req.voiceFile ? 1 : 0);
        const kind = ctx.level === "collect" ? "collect" : "reply";
        // sign-up list fields (the owner's form) — checked on the server
        const answers = kind === "collect" ? S.cleanAnswers(ctx.note.form, req.body?.fields) : undefined;
        const answered = !!answers && Object.values(answers).some((v) => v !== false && v !== "");
        if (!text && !count && !answered) throw new Bad(MSG.needText, 400, { code: "need_text" });

        // collect: one row per person — sending again changes it (new files are added to the old ones)
        const mine = kind === "collect" ? await M.NoteEntry.findOne({ note_id: ctx.note._id, kind: "collect", guest_key: ctx.guest }) : null;
        if (mine && mine.files.length + count > M.LIMITS.entryFiles) throw new Bad(MSG.tooManyFiles, 400, { code: "too_many_files", left: Math.max(0, M.LIMITS.entryFiles - mine.files.length) });
        const files = await uploadFiles(ctx, req.files, req.signFile, by, req.voiceFile);
        let e;
        try {
          if (mine) {
            // add to my row only while it still has room (two sends at once can't pass 5 files)
            const set = { name: by, seen_by_owner: false, ...(text ? { text } : {}), ...(answers ? { fields: answers } : {}) };
            e = await M.NoteEntry.findOneAndUpdate(
              { _id: mine._id, guest_key: ctx.guest, [`files.${M.LIMITS.entryFiles - files.length}`]: { $exists: false } },
              { $set: set, ...(files.length ? { $push: { files: { $each: files } } } : {}) },
              { returnDocument: "after" },
            );
            if (!e) throw new Bad(MSG.tooManyFiles, 400, { code: "too_many_files" });
          } else {
            e = await M.NoteEntry.create({ business_id: ctx.business._id, note_id: ctx.note._id, kind, guest_key: ctx.guest, name: by, text, files, ...(answers ? { fields: answers } : {}) });
            await M.Note.updateOne({ _id: ctx.note._id }, { $inc: { entry_count: 1 } });
          }
        } catch (err) {
          // the files were uploaded and their space taken: give both back
          await S.dropFiles(ctx.business._id, files);
          throw err;
        }
        await S.seenUpsert({ note_id: ctx.note._id, guest_key: ctx.guest }, { $set: { name: by, last_at: new Date() }, $setOnInsert: { business_id: ctx.business._id, first_at: new Date(), count: 1 } });
        // the owner's Telegram: a new reply / a new sign-up row (changes to my own row don't alert)
        if (!mine) await TG.alert(ctx.business._id, ctx.note._id, kind === "collect" ? "signup" : "reply", { name: by, text: text || (files.length ? `📎 ${files.length}` : "") }, ctx.state);
        res.status(mine ? 200 : 201).json({ success: true, data: entryOut(e, ctx.guest, ctx.share.hide_owner), message: MSG.saved });
      }),
    );

    prop.app.put(
      `${base}/entries/:eid`,
      writeLimit,
      handle(async (req, res) => {
        const ctx = await ctxOf(req);
        can(ctx, "reply", "edit", "collect");
        const e = await myEntry(ctx, req.params.eid);
        const set = { seen_by_owner: false };
        if (req.body?.text !== undefined) set.text = S.str(req.body.text, M.LIMITS.entry);
        if (req.body?.name !== undefined) set.name = nameIn(ctx, req.body.name);
        // a sign-up row: the answers can be changed too (checked again)
        if (req.body?.fields !== undefined && e.kind === "collect") set.fields = S.cleanAnswers(ctx.note.form, req.body.fields);
        // files the guest took off (ids in remove_files)
        const remove = (Array.isArray(req.body?.remove_files) ? req.body.remove_files.map(String) : []).filter(S.validId);
        const keep = e.files.filter((f) => !remove.includes(String(f._id)));
        const hasAnswers = Object.values(set.fields || e.fields || {}).some((v) => v !== false && v !== "");
        if (!(set.text ?? e.text) && !keep.length && !hasAnswers) throw new Bad(MSG.needText, 400, { code: "need_text" });
        // one update; the copy from just before it says which files this request really took off
        // (two removals at the same moment give the space back once)
        const before = await M.NoteEntry.findOneAndUpdate(
          { _id: e._id, guest_key: ctx.guest },
          { $set: set, ...(remove.length ? { $pull: { files: { _id: { $in: remove } } } } : {}) },
          { returnDocument: "before" },
        );
        if (!before) throw new Bad(MSG.rowNotFound, 404);
        const gone = before.files.filter((f) => remove.includes(String(f._id)));
        if (gone.length) await S.dropFiles(ctx.business._id, gone);
        const after = await M.NoteEntry.findById(e._id);
        res.json({ success: true, data: entryOut(after, ctx.guest, ctx.share.hide_owner), message: MSG.saved });
      }),
    );
    prop.app.delete(
      `${base}/entries/:eid`,
      writeLimit,
      handle(async (req, res) => {
        const ctx = await ctxOf(req);
        can(ctx, "reply", "edit", "collect");
        const e = await myEntry(ctx, req.params.eid);
        // only the request that really deleted the row gives the space back
        const gone = await M.NoteEntry.findOneAndDelete({ _id: e._id, guest_key: ctx.guest });
        if (gone) {
          await S.dropFiles(ctx.business._id, gone.files);
          await M.Note.updateOne({ _id: ctx.note._id, entry_count: { $gt: 0 } }, { $inc: { entry_count: -1 } });
        }
        res.json({ success: true, message: MSG.deleted });
      }),
    );
  }

  routes(base, noteCtx);
  routes(`${groupUrl}/notes/:nid`, groupNoteCtx);

  // ---------------------------------------------------------------- the group page (list of its notes)
  const groupShareView = (g) => {
    const gs = g.group.share;
    return { level: g.level, set_level: gs.level, ask_name: gs.ask_name !== false, hide_owner: !!gs.hide_owner, no_copy: !!gs.no_copy, expired: g.expired, paused: g.paused, expires_at: gs.expires_at || null };
  };
  prop.app.get(
    groupUrl,
    handle(async (req, res) => {
      const g = await groupBase(req);
      const now = new Date();
      const poll = req.query.poll === "1";
      let me = null;
      if (g.guest) {
        const filter = { group_id: g.group._id, guest_key: g.guest };
        const update = { $set: { last_at: now }, $setOnInsert: { business_id: g.business._id, first_at: now, name: "" }, ...(poll ? {} : { $inc: { count: 1 } }) };
        let seen;
        try {
          seen = await M.NoteGroupSeen.findOneAndUpdate(filter, update, { upsert: true, returnDocument: "after" });
        } catch (err) {
          if (err?.code !== 11000) throw err;
          seen = await M.NoteGroupSeen.findOneAndUpdate(filter, update, { upsert: true, returnDocument: "after" });
        }
        me = { name: seen.name || "" };
      }
      if (!poll) {
        await M.NoteGroup.updateOne({ _id: g.group._id }, { $inc: { views: 1 } });
        await S.countView(g.business._id, "group", g.group._id, g.guest).catch(() => {});
      }
      const ids = g.group.note_ids.map(String);
      const rows = await M.Note.find({ _id: { $in: ids }, business_id: g.business._id, deleted: false }).select("title blocks color paper updated_date share.pin_hash share.opens_at files._id").lean();
      // a group without a PIN: notes with their own PIN are listed, but locked (no preview until their PIN is given)
      const lockedOf = (n) => (!g.group.share.pin_hash && !!n.share?.pin_hash) || S.notOpen(n.share);
      const byId = new Map(rows.map((n) => [String(n._id), n]));
      const preview = (blocks) =>
        (blocks || [])
          .filter((b) => b.t !== "file" && b.t !== "draw" && b.t !== "divider" && b.t !== "sticker" && b.text)
          .map((b) => b.text)
          .join(" · ")
          .slice(0, 140);
      res.set("Cache-Control", "no-store");
      res.json({
        success: true,
        data: {
          group: { name: g.group.name, color: g.group.color, icon: g.group.icon, icon_image: g.group.icon_image?.url || "" },
          business: businessView(g.business, !!g.group.share.hide_owner),
          share: groupShareView(g),
          notes: ids
            .map((id) => byId.get(id))
            .filter(Boolean)
            .map((n) => ({ _id: n._id, title: S.notOpen(n.share) ? "" : n.title, preview: lockedOf(n) ? "" : preview(n.blocks), locked: lockedOf(n), ...(S.notOpen(n.share) ? { locked_until: n.share.opens_at } : {}), color: n.color, paper: n.paper || "plain", updated_date: n.updated_date })),
          // files the visitor can open from the group's "All files" view (notes locked by their own PIN are left out)
          files_count: rows.filter((n) => !lockedOf(n)).reduce((a, n) => a + (n.files || []).length, 0),
          me,
          features: { sign: !!g.state.sign, style: !!g.state.style, voice: !!g.state.voice },
          ack: { on: !!g.group.share.ack },
          theme: S.themeOut(g.group.theme),
        },
      });
    }),
  );
  // every file in the group's notes ("All files"): the notes' own files (not replies). The group's PIN, closed and
  // end-date rules apply (groupBase); notes with their own PIN are left out when the group has no PIN.
  prop.app.get(
    `${groupUrl}/files`,
    handle(async (req, res) => {
      const g = await groupBase(req);
      const closed = new Set((await M.Note.find({ _id: { $in: g.group.note_ids }, "share.opens_at": { $gt: new Date() } }).select("_id").lean()).map((n) => String(n._id)));
      const rows = await S.notesFiles(
        g.business._id,
        g.group.note_ids.filter((id) => !closed.has(String(id))),
        { skipLocked: !g.group.share.pin_hash },
      );
      // the owner's files go out as "owner" (never the business name)
      res.set("Cache-Control", "no-store");
      res.json({ success: true, ...S.filesPage(rows, req.query), totals: S.filesTotals(rows) });
    }),
  );
  prop.app.post(
    `${groupUrl}/seen`,
    writeLimit,
    handle(async (req, res) => {
      const g = await groupBase(req);
      if (!g.guest) throw new Bad(MSG.badValue, 400, { code: "no_guest" });
      const name = S.str(req.body?.name, M.LIMITS.name);
      if (!name) throw new Bad(MSG.needName, 400, { code: "need_name" });
      const now = new Date();
      const filter = { group_id: g.group._id, guest_key: g.guest };
      const update = { $set: { name, last_at: now }, $setOnInsert: { business_id: g.business._id, first_at: now, count: 1 } };
      try {
        await M.NoteGroupSeen.updateOne(filter, update, { upsert: true });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        await M.NoteGroupSeen.updateOne(filter, update, { upsert: true });
      }
      res.json({ success: true, data: { name } });
    }),
  );
};
