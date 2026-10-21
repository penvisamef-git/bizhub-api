// Digital Note: notes the owner shares by link / QR (view · add below · edit · collect), the things people write
// under them (entries), who opened them (seen), and old versions (history). Contract: NOTE_SPEC.md (same folder).
const mongoose = require("mongoose");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };

const BLOCK_TYPES = ["p", "h", "bullet", "check", "quote", "file", "draw", "callout", "divider", "sticker", "audio"]; // audio = a voice note (needs note_voice) // draw = a signature / pen drawing (PNG in files, needs note_sign)
// the style pack (note_style): callout / divider / sticker blocks, block styles, note paper
const STYLE_BLOCKS = ["callout", "divider", "sticker"];
const STYLE_COLORS = ["red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink", "gray"];
const STYLE_SIZES = ["sm", "md", "lg", "xl"]; // a sticker uses sm | md | lg
const STYLE_ALIGNS = ["left", "center", "right"];
const PAPERS = ["plain", "lined", "grid", "dots", "kraft", "night"];
// the public page theme (note_theme, one per key): { key, color }; color "" = the default accent
const themeSchema = new Schema({ key: { type: String, default: "default", maxlength: 40 }, color: { type: String, default: "", maxlength: 7 } }, { _id: false });
const COLORS = ["default", "yellow", "green", "blue", "purple", "pink", "gray"];
const LEVELS = ["off", "view", "reply", "edit", "collect"];
const GROUP_LEVELS = ["off", "view", "reply", "edit"]; // a group link: the same level for every note in it
const KINDS = ["image", "pdf", "doc", "audio", "other"];
const LIMITS = { title: 200, text: 5000, blocks: 500, tags: 10, tag: 30, entry: 3000, name: 80, entryFiles: 5, revs: 50, who: 60, formFields: 20, templates: 50 };
// sign-up list fields (note_form)
const FIELD_TYPES = ["text", "number", "phone", "email", "date", "choice", "checkbox"];

// one file on Cloudinary (the note's own attachments, or a file under an entry)
const fileSchema = new Schema(
  {
    public_id: { type: String, required: true },
    resource_type: { type: String, enum: ["image", "video", "raw"], default: "image" },
    url: { type: String, default: "" },
    name: { type: String, default: "", maxlength: 200 },
    size: { type: Number, default: 0, min: 0 },
    mime: { type: String, default: "" },
    kind: { type: String, enum: KINDS, default: "other" },
    by: { type: String, default: "owner", maxlength: 80 }, // "owner" or the guest's name
    sign: { type: Boolean, default: false }, // a signature / drawing made with the pen pop-up (note_sign)
    voice: { type: Boolean, default: false }, // a voice note recorded in the browser / app (note_voice)
    at: { type: Date, default: Date.now },
  },
  { _id: true },
);

const blockSchema = new Schema(
  {
    id: { type: String, required: true, maxlength: 40 },
    t: { type: String, enum: BLOCK_TYPES, default: "p" },
    text: { type: String, default: "", maxlength: LIMITS.text },
    done: { type: Boolean, default: false },
    file_id: { type: String, default: "" },
    // style pack (note_style) — only the fields that are set are stored
    style: {
      type: new Schema(
        {
          color: { type: String, enum: STYLE_COLORS },
          bg: { type: String, enum: STYLE_COLORS },
          size: { type: String, enum: STYLE_SIZES },
          align: { type: String, enum: STYLE_ALIGNS },
          bold: { type: Boolean },
          italic: { type: Boolean },
        },
        { _id: false },
      ),
      default: undefined,
    },
    icon: { type: String, default: undefined, maxlength: 16 }, // callout: an emoji
    sticker: { type: String, default: undefined, maxlength: 40 }, // sticker: its key in the built-in set
    // checklist (free): when it is due (local Cambodia time) and who does it
    due: { type: String, default: undefined, maxlength: 16 }, // "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"
    who: { type: String, default: undefined, maxlength: 60 },
  },
  { _id: false },
);

// one sign-up list field (note_form)
const fieldSchema = new Schema(
  {
    id: { type: String, required: true, maxlength: 40 },
    label: { type: String, default: "", maxlength: 80 },
    type: { type: String, enum: FIELD_TYPES, default: "text" },
    required: { type: Boolean, default: false },
    options: { type: [String], default: undefined }, // choice
    max: { type: Number, default: undefined }, // text: longest answer
  },
  { _id: false },
);

// one per business
const bookSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    storage_used: { type: Number, default: 0, min: 0 }, // bytes (owner files + guests' files)
    settings: {
      default_level: { type: String, enum: LEVELS, default: "view" },
      ask_name: { type: Boolean, default: true },
    },
    logo: { public_id: { type: String, default: "" }, url: { type: String, default: "" } }, // the business logo (also Business.logo_url)
    // Telegram alerts for the owner (note_telegram, yearly)
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "" },
      link_expires: { type: Date, default: null },
      lang: { type: String, enum: ["km", "en"], default: "km" },
      replies: { type: Boolean, default: true },
      replies_batch: { type: Boolean, default: false }, // false = at once, true = merged every 15 minutes
      signups: { type: Boolean, default: true },
      edits: { type: Boolean, default: false },
      acks: { type: Boolean, default: true },
      daily: { type: Boolean, default: true },
      reminders: { type: Boolean, default: true },
      last_daily_at: { type: Date, default: null },
    },
  },
  opts,
);

const noteSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, index: true },
    title: { type: String, default: "", maxlength: LIMITS.title },
    blocks: { type: [blockSchema], default: [] },
    color: { type: String, enum: COLORS, default: "default" },
    paper: { type: String, enum: PAPERS, default: "plain" }, // note background (style pack, except plain)
    theme: { type: themeSchema, default: () => ({ key: "default", color: "" }) }, // the public page look (single-note link)
    pinned: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    files: { type: [fileSchema], default: [] },
    share: {
      token: { type: String, required: true, unique: true },
      slug: { type: String, default: undefined, maxlength: 40 }, // custom link /n/<slug> (note_link); one namespace with groups
      level: { type: String, enum: LEVELS, default: "view" },
      pin_hash: { type: String, default: null },
      expires_at: { type: Date, default: null },
      allow_files: { type: Boolean, default: true },
      show_entries: { type: Boolean, default: true },
      ask_name: { type: Boolean, default: true },
      hide_owner: { type: Boolean, default: false }, // safety: don't show the business name / logo on the page
      no_copy: { type: Boolean, default: false }, // safety: make copying harder (no text selection, no print button)
      ack: { type: Boolean, default: false }, // "I've read it" button (note_ack)
      opens_at: { type: Date, default: null }, // the link starts working at this time (free)
    },
    // sign-up list fields (note_form): shown to people at the collect level
    form: { fields: { type: [fieldSchema], default: [] } },
    version: { type: Number, default: 1 },
    updated_by: { type: String, default: "owner" },
    views: { type: Number, default: 0 },
    entry_count: { type: Number, default: 0 },
    text: { type: String, default: "", select: false }, // all text in one line (search)
    deleted: { type: Boolean, default: false },
    deleted_at: { type: Date, default: null },
  },
  opts,
);
noteSchema.index({ business_id: 1, deleted: 1, pinned: -1, updated_date: -1 });
noteSchema.index({ "share.slug": 1 }, { unique: true, partialFilterExpression: { "share.slug": { $type: "string" } } });

const entrySchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, index: true },
    note_id: { type: ObjectId, ref: "Note", required: true },
    kind: { type: String, enum: ["reply", "collect"], default: "reply" },
    guest_key: { type: String, default: "", maxlength: 64 },
    name: { type: String, default: "", maxlength: LIMITS.name },
    text: { type: String, default: "", maxlength: LIMITS.entry },
    files: { type: [fileSchema], default: [] },
    hidden: { type: Boolean, default: false },
    by_owner: { type: Boolean, default: false },
    seen_by_owner: { type: Boolean, default: false }, // "new" until the owner opens the entries
    fields: { type: Schema.Types.Mixed, default: undefined }, // sign-up list answers { fieldId: value } (note_form)
  },
  opts,
);
entrySchema.index({ note_id: 1, created_date: -1 });
entrySchema.index({ note_id: 1, kind: 1, guest_key: 1 });

const seenSchema = new Schema({
  business_id: { type: ObjectId, ref: "Business", required: true, index: true },
  note_id: { type: ObjectId, ref: "Note", required: true },
  guest_key: { type: String, required: true, maxlength: 64 },
  name: { type: String, default: "", maxlength: LIMITS.name },
  first_at: { type: Date, default: Date.now },
  last_at: { type: Date, default: Date.now },
  count: { type: Number, default: 1 },
});
seenSchema.index({ note_id: 1, guest_key: 1 }, { unique: true });

const revSchema = new Schema({
  business_id: { type: ObjectId, ref: "Business", required: true, index: true },
  note_id: { type: ObjectId, ref: "Note", required: true, index: true },
  version: { type: Number, required: true },
  title: { type: String, default: "" },
  blocks: { type: [blockSchema], default: [] },
  by: { type: String, default: "owner" },
  at: { type: Date, default: Date.now },
});
revSchema.index({ note_id: 1, at: -1 });

// wrong PINs on a shared link: counted per link (not per IP — that can be faked), kept until `reset`, then MongoDB removes the row
const pinFailSchema = new Schema({
  token: { type: String, required: true, unique: true, maxlength: 40 },
  n: { type: Number, default: 0 },
  reset: { type: Date, required: true },
});
pinFailSchema.index({ reset: 1 }, { expireAfterSeconds: 0 });

// every custom link in use (notes + groups share one namespace): the unique key makes a duplicate impossible, even in a race
const slugSchema = new Schema({
  slug: { type: String, required: true, unique: true, maxlength: 40 },
  kind: { type: String, enum: ["note", "group"], required: true },
  ref_id: { type: ObjectId, required: true, index: true },
  business_id: { type: ObjectId, ref: "Business", required: true, index: true },
  created_date: { type: Date, default: Date.now },
});

// a group (folder) of notes, sent with one link (/n/g/<token>). Each group is paid once (note_group, item = group id).
const groupSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, index: true },
    name: { type: String, default: "", maxlength: 80 },
    color: { type: String, enum: COLORS, default: "default" },
    icon: { type: String, default: "", maxlength: 30 },
    // a picture as the group's icon (note_group_icon for this group, 2 coins once); counts toward storage
    icon_image: { public_id: { type: String, default: "" }, url: { type: String, default: "" }, size: { type: Number, default: 0 } },
    sort: { type: Number, default: 0 },
    theme: { type: themeSchema, default: () => ({ key: "default", color: "" }) }, // the public page look for every note opened through the group link
    note_ids: { type: [ObjectId], default: [] }, // in this order; a note can be in several groups
    share: {
      token: { type: String, required: true, unique: true },
      slug: { type: String, default: undefined, maxlength: 40 }, // custom link /n/g/<slug> (note_link); one namespace with notes
      level: { type: String, enum: GROUP_LEVELS, default: "view" },
      pin_hash: { type: String, default: null },
      expires_at: { type: Date, default: null },
      ask_name: { type: Boolean, default: true },
      hide_owner: { type: Boolean, default: false },
      no_copy: { type: Boolean, default: false },
      ack: { type: Boolean, default: false }, // ask "I've read it" on every note opened through the group (note_ack)
      opens_at: { type: Date, default: null }, // the group link starts working at this time (free)
    },
    paid: { type: Boolean, default: false }, // false only for a moment while the coin is being paid
    create_key: { type: String, default: undefined }, // the create dialog's random id: the same key never pays twice
    views: { type: Number, default: 0 },
    deleted: { type: Boolean, default: false },
    deleted_at: { type: Date, default: null },
  },
  opts,
);
groupSchema.index({ business_id: 1, deleted: 1, sort: 1 });
groupSchema.index({ "share.slug": 1 }, { unique: true, partialFilterExpression: { "share.slug": { $type: "string" } } });
groupSchema.index({ business_id: 1, create_key: 1 }, { unique: true, partialFilterExpression: { create_key: { $type: "string" } } });

// who opened a group link (one row per person)
const groupSeenSchema = new Schema({
  business_id: { type: ObjectId, ref: "Business", required: true, index: true },
  group_id: { type: ObjectId, ref: "NoteGroup", required: true },
  guest_key: { type: String, required: true, maxlength: 64 },
  name: { type: String, default: "", maxlength: LIMITS.name },
  first_at: { type: Date, default: Date.now },
  last_at: { type: Date, default: Date.now },
  count: { type: Number, default: 1 },
});
groupSeenSchema.index({ group_id: 1, guest_key: 1 }, { unique: true });

// "I've read it" (note_ack): one per person per note (group_id: confirmed through that group link)
const ackSchema = new Schema({
  business_id: { type: ObjectId, ref: "Business", required: true, index: true },
  note_id: { type: ObjectId, ref: "Note", required: true },
  group_id: { type: ObjectId, ref: "NoteGroup", default: null },
  guest_key: { type: String, required: true, maxlength: 64 },
  name: { type: String, default: "", maxlength: LIMITS.name },
  at: { type: Date, default: Date.now },
});
ackSchema.index({ note_id: 1, guest_key: 1 }, { unique: true });
ackSchema.index({ business_id: 1, at: -1 });

// the owner's own templates (free, up to 50 per business)
const templateSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, index: true },
    name: { type: String, default: "", maxlength: 80 },
    title: { type: String, default: "", maxlength: LIMITS.title },
    blocks: { type: [blockSchema], default: [] },
    color: { type: String, enum: COLORS, default: "default" },
    paper: { type: String, enum: PAPERS, default: "plain" },
    theme: { type: themeSchema, default: () => ({ key: "default", color: "" }) },
    share: {
      level: { type: String, enum: LEVELS, default: "off" },
      allow_files: { type: Boolean, default: true },
      show_entries: { type: Boolean, default: true },
      ask_name: { type: Boolean, default: true },
      ack: { type: Boolean, default: false },
    },
    form: { fields: { type: [fieldSchema], default: [] } },
  },
  opts,
);

// views per day (free): one row per note / group per Cambodia day; people = different guest keys that day
const viewSchema = new Schema({
  business_id: { type: ObjectId, ref: "Business", required: true, index: true },
  kind: { type: String, enum: ["note", "group"], required: true },
  ref_id: { type: ObjectId, required: true },
  day: { type: String, required: true, maxlength: 10 }, // "YYYY-MM-DD" (UTC+7)
  views: { type: Number, default: 0 },
  people: { type: Number, default: 0 },
});
viewSchema.index({ ref_id: 1, day: 1 }, { unique: true });
// who was already counted on a day (kept 40 days, then MongoDB removes the row)
const viewKeySchema = new Schema({
  ref_id: { type: ObjectId, required: true },
  day: { type: String, required: true, maxlength: 10 },
  guest_key: { type: String, required: true, maxlength: 64 },
  at: { type: Date, default: Date.now },
});
viewKeySchema.index({ ref_id: 1, day: 1, guest_key: 1 }, { unique: true });
viewKeySchema.index({ at: 1 }, { expireAfterSeconds: 40 * 86400 });

// Telegram alerts waiting to go out (note_telegram): merged per note + kind, at most one message a minute
const alertSchema = new Schema({
  business_id: { type: ObjectId, ref: "Business", required: true, index: true },
  note_id: { type: ObjectId, ref: "Note", required: true },
  kind: { type: String, enum: ["reply", "signup", "edit", "ack"], required: true },
  name: { type: String, default: "", maxlength: LIMITS.name },
  text: { type: String, default: "", maxlength: 200 },
  at: { type: Date, default: Date.now },
  batch: { type: String, default: "" }, // "" = waiting; set when a send claims it
});
alertSchema.index({ batch: 1, business_id: 1, note_id: 1, kind: 1 });
alertSchema.index({ at: 1 }, { expireAfterSeconds: 7 * 86400 });
// when a note + kind last sent (the one-message-a-minute gate)
const alertGateSchema = new Schema({
  key: { type: String, required: true, unique: true, maxlength: 80 },
  last_at: { type: Date, default: null },
});
alertGateSchema.index({ last_at: 1 }, { expireAfterSeconds: 86400 }); // an old gate is the same as no gate
// checklist reminders already sent (one per item + due + kind), so a reminder never goes twice
const remindSchema = new Schema({
  note_id: { type: ObjectId, required: true },
  block_id: { type: String, required: true, maxlength: 40 },
  due: { type: String, required: true, maxlength: 16 },
  kind: { type: String, enum: ["day", "hour"], required: true },
  at: { type: Date, default: Date.now },
});
remindSchema.index({ note_id: 1, block_id: 1, due: 1, kind: 1 }, { unique: true });
remindSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 86400 });

// one "buy N storage packs" request, by its key (POST /storage { qty, key }): the same key never pays twice.
// bought fills up pack by pack, so a request that stopped half way can carry on with the rest only.
const packBuySchema = new mongoose.Schema(
  {
    business_id: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    key: { type: String, required: true },
    qty: { type: Number, default: 1 },
    status: { type: String, enum: ["running", "done"], default: "running" },
    bought: { type: [String], default: [] },
    charged: { type: Number, default: 0 },
    created_date: { type: Date, default: Date.now },
    updated_date: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
packBuySchema.index({ business_id: 1, key: 1 }, { unique: true });
packBuySchema.index({ created_date: 1 }, { expireAfterSeconds: 30 * 86400 });

const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);
module.exports = {
  NoteBook: model("NoteBook", bookSchema),
  Note: model("Note", noteSchema),
  NoteEntry: model("NoteEntry", entrySchema),
  NoteSeen: model("NoteSeen", seenSchema),
  NoteRev: model("NoteRev", revSchema),
  NotePinFail: model("NotePinFail", pinFailSchema),
  NoteGroup: model("NoteGroup", groupSchema),
  NoteGroupSeen: model("NoteGroupSeen", groupSeenSchema),
  NoteSlug: model("NoteSlug", slugSchema),
  NoteAck: model("NoteAck", ackSchema),
  NoteTemplate: model("NoteTemplate", templateSchema),
  NoteView: model("NoteView", viewSchema),
  NoteViewKey: model("NoteViewKey", viewKeySchema),
  NoteAlert: model("NoteAlert", alertSchema),
  NoteAlertGate: model("NoteAlertGate", alertGateSchema),
  NoteRemind: model("NoteRemind", remindSchema),
  NotePackBuy: model("NotePackBuy", packBuySchema),
  FIELD_TYPES,
  BLOCK_TYPES,
  STYLE_BLOCKS,
  STYLE_COLORS,
  STYLE_SIZES,
  STYLE_ALIGNS,
  PAPERS,
  GROUP_LEVELS,
  COLORS,
  LEVELS,
  LIMITS,
};
