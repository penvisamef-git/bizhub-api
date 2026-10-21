// Digital Note — the owner (contract: NOTE_SPEC.md in this folder).
// The business is yearly (digital_note, 10 coins) with 5 GB of files, 20 MB per file. Add-ons (NOTE_ADDONS.md):
// note_storage = +5 GB per pack, each pack its own yearly slot (POST /storage; renew one on the Licenses route with its item),
// note_group = 1 coin per group (price in Homepage.prices), paid when the group is made (POST /groups), note_sign = signature / pen pop-up (forever,
// bought on the Licenses route). After the year (+7 days grace) the book is read-only: reading, deleting and
// sharing settings still work; new notes, edits, files and replies don't.
//
// Base /api/user/businesses/:id/note
//   GET  ""                                   book, license, add-ons, prices, counts
//   GET  /notes?q&filter=all|pinned|shared|deleted&sort=updated|created|title&page    (30 a page, no blocks)
//   POST /notes { title, blocks, color, tags, template, lang }
//   GET/PUT/DELETE /notes/:nid   POST /notes/:nid/restore   DELETE /notes/:nid/forever   POST /notes/:nid/duplicate
//   PUT  /notes/:nid/share { level, pin, expires_at, allow_files, show_entries, ask_name }   POST /notes/:nid/share/new-link
//   GET  /upload-sign   POST /notes/:nid/files { public_id, resource_type, name }   POST /notes/:nid/files/direct (multipart "file")
//   DELETE /notes/:nid/files/:fid
//   GET/POST /notes/:nid/entries   PUT/DELETE /entries/:eid
//   GET /notes/:nid/seen   GET /notes/:nid/history   POST /notes/:nid/history/:rid/restore
//   PUT /settings { default_level, ask_name }
//   POST /storage { qty?, key?, item?, expect? }  buy N new +5 GB packs (key = one per attempt, never pays twice), or renew one pack (item = "slot-N")
//   GET /groups?deleted=1   POST /groups { name, color, icon, note_ids }   (pays the note_group price)
//   PUT/DELETE /groups/:gid   POST /groups/:gid/restore   POST /groups/:gid/notes { note_id }   DELETE /groups/:gid/notes/:nid
//   PUT /groups/:gid/share { level, pin, expires_at, ask_name, hide_owner, no_copy }   POST /groups/:gid/share/new-link
//   GET /groups/:gid/seen
// v3 (NOTE_V3.md): note_style (style pack, 5 coins once) · note_group_icon (a picture icon per group, 2 coins each,
// POST /groups/:gid/icon/unlock) · note_media (media manager, 8 coins once)
//   POST /notes { …, share_level, paper }   PUT /notes/:nid { …, paper }
//   POST/DELETE /logo (multipart "file")      the business logo (Business.logo_url too); the name: PUT /api/user/businesses/:id
//   GET /notes/:nid/files/:fid/download   GET /entries/:eid/files/:fid/download    → { url, name, expires_at } (?inline=1, ?redirect=1)
//   POST /groups/:gid/icon/unlock   POST/DELETE /groups/:gid/icon (multipart "file")
//   GET /media?sort=size|date|name&kind=all|image|video|audio|pdf|word|excel|slides|text|zip|sign|other&q&page
//   DELETE /media { items: [{ where, note_id, entry_id?, file_id }] }
// v3b (NOTE_V3B.md): GET /notes/:nid → group_ids · GET /groups?q= · note_theme (3 coins per theme key, forever):
//   POST /themes/unlock { key }   PUT /notes/:nid { theme: { key, color } }   PUT /groups/:gid { theme }
// custom links (note_link, 10 coins once): GET /link-check?slug=&kind=note|group&id=  POST /link/unlock
//   PUT /notes/:nid/share { slug }   PUT /groups/:gid/share { slug }   ("" removes it, free; New link also removes it)
// files views: GET /notes → rows carry group_ids · GET /groups → files_count · GET /groups/:gid/files?q&kind&sort&page (free)
// v4 (NOTE_V4.md — "Changes (API, as built)" at its top): note_telegram (yearly) · note_ack · note_form · note_voice · note_pdf
//   GET /telegram (the state only)   POST /telegram/link   POST /telegram/test   PUT /telegram { lang, replies, replies_batch, signups, edits, acks, daily, reminders }   DELETE /telegram
//   PUT /notes/:nid/share { ack, opens_at }   PUT /groups/:gid/share { ack, opens_at }   GET /notes/:nid/acks (?format=csv)
//   PUT /notes/:nid { form: { fields } }   GET /notes/:nid/entries/export?format=csv|xlsx
//   GET /notes?filter=due (rows carry due counts)   GET /people
//   POST /notes/:nid/files { …, voice: true }   GET/POST /templates   PUT/DELETE /templates/:tid   POST /notes { my_template }
//   GET /notes/:nid/print (note_pdf)   GET /notes/:nid/stats?days=30   GET /groups/:gid/stats?days=30
const mongoose = require("mongoose");
const multer = require("multer");
const bcrypt = require("bcrypt");
const Business = require("../business.model");
const { customer_auth } = require("../../user/customer_auth");
const { priceOf } = require("../../homepage/prices");
const { buy, LicenseError } = require("../../license/license.service");
const License = require("../../license/license.model");
const cloud = require("../../util/cloudinary");
const { rate_limit } = require("../../util/rate_limit");
const S = require("./note.shared");
const { TEMPLATES, fromTemplate } = require("./note.templates");
const TG = require("./note.telegram");
const telegram = require("../../telegram");

const { M, MSG, Bad } = S;
const PAGE = 30;
const handle = S.handle("note");

const direct = multer({ storage: multer.memoryStorage(), limits: { fileSize: S.LIMITS.file, files: 1 } });
// a small picture (business logo, group icon): JPG / PNG / WEBP ≤ 2 MB
const IMG_MAX = 2 * 1024 * 1024;
const imgOnly = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMG_MAX, files: 1 },
  fileFilter: (req, file, cb) => (/^image\/(jpeg|png|webp)$/.test(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});
const imgUpload = (req, res, next) =>
  imgOnly.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: MSG.badImage, code: "bad_image" });
    next();
  });
// upload a square picture, resized on Cloudinary (incoming transformation) → { public_id, url, bytes }
const uploadSquare = (file, folder, size) =>
  new Promise((resolve, reject) => {
    const stream = cloud.cloudinary.uploader.upload_stream(
      { folder: `${cloud.signUpload("x").folder.replace(/\/x$/, "")}/${folder}`, resource_type: "image", transformation: [{ width: size, height: size, crop: "fill", gravity: "auto" }] },
      (err, r) => (err ? reject(cloud.cloudinaryError(err)) : resolve({ public_id: r.public_id, url: r.secure_url, bytes: r.bytes || file.size })),
    );
    stream.end(file.buffer);
  });
const directUpload = (req, res, next) =>
  direct.single("file")(req, res, (err) => {
    if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, message: MSG.fileTooBig, code: "file_too_big" });
    if (err) return res.status(400).json({ success: false, message: MSG.badFile });
    next();
  });

module.exports = (prop) => {
  const base = "/api/user/businesses/:id/note";

  // write: "content" = new / changed notes, files, replies (refused when read-only); true = any other change
  async function ctxOf(req, write) {
    if (!S.validId(req.params.id)) throw new Bad(MSG.badId);
    const [business, state] = await Promise.all([Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false }), S.licenseState(req.params.id)]);
    if (!business) throw new Bad(MSG.notFound, 404);
    if (business.category !== "digital_note") throw new Bad(MSG.notNote);
    if (write && !business.status) throw new Bad(MSG.suspended, 403);
    if (write === "content" && state.license.read_only) throw new Bad(MSG.locked, 402, { product: "digital_note", code: "locked" });
    const book = await S.bookOf(business._id);
    return { business, book, ...state };
  }
  const own = (method, path, write, fn, mw = []) =>
    prop.app[method](
      `${base}${path}`,
      prop.api_auth,
      customer_auth,
      ...mw,
      handle(async (req, res) => fn(await ctxOf(req, write), req, res)),
    );
  const noteOf = async (ctx, nid, withDeleted = false) => {
    if (!S.validId(nid)) throw new Bad(MSG.badId);
    const n = await M.Note.findOne({ _id: nid, business_id: ctx.business._id, ...(withDeleted ? {} : { deleted: false }) });
    if (!n) throw new Bad(MSG.noteNotFound, 404);
    return n;
  };
  // note paper: anything but "plain" needs the style pack (keeping the paper the note already has is fine)
  const paperIn = (ctx, v, current) => {
    if (v === undefined) return current;
    if (!M.PAPERS.includes(v)) throw new Bad(MSG.badValue);
    if (v !== "plain" && v !== current && !ctx.style) throw new Bad(MSG.needStyle, 403, { code: "need_style", product: "note_style" });
    return v;
  };
  const bookOut = (ctx) => ({ storage_used: ctx.book.storage_used || 0, storage_limit: ctx.limits.storage_limit, file_limit: ctx.limits.file_limit, storage_included: ctx.limits.storage_included, storage_pack: ctx.limits.storage_pack, settings: ctx.book.settings });
  // coins short → 402 { code: "coins", price, balance } (other license errors pass through)
  const coinsErr = (err) => (err instanceof LicenseError && err.message === "noCoins" ? new Bad(MSG.noCoins, 402, { code: "coins", ...err.extra }) : err);

  // open checklist items with a due date over all notes: { overdue, today, week } (+ per note)
  const dueNotes = (bid) => M.Note.find({ business_id: bid, deleted: false, "blocks.due": { $exists: true, $ne: "" } }).lean();
  async function dueTotals(bid) {
    const out = { overdue: 0, today: 0, week: 0 };
    const now = new Date();
    for (const n of await dueNotes(bid)) {
      const d = S.dueOf(n.blocks, now);
      out.overdue += d.overdue.length;
      out.today += d.today.length;
      out.week += d.week.length;
    }
    return out;
  }
  const dueCount = (blocks, now) => {
    const d = S.dueOf(blocks, now);
    return { overdue: d.overdue.length, today: d.today.length, week: d.week.length };
  };

  // ---------------------------------------------------------------- the book
  own("get", "", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const [notes, shared, entriesNew, groups, pStorage, pGroup, pSign, pPlan, pStyle, pIcon, pMedia, pTheme, pLink, pTg, pAck, pForm, pVoice, pPdf, due] = await Promise.all([
      M.Note.countDocuments({ business_id: bid, deleted: false }),
      M.Note.countDocuments({ business_id: bid, deleted: false, "share.level": { $ne: "off" } }),
      M.NoteEntry.countDocuments({ business_id: bid, by_owner: false, seen_by_owner: false }),
      M.NoteGroup.countDocuments({ business_id: bid, deleted: false, paid: true }),
      priceOf("note_storage"),
      priceOf("note_group"),
      priceOf("note_sign"),
      priceOf("digital_note"),
      priceOf("note_style"),
      priceOf("note_group_icon"),
      priceOf("note_media"),
      priceOf("note_theme"),
      priceOf("note_link"),
      priceOf("note_telegram"),
      priceOf("note_ack"),
      priceOf("note_form"),
      priceOf("note_voice"),
      priceOf("note_pdf"),
      dueTotals(bid),
    ]);
    res.json({
      success: true,
      data: {
        book: bookOut(ctx),
        license: ctx.license,
        addons: ctx.addons,
        storage_slots: ctx.storage_slots,
        prices: { note_storage: pStorage, note_group: pGroup, note_sign: pSign, digital_note: pPlan, note_style: pStyle, note_group_icon: pIcon, note_media: pMedia, note_theme: pTheme, note_link: pLink, note_telegram: pTg, note_ack: pAck, note_form: pForm, note_voice: pVoice, note_pdf: pPdf },
        themes: { owned: ctx.themes, price: pTheme, keys: S.THEME_KEYS },
        link: { owned: !!ctx.link, price: pLink },
        business: { _id: ctx.business._id, name: ctx.business.name, logo_url: ctx.business.logo_url || ctx.book.logo?.url || "" },
        counts: { notes, shared, entries_new: entriesNew, groups, due },
        telegram: TG.stateOut(ctx.book, ctx),
        templates: TEMPLATES,
      },
    });
  });

  own("put", "/settings", true, async (ctx, req, res) => {
    const b = req.body || {};
    if (b.default_level !== undefined) {
      if (!M.LEVELS.includes(b.default_level)) throw new Bad(MSG.badValue);
      ctx.book.settings.default_level = b.default_level;
    }
    if (b.ask_name !== undefined) ctx.book.settings.ask_name = S.bool(b.ask_name, true);
    await ctx.book.save();
    res.json({ success: true, data: bookOut(ctx), message: MSG.saved });
  });

  // ---------------------------------------------------------------- notes
  own("get", "/notes", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const filter = ["pinned", "shared", "deleted", "due"].includes(req.query.filter) ? req.query.filter : "all";
    const where = { business_id: bid, deleted: filter === "deleted" };
    if (filter === "due") where["blocks.due"] = { $exists: true, $ne: "" };
    if (filter === "pinned") where.pinned = true;
    if (filter === "shared") where["share.level"] = { $ne: "off" };
    const q = S.str(req.query.q, 80);
    if (q) {
      const re = new RegExp(S.escRe(q), "i");
      where.$or = [{ title: re }, { text: re }, { tags: re }];
    }
    const sort = req.query.sort === "created" ? { created_date: -1 } : req.query.sort === "title" ? { title: 1, _id: 1 } : { updated_date: -1 };
    const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
    const now = new Date();
    let rows;
    let total;
    if (filter === "due") {
      // notes with open items overdue / today / this week; the most overdue first, then the soonest
      const all = (await M.Note.find(where).lean())
        .map((n) => ({ n, d: S.dueOf(n.blocks, now) }))
        .filter(({ d }) => d.overdue.length || d.today.length || d.week.length)
        .map(({ n, d }) => ({ n, d, first: Math.min(...[...d.overdue, ...d.today, ...d.week].map((x) => S.dueAt(x.due).getTime())) }))
        .sort((a, b) => b.d.overdue.length - a.d.overdue.length || a.first - b.first);
      total = all.length;
      rows = all.slice((page - 1) * PAGE, page * PAGE).map((x) => x.n);
    } else {
      [rows, total] = await Promise.all([
        M.Note.find(where)
          .sort(filter === "deleted" ? { deleted_at: -1 } : { pinned: -1, ...sort })
          .skip((page - 1) * PAGE)
          .limit(PAGE)
          .lean(),
        M.Note.countDocuments(where),
      ]);
    }
    // the groups each listed note is in (the list view shows them as chips)
    const ids = rows.map((n) => n._id);
    const inGroups = ids.length ? await M.NoteGroup.find({ business_id: bid, paid: true, deleted: false, note_ids: { $in: ids } }).select("note_ids").lean() : [];
    const groupsOf = new Map();
    for (const g of inGroups) for (const nid of g.note_ids || []) groupsOf.set(String(nid), [...(groupsOf.get(String(nid)) || []), String(g._id)]);
    res.json({ success: true, data: rows.map((n) => ({ ...S.rowOut(n), group_ids: groupsOf.get(String(n._id)) || [], due: dueCount(n.blocks, now) })), page, pages: Math.max(1, Math.ceil(total / PAGE)), total });
  });

  own("post", "/notes", "content", async (ctx, req, res) => {
    const b = req.body || {};
    if (b.my_template !== undefined) return fromMyTemplate(ctx, req, res);
    const tpl = b.template && TEMPLATES.includes(b.template) ? fromTemplate(b.template, b.lang) : null;
    const title = S.str(b.title ?? tpl?.title ?? "", M.LIMITS.title) || tpl?.title || "";
    const blocks = Array.isArray(b.blocks) && b.blocks.length ? S.cleanBlocks(b.blocks, [], { style: ctx.style }) : tpl?.blocks || [{ id: Math.random().toString(36).slice(2, 10), t: "p", text: "", done: false, file_id: "" }];
    const paper = paperIn(ctx, b.paper, "plain");
    // how the new note is shared: the dialog's choice, else the template's, else closed
    const level = M.LEVELS.includes(b.share_level) ? b.share_level : tpl?.level || "off";
    const note = await S.createNote({
      business_id: ctx.business._id,
      title,
      blocks,
      color: M.COLORS.includes(b.color) ? b.color : "default",
      paper,
      tags: S.cleanTags(b.tags),
      text: S.textOf(title, blocks),
      share: { level, ask_name: ctx.book.settings?.ask_name !== false },
    });
    await S.saveRev(note, "owner");
    res.status(201).json({ success: true, data: S.noteOut(note), message: MSG.saved });
  });

  own("get", "/notes/:nid", false, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid, true);
    const [entriesNew, groups] = await Promise.all([
      M.NoteEntry.countDocuments({ note_id: note._id, by_owner: false, seen_by_owner: false }),
      M.NoteGroup.find({ business_id: ctx.business._id, paid: true, deleted: false, note_ids: note._id }).select("_id").lean(),
    ]);
    res.json({ success: true, data: { note: S.noteOut(note), entries_new: entriesNew, group_ids: groups.map((g) => String(g._id)) } });
  });

  own("put", "/notes/:nid", true, async (ctx, req, res) => {
    const b = req.body || {};
    let note = await noteOf(ctx, req.params.nid);
    const content = b.title !== undefined || b.blocks !== undefined;
    if (content && ctx.license.read_only) throw new Bad(MSG.locked, 402, { product: "digital_note", code: "locked" });
    // colour / pin / tags: no version needed
    const meta = {};
    if (b.color !== undefined) {
      if (!M.COLORS.includes(b.color)) throw new Bad(MSG.badValue);
      meta.color = b.color;
    }
    if (b.pinned !== undefined) meta.pinned = S.bool(b.pinned, false);
    if (b.tags !== undefined) meta.tags = S.cleanTags(b.tags);
    if (b.paper !== undefined) meta.paper = paperIn(ctx, b.paper, note.paper || "plain");
    if (b.theme !== undefined) meta.theme = S.themeIn(b.theme, note.theme, ctx.themes);
    if (b.form !== undefined) meta.form = S.cleanForm(b.form, note.form, ctx.form);
    if (Object.keys(meta).length) note = await M.Note.findByIdAndUpdate(note._id, { $set: meta }, { returnDocument: "after" });
    if (content) note = await S.saveContent(note, b, "owner", false, ctx.sign, ctx.style, ctx.voice);
    res.json({ success: true, data: S.noteOut(note), message: MSG.saved });
  });

  own("delete", "/notes/:nid", true, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid);
    await M.Note.updateOne({ _id: note._id }, { $set: { deleted: true, deleted_at: new Date() } });
    res.json({ success: true, message: MSG.deleted });
  });
  own("post", "/notes/:nid/restore", true, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid, true);
    const saved = await M.Note.findByIdAndUpdate(note._id, { $set: { deleted: false, deleted_at: null } }, { returnDocument: "after" });
    res.json({ success: true, data: S.noteOut(saved), message: MSG.restored });
  });
  // gone for good: the note, its entries, who saw it, its history and every file (the space comes back)
  own("delete", "/notes/:nid/forever", true, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid, true);
    const entries = await M.NoteEntry.find({ note_id: note._id }).select("files").lean();
    await S.dropFiles(ctx.business._id, [...(note.files || []), ...entries.flatMap((e) => e.files || [])]);
    await Promise.all([
      M.NoteEntry.deleteMany({ note_id: note._id }),
      M.NoteSeen.deleteMany({ note_id: note._id }),
      M.NoteRev.deleteMany({ note_id: note._id }),
      M.NoteAck.deleteMany({ note_id: note._id }),
      M.NoteView.deleteMany({ ref_id: note._id }),
      M.NoteAlert.deleteMany({ note_id: note._id }),
      M.NoteGroup.updateMany({ business_id: ctx.business._id, note_ids: note._id }, { $pull: { note_ids: note._id } }),
      M.Note.deleteOne({ _id: note._id }),
      S.dropSlugsOf(note._id),
    ]);
    res.json({ success: true, message: MSG.deleted });
  });
  // a copy of the text (files are not copied: file blocks are left out), with its own new link
  own("post", "/notes/:nid/duplicate", "content", async (ctx, req, res) => {
    const src = await noteOf(ctx, req.params.nid);
    const blocks = (src.blocks || [])
      .filter((x) => x.t !== "file" && x.t !== "draw" && x.t !== "audio")
      .map((x) => {
        const o = x.toObject ? x.toObject() : x;
        return { id: o.id, t: o.t, text: o.text, done: o.done, file_id: "", ...(o.style ? { style: o.style } : {}), ...(o.icon ? { icon: o.icon } : {}), ...(o.sticker ? { sticker: o.sticker } : {}), ...(o.due ? { due: o.due } : {}), ...(o.who ? { who: o.who } : {}) };
      });
    const title = `${src.title || ""} (copy)`.trim().slice(0, M.LIMITS.title);
    const note = await S.createNote({
      business_id: ctx.business._id,
      title,
      blocks,
      color: src.color,
      paper: src.paper || "plain",
      tags: src.tags,
      text: S.textOf(title, blocks),
      form: src.form?.fields?.length && ctx.form ? { fields: src.form.fields } : { fields: [] }, // the form fields need note_form
      share: { level: src.share.level, allow_files: src.share.allow_files, show_entries: src.share.show_entries, ask_name: src.share.ask_name, ack: !!src.share.ack },
    });
    await S.saveRev(note, "owner");
    res.status(201).json({ success: true, data: S.noteOut(note), message: MSG.saved });
  });

  // ---------------------------------------------------------------- sharing
  // v4: "I've read it" (turning it on needs note_ack; off is free; a note / group that has it keeps it) + "Open from"
  function v4Share(ctx, b, current, set) {
    if (b.ack !== undefined) {
      const on = S.bool(b.ack, false);
      if (on && !current?.ack && !ctx.ack) throw new Bad(MSG.needAck, 403, { code: "need_ack", product: "note_ack" });
      set["share.ack"] = on;
    }
    if (b.opens_at !== undefined) {
      const d = S.dateIn(b.opens_at);
      if (d === undefined) throw new Bad(MSG.badValue);
      set["share.opens_at"] = d;
    }
  }
  own("put", "/notes/:nid/share", true, async (ctx, req, res) => {
    const b = req.body || {};
    const note = await noteOf(ctx, req.params.nid);
    const set = {};
    if (b.level !== undefined) {
      if (!M.LEVELS.includes(b.level)) throw new Bad(MSG.badValue);
      set["share.level"] = b.level;
    }
    if (b.pin !== undefined) {
      const pin = String(b.pin ?? "").trim();
      if (pin === "") set["share.pin_hash"] = null;
      else if (!/^\d{4,8}$/.test(pin)) throw new Bad(MSG.badPin, 400, { code: "bad_pin" });
      else set["share.pin_hash"] = await bcrypt.hash(pin, 10);
    }
    if (b.expires_at !== undefined) {
      const d = S.dateIn(b.expires_at);
      if (d === undefined) throw new Bad(MSG.badValue);
      set["share.expires_at"] = d;
    }
    for (const k of ["allow_files", "show_entries", "ask_name"]) if (b[k] !== undefined) set[`share.${k}`] = S.bool(b[k], true);
    for (const k of ["hide_owner", "no_copy"]) if (b[k] !== undefined) set[`share.${k}`] = S.bool(b[k], false);
    v4Share(ctx, b, note.share, set);
    const slug = b.slug !== undefined ? slugIn(ctx, b.slug, note.share?.slug) : undefined;
    let saved = Object.keys(set).length ? await M.Note.findByIdAndUpdate(note._id, { $set: set }, { returnDocument: "after" }) : note;
    if (slug !== undefined) saved = await S.setSlug("note", saved, slug);
    res.json({ success: true, data: S.noteOut(saved), message: MSG.saved });
  });
  own("post", "/notes/:nid/share/new-link", true, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid);
    let saved = null;
    for (let i = 0; i < 5 && !saved; i += 1) {
      try {
        saved = await M.Note.findByIdAndUpdate(note._id, { $set: { "share.token": S.newToken() }, $unset: { "share.slug": 1 } }, { returnDocument: "after" });
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
    }
    await S.dropSlugsOf(note._id); // the custom link stops too (a new link kills every old one)
    await M.NoteSeen.deleteMany({ note_id: note._id }); // people with the old link can't come back: start "seen by" again
    res.json({ success: true, data: S.noteOut(saved), message: MSG.saved });
  });

  // ---------------------------------------------------------------- files (the note's own attachments)
  // the browser / app uploads straight to Cloudinary ("auto" = any file type), then tells us the public_id
  own("get", "/upload-sign", "content", async (ctx, req, res) => {
    const sign = cloud.signUpload(`note/${ctx.business._id}`);
    sign.upload_url = sign.upload_url.replace("/image/upload", "/auto/upload");
    res.json({ success: true, data: { ...sign, file_limit: ctx.limits.file_limit, storage_left: Math.max(0, ctx.limits.storage_limit - (ctx.book.storage_used || 0)) } });
  });

  const SIGN_MAX = 2 * 1024 * 1024;
  async function attach(ctx, note, info) {
    const size = Number(info.bytes) || 0;
    const drop = () => cloud.deleteFile(info.public_id, info.resource_type).catch(() => {});
    // a signature / drawing from the pen pop-up: needs note_sign, a small PNG
    if (info.sign) {
      if (!ctx.sign) {
        drop();
        throw new Bad(MSG.needSign, 403, { code: "need_sign", product: "note_sign" });
      }
      if (size > SIGN_MAX || !/png$/i.test(info.format || info.mime || info.name || "")) {
        drop();
        throw new Bad(MSG.badSign, 400, { code: "bad_sign" });
      }
    }
    // a voice note (recorded in the browser / app): needs note_voice, an audio file, ≤ 15 MB
    if (info.voice) {
      if (!ctx.voice) {
        drop();
        throw new Bad(MSG.needVoice, 403, { code: "need_voice", product: "note_voice" });
      }
      if (size > S.VOICE_MAX || S.fineKind({ mime: info.mime, name: info.name }) !== "audio") {
        drop();
        throw new Bad(MSG.badVoice, 400, { code: "bad_voice" });
      }
    }
    if (size > ctx.limits.file_limit) {
      drop();
      throw new Bad(MSG.fileTooBig, 413, { code: "file_too_big" });
    }
    if (!(await S.reserve(ctx.business._id, size, ctx.limits.storage_limit))) {
      drop();
      throw new Bad(MSG.storageFull, 413, { code: "storage_full", product: "note_storage" });
    }
    const name = S.str(info.name, 200) || "file";
    const mime = info.mime || S.mimeOf(name);
    const file = { public_id: info.public_id, resource_type: info.resource_type, url: info.url, name, size, mime, kind: S.kindOf(mime, name), by: "owner", sign: !!info.sign, voice: !!info.voice, at: new Date() };
    const saved = await M.Note.findOneAndUpdate({ _id: note._id, deleted: false }, { $push: { files: file } }, { returnDocument: "after" });
    if (!saved) {
      await S.release(ctx.business._id, size);
      drop();
      throw new Bad(MSG.noteNotFound, 404);
    }
    return S.fileOut(saved.files[saved.files.length - 1]);
  }

  own("post", "/notes/:nid/files", "content", async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid);
    const publicId = S.str(req.body?.public_id, 300);
    const type = ["image", "video", "raw"].includes(req.body?.resource_type) ? req.body.resource_type : "image";
    const folder = `${cloud.signUpload("x").folder.replace(/\/x$/, "")}/note/${ctx.business._id}/`;
    // the owner's own folder only — not the guests' (a guest's file would then be counted twice)
    if (!publicId || !publicId.startsWith(folder) || publicId.startsWith(`${folder}guest/`)) throw new Bad(MSG.badFile, 400, { code: "bad_file" });
    const had = (note.files || []).find((f) => f.public_id === publicId);
    if (had) return res.json({ success: true, data: S.fileOut(had) });
    let r;
    try {
      r = await cloud.cloudinary.api.resource(publicId, { resource_type: type });
    } catch (err) {
      throw new Bad(MSG.badFile, 400, { code: "bad_file" });
    }
    const ext = r.format ? `.${r.format}` : "";
    const name = S.str(req.body?.name, 200) || `${r.original_filename || "file"}${ext && !String(r.original_filename || "").endsWith(ext) ? ext : ""}`;
    const voice = S.bool(req.body?.voice, false);
    const guess = S.mimeOf(name) || (type === "image" ? `image/${r.format || "jpeg"}` : type === "video" ? `video/${r.format || "webm"}` : "");
    const mimeGuess = voice ? S.voiceMime(guess) : guess; // a voice clip is audio (Cloudinary stores it as "video")
    const file = await attach(ctx, note, { public_id: r.public_id, resource_type: r.resource_type || type, url: r.secure_url, bytes: r.bytes, name, mime: mimeGuess, format: r.format, sign: S.bool(req.body?.sign, false), voice });
    res.status(201).json({ success: true, data: file, message: MSG.saved });
  });

  own(
    "post",
    "/notes/:nid/files/direct",
    "content",
    async (ctx, req, res) => {
      if (!req.file) throw new Bad(MSG.noFile);
      const note = await noteOf(ctx, req.params.nid);
      // check the space before sending the file on
      const left = ctx.limits.storage_limit - (ctx.book.storage_used || 0);
      if (req.file.size > left) throw new Bad(MSG.storageFull, 413, { code: "storage_full", product: "note_storage" });
      // refuse a signature before anything is sent to Cloudinary (nothing to clean up)
      const sign = S.bool(req.body?.sign, false);
      if (sign && !ctx.sign) throw new Bad(MSG.needSign, 403, { code: "need_sign", product: "note_sign" });
      const voice = S.bool(req.body?.voice, false);
      if (voice && !ctx.voice) throw new Bad(MSG.needVoice, 403, { code: "need_voice", product: "note_voice" });
      if (voice) req.file.mimetype = S.voiceMime(req.file.mimetype);
      if (voice && (req.file.size > S.VOICE_MAX || S.fineKind({ mime: req.file.mimetype, name: req.file.originalname }) !== "audio")) throw new Bad(MSG.badVoice, 400, { code: "bad_voice" });
      const up = await cloud.uploadBuffer(req.file, `note/${ctx.business._id}`, "auto");
      const name = S.str(up.original_name || req.file.originalname, 200);
      const file = await attach(ctx, note, { public_id: up.public_id, resource_type: up.resource_type, url: up.url, bytes: up.bytes || req.file.size, name, mime: req.file.mimetype, sign, voice });
      res.status(201).json({ success: true, data: file, message: MSG.saved });
    },
    [directUpload],
  );

  own("delete", "/notes/:nid/files/:fid", true, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid, true);
    const f = (note.files || []).find((x) => String(x._id) === String(req.params.fid));
    if (!f) throw new Bad(MSG.rowNotFound, 404);
    // the file + the blocks that showed it (a new version, so open editors see the change)
    const blocks = (note.blocks || []).filter((b) => !(["file", "draw", "audio"].includes(b.t) && b.file_id === String(f._id)));
    const changed = blocks.length !== note.blocks.length;
    // only when the file was still there (two deletes at once give its space back once)
    const saved = await M.Note.findOneAndUpdate({ _id: note._id, "files._id": f._id }, { $pull: { files: { _id: f._id } }, ...(changed ? { $set: { blocks }, $inc: { version: 1 } } : {}) }, { returnDocument: "after" });
    if (!saved) throw new Bad(MSG.rowNotFound, 404);
    await S.dropFiles(ctx.business._id, [f]);
    res.json({ success: true, data: S.noteOut(saved), message: MSG.deleted });
  });

  // ---------------------------------------------------------------- storage packs (+5 GB each, yearly slots)
  // { qty: 1…20 } buys that many new packs (ended slots are reused first) · { item: "slot-N", expect } renews one
  own("post", "/storage", true, async (ctx, req, res) => {
    const b = req.body || {};
    const slots = ctx.storage_slots;
    const bought = [];
    let charged = 0;
    let balance;
    const finish = async (status = 200, extra = {}) => {
      const state = await S.licenseState(ctx.business._id);
      res.status(status).json({ success: status < 400, ...extra, data: { bought, storage_slots: state.storage_slots, addons: state.addons, limits: state.limits }, charged, balance });
    };
    if (b.item !== undefined) {
      const item = String(b.item);
      if (!slots.some((x) => x.item === item)) throw new Bad(`${MSG.badValue} (item)`);
      const r = await buy({ customer: req.customer, business: ctx.business, product: "note_storage", item, expect: b.expect }).catch((err) => {
        throw coinsErr(err);
      });
      bought.push(item);
      charged += r.charged;
      balance = r.balance;
      return finish(200, { message: MSG.saved });
    }
    const qty = Math.round(Number(b.qty ?? 1));
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new Bad(MSG.badValue);
    // key: a random id per purchase attempt (the app / web keep it across retries). The same key again — a double tap,
    // a retry after a timeout while the server was still buying — never pays twice: a finished one returns what it bought,
    // a running one answers 409 busy, one that stopped half way (the server restarted) only buys the packs still missing.
    const key = /^[A-Za-z0-9_-]{8,64}$/.test(String(b.key || "")) ? String(b.key) : undefined;
    let job = null;
    let want = qty;
    if (key) {
      const STALE = 2 * 60 * 1000;
      const now = new Date();
      try {
        job = await M.NotePackBuy.create({ business_id: ctx.business._id, key, qty, status: "running", created_date: now, updated_date: now });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        const had = await M.NotePackBuy.findOne({ business_id: ctx.business._id, key }).lean();
        if (!had) throw new Bad(MSG.packsBusy, 409, { code: "busy" });
        if (had.status === "done") {
          bought.push(...had.bought);
          return finish(200, { message: MSG.saved, repeat: true });
        }
        // still running (another request is buying): wait for it. Stuck for a while: take it over, buy only what's missing
        const took = await M.NotePackBuy.findOneAndUpdate({ _id: had._id, status: "running", updated_date: { $lt: new Date(now.getTime() - STALE) } }, { $set: { updated_date: now } }, { returnDocument: "after" }).lean();
        if (!took) throw new Bad(MSG.packsBusy, 409, { code: "busy" });
        job = took;
        bought.push(...took.bought);
        want = Math.max(0, took.qty - took.bought.length);
      }
    }
    const done = async () => {
      if (job) await M.NotePackBuy.updateOne({ _id: job._id }, { $set: { status: "done", updated_date: new Date() } });
    };
    if (want > 0 && slots.filter((x) => x.active).length + want > S.LIMITS.packs) {
      if (job && !bought.length) await M.NotePackBuy.deleteOne({ _id: job._id });
      else await done();
      throw new Bad(MSG.tooManyPacks);
    }
    // one purchase per pack: stop at the first one that fails (e.g. not enough coins), keep the ones already paid
    const ended = slots.filter((x) => !x.active).map((x) => x.item);
    let next = slots.reduce((m, x) => Math.max(m, S.slotNo(x.item)), 0);
    for (let i = 0; i < want; i += 1) {
      const item = ended.shift() || `slot-${++next}`;
      try {
        const r = await buy({ customer: req.customer, business: ctx.business, product: "note_storage", item });
        bought.push(item);
        charged += r.charged;
        balance = r.balance;
        if (job) await M.NotePackBuy.updateOne({ _id: job._id }, { $push: { bought: item }, $inc: { charged: r.charged }, $set: { updated_date: new Date() } });
      } catch (err) {
        const e = coinsErr(err);
        if (!bought.length) {
          // nothing was paid: the same key may try again (e.g. after topping up)
          if (job) await M.NotePackBuy.deleteOne({ _id: job._id });
          throw e;
        }
        await done();
        // part of it went through: say how many
        return finish(e.status || 500, { message: e.message, code: e.extra?.code || e.message, ...(e.extra || {}) });
      }
    }
    await done();
    await finish(200, { message: MSG.saved });
  });

  // ---------------------------------------------------------------- groups (paid each, sent with one link)
  const groupOf = async (ctx, gid, withDeleted = false) => {
    if (!S.validId(gid)) throw new Bad(MSG.badId);
    const g = await M.NoteGroup.findOne({ _id: gid, business_id: ctx.business._id, paid: true, ...(withDeleted ? {} : { deleted: false }) });
    if (!g) throw new Bad(MSG.groupNotFound, 404);
    return g;
  };
  // note ids from the client → only this business's notes, no repeats, in the given order
  const ownNoteIds = async (ctx, ids) => {
    if (!Array.isArray(ids)) throw new Bad(MSG.badValue);
    const list = [...new Set(ids.map(String).filter(S.validId))].slice(0, 500);
    const found = await M.Note.find({ _id: { $in: list }, business_id: ctx.business._id }).select("_id").lean();
    const ok = new Set(found.map((n) => String(n._id)));
    return list.filter((id) => ok.has(id));
  };

  // a group stays paid: false only for a moment while paying. If the server stopped in between: a group whose
  // license exists becomes paid (the coins were taken), one without a license after a few minutes is removed.
  const repairGroups = async (ctx) => {
    const stuck = await M.NoteGroup.find({ business_id: ctx.business._id, paid: false }).select("_id created_date").lean();
    for (const g of stuck) {
      const lic = await License.exists({ business_id: ctx.business._id, product: "note_group", item: String(g._id) });
      if (lic) await M.NoteGroup.updateOne({ _id: g._id, paid: false }, { $set: { paid: true } });
      else if (Date.now() - new Date(g.created_date).getTime() > 5 * 60 * 1000) await M.NoteGroup.deleteOne({ _id: g._id, paid: false });
    }
  };

  own("get", "/groups", false, async (ctx, req, res) => {
    await repairGroups(ctx);
    const deleted = req.query.deleted === "1";
    const q = S.str(req.query.q, 80);
    const rows = await M.NoteGroup.find({ business_id: ctx.business._id, paid: true, deleted, ...(q ? { name: new RegExp(S.escRe(q), "i") } : {}) }).sort(deleted ? { deleted_at: -1 } : { sort: 1, created_date: 1 }).lean();
    // how many files each group's notes hold (one query for all the listed groups)
    const allIds = [...new Set(rows.flatMap((g) => (g.note_ids || []).map(String)))];
    const counts = new Map();
    if (allIds.length) {
      const per = await M.Note.aggregate([{ $match: { _id: { $in: allIds.map((x) => new mongoose.Types.ObjectId(x)) }, business_id: ctx.business._id, deleted: false } }, { $project: { n: { $size: { $ifNull: ["$files", []] } } } }]);
      for (const r of per) counts.set(String(r._id), r.n);
    }
    const filesOf = (g) => (g.note_ids || []).reduce((a, nid) => a + (counts.get(String(nid)) || 0), 0);
    res.json({ success: true, data: rows.map((g) => ({ ...S.groupOut(g), files_count: filesOf(g) })), price: await priceOf("note_group") });
  });

  // every file in a group's notes (free; not the replies' files) · ?q&kind&sort=date|size|name&page
  own("get", "/groups/:gid/files", false, async (ctx, req, res) => {
    const g = await groupOf(ctx, req.params.gid);
    const rows = await S.notesFiles(ctx.business._id, g.note_ids);
    res.json({ success: true, ...S.filesPage(rows, req.query), totals: S.filesTotals(rows) });
  });

  // a new group: made first (hidden, paid: false), then paid; if paying fails the group is removed again.
  // key: a random id per create dialog. The same key again (a double click, a retry, a second request) returns
  // that group and never pays twice.
  own("post", "/groups", "content", async (ctx, req, res) => {
    const b = req.body || {};
    const name = S.str(b.name, 80);
    if (!name) throw new Bad(MSG.needGroupName, 400, { code: "need_name" });
    const key = /^[A-Za-z0-9_-]{8,64}$/.test(String(b.key || "")) ? String(b.key) : undefined;
    const sameKey = async () => {
      await repairGroups(ctx);
      const g = await M.NoteGroup.findOne({ business_id: ctx.business._id, create_key: key });
      if (!g) return null;
      if (!g.paid) throw new Bad(MSG.groupBusy, 409, { code: "busy" });
      return g;
    };
    if (key) {
      const had = await sameKey();
      if (had) return res.json({ success: true, data: S.groupOut(had.toObject()), charged: 0, repeat: true, message: MSG.saved });
    }
    const noteIds = b.note_ids !== undefined ? await ownNoteIds(ctx, b.note_ids) : [];
    const last = await M.NoteGroup.findOne({ business_id: ctx.business._id }).sort({ sort: -1 }).select("sort").lean();
    const group = await S.createGroup({
      business_id: ctx.business._id,
      name,
      color: M.COLORS.includes(b.color) ? b.color : "default",
      icon: S.str(b.icon, 30),
      sort: (last?.sort || 0) + 1,
      note_ids: noteIds,
      paid: false,
      ...(key ? { create_key: key } : {}),
      share: { level: "view", ask_name: ctx.book.settings?.ask_name !== false },
    }).catch(async (err) => {
      // two requests with the same key at once: the other one is making it
      if (key && err?.code === 11000 && String(err.message).includes("create_key")) {
        const had = await sameKey();
        if (had) return { repeat: had };
        throw new Bad(MSG.groupBusy, 409, { code: "busy" });
      }
      throw err;
    });
    if (group.repeat) return res.json({ success: true, data: S.groupOut(group.repeat.toObject()), charged: 0, repeat: true, message: MSG.saved });
    let r;
    try {
      r = await buy({ customer: req.customer, business: ctx.business, product: "note_group", item: String(group._id) });
    } catch (err) {
      await M.NoteGroup.deleteOne({ _id: group._id });
      throw coinsErr(err);
    }
    const saved = await M.NoteGroup.findByIdAndUpdate(group._id, { $set: { paid: true } }, { returnDocument: "after" });
    res.status(201).json({ success: true, data: S.groupOut(saved), charged: r.charged, balance: r.balance, message: MSG.saved });
  });

  own("put", "/groups/:gid", true, async (ctx, req, res) => {
    const g = await groupOf(ctx, req.params.gid);
    const b = req.body || {};
    const set = {};
    if (b.name !== undefined) {
      set.name = S.str(b.name, 80);
      if (!set.name) throw new Bad(MSG.needGroupName, 400, { code: "need_name" });
    }
    if (b.color !== undefined) {
      if (!M.COLORS.includes(b.color)) throw new Bad(MSG.badValue);
      set.color = b.color;
    }
    if (b.icon !== undefined) set.icon = S.str(b.icon, 30);
    if (b.theme !== undefined) set.theme = S.themeIn(b.theme, g.theme, ctx.themes);
    if (b.sort !== undefined && Number.isFinite(Number(b.sort))) set.sort = Number(b.sort);
    if (b.note_ids !== undefined) set.note_ids = await ownNoteIds(ctx, b.note_ids);
    const saved = await M.NoteGroup.findByIdAndUpdate(g._id, { $set: set }, { returnDocument: "after" });
    res.json({ success: true, data: S.groupOut(saved), message: MSG.saved });
  });
  own("post", "/groups/:gid/notes", true, async (ctx, req, res) => {
    const g = await groupOf(ctx, req.params.gid);
    const [id] = await ownNoteIds(ctx, [req.body?.note_id]);
    if (!id) throw new Bad(MSG.noteNotFound, 404);
    const saved = await M.NoteGroup.findByIdAndUpdate(g._id, { $addToSet: { note_ids: id } }, { returnDocument: "after" });
    res.json({ success: true, data: S.groupOut(saved), message: MSG.saved });
  });
  own("delete", "/groups/:gid/notes/:nid", true, async (ctx, req, res) => {
    const g = await groupOf(ctx, req.params.gid);
    if (!S.validId(req.params.nid)) throw new Bad(MSG.badId);
    const saved = await M.NoteGroup.findByIdAndUpdate(g._id, { $pull: { note_ids: req.params.nid } }, { returnDocument: "after" });
    res.json({ success: true, data: S.groupOut(saved), message: MSG.saved });
  });
  own("put", "/groups/:gid/share", true, async (ctx, req, res) => {
    const g = await groupOf(ctx, req.params.gid);
    const b = req.body || {};
    const set = {};
    if (b.level !== undefined) {
      if (!M.GROUP_LEVELS.includes(b.level)) throw new Bad(MSG.badValue);
      set["share.level"] = b.level;
    }
    if (b.pin !== undefined) {
      const pin = String(b.pin ?? "").trim();
      if (pin === "") set["share.pin_hash"] = null;
      else if (!/^\d{4,8}$/.test(pin)) throw new Bad(MSG.badPin, 400, { code: "bad_pin" });
      else set["share.pin_hash"] = await bcrypt.hash(pin, 10);
    }
    if (b.expires_at !== undefined) {
      const d = S.dateIn(b.expires_at);
      if (d === undefined) throw new Bad(MSG.badValue);
      set["share.expires_at"] = d;
    }
    if (b.ask_name !== undefined) set["share.ask_name"] = S.bool(b.ask_name, true);
    for (const k of ["hide_owner", "no_copy"]) if (b[k] !== undefined) set[`share.${k}`] = S.bool(b[k], false);
    v4Share(ctx, b, g.share, set);
    const slug = b.slug !== undefined ? slugIn(ctx, b.slug, g.share?.slug) : undefined;
    let saved = Object.keys(set).length ? await M.NoteGroup.findByIdAndUpdate(g._id, { $set: set }, { returnDocument: "after" }) : g;
    if (slug !== undefined) saved = await S.setSlug("group", saved, slug);
    res.json({ success: true, data: S.groupOut(saved), message: MSG.saved });
  });
  own("post", "/groups/:gid/share/new-link", true, async (ctx, req, res) => {
    const g = await groupOf(ctx, req.params.gid);
    let saved = null;
    for (let i = 0; i < 5 && !saved; i += 1) {
      try {
        saved = await M.NoteGroup.findByIdAndUpdate(g._id, { $set: { "share.token": S.newToken() }, $unset: { "share.slug": 1 } }, { returnDocument: "after" });
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
    }
    await S.dropSlugsOf(g._id);
    await M.NoteGroupSeen.deleteMany({ group_id: g._id });
    res.json({ success: true, data: S.groupOut(saved), message: MSG.saved });
  });
  // deleting is not refunded; a group can come back within 30 days (still paid)
  own("delete", "/groups/:gid", true, async (ctx, req, res) => {
    const g = await groupOf(ctx, req.params.gid);
    await M.NoteGroup.updateOne({ _id: g._id }, { $set: { deleted: true, deleted_at: new Date() } });
    res.json({ success: true, message: MSG.deleted });
  });
  own("post", "/groups/:gid/restore", true, async (ctx, req, res) => {
    const g = await groupOf(ctx, req.params.gid, true);
    if (g.deleted && g.deleted_at && Date.now() - new Date(g.deleted_at).getTime() > 30 * 864e5) throw new Bad(MSG.tooLateRestore, 400, { code: "too_late" });
    const saved = await M.NoteGroup.findByIdAndUpdate(g._id, { $set: { deleted: false, deleted_at: null } }, { returnDocument: "after" });
    res.json({ success: true, data: S.groupOut(saved), message: MSG.restored });
  });
  own("get", "/groups/:gid/seen", false, async (ctx, req, res) => {
    const g = await groupOf(ctx, req.params.gid, true);
    const rows = await M.NoteGroupSeen.find({ group_id: g._id }).sort({ last_at: -1 }).limit(500).lean();
    res.json({ success: true, data: rows.map((r) => ({ name: r.name, first_at: r.first_at, last_at: r.last_at, count: r.count })) });
  });

  // ---------------------------------------------------------------- entries (written under the note)
  const entryOut = (e) => ({ _id: e._id, kind: e.kind, name: e.name, text: e.text, files: (e.files || []).map(S.fileOut), ...(e.fields ? { fields: e.fields } : {}), hidden: !!e.hidden, by_owner: !!e.by_owner, new: !e.by_owner && !e.seen_by_owner, created_date: e.created_date, updated_date: e.updated_date });

  own("get", "/notes/:nid/entries", false, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid, true);
    const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
    const where = { note_id: note._id };
    const [rows, total] = await Promise.all([
      M.NoteEntry.find(where)
        .sort({ created_date: -1 })
        .skip((page - 1) * PAGE)
        .limit(PAGE)
        .lean(),
      M.NoteEntry.countDocuments(where),
    ]);
    // the owner has now seen them
    if (rows.some((e) => !e.seen_by_owner)) await M.NoteEntry.updateMany({ _id: { $in: rows.map((e) => e._id) }, seen_by_owner: false }, { $set: { seen_by_owner: true } });
    res.json({ success: true, data: rows.map(entryOut), page, pages: Math.max(1, Math.ceil(total / PAGE)), total });
  });

  own("post", "/notes/:nid/entries", "content", async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid);
    const text = S.str(req.body?.text, M.LIMITS.entry);
    if (!text) throw new Bad(MSG.needText);
    const e = await M.NoteEntry.create({ business_id: ctx.business._id, note_id: note._id, kind: "reply", name: S.str(ctx.business.name, M.LIMITS.name), text, by_owner: true, seen_by_owner: true });
    await M.Note.updateOne({ _id: note._id }, { $inc: { entry_count: 1 } });
    res.status(201).json({ success: true, data: entryOut(e), message: MSG.saved });
  });

  const entryOf = async (ctx, eid) => {
    if (!S.validId(eid)) throw new Bad(MSG.badId);
    const e = await M.NoteEntry.findOne({ _id: eid, business_id: ctx.business._id });
    if (!e) throw new Bad(MSG.rowNotFound, 404);
    return e;
  };
  own("put", "/entries/:eid", true, async (ctx, req, res) => {
    const e = await entryOf(ctx, req.params.eid);
    if (req.body?.hidden !== undefined) e.hidden = S.bool(req.body.hidden, false);
    await e.save();
    res.json({ success: true, data: entryOut(e), message: MSG.saved });
  });
  own("delete", "/entries/:eid", true, async (ctx, req, res) => {
    const e = await entryOf(ctx, req.params.eid);
    // only the request that really deleted the row gives the space back
    const gone = await M.NoteEntry.findOneAndDelete({ _id: e._id, business_id: ctx.business._id });
    if (gone) {
      await S.dropFiles(ctx.business._id, gone.files);
      await M.Note.updateOne({ _id: e.note_id, entry_count: { $gt: 0 } }, { $inc: { entry_count: -1 } });
    }
    res.json({ success: true, message: MSG.deleted });
  });

  // ---------------------------------------------------------------- seen by + history
  own("get", "/notes/:nid/seen", false, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid, true);
    const rows = await M.NoteSeen.find({ note_id: note._id }).sort({ last_at: -1 }).limit(500).lean();
    res.json({ success: true, data: rows.map((r) => ({ name: r.name, first_at: r.first_at, last_at: r.last_at, count: r.count })) });
  });
  own("get", "/notes/:nid/history", false, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid, true);
    const rows = await M.NoteRev.find({ note_id: note._id }).sort({ at: -1 }).select("version by at title").lean();
    res.json({ success: true, data: rows.map((r) => ({ _id: r._id, version: r.version, by: r.by, at: r.at, title: r.title })) });
  });
  // an old version: GET shows its text (for a preview before restoring)
  own("get", "/notes/:nid/history/:rid", false, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid, true);
    if (!S.validId(req.params.rid)) throw new Bad(MSG.badId);
    const r = await M.NoteRev.findOne({ _id: req.params.rid, note_id: note._id }).lean();
    if (!r) throw new Bad(MSG.rowNotFound, 404);
    res.json({ success: true, data: { _id: r._id, version: r.version, by: r.by, at: r.at, title: r.title, blocks: r.blocks } });
  });
  own("post", "/notes/:nid/history/:rid/restore", "content", async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid);
    if (!S.validId(req.params.rid)) throw new Bad(MSG.badId);
    const r = await M.NoteRev.findOne({ _id: req.params.rid, note_id: note._id }).lean();
    if (!r) throw new Bad(MSG.rowNotFound, 404);
    const saved = await S.saveContent(note, { title: r.title, blocks: r.blocks }, "owner", true); // file blocks of deleted files drop out
    res.json({ success: true, data: S.noteOut(saved), message: MSG.restored });
  });
  // ================================================================ v3 (NOTE_V3.md)
  // ---------------------------------------------------------------- business logo (the name: PUT /api/user/businesses/:id)
  own(
    "post",
    "/logo",
    true,
    async (ctx, req, res) => {
      if (!req.file) throw new Bad(MSG.noFile);
      const up = await uploadSquare(req.file, `note/${ctx.business._id}/logo`, 512);
      const old = ctx.book.logo?.public_id;
      await M.NoteBook.updateOne({ _id: ctx.book._id }, { $set: { logo: { public_id: up.public_id, url: up.url } } });
      await Business.updateOne({ _id: ctx.business._id }, { $set: { logo_url: up.url } });
      if (old) cloud.deleteFile(old).catch(() => {});
      res.status(201).json({ success: true, data: { logo_url: up.url }, message: MSG.saved });
    },
    [imgUpload],
  );
  own("delete", "/logo", true, async (ctx, req, res) => {
    const old = ctx.book.logo?.public_id;
    await M.NoteBook.updateOne({ _id: ctx.book._id }, { $set: { logo: { public_id: "", url: "" } } });
    await Business.updateOne({ _id: ctx.business._id }, { $set: { logo_url: "" } });
    if (old) cloud.deleteFile(old).catch(() => {});
    res.json({ success: true, data: { logo_url: "" }, message: MSG.saved });
  });

  // ---------------------------------------------------------------- downloads (signed links; plain PDF links are refused by Cloudinary)
  own("get", "/notes/:nid/files/:fid/download", false, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid, true);
    const f = (note.files || []).find((x) => String(x._id) === String(req.params.fid));
    if (!f) throw new Bad(MSG.rowNotFound, 404);
    S.sendDownload(req, res, f);
  });
  own("get", "/entries/:eid/files/:fid/download", false, async (ctx, req, res) => {
    const e = await entryOf(ctx, req.params.eid);
    const f = (e.files || []).find((x) => String(x._id) === String(req.params.fid));
    if (!f) throw new Bad(MSG.rowNotFound, 404);
    S.sendDownload(req, res, f);
  });

  // ---------------------------------------------------------------- group icon picture (note_group_icon per group)
  const iconOwned = async (ctx, gid) => !!(await License.exists({ business_id: ctx.business._id, product: "note_group_icon", item: String(gid) }));
  own("post", "/groups/:gid/icon/unlock", true, async (ctx, req, res) => {
    const g = await groupOf(ctx, req.params.gid);
    if (await iconOwned(ctx, g._id)) return res.json({ success: true, data: S.groupOut(g), charged: 0, already: true, message: MSG.already });
    let r;
    try {
      r = await buy({ customer: req.customer, business: ctx.business, product: "note_group_icon", item: String(g._id) });
    } catch (err) {
      // a double click: the other request bought it
      if (err instanceof LicenseError && (err.message === "already" || err.message === "busy") && (await iconOwned(ctx, g._id))) return res.json({ success: true, data: S.groupOut(g), charged: 0, already: true, message: MSG.already });
      throw coinsErr(err);
    }
    res.status(201).json({ success: true, data: S.groupOut(g), charged: r.charged, balance: r.balance, message: MSG.saved });
  });
  own(
    "post",
    "/groups/:gid/icon",
    "content",
    async (ctx, req, res) => {
      const g = await groupOf(ctx, req.params.gid);
      if (!(await iconOwned(ctx, g._id))) throw new Bad(MSG.needGroupIcon, 403, { code: "need_group_icon", product: "note_group_icon", item: String(g._id) });
      if (!req.file) throw new Bad(MSG.noFile);
      // the space: take the picture's size first (an upper bound), then give back what the resize saved
      if (!(await S.reserve(ctx.business._id, req.file.size, ctx.limits.storage_limit))) throw new Bad(MSG.storageFull, 413, { code: "storage_full", product: "note_storage" });
      let up;
      try {
        up = await uploadSquare(req.file, `note/${ctx.business._id}/groups`, 256);
      } catch (err) {
        await S.release(ctx.business._id, req.file.size);
        throw err;
      }
      const size = Math.min(up.bytes || req.file.size, req.file.size);
      if (req.file.size > size) await S.release(ctx.business._id, req.file.size - size);
      const before = await M.NoteGroup.findOneAndUpdate({ _id: g._id }, { $set: { icon_image: { public_id: up.public_id, url: up.url, size } } }, { returnDocument: "before" });
      // the old picture (from just before this change) goes, with its space
      const old = before?.icon_image;
      if (old?.public_id && old.public_id !== up.public_id) await S.dropFiles(ctx.business._id, [{ public_id: old.public_id, resource_type: "image", size: old.size || 0 }]);
      const saved = await M.NoteGroup.findById(g._id);
      res.status(201).json({ success: true, data: S.groupOut(saved), message: MSG.saved });
    },
    [imgUpload],
  );
  own("delete", "/groups/:gid/icon", true, async (ctx, req, res) => {
    const g = await groupOf(ctx, req.params.gid);
    const before = await M.NoteGroup.findOneAndUpdate({ _id: g._id, "icon_image.public_id": { $nin: ["", null] } }, { $set: { icon_image: { public_id: "", url: "", size: 0 } } }, { returnDocument: "before" });
    if (before?.icon_image?.public_id) await S.dropFiles(ctx.business._id, [{ public_id: before.icon_image.public_id, resource_type: "image", size: before.icon_image.size || 0 }]);
    const saved = await M.NoteGroup.findById(g._id);
    res.json({ success: true, data: S.groupOut(saved), message: MSG.deleted });
  });

  // ---------------------------------------------------------------- media manager (note_media)
  // every stored file: the notes' own files + files under entries (signatures included). Group icons and the logo are
  // managed on their own screens (they are in storage_used, not in this list).
  const MEDIA_PAGE = 50;
  const KIND_KEYS = S.FINE_KINDS; // the fine type, worked out from mime + name on read
  async function allMedia(bid) {
    const [notes, entries] = await Promise.all([
      M.Note.find({ business_id: bid, "files.0": { $exists: true } }).select("title files deleted").lean(),
      M.NoteEntry.find({ business_id: bid, "files.0": { $exists: true } }).select("note_id name files by_owner").lean(),
    ]);
    const titles = new Map((await M.Note.find({ business_id: bid }).select("title deleted").lean()).map((n) => [String(n._id), n]));
    const rows = [];
    for (const n of notes) for (const f of n.files) rows.push({ _id: String(f._id), where: "note", note_id: String(n._id), note_title: n.title || "", note_deleted: !!n.deleted, entry_id: null, entry_name: "", f });
    for (const e of entries) {
      const n = titles.get(String(e.note_id));
      for (const f of e.files) rows.push({ _id: String(f._id), where: "entry", note_id: String(e.note_id), note_title: n?.title || "", note_deleted: !!n?.deleted, entry_id: String(e._id), entry_name: e.name || "", f });
    }
    return rows;
  }
  const kindKey = (f) => S.fineKind(f);
  const mediaOut = (r) => ({ _id: r._id, where: r.where, note_id: r.note_id, note_title: r.note_title, note_deleted: r.note_deleted, entry_id: r.entry_id, entry_name: r.entry_name, name: r.f.name, kind: kindKey(r.f), size: r.f.size || 0, mime: r.f.mime, url: r.f.url, at: r.f.at, by: r.f.by, sign: !!r.f.sign });
  function mediaTotals(ctx, rows) {
    const kinds = Object.fromEntries(KIND_KEYS.map((k) => [k, { count: 0, bytes: 0 }]));
    const byNote = new Map();
    for (const r of rows) {
      const k = kinds[kindKey(r.f)];
      k.count += 1;
      k.bytes += r.f.size || 0;
      const n = byNote.get(r.note_id) || { note_id: r.note_id, note_title: r.note_title, note_deleted: r.note_deleted, count: 0, bytes: 0 };
      n.count += 1;
      n.bytes += r.f.size || 0;
      byNote.set(r.note_id, n);
    }
    return {
      used: ctx.book.storage_used || 0,
      limit: ctx.limits.storage_limit,
      count: rows.length,
      bytes: rows.reduce((a, r) => a + (r.f.size || 0), 0),
      kinds,
      top_notes: [...byNote.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    };
  }
  own("get", "/media", false, async (ctx, req, res) => {
    const rows = await allMedia(ctx.business._id);
    const totals = mediaTotals(ctx, rows);
    // not unlocked: the totals only (for the locked preview)
    if (!ctx.media) return res.json({ success: true, locked: true, data: [], totals, page: 1, pages: 1, total: rows.length, price: await priceOf("note_media") });
    const kind = KIND_KEYS.includes(req.query.kind) ? req.query.kind : "all";
    const q = S.str(req.query.q, 80).toLowerCase();
    let list = rows.filter((r) => (kind === "all" || kindKey(r.f) === kind) && (!q || `${r.f.name} ${r.note_title} ${r.entry_name}`.toLowerCase().includes(q)));
    const sort = ["date", "name"].includes(req.query.sort) ? req.query.sort : "size";
    list.sort(sort === "date" ? (a, b) => new Date(b.f.at) - new Date(a.f.at) : sort === "name" ? (a, b) => String(a.f.name).localeCompare(String(b.f.name)) : (a, b) => (b.f.size || 0) - (a.f.size || 0));
    const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
    const total = list.length;
    list = list.slice((page - 1) * MEDIA_PAGE, page * MEDIA_PAGE);
    res.json({ success: true, locked: false, data: list.map(mediaOut), totals, page, pages: Math.max(1, Math.ceil(total / MEDIA_PAGE)), total });
  });

  // remove many files at once (up to 100). Each removal is conditional: a file gone already gives nothing back again.
  // a note file also takes its file / draw blocks with it (a new version, so open editors see the change)
  own("delete", "/media", true, async (ctx, req, res) => {
    if (!ctx.media) throw new Bad(MSG.needMedia, 403, { code: "need_media", product: "note_media" });
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items || !items.length) throw new Bad(MSG.badValue);
    if (items.length > 100) throw new Bad(MSG.tooManyItems, 400, { code: "too_many" });
    const bid = ctx.business._id;
    const removed = [];
    let freed = 0;
    for (const it of items) {
      const fid = String(it?.file_id || "");
      if (!S.validId(fid) || !S.validId(it?.note_id)) continue;
      if (it.where === "note") {
        for (let i = 0; i < 3; i += 1) {
          const note = await M.Note.findOne({ _id: it.note_id, business_id: bid, "files._id": fid });
          if (!note) break;
          const f = note.files.find((x) => String(x._id) === fid);
          const blocks = (note.blocks || []).filter((b) => !(["file", "draw", "audio"].includes(b.t) && b.file_id === fid));
          const changed = blocks.length !== note.blocks.length;
          // only if nothing changed in between (same version) and the file is still there
          const saved = await M.Note.findOneAndUpdate({ _id: note._id, version: note.version, "files._id": f._id }, { $pull: { files: { _id: f._id } }, ...(changed ? { $set: { blocks }, $inc: { version: 1 } } : {}) }, { returnDocument: "after" });
          if (!saved) continue; // someone saved the note meanwhile: read it again
          await S.dropFiles(bid, [f]);
          removed.push({ where: "note", note_id: String(note._id), file_id: fid });
          freed += f.size || 0;
          break;
        }
      } else if (it.where === "entry" && S.validId(it.entry_id)) {
        const before = await M.NoteEntry.findOneAndUpdate({ _id: it.entry_id, business_id: bid, note_id: it.note_id, "files._id": fid }, { $pull: { files: { _id: fid } } }, { returnDocument: "before" });
        const f = before?.files?.find((x) => String(x._id) === fid);
        if (!f) continue;
        await S.dropFiles(bid, [f]);
        removed.push({ where: "entry", note_id: String(it.note_id), entry_id: String(it.entry_id), file_id: fid });
        freed += f.size || 0;
      }
    }
    const book = await M.NoteBook.findOne({ business_id: bid }).lean();
    res.json({ success: true, data: { removed, freed, storage_used: book?.storage_used || 0, storage_limit: ctx.limits.storage_limit }, message: MSG.deleted });
  });

  // ---------------------------------------------------------------- custom links (note_link, once, forever)
  // a slug from the share dialog: "" removes (free). Setting / changing one needs note_link. Returns the clean slug.
  function slugIn(ctx, v, current) {
    if (v === null || String(v).trim() === "") return "";
    const { slug } = S.normSlug(v);
    if (slug === (current || "")) return slug;
    if (!ctx.link) throw new Bad(MSG.needLink, 403, { code: "need_link", product: "note_link" });
    const problem = S.slugProblem(slug);
    if (problem) throw new Bad({ short: MSG.slugShort, bad: MSG.slugBad, reserved: MSG.slugReserved }[problem], 400, { code: `slug_${problem}`, slug });
    return slug;
  }
  const checkLimit = rate_limit({ windowMs: 60 * 1000, max: 60, message: MSG.slow });
  // is a link free? → { slug (cleaned), ok, reason: taken|reserved|short|bad|mine, dropped, suggestions }
  own(
    "get",
    "/link-check",
    false,
    async (ctx, req, res) => {
      const { slug, dropped } = S.normSlug(String(req.query.slug || "").slice(0, 120));
      const kind = req.query.kind === "group" ? "group" : "note";
      const id = String(req.query.id || "");
      let reason = S.slugProblem(slug);
      if (!reason) {
        const who = await S.slugOwner(slug);
        if (who) reason = who.kind === kind && who.ref_id === id ? "mine" : "taken";
      }
      const ok = !reason || reason === "mine";
      const suggestions = ok || !slug ? [] : await S.slugSuggest(slug.length >= S.SLUG_MIN ? slug : `${slug || "my"}-note`);
      res.json({ success: true, data: { slug, ok, reason: reason || "", dropped, suggestions, owned: !!ctx.link } });
    },
    [checkLimit],
  );
  own("post", "/link/unlock", true, async (ctx, req, res) => {
    const owned = () => License.exists({ business_id: ctx.business._id, product: "note_link", item: "" });
    const done = (charged, extra = {}) => res.status(charged ? 201 : 200).json({ success: true, data: { owned: true }, charged, ...extra, message: charged ? MSG.saved : MSG.already });
    if (ctx.link) return done(0, { already: true });
    let r;
    try {
      r = await buy({ customer: req.customer, business: ctx.business, product: "note_link" });
    } catch (err) {
      if (err instanceof LicenseError && (err.message === "already" || err.message === "busy") && (await owned())) return done(0, { already: true });
      throw coinsErr(err);
    }
    done(r.charged, { balance: r.balance });
  });

  // ---------------------------------------------------------------- public page themes (note_theme, item = theme key)
  own("post", "/themes/unlock", true, async (ctx, req, res) => {
    const key = String(req.body?.key || "");
    if (!S.THEME_KEYS.includes(key)) throw new Bad(MSG.badTheme, 400, { code: "bad_theme" });
    const owned = () => License.exists({ business_id: ctx.business._id, product: "note_theme", item: key });
    const done = (charged, extra = {}) => res.status(charged ? 201 : 200).json({ success: true, data: { key, owned: [...new Set([...ctx.themes, key])] }, charged, ...extra, message: charged ? MSG.saved : MSG.already });
    if (await owned()) return done(0, { already: true });
    let r;
    try {
      r = await buy({ customer: req.customer, business: ctx.business, product: "note_theme", item: key });
    } catch (err) {
      // a double click: the other request bought it
      if (err instanceof LicenseError && (err.message === "already" || err.message === "busy") && (await owned())) return done(0, { already: true });
      throw coinsErr(err);
    }
    done(r.charged, { balance: r.balance });
  });

  // ================================================================ v4 (NOTE_V4.md)
  // ---------------------------------------------------------------- Telegram alerts (note_telegram, yearly)
  const tgFail = (err) => {
    if (err instanceof telegram.TelegramError) {
      const blocked = err.message === "blocked";
      throw new Bad(err.message === "not_configured" ? MSG.tgNotConfigured : blocked ? MSG.tgBlocked : MSG.tgUnreachable, err.status || 502, { code: err.message === "not_configured" ? "tg_not_configured" : blocked ? "tg_blocked" : "tg_unreachable" });
    }
    throw err;
  };
  const needTg = (ctx) => {
    if (!ctx.telegram) throw new Bad(MSG.needTelegram, 403, { code: "need_telegram", product: "note_telegram" });
    if (!telegram.ready()) throw new Bad(MSG.tgNotConfigured, 503, { code: "tg_not_configured" });
  };
  const tgState = async (ctx) => TG.stateOut(await M.NoteBook.findById(ctx.book._id).lean(), ctx);
  // the Telegram state only (light: the app asks every few seconds while waiting for the bot to link the chat)
  own("get", "/telegram", false, async (ctx, req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ success: true, data: await tgState(ctx) });
  });
  own("post", "/telegram/link", true, async (ctx, req, res) => {
    needTg(ctx);
    const bot = await telegram.botUsername().catch(tgFail);
    const code = `nt_${S.newToken()}`;
    const expires = new Date(Date.now() + 15 * 60000);
    await M.NoteBook.updateOne({ _id: ctx.book._id }, { $set: { "tg.link_code": code, "tg.link_expires": expires } });
    res.json({ success: true, data: { url: `https://t.me/${bot}?start=${code}`, group_url: `https://t.me/${bot}?startgroup=${code}`, bot, expires_at: expires } });
  });
  own("post", "/telegram/test", true, async (ctx, req, res) => {
    needTg(ctx);
    const book = await M.NoteBook.findById(ctx.book._id).lean();
    if (!book.tg?.chat_id) throw new Bad(MSG.tgNotConnected, 400, { code: "tg_not_connected" });
    try {
      await telegram.send(book.tg.chat_id, TG.words(book).test(ctx.business.name || "Digital Note"));
    } catch (err) {
      if (err instanceof telegram.TelegramError && err.message === "blocked") await M.NoteBook.updateOne({ _id: book._id }, { $set: { "tg.chat_id": "" } });
      tgFail(err);
    }
    res.json({ success: true, data: await tgState(ctx), message: MSG.tgSent });
  });
  own("put", "/telegram", true, async (ctx, req, res) => {
    const b = req.body || {};
    const set = {};
    if (b.lang !== undefined) {
      if (!["km", "en"].includes(b.lang)) throw new Bad(MSG.badValue);
      set["tg.lang"] = b.lang;
    }
    for (const k of ["replies", "replies_batch", "signups", "edits", "acks", "daily", "reminders"]) if (b[k] !== undefined) set[`tg.${k}`] = S.bool(b[k], false);
    if (Object.keys(set).length) await M.NoteBook.updateOne({ _id: ctx.book._id }, { $set: set });
    res.json({ success: true, data: await tgState(ctx), message: MSG.saved });
  });
  own("delete", "/telegram", true, async (ctx, req, res) => {
    const book = await M.NoteBook.findById(ctx.book._id).lean();
    const chat = book.tg?.chat_id;
    await M.NoteBook.updateOne({ _id: book._id }, { $set: { "tg.chat_id": "", "tg.chat_name": "", "tg.connected_at": null, "tg.link_code": "", "tg.link_expires": null } });
    if (chat) telegram.send(chat, TG.words(book).bye).catch(() => {});
    res.json({ success: true, data: await tgState(ctx), message: MSG.saved });
  });

  // ---------------------------------------------------------------- CSV (UTF-8 with BOM, so Excel shows Khmer)
  // a text cell starting with = + - @ (or tab / CR) would run as a formula in Excel → a leading ' keeps it text
  // (real numbers stay numbers; a phone "+855 …" stays readable)
  const csvCell = (v) => {
    let t = v === null || v === undefined ? "" : String(v);
    if (typeof v !== "number" && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const sendCsv = (res, name, rows) => {
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${String(name).replace(/[^A-Za-z0-9_.-]+/g, "-") || "export"}.csv"`);
    res.set("Cache-Control", "no-store");
    res.send(`﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`);
  };
  const isoLocal = (d) => (d ? `${S.localDay(d)} ${S.localHm(d)}` : "");

  // ---------------------------------------------------------------- "I've read it" (note_ack)
  own("get", "/notes/:nid/acks", false, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid, true);
    const [acks, seen] = await Promise.all([M.NoteAck.find({ note_id: note._id }).sort({ at: -1 }).limit(5000).lean(), M.NoteSeen.find({ note_id: note._id }).sort({ last_at: -1 }).limit(5000).lean()]);
    const confirmed = new Set(acks.map((a) => a.guest_key));
    const notYet = seen.filter((x) => !confirmed.has(x.guest_key)).map((x) => ({ name: x.name || "", first_at: x.first_at, last_at: x.last_at }));
    // CSV: who confirmed, then who opened it but didn't confirm yet
    if (req.query.format === "csv") return sendCsv(res, `${note.title || "note"}-confirmed`, [["Name", "Status", "Time", "Through a group link"], ...acks.map((a) => [a.name, "Confirmed", isoLocal(a.at), a.group_id ? "yes" : ""]), ...notYet.map((x) => [x.name, "Opened, not confirmed", isoLocal(x.last_at), ""])]);
    res.json({ success: true, data: acks.map((a) => ({ name: a.name, at: a.at, by_group: !!a.group_id })), not_confirmed: notYet, counts: { confirmed: acks.length, opened_not_confirmed: notYet.length } });
  });

  // ---------------------------------------------------------------- sign-up rows export (CSV free · Excel = note_form)
  own("get", "/notes/:nid/entries/export", false, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid, true);
    const xlsx = req.query.format === "xlsx";
    if (xlsx && !ctx.form) throw new Bad(MSG.needExcel, 403, { code: "need_form", product: "note_form" });
    const fields = note.form?.fields || [];
    const rows = await M.NoteEntry.find({ note_id: note._id, by_owner: false }).sort({ created_date: 1 }).limit(20000).lean();
    const columns = ["Name", "Time", ...fields.map((f) => f.label), "Text", "Files"];
    const data = rows.map((e) => [
      e.name || "",
      isoLocal(e.created_date),
      ...fields.map((f) => {
        const v = e.fields?.[f.id];
        if (v === undefined || v === null) return "";
        if (f.type === "checkbox") return v ? "✓" : "";
        return v;
      }),
      e.text || "",
      (e.files || []).map((f) => f.name).join(", "),
    ]);
    if (xlsx) return res.json({ success: true, data: { title: note.title || "", columns, rows: data } });
    sendCsv(res, note.title || "sign-ups", [columns, ...data]);
  });

  // ---------------------------------------------------------------- names for the checklist "who" list
  own("get", "/people", false, async (ctx, req, res) => {
    const bid = ctx.business._id;
    const [seen, notes] = await Promise.all([M.NoteSeen.find({ business_id: bid, name: { $gt: "" } }).sort({ last_at: -1 }).limit(500).select("name").lean(), M.Note.find({ business_id: bid, deleted: false, "blocks.who": { $exists: true, $ne: "" } }).select("blocks.who").limit(300).lean()]);
    const names = [];
    const add = (n) => {
      const t = S.str(n, M.LIMITS.who);
      if (t && !names.some((x) => x.toLowerCase() === t.toLowerCase())) names.push(t);
    };
    for (const n of notes) for (const b of n.blocks || []) if (b.who) add(b.who);
    for (const x of seen) add(x.name);
    res.json({ success: true, data: names.slice(0, 200) });
  });

  // ---------------------------------------------------------------- your own templates (free, up to 50)
  const tplOut = (t) => ({ _id: t._id, name: t.name, title: t.title, color: t.color, paper: t.paper || "plain", theme: S.themeOut(t.theme), share: { level: t.share?.level || "off", allow_files: t.share?.allow_files !== false, show_entries: t.share?.show_entries !== false, ask_name: t.share?.ask_name !== false, ack: !!t.share?.ack }, form: S.formOut(t.form), blocks_count: (t.blocks || []).length, created_date: t.created_date, updated_date: t.updated_date });
  const tplOf = async (ctx, tid) => {
    if (!S.validId(tid)) throw new Bad(MSG.badId);
    const t = await M.NoteTemplate.findOne({ _id: tid, business_id: ctx.business._id });
    if (!t) throw new Bad(MSG.templateNotFound, 404);
    return t;
  };
  own("get", "/templates", false, async (ctx, req, res) => {
    const rows = await M.NoteTemplate.find({ business_id: ctx.business._id }).sort({ updated_date: -1 }).lean();
    res.json({ success: true, data: rows.map(tplOut) });
  });
  own("post", "/templates", "content", async (ctx, req, res) => {
    const b = req.body || {};
    const name = S.str(b.name, 80);
    if (!name) throw new Bad(MSG.needTemplateName, 400, { code: "need_name" });
    const note = await noteOf(ctx, b.note_id);
    if ((await M.NoteTemplate.countDocuments({ business_id: ctx.business._id })) >= M.LIMITS.templates) throw new Bad(MSG.tooManyTemplates, 400, { code: "too_many_templates" });
    // the text only: no files, signatures or voice; due dates are left out (they'd be old), who stays
    const blocks = (note.blocks || [])
      .filter((x) => !["file", "draw", "audio"].includes(x.t))
      .map((x) => {
        const o = x.toObject ? x.toObject() : x;
        return { id: o.id, t: o.t, text: o.text, done: false, file_id: "", ...(o.style ? { style: o.style } : {}), ...(o.icon ? { icon: o.icon } : {}), ...(o.sticker ? { sticker: o.sticker } : {}), ...(o.who ? { who: o.who } : {}) };
      });
    const t = await M.NoteTemplate.create({
      business_id: ctx.business._id,
      name,
      title: note.title,
      blocks,
      color: note.color,
      paper: note.paper || "plain",
      theme: S.themeOut(note.theme),
      share: { level: note.share.level, allow_files: note.share.allow_files !== false, show_entries: note.share.show_entries !== false, ask_name: note.share.ask_name !== false, ack: !!note.share.ack },
      form: { fields: note.form?.fields || [] },
    });
    res.status(201).json({ success: true, data: tplOut(t), message: MSG.saved });
  });
  own("put", "/templates/:tid", true, async (ctx, req, res) => {
    const t = await tplOf(ctx, req.params.tid);
    if (req.body?.name !== undefined) {
      t.name = S.str(req.body.name, 80);
      if (!t.name) throw new Bad(MSG.needTemplateName, 400, { code: "need_name" });
    }
    await t.save();
    res.json({ success: true, data: tplOut(t), message: MSG.saved });
  });
  own("delete", "/templates/:tid", true, async (ctx, req, res) => {
    const t = await tplOf(ctx, req.params.tid);
    await M.NoteTemplate.deleteOne({ _id: t._id });
    res.json({ success: true, message: MSG.deleted });
  });
  // POST /notes { my_template } — paid parts only when owned now (else quietly left out)
  async function fromMyTemplate(ctx, req, res) {
    const b = req.body || {};
    const t = await tplOf(ctx, b.my_template);
    const blocks = (t.blocks || []).map((x) => {
      const o = x.toObject ? x.toObject() : x;
      const keep = ctx.style || !(M.STYLE_BLOCKS.includes(o.t) || o.style);
      if (keep) return o;
      // without the style pack: a callout / sticker / divider becomes plain text (a sticker / divider is dropped)
      if (o.t === "divider" || o.t === "sticker") return null;
      return { id: o.id, t: o.t === "callout" ? "p" : o.t, text: o.text, done: false, file_id: "", ...(o.who ? { who: o.who } : {}) };
    }).filter(Boolean);
    const clean = S.cleanBlocks(blocks.length ? blocks : [{ id: Math.random().toString(36).slice(2, 10), t: "p", text: "" }], [], { style: true });
    const level = M.LEVELS.includes(b.share_level) ? b.share_level : t.share?.level || "off";
    const theme = S.themeOut(t.theme);
    const note = await S.createNote({
      business_id: ctx.business._id,
      title: t.title,
      blocks: clean,
      color: t.color,
      paper: ctx.style ? t.paper || "plain" : "plain",
      theme: theme.key === "default" || ctx.themes.includes(theme.key) ? theme : { key: "default", color: theme.color },
      text: S.textOf(t.title, clean),
      form: ctx.form ? { fields: t.form?.fields || [] } : { fields: [] },
      share: { level, allow_files: t.share?.allow_files !== false, show_entries: t.share?.show_entries !== false, ask_name: t.share?.ask_name !== false, ack: !!t.share?.ack && !!ctx.ack },
    });
    await S.saveRev(note, "owner");
    res.status(201).json({ success: true, data: S.noteOut(note), message: MSG.saved });
  }

  // ---------------------------------------------------------------- PDF export (note_pdf): everything the print page needs
  own("get", "/notes/:nid/print", false, async (ctx, req, res) => {
    if (!ctx.pdf) throw new Bad(MSG.needPdf, 403, { code: "need_pdf", product: "note_pdf" });
    const note = await noteOf(ctx, req.params.nid, true);
    const [entries, acks] = await Promise.all([M.NoteEntry.find({ note_id: note._id, hidden: false }).sort({ created_date: 1 }).limit(1000).lean(), M.NoteAck.find({ note_id: note._id }).sort({ at: 1 }).limit(5000).lean()]);
    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      data: {
        note: S.noteOut(note),
        business: { name: ctx.business.name, logo_url: ctx.business.logo_url || ctx.book.logo?.url || "" },
        entries: entries.map(entryOut),
        acks: acks.map((a) => ({ name: a.name, at: a.at })),
        theme: S.themeOut(note.theme),
        printed_at: new Date(),
      },
    });
  });

  // ---------------------------------------------------------------- views per day (free)
  own("get", "/notes/:nid/stats", false, async (ctx, req, res) => {
    const note = await noteOf(ctx, req.params.nid, true);
    res.json({ success: true, data: await S.statsOf(note._id, req.query.days) });
  });
  own("get", "/groups/:gid/stats", false, async (ctx, req, res) => {
    const g = await groupOf(ctx, req.params.gid, true);
    res.json({ success: true, data: await S.statsOf(g._id, req.query.days) });
  });

  // ---------------------------------------------------------------- the scheduler (also run by /api/cron/daily-report)
  prop.app.get("/api/cron/note-telegram", async (req, res) => {
    const secret = process.env.CRON_SECRET || "";
    const given = (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || String(req.query.key || "");
    if (!secret || given !== secret) return res.sendStatus(404);
    res.json({ success: true, ...(await TG.tick().catch((err) => ({ error: err.message }))) });
  });
};
