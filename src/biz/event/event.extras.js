// Event Tickets extras, shared by event.route.js + event.door.js:
//   showtimes (ev_shows) · seat map (ev_seats) · promo codes (ev_promos) · registration questions (ev_questions)
const M = require("./event.models");

module.exports = function extras({ Bad, MSG, str, int, r2, randCode }) {
  // ======================================== showtimes ========================================
  // An event with shows sells every ticket type once per show: EvStock { event_id, show, key, taken } (qty = the type's qty)
  const hasShows = (ev) => (ev?.shows || []).length > 0;
  const showOf = (ev, key) => (ev?.shows || []).find((s) => s.key === key) || null;
  // the show an order is for ("" when the event has none)
  function pickShow(ev, key, { gate = false } = {}) {
    if (!hasShows(ev)) return "";
    const s = showOf(ev, String(key || ""));
    if (!s) throw new Bad(MSG.pickShow, 400, { code: "pick_show" });
    if (!gate && (s.active === false || new Date(s.starts_at) < new Date())) throw new Bad(MSG.showClosed, 409, { code: "show_closed", show: s.key });
    return s.key;
  }
  // the unique indexes must exist before we count on them (a new database builds them in the background)
  const indexes = () => (indexes.p = indexes.p || Promise.all([M.EvStock.init(), M.EvSeat.init(), M.EvPromo.init()]));
  async function takeShow(ev, show, want, gate) {
    await indexes();
    const done = [];
    for (const l of want) {
      const t = ev.types.find((x) => x.key === l.key);
      let ok = !!t && (gate || t.active) && l.qty <= t.qty;
      if (ok) {
        try {
          const r = await M.EvStock.updateOne({ event_id: ev._id, show, key: l.key, taken: { $lte: t.qty - l.qty } }, { $inc: { taken: l.qty } }, { upsert: true });
          ok = !!(r.modifiedCount || r.upsertedCount);
        } catch (err) {
          if (err.code !== 11000) throw err;
          ok = false; // the row exists and is full
        }
      }
      if (!ok) {
        if (done.length) await giveShow(ev._id, show, done);
        throw new Bad(MSG.soldOut, 409, { code: "sold_out", key: l.key, show });
      }
      done.push(l);
    }
  }
  async function giveShow(eventId, show, lines) {
    for (const l of lines || []) if (l.qty) await M.EvStock.updateOne({ event_id: eventId, show, key: l.key }, { $inc: { taken: -l.qty } });
    await M.EvStock.updateMany({ event_id: eventId, show, taken: { $lt: 0 } }, { $set: { taken: 0 } });
  }
  // { showKey: { typeKey: left } }
  async function showLeft(ev) {
    if (!hasShows(ev)) return {};
    const rows = await M.EvStock.find({ event_id: ev._id }).lean();
    const out = {};
    for (const s of ev.shows) {
      out[s.key] = {};
      for (const t of ev.types) {
        const r = rows.find((x) => x.show === s.key && x.key === t.key);
        out[s.key][t.key] = Math.max(0, t.qty - (r?.taken || 0));
      }
    }
    return out;
  }
  // the most taken of each type over all shows (a type's qty can't go below it)
  async function maxTaken(eventId) {
    const rows = await M.EvStock.aggregate([{ $match: { event_id: eventId } }, { $group: { _id: "$key", max: { $max: "$taken" } } }]);
    return Object.fromEntries(rows.map((r) => [r._id, r.max]));
  }
  // the editor's list → shows (keys kept; a show with tickets can't be removed)
  async function showsFrom(raw, ev) {
    const old = ev?.shows || [];
    const out = [];
    for (const x of Array.isArray(raw) ? raw.slice(0, 60) : []) {
      const at = x?.starts_at ? new Date(x.starts_at) : null;
      if (!at || Number.isNaN(at.getTime())) continue;
      const end = x?.ends_at ? new Date(x.ends_at) : null;
      const prev = old.find((s) => s.key === x?.key);
      out.push({ key: prev?.key || `s_${randCode(6).toLowerCase()}`, starts_at: at, ends_at: end && !Number.isNaN(end.getTime()) ? end : null, label: str(x?.label, 60), active: x?.active !== false });
    }
    out.sort((a, b) => a.starts_at - b.starts_at);
    if (ev) {
      const gone = old.filter((s) => !out.some((o) => o.key === s.key)).map((s) => s.key);
      if (gone.length && (await M.EvStock.exists({ event_id: ev._id, show: { $in: gone }, taken: { $gt: 0 } }))) throw new Bad(MSG.showSold, 400, { code: "show_sold" });
      // tickets were sold before the event had shows → can't split them now (and the other way round)
      if (!old.length && out.length && (await M.EvOrder.exists({ event_id: ev._id, show: "", status: { $in: ["pending", "review", "paid"] } }))) throw new Bad(MSG.showsAfterSales, 400, { code: "shows_after_sales" });
    }
    return out;
  }

  // ======================================== seat map ========================================
  // a section has rows × cols seats; seat id "<section key>:<row letters><number>" (A1 … AB40); blocked = no seat there
  const rowName = (i) => {
    let s = "";
    let n = i + 1;
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const rowIndex = (letters) => [...letters].reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const seatedOn = (ev) => !!ev?.seating?.on && (ev.seating.sections || []).length > 0;
  const sectionsOf = (ev, typeKey) => (seatedOn(ev) ? ev.seating.sections.filter((s) => s.type_key === typeKey) : []);
  const isSeated = (ev, typeKey) => sectionsOf(ev, typeKey).length > 0;
  function seatInfo(ev, id) {
    const m = /^([a-z0-9_]{2,20}):([A-Z]{1,2})(\d{1,3})$/.exec(String(id || ""));
    if (!m || !seatedOn(ev)) return null;
    const sec = ev.seating.sections.find((s) => s.key === m[1]);
    if (!sec) return null;
    const r = rowIndex(m[2]);
    const c = Number(m[3]) - 1;
    if (r < 0 || r >= sec.rows || c < 0 || c >= sec.cols || (sec.blocked || []).includes(`${m[2]}${m[3]}`)) return null;
    return { sec, id: `${sec.key}:${m[2]}${m[3]}`, seat: `${m[2]}${m[3]}`, label: `${sec.name ? `${sec.name} · ` : ""}${m[2]}${m[3]}` };
  }
  const seatLabel = (ev, id) => seatInfo(ev, id)?.label || "";
  async function takenSeats(ev, show) {
    const rows = await M.EvSeat.find({ event_id: ev._id, show: show || "" }).select("seat").lean();
    return rows.map((r) => r.seat);
  }
  // the buyer's seats → { typeKey: [ids] } (checks every seat)
  function seatsByType(ev, raw) {
    const out = {};
    const seen = new Set();
    for (const id of Array.isArray(raw) ? raw.slice(0, 50) : []) {
      const s = seatInfo(ev, id);
      if (!s || seen.has(s.id)) throw new Bad(MSG.badSeat, 400, { code: "bad_seat", seat: String(id) });
      seen.add(s.id);
      (out[s.sec.type_key] = out[s.sec.type_key] || []).push(s.id);
    }
    return out;
  }
  // hold seats for an order (all or none)
  async function holdSeats(ev, show, orderId, ids) {
    if (!ids?.length) return;
    await indexes();
    try {
      await M.EvSeat.insertMany(
        ids.map((seat) => ({ event_id: ev._id, show: show || "", seat, order_id: orderId })),
        { ordered: true },
      );
    } catch (err) {
      await M.EvSeat.deleteMany({ order_id: orderId, seat: { $in: ids } });
      if (err.code === 11000) throw new Bad(MSG.seatTaken, 409, { code: "seat_taken" });
      throw err;
    }
  }
  // the first free seats of a type (gate sales, invites)
  async function autoSeats(ev, show, typeKey, n) {
    const taken = new Set(await takenSeats(ev, show));
    const out = [];
    for (const sec of sectionsOf(ev, typeKey))
      for (let r = 0; r < sec.rows && out.length < n; r += 1)
        for (let c = 0; c < sec.cols && out.length < n; c += 1) {
          const seat = `${rowName(r)}${c + 1}`;
          const id = `${sec.key}:${seat}`;
          if (!(sec.blocked || []).includes(seat) && !taken.has(id)) out.push(id);
        }
    if (out.length < n) throw new Bad(MSG.soldOut, 409, { code: "sold_out", key: typeKey });
    return out;
  }
  const freeSeats = (orderId, seats) => M.EvSeat.deleteMany({ order_id: orderId, ...(seats ? { seat: { $in: seats } } : {}) });
  async function seatingFrom(raw, ev) {
    const out = { on: !!raw?.on, sections: [] };
    for (const x of Array.isArray(raw?.sections) ? raw.sections.slice(0, 20) : []) {
      const rows = int(x?.rows, 1, 40, 5);
      const cols = int(x?.cols, 1, 60, 10);
      const key = /^[a-z0-9_]{2,20}$/.test(String(x?.key || "")) ? x.key : `z${randCode(4).toLowerCase()}`;
      const blocked = [...new Set((Array.isArray(x?.blocked) ? x.blocked : []).map((b) => String(b).toUpperCase()).filter((b) => /^[A-Z]{1,2}\d{1,3}$/.test(b)))].slice(0, 2400);
      out.sections.push({ key, name: str(x?.name, 40), type_key: str(x?.type_key, 20), rows, cols, blocked });
    }
    if (ev) {
      // a seat already sold must still exist
      const sold = await M.EvSeat.find({ event_id: ev._id }).select("seat").lean();
      if (sold.some((s) => !seatInfo({ seating: { on: true, sections: out.sections } }, s.seat))) throw new Bad(MSG.seatsSold, 400, { code: "seats_sold" });
    }
    return out;
  }

  // ======================================== promo codes ========================================
  const codeOf = (v) =>
    String(v || "")
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, "")
      .slice(0, 24);
  // the discount a code gives on these lines (throws when it can't be used)
  async function promoFor(businessId, ev, raw, lines) {
    const code = codeOf(raw);
    const p = code ? await M.EvPromo.findOne({ business_id: businessId, code }).lean() : null;
    if (!p || !p.active || (p.event_id && String(p.event_id) !== String(ev._id))) throw new Bad(MSG.promoBad, 400, { code: "promo_bad" });
    if (p.ends_at && new Date(p.ends_at) < new Date()) throw new Bad(MSG.promoEnded, 400, { code: "promo_ended" });
    if (p.max_uses && p.used >= p.max_uses) throw new Bad(MSG.promoUsed, 400, { code: "promo_used" });
    const ok = lines.filter((l) => !p.types?.length || p.types.includes(l.key));
    const qty = ok.reduce((a, l) => a + l.qty, 0);
    if (!qty || qty < (p.min_qty || 1)) throw new Bad(MSG.promoMin.replace("{n}", p.min_qty || 1), 400, { code: "promo_min", min: p.min_qty || 1 });
    const base = r2(ok.reduce((a, l) => a + l.price * l.qty, 0));
    const off = r2(Math.min(base, p.kind === "percent" ? (base * Math.min(100, p.value)) / 100 : p.value));
    return { promo: p, off };
  }
  async function promoUse(p) {
    const r = await M.EvPromo.updateOne({ _id: p._id, active: true, ...(p.max_uses ? { used: { $lt: p.max_uses } } : {}) }, { $inc: { used: 1 } });
    if (!r.modifiedCount) throw new Bad(MSG.promoUsed, 400, { code: "promo_used" });
  }
  const promoRelease = (businessId, code) => (code ? M.EvPromo.updateOne({ business_id: businessId, code, used: { $gt: 0 } }, { $inc: { used: -1 } }) : null);

  // ======================================== registration questions ========================================
  const KINDS = ["text", "long", "choice", "yesno", "email", "number"];
  function questionsFrom(raw) {
    const out = [];
    for (const x of Array.isArray(raw) ? raw.slice(0, 15) : []) {
      const label = str(x?.label, 120);
      if (!label) continue;
      const kind = KINDS.includes(x?.kind) ? x.kind : "text";
      const options = kind === "choice" ? [...new Set((Array.isArray(x?.options) ? x.options : String(x?.options || "").split("\n")).map((o) => str(o, 60)).filter(Boolean))].slice(0, 20) : [];
      if (kind === "choice" && options.length < 2) continue;
      out.push({ key: /^q_[a-z0-9]{4,10}$/.test(String(x?.key || "")) ? x.key : `q_${randCode(6).toLowerCase()}`, label, kind, options, required: !!x?.required });
    }
    return out;
  }
  // the buyer's answers (checks required ones and the kind)
  function answersOf(ev, raw) {
    const out = [];
    for (const q of ev.questions || []) {
      let v = raw && typeof raw === "object" ? raw[q.key] : undefined;
      if (q.kind === "yesno") v = v === true || v === "yes" ? "yes" : v === false || v === "no" ? "no" : "";
      else v = str(v, q.kind === "long" ? 1000 : 200);
      if (v && q.kind === "choice" && !q.options.includes(v)) v = "";
      if (v && q.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw new Bad(MSG.badAnswer.replace("{q}", q.label), 400, { code: "bad_answer", key: q.key });
      if (v && q.kind === "number" && !Number.isFinite(Number(v))) throw new Bad(MSG.badAnswer.replace("{q}", q.label), 400, { code: "bad_answer", key: q.key });
      if (!v && q.required) throw new Bad(MSG.needAnswer.replace("{q}", q.label), 400, { code: "need_answer", key: q.key });
      if (v) out.push({ key: q.key, label: q.label, value: v });
    }
    return out;
  }
  const namesOf = (ev, raw, qty) => (ev.ask_names ? Array.from({ length: qty }, (_, i) => str(Array.isArray(raw) ? raw[i] : "", 80)) : []);

  return { hasShows, showOf, pickShow, takeShow, giveShow, showLeft, maxTaken, showsFrom, rowName, seatedOn, sectionsOf, isSeated, seatInfo, seatLabel, takenSeats, seatsByType, holdSeats, autoSeats, freeSeats, seatingFrom, codeOf, promoFor, promoUse, promoRelease, questionsFrom, answersOf, namesOf };
};
