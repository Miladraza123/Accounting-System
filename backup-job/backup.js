// QTC Daily Backup — Supabase se data nikal kar Excel banata hai aur email
// attachment ke tor par bhej deta hai. GitHub Actions ke scheduled workflow
// se roz khud-b-khud chalta hai.
//
// OHT wale backup se teen farq:
//   1. Sales Returns bhi Account sheet mein ginte hain (OHT mein chhoot gaye thay)
//   2. Service Invoices — apna alag table hai, Account aur Bills dono mein
//   3. Cutting ka data — Coils, Jobs, Challans ki apni sheets
//
// ZAROORI env variables (GitHub repo -> Settings -> Secrets mein set karni hain):
//   SUPABASE_URL         - jaisa masters.html mein use hoti hai
//   SUPABASE_ANON_KEY    - jaisa masters.html mein use hoti hai
//   BACKUP_EMAIL         - wahi email jisse aap masters.html mein "Sign in" karte hain
//   BACKUP_PASSWORD      - wahi password
//   GMAIL_USER           - jis Gmail se bhejna hai
//   GMAIL_APP_PASSWORD   - Gmail ka "App Password"
//   BACKUP_TO_EMAIL      - jahan backup email jani hai

const { createClient } = require('@supabase/supabase-js');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function signIn() {
  var res = await sb.auth.signInWithPassword({
    email: process.env.BACKUP_EMAIL,
    password: process.env.BACKUP_PASSWORD
  });
  if (res.error) throw new Error('Sign-in failed: ' + res.error.message);
}

async function fetchAll() {
  // Restore ke liye HAR table chahiye — warna file se system wapas nahi aata
  const tables = RESTORE_ORDER;
  const out = {};
  for (const t of tables) {
    const { data, error } = await sb.from(t).select('*');
    if (error) throw new Error(t + ': ' + error.message);
    out[t] = data || [];
  }
  return out;
}

/* ══════ Formatting helpers (masters.html ke bkBtn wale style se, ExcelJS API mein) ══════ */
const INK = 'FF1F2933', MUTE = 'FF7B8794', CR_C = 'FF0E6132', DR_C = 'FF9B2C2C';
const CR_BG = 'FFEEF5F1', DR_BG = 'FFFBEFEF', PANEL = 'FFF2F4F5', HAIR = 'FFE4E7EB';
// Service Invoice ka apna rang — sale ki tarah receivable hai, magar wo maal
// ka bill nahi, kaam ka bill hai. Alag rang se nazar mein aa jata hai.
const SV_C = 'FF8A5A00', SV_BG = 'FFFBF3E6';
const thinBorder = { top: { style: 'thin', color: { argb: HAIR } }, bottom: { style: 'thin', color: { argb: HAIR } },
                      left: { style: 'thin', color: { argb: HAIR } }, right: { style: 'thin', color: { argb: HAIR } } };
const mediumTB = { top: { style: 'medium', color: { argb: INK } }, bottom: { style: 'medium', color: { argb: INK } } };

/* ============================================================
   TAREEKH KA HISAAB

   Pehle naam UTC se banta tha (toISOString). Karachi UTC se 5 ghante
   aage hai, is liye jo backup subah 5 baje se pehle chalta wo PICHLE
   din ke naam se aata, aur jo baad mein chalta wo usi din ke naam se.
   Do system ek hi raat chal kar do alag tareekhein dikhate thay.

   Ab naam us din ka hai JIS KA DATA hai — yani chalne se ek din pehle.
   Backup raat ko chalta hai, to us waqt tak pichla din poora ho chuka
   hota hai. Aur email mein upar likh dete hain ke asal mein kab liya
   gaya, taake koi shak na rahe — chahe padhne wala dunya mein kahin
   bhi ho.
   ============================================================ */

function karachiParts() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const g = t => (f.find(x => x.type === t) || {}).value;
  return { y: g('year'), m: g('month'), d: g('day'), hh: g('hour'), mm: g('minute') };
}

/* Jis din ka data hai — chalne wale din se ek din pehle */
function dataDate() {
  const p = karachiParts();
  const d = new Date(Date.UTC(+p.y, +p.m - 1, +p.d));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/* Backup asal mein kab liya gaya — Karachi ke waqt se */
function takenAtText() {
  const p = karachiParts();
  const MON = ['January','February','March','April','May','June',
               'July','August','September','October','November','December'];
  return (+p.d) + ' ' + MON[+p.m - 1] + ' ' + p.y + ', ' + p.hh + ':' + p.mm + ' (Karachi)';
}

function fmt2(v) {
  var n = Number(v) || 0;
  return n.toLocaleString('en-PK', { maximumFractionDigits: 3 });
}

function setCell(ws, row, col, val, opts) {
  opts = opts || {};
  var cell = ws.getCell(row, col);
  cell.value = val;
  cell.font = { bold: !!opts.bold, color: { argb: opts.color || INK }, size: opts.title ? 14 : (opts.header ? 9 : 10),
                name: opts.title ? 'Georgia' : undefined };
  cell.alignment = { horizontal: opts.align || 'left', vertical: 'center' };
  if (opts.header) { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fg || PANEL } }; cell.border = thinBorder; }
  else if (opts.border) cell.border = thinBorder;
  if (opts.total) cell.border = mediumTB;
  if (opts.numFmt) cell.numFmt = opts.numFmt;
  return cell;
}
const INT_FMT = '#,##0', NUM_FMT = '#,##0.00';

async function buildExcel(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'QTC Automated Backup';
  wb.created = new Date();

  var notDeleted = function (r) { return !r.deleted_at; };
  const P = (data.parties || []).filter(notDeleted);
  const I = (data.items || []).filter(notDeleted);
  const C = (data.companies || []).filter(notDeleted);
  const V = (data.vouchers || []).filter(notDeleted).sort(function (a, b) { return (a.vdate || '') < (b.vdate || '') ? -1 : 1; });
  const L = (data.voucher_lines || []);
  const S = (data.sheets || []).filter(notDeleted).sort(function (a, b) { return (a.sheet_date || '') < (b.sheet_date || '') ? -1 : 1; });

  const partyName = {}; P.forEach(function (p) { partyName[p.id] = p.name; });
  const itemName = {}; I.forEach(function (i) { itemName[i.id] = i.name; });
  const firmName = {}; C.forEach(function (c) { firmName[c.id] = c.name; });
  const linesByV = {}; L.forEach(function (l) { (linesByV[l.voucher_id] = linesByV[l.voucher_id] || []).push(l); });

  // Sales Returns — OHT wale backup mein yeh bilkul chhoot gaye thay, is liye
  // wahan ka Account sheet app ke ledger se nahi milta.
  const RT = (data.sales_returns || []).filter(notDeleted);

  // Service Invoices — apna alag table hai, vouchers mein nahi
  const SI = (data.service_invoices || []).filter(notDeleted)
               .filter(function (x) { return x.status !== 'cancelled'; })
               .sort(function (a, b) { return (a.sidate || '') < (b.sidate || '') ? -1 : 1; });
  const SL = (data.service_invoice_lines || []);
  const linesBySI = {}; SL.forEach(function (l) { (linesBySI[l.invoice_id] = linesBySI[l.invoice_id] || []).push(l); });
  const svcName = {}; (data.service_categories || []).forEach(function (c) { svcName[c.id] = c.name; });
  const METHOD = { kg:'Per KG', ton:'Per Ton', piece:'Per piece', meter:'Per meter',
                   foot:'Per foot', cut:'Per cut', fixed:'Fixed amount' };

  // Cutting ka data
  const active = function (r) { return !r.deleted_at && r.status !== 'cancelled'; };
  const CO = (data.coils || []).filter(active);
  const MI = (data.material_inwards || []).filter(active);
  const CJ = (data.cutting_jobs || []).filter(active).sort(function (a, b) { return (a.jdate || '') < (b.jdate || '') ? -1 : 1; });
  const DC = (data.delivery_challans || []).filter(active).sort(function (a, b) { return (a.ddate || '') < (b.ddate || '') ? -1 : 1; });
  const MR = (data.material_returns || []).filter(active).sort(function (a, b) { return (a.rdate || '') < (b.rdate || '') ? -1 : 1; });
  const whName = {}; (data.warehouses || []).forEach(function (w) { whName[w.id] = w.name; });
  const coilSerial = {}; CO.forEach(function (c) { coilSerial[c.id] = c.coil_serial; });

  const jobIn = {}, jobOut = {};
  (data.cutting_job_inputs || []).forEach(function (x) { jobIn[x.job_id] = (jobIn[x.job_id] || 0) + (Number(x.input_weight) || 0); });
  (data.cutting_job_outputs || []).forEach(function (x) { jobOut[x.job_id] = (jobOut[x.job_id] || 0) + (Number(x.output_weight) || 0); });
  const chLines = {};
  (data.delivery_challan_lines || []).forEach(function (l) { (chLines[l.challan_id] = chLines[l.challan_id] || []).push(l); });
  const mrLines = {};
  (data.material_return_lines || []).forEach(function (l) { (mrLines[l.return_id] = mrLines[l.return_id] || []).push(l); });

  /* ─── SHEET 1: LEDGER ─── */
  const wsL = wb.addWorksheet('Ledger');
  var rowL = 1;
  S.forEach(function (sh) {
    var ds = sh.sheet_date ? new Date(sh.sheet_date + 'T00:00:00').toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    setCell(wsL, rowL, 1, sh.firm || 'Daily Register', { title: true });
    setCell(wsL, rowL, 4, 'Date: ' + ds, { bold: true, align: 'right' });
    if (sh.opening && Number(sh.opening)) {
      setCell(wsL, rowL, 6, 'Opening: ' + Number(sh.opening).toLocaleString('en-PK') + ' ' + (sh.side || 'Cr').toUpperCase(), { bold: true, align: 'right' });
    }
    rowL++;
    setCell(wsL, rowL, 1, 'CREDIT', { header: true, fg: CR_BG, color: CR_C, align: 'center' });
    setCell(wsL, rowL, 4, 'DEBIT', { header: true, fg: DR_BG, color: DR_C, align: 'center' });
    rowL++;
    ['Cash', 'Amount (Rs)', 'Party / Remarks', 'Cash', 'Amount (Rs)', 'Party / Remarks'].forEach(function (h, i) {
      setCell(wsL, rowL, i + 1, h, { header: true, align: 'center' });
    });
    rowL++;
    var crTot = 0, drTot = 0;
    (sh.rows || []).forEach(function (row) {
      if (!row || row.every(function (c) { return !c; })) return;
      var ca = Number(String(row[2] || '').replace(/,/g, '')) || 0, cp = row[3] || '';
      var da = Number(String(row[0] || '').replace(/,/g, '')) || 0, dp = row[1] || '';
      crTot += ca; drTot += da;
      setCell(wsL, rowL, 1, row[4] ? '\u2713' : '', { color: CR_C, align: 'center', border: true });
      setCell(wsL, rowL, 2, ca || '', { bold: !!ca, color: ca ? CR_C : INK, align: 'right', border: true, numFmt: ca ? INT_FMT : undefined });
      setCell(wsL, rowL, 3, cp, { align: 'left', border: true });
      setCell(wsL, rowL, 4, row[5] ? '\u2713' : '', { color: DR_C, align: 'center', border: true });
      setCell(wsL, rowL, 5, da || '', { bold: !!da, color: da ? DR_C : INK, align: 'right', border: true, numFmt: da ? INT_FMT : undefined });
      setCell(wsL, rowL, 6, dp, { align: 'left', border: true });
      rowL++;
    });
    setCell(wsL, rowL, 2, crTot, { bold: true, color: CR_C, align: 'right', total: true, numFmt: INT_FMT });
    setCell(wsL, rowL, 3, 'TOTAL CREDIT', { bold: true, color: MUTE, align: 'left', total: true });
    setCell(wsL, rowL, 5, drTot, { bold: true, color: DR_C, align: 'right', total: true, numFmt: INT_FMT });
    setCell(wsL, rowL, 6, 'TOTAL DEBIT', { bold: true, color: MUTE, align: 'left', total: true });
    rowL += 2;
  });
  wsL.getColumn(1).width = 6; wsL.getColumn(2).width = 14; wsL.getColumn(3).width = 28;
  wsL.getColumn(4).width = 6; wsL.getColumn(5).width = 14; wsL.getColumn(6).width = 28;

  /* ─── SHEET 2: ACCOUNT ─── */
  const wsA = wb.addWorksheet('Account');
  var rowA = 1;
  P.forEach(function (p) {
    var pB = V.filter(function (v) { return v.party_id === p.id; });
    var pR = RT.filter(function (x) { return x.party_id === p.id; });
    var pS = SI.filter(function (x) { return x.party_id === p.id; });
    if (!pB.length && !pR.length && !pS.length && !Number(p.opening)) return;
    setCell(wsA, rowA, 1, p.name + (p.city ? '  \u2014  ' + p.city : ''), { title: true }); rowA++;
    ['Date', 'Particulars', 'Debit', 'Credit', 'Balance'].forEach(function (h, i) {
      setCell(wsA, rowA, i + 1, h, { header: true, color: MUTE, align: i >= 2 ? 'right' : 'left' });
    }); rowA++;
    var bal = (p.opening_side === 'dr' ? 1 : -1) * (Number(p.opening) || 0);
    if (Number(p.opening)) {
      setCell(wsA, rowA, 2, 'Balance brought forward', { color: MUTE, border: true });
      setCell(wsA, rowA, 5, Math.abs(bal).toLocaleString('en-PK') + (bal > 0 ? ' Dr' : ' Cr'), { bold: true, align: 'right', border: true });
      rowA++;
    }
    /* Party ke ledger mein teen qism ki entries aati hain \u2014 bill, sales
       return, aur service invoice. Sab ko tareekh ke hisaab se ek hi qatar
       mein lagate hain, taake statement app ke ledger se bilkul mile. */
    var ev = [];
    pB.forEach(function (v) {
      var g = Number(v.grand_total) || 0, pd = Number(v.paid) || 0;
      var lns = (linesByV[v.id] || []).length;
      ev.push({ d: v.vdate || '',
                t: (v.vtype === 'sale' ? 'Sale ' : 'Purchase ') + v.vno + ' \u2014 ' +
                   (partyName[v.party_id] || '') + ' (' + lns + ' item' + (lns !== 1 ? 's' : '') + ')',
                dr: v.vtype === 'sale' ? g : 0, cr: v.vtype === 'purchase' ? g : 0,
                delta: (v.vtype === 'sale' ? (g - pd) : -(g - pd)), col: null });
    });
    pR.forEach(function (rr) {
      var g = Number(rr.grand_total) || 0;
      ev.push({ d: rr.rdate || '', t: 'Sales Return ' + (rr.rno || ''),
                dr: 0, cr: g, delta: -g, col: null });
    });
    pS.forEach(function (si) {
      var g = Number(si.grand_total) || 0, pd = Number(si.paid) || 0;
      ev.push({ d: si.sidate || '',
                t: 'Service Invoice ' + (si.sino || '') +
                   (si.narration ? ' \u2014 ' + si.narration : ' \u2014 Processing charges'),
                dr: g, cr: 0, delta: g, col: SV_C });
      if (pd) ev.push({ d: si.sidate || '', t: 'Received with ' + (si.sino || ''),
                        dr: 0, cr: pd, delta: -pd, col: null });
    });
    ev.sort(function (a, b) { return (a.d || '') < (b.d || '') ? -1 : ((a.d || '') > (b.d || '') ? 1 : 0); });

    ev.forEach(function (e) {
      bal += e.delta;
      setCell(wsA, rowA, 1, e.d, { border: true });
      setCell(wsA, rowA, 2, e.t, { border: true, color: e.col || INK });
      setCell(wsA, rowA, 3, e.dr || '', { bold: !!e.dr, color: e.col || DR_C, align: 'right', border: true, numFmt: e.dr ? INT_FMT : undefined });
      setCell(wsA, rowA, 4, e.cr || '', { bold: !!e.cr, color: CR_C, align: 'right', border: true, numFmt: e.cr ? INT_FMT : undefined });
      setCell(wsA, rowA, 5, Math.abs(bal).toLocaleString('en-PK') + (bal > 0 ? ' Dr' : ' Cr'), { bold: true, color: bal > 0 ? DR_C : CR_C, align: 'right', border: true });
      rowA++;
    });
    setCell(wsA, rowA, 2, 'Closing balance', { bold: true, total: true });
    setCell(wsA, rowA, 5, Math.abs(bal).toLocaleString('en-PK') + (bal > 0 ? ' Dr' : ' Cr'), { bold: true, color: bal > 0 ? DR_C : CR_C, align: 'right', total: true });
    rowA += 2;
  });
  wsA.getColumn(1).width = 12; wsA.getColumn(2).width = 40; wsA.getColumn(3).width = 14;
  wsA.getColumn(4).width = 14; wsA.getColumn(5).width = 16;

  /* ─── SHEET 3: BILLS ─── */
  const wsB = wb.addWorksheet('Bills');
  var rowB = 1;
  V.forEach(function (v) {
    var p = partyName[v.party_id] || '', f = firmName[v.company_id] || '';
    var lines = (linesByV[v.id] || []).sort(function (a, b) { return (a.line_no || 0) - (b.line_no || 0); });
    var typ = v.vtype === 'sale' ? 'Sales Invoice' : 'Purchase Bill';
    setCell(wsB, rowB, 1, typ + ' \u00b7 ' + v.vno, { title: true });
    setCell(wsB, rowB, 5, v.vdate || '', { color: MUTE, align: 'right' });
    setCell(wsB, rowB, 6, f, { color: MUTE, align: 'right' }); rowB++;
    setCell(wsB, rowB, 1, (v.vtype === 'sale' ? 'Sold To: ' : 'Bought From: ') + p, { bold: true }); rowB++;
    ['#', 'Item', 'Unit', 'Qty', 'Rate', 'Amount'].forEach(function (h, i) {
      setCell(wsB, rowB, i + 1, h, { header: true, align: i >= 3 ? 'right' : 'left' });
    }); rowB++;
    lines.forEach(function (l, idx) {
      /* Cheez kisi aur unit mein bhi bik sakti hai. Bill par wohi qty aur
         unit chapte hain jo user ne likhe; item ka apna wazan saath mein
         chhote harfon jaisa alag column mein. */
      var alt   = !!l.sale_unit;
      var qty   = alt ? (Number(l.sale_qty) || 0) : (Number(l.qty) || 0);
      var unit  = alt ? l.sale_unit : (l.unit || '');
      var rate  = Number(l.rate) || 0;
      var amt   = Number(l.amount) || (qty * rate);
      setCell(wsB, rowB, 1, idx + 1, { color: MUTE, align: 'center', border: true });
      setCell(wsB, rowB, 2, (itemName[l.item_id] || '') +
        (alt ? '  (' + fmt2(l.unit_factor) + ' ' + (l.unit || '') + ' per ' + l.sale_unit +
               '  \u00b7  ' + fmt2(l.qty) + ' ' + (l.unit || '') + ')' : ''), { border: true });
      setCell(wsB, rowB, 3, unit, { align: 'center', border: true });
      setCell(wsB, rowB, 4, qty, { bold: true, align: 'right', border: true, numFmt: INT_FMT });
      setCell(wsB, rowB, 5, rate, { align: 'right', border: true, numFmt: NUM_FMT });
      setCell(wsB, rowB, 6, amt, { bold: true, align: 'right', border: true, numFmt: NUM_FMT });
      rowB++;
    });
    var sub = Number(v.sub_total) || 0, disc = Number(v.discount) || 0, tax = Number(v.tax_total) || 0, grand = Number(v.grand_total) || 0, paid = Number(v.paid) || 0;
    function tRow(lbl, val, col) {
      setCell(wsB, rowB, 5, lbl, { bold: true, color: MUTE, align: 'right' });
      setCell(wsB, rowB, 6, val, { bold: true, color: col || INK, align: 'right', numFmt: NUM_FMT });
      rowB++;
    }
    tRow('Items total', sub); if (disc) tRow('Discount', disc); if (tax) tRow('Tax', tax);
    setCell(wsB, rowB, 5, 'Total', { bold: true, total: true, align: 'right' });
    setCell(wsB, rowB, 6, grand, { bold: true, total: true, align: 'right', numFmt: NUM_FMT }); rowB++;
    if (paid) { tRow('Paid', paid, CR_C); tRow('Balance due', grand - paid, DR_C); }
    rowB += 2;
  });

  /* Service Invoice usi Bills sheet mein, apne alag block ke saath — kyunki
     us par item nahi, kaam hota hai. Sunehri rang se alag pehchana jata hai. */
  SI.forEach(function (si) {
    var lines = (linesBySI[si.id] || []).sort(function (a, b) { return (a.line_no || 0) - (b.line_no || 0); });
    setCell(wsB, rowB, 1, 'Service Invoice \u00b7 ' + (si.sino || ''), { title: true, color: SV_C });
    setCell(wsB, rowB, 5, si.sidate || '', { color: MUTE, align: 'right' });
    setCell(wsB, rowB, 6, firmName[si.company_id] || '', { color: MUTE, align: 'right' }); rowB++;
    setCell(wsB, rowB, 1, 'Billed To: ' + (partyName[si.party_id] || ''), { bold: true }); rowB++;
    ['#', 'Service', 'Basis', 'Qty', 'Rate', 'Amount'].forEach(function (h, i) {
      setCell(wsB, rowB, i + 1, h, { header: true, fg: SV_BG, color: SV_C, align: i >= 3 ? 'right' : 'left' });
    }); rowB++;
    lines.forEach(function (l, idx) {
      var qty = Number(l.qty) || 0, rate = Number(l.rate) || 0, amt = Number(l.amount) || (qty * rate);
      setCell(wsB, rowB, 1, idx + 1, { color: MUTE, align: 'center', border: true });
      setCell(wsB, rowB, 2, svcName[l.service_category_id] || l.description || '', { border: true });
      setCell(wsB, rowB, 3, METHOD[l.calc_method] || l.calc_method || '', { color: MUTE, align: 'center', border: true });
      setCell(wsB, rowB, 4, qty, { bold: true, align: 'right', border: true, numFmt: INT_FMT });
      setCell(wsB, rowB, 5, rate, { align: 'right', border: true, numFmt: NUM_FMT });
      setCell(wsB, rowB, 6, amt, { bold: true, align: 'right', border: true, numFmt: NUM_FMT });
      rowB++;
    });
    var sSub = Number(si.sub_total) || 0, sDisc = Number(si.discount) || 0,
        sTax = Number(si.tax_total) || 0, sGrand = Number(si.grand_total) || 0, sPaid = Number(si.paid) || 0;
    function sRow(lbl, val, col) {
      setCell(wsB, rowB, 5, lbl, { bold: true, color: MUTE, align: 'right' });
      setCell(wsB, rowB, 6, val, { bold: true, color: col || INK, align: 'right', numFmt: NUM_FMT });
      rowB++;
    }
    sRow('Services total', sSub); if (sDisc) sRow('Discount', sDisc); if (sTax) sRow('Tax', sTax);
    setCell(wsB, rowB, 5, 'Total', { bold: true, total: true, align: 'right' });
    setCell(wsB, rowB, 6, sGrand, { bold: true, total: true, align: 'right', numFmt: NUM_FMT }); rowB++;
    if (sPaid) { sRow('Paid', sPaid, CR_C); sRow('Balance due', sGrand - sPaid, DR_C); }
    rowB += 2;
  });

  wsB.getColumn(1).width = 4; wsB.getColumn(2).width = 28; wsB.getColumn(3).width = 12;
  wsB.getColumn(4).width = 10; wsB.getColumn(5).width = 14; wsB.getColumn(6).width = 16;

  /* ─── SHEETS 4-6: DATA (Parties / Items / Firms) — saaf, koi UUID nahi ─── */
  function addPlain(name, headers, rows) {
    const ws = wb.addWorksheet(name);
    ws.columns = headers.map(function (h) {
      return { header: h, key: h, width: h.length > 14 ? h.length + 3 : 16 };
    });
    var hr = ws.getRow(1);
    hr.font = { bold: true, size: 9, color: { argb: MUTE } };
    hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PANEL } };
    hr.alignment = { horizontal: 'center', vertical: 'center' };
    hr.border = thinBorder;
    rows.forEach(function (r) {
      var row = ws.addRow(r);
      row.eachCell(function (cell) {
        if (typeof cell.value === 'number') { cell.numFmt = NUM_FMT; cell.alignment = { horizontal: 'right' }; }
      });
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  addPlain('Parties', ['Name', 'Type', 'Phone', 'City', 'Opening Amount', 'Opening Side', 'Notes', 'Active'],
    P.map(function (p) { return { Name: p.name, Type: p.kind, Phone: p.phone, City: p.city, 'Opening Amount': Number(p.opening) || 0, 'Opening Side': (p.opening_side === 'dr' ? 'They owe us' : 'We owe them'), Notes: p.notes, Active: p.active === false ? 'No' : 'Yes' }; }));
  /* Opening ke saath ABHI ka stock bhi — kyunki asal sawaal yehi hota hai
     ke aaj kitna maal para hai. stock_qty aur avg_cost costing engine khud
     rakhta hai: har purchase, sale, return, conversion aur adjustment par. */
  addPlain('Items',
    ['Name', 'Unit', 'Stock', 'Avg Cost', 'Stock Value', 'Sale Rate', 'Purchase Rate',
     'Tax %', 'Opening Qty', 'Opening Rate', 'Low Stock Alert', 'HS Code', 'Notes', 'Active'],
    I.map(function (i) {
      var qty = Number(i.stock_qty) || 0, cost = Number(i.avg_cost) || 0;
      return { Name: i.name, Unit: i.unit,
               'Stock': qty, 'Avg Cost': cost, 'Stock Value': Math.round(qty * cost * 100) / 100,
               'Sale Rate': Number(i.sale_rate) || 0, 'Purchase Rate': Number(i.buy_rate) || 0,
               'Tax %': Number(i.tax_pct) || 0,
               'Opening Qty': Number(i.opening_qty) || 0, 'Opening Rate': Number(i.opening_rate) || 0,
               'Low Stock Alert': Number(i.reorder_level) || 0, 'HS Code': i.hs_code,
               Notes: i.notes, Active: i.active === false ? 'No' : 'Yes' };
    }));
  addPlain('Firms', ['Name', 'Address', 'City', 'Phone', 'NTN', 'STRN', 'Default', 'Active'],
    C.map(function (c) { return { Name: c.name, Address: c.address, City: c.city, Phone: c.phone, NTN: c.ntn, STRN: c.strn, Default: c.is_default ? 'Yes' : 'No', Active: c.active === false ? 'No' : 'Yes' }; }));

  /* ─── CUTTING KA DATA ─── */

  // Party ki coils — poora balance, wahi teen numbers jo app dikhati hai
  addPlain('Coils',
    ['Coil', 'Party', 'Warehouse', 'Material', 'Grade', 'Thickness mm', 'Width mm',
     'Received', 'Bina kata', 'Tayyar', 'Delivered', 'Wapas', 'Adjustment',
     'Hamare paas', 'Status', 'Received date', 'Party ref'],
    CO.filter(function (c) { return c.ownership === 'party'; }).map(function (c) {
      return { 'Coil': c.coil_serial, 'Party': partyName[c.party_id] || '',
               'Warehouse': whName[c.warehouse_id] || '', 'Material': c.material_type,
               'Grade': c.grade, 'Thickness mm': Number(c.thickness_mm) || 0,
               'Width mm': Number(c.width_mm) || 0,
               'Received': Number(c.received_weight) || 0,
               'Bina kata': Number(c.raw_balance) || 0,
               'Tayyar': Number(c.pending_delivery) || 0,
               'Delivered': Number(c.delivered_weight) || 0,
               'Wapas': Number(c.returned_weight) || 0,
               'Adjustment': Number(c.closing_adjust_weight) || 0,
               'Hamare paas': Number(c.physical_balance) || 0,
               'Status': c.status, 'Received date': c.received_date, 'Party ref': c.party_coil_ref };
    }));

  // Cutting jobs — input vs output, aur unka farq
  addPlain('Cutting Jobs',
    ['Job', 'Date', 'Party', 'Warehouse', 'Input KG', 'Output KG', 'Variance', 'Status', 'Remarks'],
    CJ.map(function (j) {
      var i = jobIn[j.id] || 0, o = jobOut[j.id] || 0;
      return { 'Job': j.jno, 'Date': j.jdate, 'Party': partyName[j.party_id] || '',
               'Warehouse': whName[j.warehouse_id] || '',
               'Input KG': i, 'Output KG': o, 'Variance': o - i,
               'Status': j.status, 'Remarks': j.remarks };
    }));

  // Delivery challans — expected vs weight slip ka actual
  addPlain('Challans',
    ['Challan', 'Date', 'Party', 'Vehicle', 'Driver', 'Weighbridge slip',
     'Expected KG', 'Delivered KG', 'Variance', 'Coils', 'Remarks'],
    DC.map(function (d) {
      var ls = chLines[d.id] || [];
      var e = ls.reduce(function (t, l) { return t + (Number(l.expected_weight) || 0); }, 0);
      var a = ls.reduce(function (t, l) { return t + (Number(l.delivered_weight) || 0); }, 0);
      return { 'Challan': d.dno, 'Date': d.ddate, 'Party': partyName[d.party_id] || '',
               'Vehicle': d.vehicle_no, 'Driver': d.driver_name,
               'Weighbridge slip': d.weighbridge_slip_no,
               'Expected KG': e, 'Delivered KG': a, 'Variance': a - e,
               'Coils': ls.map(function (l) { return coilSerial[l.coil_id] || ''; })
                          .filter(Boolean).join(', '),
               'Remarks': d.remarks };
    }));

  // Material inward aur raw wapsi
  addPlain('Material In-Out',
    ['Type', 'Doc', 'Date', 'Party', 'Warehouse', 'Vehicle', 'Weight KG', 'Coils', 'Remarks'],
    MI.map(function (m) {
      var cs = CO.filter(function (c) { return c.inward_id === m.id; });
      return { 'Type': 'Inward', 'Doc': m.ino, 'Date': m.idate,
               'Party': partyName[m.party_id] || '', 'Warehouse': whName[m.warehouse_id] || '',
               'Vehicle': m.vehicle_no,
               'Weight KG': cs.reduce(function (t, c) { return t + (Number(c.received_weight) || 0); }, 0),
               'Coils': cs.map(function (c) { return c.coil_serial; }).join(', '),
               'Remarks': m.remarks };
    }).concat(MR.map(function (r) {
      var ls = mrLines[r.id] || [];
      return { 'Type': 'Raw return', 'Doc': r.rno, 'Date': r.rdate,
               'Party': partyName[r.party_id] || '', 'Warehouse': whName[r.warehouse_id] || '',
               'Vehicle': r.vehicle_no,
               'Weight KG': ls.reduce(function (t, l) { return t + (Number(l.return_weight) || 0); }, 0),
               'Coils': ls.map(function (l) { return coilSerial[l.coil_id] || ''; }).filter(Boolean).join(', '),
               'Remarks': r.remarks };
    })).sort(function (a, b) { return (a.Date || '') < (b.Date || '') ? -1 : 1; }));

  return wb.xlsx.writeBuffer();
}

/* ============================================================
   RESTORE KE LIYE
   Excel insaan ke padhne ke liye hai — us mein na ID hoti hai, na
   rishtay. Us se system wapas nahi aa sakta. Is liye saath mein yeh
   JSON bhi jati hai: har table poori, apni ID aur rishton ke saath,
   bilkul waisi jaisi database mein hai.
   ============================================================ */
function buildRestoreJson(data) {
  return Buffer.from(JSON.stringify({
    format: 'qtc-restore',
    version: 1,
    taken_at: new Date().toISOString(),
    taken_at_karachi: takenAtText(),
    data_date: dataDate(),
    // Tarteeb ahem hai — restore isi tarteeb se daalta hai, taake
    // jis cheez par koi doosri cheez khadi hai wo pehle mojood ho.
    order: RESTORE_ORDER,
    tables: data
  }), 'utf8');
}

/* Pehle wo tables jin par baqi khadi hain, phir un par khadi hui cheezein */
const RESTORE_ORDER = [
  'app_settings', 'cutting_settings', 'period_lock',
  'warehouses', 'companies', 'parties', 'party_kinds', 'items', 'item_units',
  'machines', 'operators', 'service_categories',
  'vouchers', 'voucher_lines',
  'sales_returns', 'sales_return_lines',
  'quotations', 'quotation_lines',
  'purchase_orders', 'po_lines',
  'stock_transfers', 'stock_transfer_lines', 'stock_adjustments',
  'sheets',
  'material_inwards', 'coils',
  'cutting_jobs', 'cutting_job_inputs', 'cutting_job_outputs',
  'delivery_challans', 'delivery_challan_lines',
  'material_returns', 'material_return_lines',
  'service_invoices', 'service_invoice_lines',
  'service_invoice_jobs', 'service_invoice_challans',
  'stock_conversions', 'stock_conversion_inputs', 'stock_conversion_outputs'
];

async function sendEmail(buffer, filename, jsonBuffer, jsonName) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.BACKUP_TO_EMAIL,
    subject: 'QTC Daily Backup \u2014 ' + dataDate(),
    text: 'Backup liya gaya: ' + takenAtText() + '\n' +
          'Data is tareekh tak ka: ' + dataDate() + '\n\n' +
          'Poora QTC data attached hai \u2014 accounting aur cutting dono.\n\n' +
          'Do file hain:\n' +
          '\u2022 ' + filename + ' \u2014 padhne ke liye (Excel)\n' +
          '\u2022 ' + jsonName + ' \u2014 system wapas laane ke liye. Isay kholne ki zaroorat nahi, ' +
          'bas mehfooz rakhein. Zaroorat pade to Masters \u2192 Restore se yehi file daali jati hai.\n\n' +
          'Ye backup roz khud-b-khud banti hai.',
    attachments: [
      { filename: filename, content: buffer },
      { filename: jsonName, content: jsonBuffer }
    ]
  });
}

async function main() {
  console.log('QTC backup starting\u2026');
  await signIn();
  const data = await fetchAll();
  const buffer = await buildExcel(data);
  const stamp = dataDate();                    // jis din ka data hai
  const filename = 'QTC-Backup-' + stamp + '.xlsx';
  const jsonName = 'QTC-Restore-' + stamp + '.json';
  const jsonBuffer = buildRestoreJson(data);
  await sendEmail(buffer, filename, jsonBuffer, jsonName);
  console.log('Liya gaya: ' + takenAtText() + ' | data ' + stamp);
  console.log('Backup emailed: ' + filename + ' + ' + jsonName +
              ' (' + Math.round(jsonBuffer.length / 1024) + ' KB)');
}

main().catch(function (e) {
  console.error('Backup failed:', e.message);
  process.exit(1);
});
