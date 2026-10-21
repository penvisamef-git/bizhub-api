// Flip Book: PDFs shown as books you can flip, on a public shelf with categories
const mongoose = require("mongoose");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const owned = { business_id: { type: ObjectId, ref: "Business", required: true, index: true } };
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };

const settingsSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 40 }, // the shelf: /f/<slug>
    title: { type: String, default: "", trim: true, maxlength: 80 },
    about: { type: String, default: "", trim: true, maxlength: 600 },
    logo: { url: { type: String, default: "" }, public_id: { type: String, default: "" } },
    contact: {
      phone: { type: String, default: "", trim: true, maxlength: 30 },
      telegram: { type: String, default: "", trim: true, maxlength: 120 },
      facebook: { type: String, default: "", trim: true, maxlength: 200 },
      website: { type: String, default: "", trim: true, maxlength: 200 },
      email: { type: String, default: "", trim: true, maxlength: 120 },
    },
    color: { type: String, default: "", match: /^(#[0-9a-fA-F]{6})?$/ }, // "" = the design's own colour
    shelf_theme: { type: String, default: "classic" },
    // "Contact us" button on the library and category pages (fb_leads)
    lead_form: {
      on: { type: Boolean, default: false },
      ask_email: { type: Boolean, default: false },
      ask_telegram: { type: Boolean, default: false },
      ask_note: { type: Boolean, default: true },
      title: { type: String, default: "", trim: true, maxlength: 80 },
      message: { type: String, default: "", trim: true, maxlength: 300 },
    },
    qr_style: { type: String, default: "classic" }, // QR card style on Share & QR
    reader_theme: { type: String, default: "classic" }, // the default look for books (each book can pick its own)
    sound: { type: Boolean, default: true }, // page-flip sound
    lang: { type: String, enum: ["km", "en"], default: "km" },
    book_slots: { type: Number, default: 0, min: 0 }, // books bought on top of the 5 free (5 coins each)
    big_slots: { type: Number, default: 0, min: 0 }, // big books (up to 50 MB / 400 pages) bought (10 coins each)
    views: { type: Number, default: 0 },
  },
  opts,
);

const categorySchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 60 },
    about: { type: String, default: "", trim: true, maxlength: 600 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 60 }, // /fc/<slug>
    sort: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    views: { type: Number, default: 0 },
  },
  opts,
);

const bookSchema = new Schema(
  {
    ...owned,
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 60 }, // /b/<slug>
    title: { type: String, required: true, trim: true, maxlength: 120 },
    about: { type: String, default: "", trim: true, maxlength: 600 },
    category_ids: { type: [ObjectId], default: [], index: true },
    file: {
      public_id: { type: String, required: true },
      url: { type: String, default: "" }, // the PDF itself (download)
      bytes: { type: Number, default: 0 },
      pages: { type: Number, default: 1 },
      width: { type: Number, default: 0 },
      height: { type: Number, default: 0 },
      name: { type: String, default: "" },
    },
    big: { type: Boolean, default: false }, // uses a big-book place (over 20 MB / 150 pages)
    edition: { type: Number, default: 1 }, // +1 each time the PDF is replaced (same link)
    download: { type: Boolean, default: false }, // readers may download the PDF
    reader_theme: { type: String, default: "" }, // "" = the shelf's default look
    password_hash: { type: String, default: "" }, // fb_password (this book) — scrypt "salt:hash"
    published: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    // contact form (fb_leads): readers leave name + phone before reading, or after page N
    lead_form: {
      mode: { type: String, enum: ["off", "before", "after"], default: "off" },
      page: { type: Number, default: 3, min: 1 },
      ask_email: { type: Boolean, default: false },
      ask_telegram: { type: Boolean, default: false },
      ask_note: { type: Boolean, default: false },
      skip: { type: Boolean, default: false }, // readers may close the form and keep reading
      title: { type: String, default: "", trim: true, maxlength: 80 },
      message: { type: String, default: "", trim: true, maxlength: 300 },
    },
    leads: { type: Number, default: 0 },
    // clickable pages (fb_links): boxes on a page (x, y, w, h as 0–1 of the page) that open a link
    links: {
      type: [
        new Schema(
          {
            page: { type: Number, required: true, min: 1 },
            x: { type: Number, required: true, min: 0, max: 1 },
            y: { type: Number, required: true, min: 0, max: 1 },
            w: { type: Number, required: true, min: 0.01, max: 1 },
            h: { type: Number, required: true, min: 0.01, max: 1 },
            kind: { type: String, enum: ["url", "phone", "telegram", "facebook", "map", "youtube", "email", "page"], default: "url" },
            value: { type: String, default: "", trim: true, maxlength: 500 },
            label: { type: String, default: "", trim: true, maxlength: 60 },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
  },
  opts,
);

// people who filled the contact form of a book (fb_leads)
const leadSchema = new Schema(
  {
    ...owned,
    book_id: { type: ObjectId, default: null, index: true }, // null = from the library "Contact us" button
    category_ids: { type: [ObjectId], default: [], index: true }, // the book's categories (or the category page) when it was sent
    source: { type: String, enum: ["book", "library", "category"], default: "book" },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, default: "", trim: true, maxlength: 30 },
    email: { type: String, default: "", trim: true, maxlength: 120 },
    telegram: { type: String, default: "", trim: true, maxlength: 60 },
    note: { type: String, default: "", trim: true, maxlength: 500 },
    page: { type: Number, default: 0 },
  },
  opts,
);
leadSchema.index({ business_id: 1, created_date: -1 });

// reads per Cambodia day per book (fb_stats reads them; counted for everyone)
const statSchema = new Schema(
  {
    ...owned,
    book_id: { type: ObjectId, required: true },
    day: { type: String, required: true },
    views: { type: Number, default: 0 },
    pages: { type: Map, of: Number, default: () => ({}) }, // page number → times seen
  },
  opts,
);
statSchema.index({ business_id: 1, book_id: 1, day: 1 }, { unique: true });

module.exports = {
  FbSettings: mongoose.model("FbSettings", settingsSchema),
  FbCategory: mongoose.model("FbCategory", categorySchema),
  FbBook: mongoose.model("FbBook", bookSchema),
  FbStat: mongoose.model("FbStat", statSchema),
  FbLead: mongoose.model("FbLead", leadSchema),
};
