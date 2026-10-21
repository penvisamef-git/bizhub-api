// Cambodia payroll (att_khpay add-on): tax on salary, NSSF and seniority indemnity, on top of a staff's month pay.
// Rates are settings (they change by law); defaults as of 2026:
//   Tax on salary (residents, monthly, progressive, KHR): 0–1,500,000 0% · –2,000,000 5% · –8,500,000 10% · –12,500,000 15% · above 20%
//   Dependants: 150,000 KHR off the taxable salary for each dependent spouse / child. Non-residents: 20% flat.
//   NSSF on the wage between 400,000 and 1,200,000 KHR: pension 2% staff + 2% employer; occupational risk 0.8% and
//   health care 2.6% paid by the employer.
//   Seniority indemnity (UDC contracts): 15 days' wage a year, paid in two parts — 7.5 days in June and in December.
const BRACKETS = [
  [1500000, 0],
  [2000000, 0.05],
  [8500000, 0.1],
  [12500000, 0.15],
  [Infinity, 0.2],
];
const DEFAULTS = { tax: true, nssf: true, seniority: true, khr_rate: 4100, pension_ee: 2, pension_er: 2, risk_er: 0.8, health_er: 2.6, nssf_min: 400000, nssf_max: 1200000, dependant: 150000 };

// progressive tax on a monthly taxable salary in KHR
function salaryTax(khr, resident = true) {
  if (khr <= 0) return 0;
  if (!resident) return khr * 0.2;
  let tax = 0;
  let low = 0;
  for (const [top, rate] of BRACKETS) {
    if (khr > low) tax += (Math.min(khr, top) - low) * rate;
    low = top;
  }
  return tax;
}

// one staff's month → the Cambodia lines (all amounts in the payroll currency, rounded)
//   gross: the month's pay before these lines · daily: one day's wage (for the seniority part)
function khLines({ gross, daily = 0, month, currency = "USD", staff = {}, settings = {} }) {
  const k = { ...DEFAULTS, ...settings };
  const rate = currency === "KHR" ? 1 : Number(k.khr_rate) || 4100;
  const toKhr = (v) => v * rate;
  const fromKhr = (v) => v / rate;
  const r = (v) => (currency === "KHR" ? Math.round(v / 100) * 100 : Math.round(v * 100) / 100);
  const m = Number(String(month).slice(5, 7));
  const seniority = k.seniority && staff.contract !== "fdc" && (m === 6 || m === 12) ? daily * 7.5 : 0;
  const total = Math.max(0, gross + seniority);
  const wageKhr = toKhr(total);
  // NSSF: on the wage, kept between the minimum and the maximum
  const base = Math.min(Math.max(wageKhr, k.nssf_min), k.nssf_max);
  const nssf = k.nssf && total > 0;
  const pensionEe = nssf ? fromKhr((base * k.pension_ee) / 100) : 0;
  const pensionEr = nssf ? fromKhr((base * k.pension_er) / 100) : 0;
  const risk = nssf ? fromKhr((base * k.risk_er) / 100) : 0;
  const health = nssf ? fromKhr((base * k.health_er) / 100) : 0;
  // tax on salary
  const resident = staff.resident !== false;
  const deps = resident ? Math.max(0, Math.min(10, Number(staff.dependents) || 0)) : 0;
  const taxBaseKhr = Math.max(0, wageKhr - deps * k.dependant);
  const taxKhr = k.tax ? salaryTax(taxBaseKhr, resident) : 0;
  const tax = fromKhr(taxKhr);
  const net = total - pensionEe - tax;
  return {
    seniority: r(seniority),
    gross: r(total),
    pension_ee: r(pensionEe),
    tax: r(tax),
    tax_base_khr: Math.round(taxBaseKhr),
    tax_khr: Math.round(taxKhr / 100) * 100,
    dependents: deps,
    resident,
    net: r(Math.max(0, net)),
    employer: { pension: r(pensionEr), risk: r(risk), health: r(health), total: r(pensionEr + risk + health) },
    khr_rate: rate,
  };
}

module.exports = { salaryTax, khLines, KH_DEFAULTS: DEFAULTS, BRACKETS };
