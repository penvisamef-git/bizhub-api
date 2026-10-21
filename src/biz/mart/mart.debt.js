// Debt book (mart_debt, yearly) — both doors (owner dashboard + POS):
//   GET  /debtors?q=                 everyone with their balance + totals (owed, people)
//   POST /debtors { name, phone, note }      PUT /debtors/:did      DELETE /debtors/:did (manager, balance 0 only)
//   GET  /debtors/:did               one person + their history (last 200 lines)
//   POST /debtors/:did/payments { amount, method, note }     money paid back at the counter
// A sale paid "debt" (mart.sales.js) writes "+amount" here; voiding it writes it back.
const T = {
  needDebt: "សូមដោះសោ “សៀវភៅជំពាក់” ជាមុនសិន!",
  hasDebt: "អ្នកនេះនៅជំពាក់ប្រាក់ មិនអាចលុបបានទេ!",
  tooMuch: "ច្រើនជាងប្រាក់ជំពាក់! នៅជំពាក់ {amt}។",
  needDebtor: "សូមជ្រើសរើសអតិថិជន ឬបញ្ចូលឈ្មោះថ្មី!",
};

module.exports = (prop, kit) => {
  const { dual, managerOnly, Bad, MSG, text, num, oneOf, validId, roundOf, M } = kit;
  const need = (ctx) => {
    if (!ctx.addons.mart_debt?.active) throw new Bad(T.needDebt, 402, { product: "mart_debt" });
  };
  const out = (d) => ({ _id: d._id, name: d.name, phone: d.phone, note: d.note, balance: d.balance, active: d.active, created_date: d.created_date, updated_date: d.updated_date });

  dual("get", "/debtors", false, async (ctx, req, res) => {
    need(ctx);
    const t = String(req.query.q || "").trim().toLowerCase(); // prettier-ignore
    const rows = await M.MartDebtor.find({ business_id: ctx.business._id, active: true }).sort({ balance: -1, name: 1 }).limit(1000).lean();
    const r = roundOf(ctx.settings.currency);
    res.json({
      success: true,
      data: {
        rows: (t ? rows.filter((d) => d.name.toLowerCase().includes(t) || (d.phone || "").includes(t)) : rows).map(out),
        totals: { owed: r(rows.reduce((a, d) => a + Math.max(0, d.balance), 0)), people: rows.filter((d) => d.balance > 0).length },
      },
    });
  });

  const readDebtor = (b, partial) => {
    const set = {};
    const name = text(b, "name", 80, { required: !partial });
    if (name !== undefined) {
      if (!name) throw new Bad(`${MSG.required}: name`);
      set.name = name;
    }
    const phone = text(b, "phone", 30);
    if (phone !== undefined) set.phone = phone;
    const note = text(b, "note", 200);
    if (note !== undefined) set.note = note;
    return set;
  };
  dual("post", "/debtors", true, async (ctx, req, res) => {
    need(ctx);
    const row = await M.MartDebtor.create({ business_id: ctx.business._id, ...readDebtor(req.body || {}, false) });
    res.status(201).json({ success: true, data: out(row), message: MSG.saved });
  });
  const load = async (ctx, did) => {
    if (!validId(did)) throw new Bad(MSG.badId);
    const row = await M.MartDebtor.findOne({ _id: did, business_id: ctx.business._id, active: true });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  dual("put", "/debtors/:did", true, async (ctx, req, res) => {
    need(ctx);
    const row = await load(ctx, req.params.did);
    row.set(readDebtor(req.body || {}, true));
    await row.save();
    res.json({ success: true, data: out(row), message: MSG.saved });
  });
  dual("delete", "/debtors/:did", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const row = await load(ctx, req.params.did);
    if (Math.abs(row.balance) >= 0.005) throw new Bad(T.hasDebt, 409, { code: "has_debt" });
    row.active = false;
    await row.save();
    res.json({ success: true, message: MSG.deleted });
  });
  dual("get", "/debtors/:did", false, async (ctx, req, res) => {
    need(ctx);
    const row = await load(ctx, req.params.did);
    const txs = await M.MartDebtTx.find({ business_id: ctx.business._id, debtor_id: row._id }).sort({ created_date: -1 }).limit(200).lean();
    res.json({ success: true, data: { ...out(row), txs } });
  });

  // money paid back at the counter
  dual("post", "/debtors/:did/payments", true, async (ctx, req, res) => {
    need(ctx);
    const b = req.body || {};
    const row = await load(ctx, req.params.did);
    const r = roundOf(ctx.settings.currency);
    const amount = r(num(b, "amount", 0.000001, 1000000000, { required: true }));
    if (amount > r(row.balance) + 0.005) throw new Bad(T.tooMuch.replace("{amt}", ctx.settings.currency === "KHR" ? `${r(row.balance)}៛` : `$${r(row.balance)}`), 400, { code: "too_much", balance: r(row.balance) });
    row.balance = r(row.balance - amount);
    await row.save();
    const tx = await M.MartDebtTx.create({
      business_id: ctx.business._id,
      debtor_id: row._id,
      kind: "payment",
      amount: -amount,
      balance_after: row.balance,
      method: oneOf(b, "method", kit.methodKeys(ctx.settings)) || "cash",
      note: text(b, "note", 200) || "",
      by: ctx.by,
    });
    res.json({ success: true, data: { debtor: out(row), tx }, message: MSG.saved });
  });

  // called from the sales routes
  const on = (ctx) => !!ctx.addons.mart_debt?.active;
  async function resolveDebtor(ctx, b) {
    if (b.debtor_id) {
      if (!validId(b.debtor_id)) throw new Bad(MSG.badId);
      const row = await M.MartDebtor.findOne({ _id: b.debtor_id, business_id: ctx.business._id, active: true });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      return row;
    }
    const name = String(b.new_debtor?.name || "").trim().slice(0, 80); // prettier-ignore
    if (!name) throw new Bad(T.needDebtor, 400, { code: "need_debtor" });
    return M.MartDebtor.create({ business_id: ctx.business._id, name, phone: String(b.new_debtor?.phone || "").trim().slice(0, 30) }); // prettier-ignore
  }
  async function saleUp(ctx, debtor, sale, sign) {
    const r = roundOf(ctx.settings.currency);
    debtor.balance = r(debtor.balance + sign * sale.total);
    await debtor.save();
    await M.MartDebtTx.create({ business_id: ctx.business._id, debtor_id: debtor._id, kind: sign > 0 ? "sale" : "void", amount: sign * sale.total, balance_after: debtor.balance, sale_id: sale._id, sale_no: sale.no, by: ctx.by });
  }
  return { on, need, resolveDebtor, saleUp, load };
};
