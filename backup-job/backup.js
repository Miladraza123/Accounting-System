// OHT Daily Backup — Supabase se data nikal kar Excel banata hai aur email
// attachment ke tor par bhej deta hai. GitHub Actions ke scheduled workflow
// se roz khud-b-khud chalta hai.
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

async function signIn() {
  var res = await sb.auth.signInWithPassword({
    email: process.env.BACKUP_EMAIL,
    password: process.env.BACKUP_PASSWORD
  });
  if (res.error) throw new Error('Sign-in failed: ' + res.error.message);
}

async function fetchAll() {
  const tables = ['parties', 'items', 'companies', 'vouchers', 'voucher_lines', 'sheets', 'sales_returns'];
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
const thinBorder = { top: { style: 'thin', color: { argb: HAIR } }, bottom: { style: 'thin', color: { argb: HAIR } },
                      left: { style: 'thin', color: { argb: HAIR } }, right: { style: 'thin', color: { argb: HAIR } } };
const mediumTB = { top: { style: 'medium', color: { argb: INK } }, bottom: { style: 'medium', color: { argb: INK } } };

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
  wb.creator = 'OHT Automated Backup';
  wb.created = new Date();

  var notDeleted = function (r) { return !r.deleted_at; };
  const P = (data.parties || []).filter(notDeleted);
  const I = (data.items || []).filter(notDeleted);
  const C = (data.companies || []).filter(notDeleted);
  const V = (data.vouchers || []).filter(notDeleted).sort(function (a, b) { return (a.vdate || '') < (b.vdate || '') ? -1 : 1; });
  const L = (data.voucher_lines || []);
  const S = (data.sheets || []).filter(notDeleted).sort(function (a, b) { return (a.sheet_date || '') < (b.sheet_date || '') ? -1 : 1; });
  const R = (data.sales_returns || []).filter(notDeleted);

  const partyName = {}; P.forEach(function (p) { partyName[p.id] = p.name; });
  const itemName = {}; I.forEach(function (i) { itemName[i.id] = i.name; });
  const firmName = {}; C.forEach(function (c) { firmName[c.id] = c.name; });
  const linesByV = {}; L.forEach(function (l) { (linesByV[l.voucher_id] = linesByV[l.voucher_id] || []).push(l); });

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
    var pR = R.filter(function (rr) { return rr.party_id === p.id; });
    if (!pB.length && !pR.length && !Number(p.opening)) return;
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
    // Bills aur Returns dono ko ek hi timeline mein, tareekh ke hisaab se jama karte hain
    var timeline = pB.map(function (v) { return { kind: 'voucher', date: v.vdate, rec: v }; })
      .concat(pR.map(function (rr) { return { kind: 'return', date: rr.rdate, rec: rr }; }));
    timeline.sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; });
    timeline.forEach(function (item) {
      if (item.kind === 'voucher') {
        var v = item.rec;
        var g = Number(v.grand_total) || 0, pd = Number(v.paid) || 0;
        var dr = v.vtype === 'sale' ? g : 0, cr = v.vtype === 'purchase' ? g : 0;
        bal += (v.vtype === 'sale' ? (g - pd) : -(g - pd));
        var lns = (linesByV[v.id] || []).length;
        setCell(wsA, rowA, 1, v.vdate || '', { border: true });
        setCell(wsA, rowA, 2, (v.vtype === 'sale' ? 'Sale ' : 'Purchase ') + v.vno + ' \u2014 ' + (partyName[v.party_id] || '') + ' (' + lns + ' item' + (lns !== 1 ? 's' : '') + ')', { border: true });
        setCell(wsA, rowA, 3, dr || '', { bold: !!dr, color: DR_C, align: 'right', border: true, numFmt: dr ? INT_FMT : undefined });
        setCell(wsA, rowA, 4, cr || '', { bold: !!cr, color: CR_C, align: 'right', border: true, numFmt: cr ? INT_FMT : undefined });
      } else {
        // Sales Return: customer jitna wapas kare utna kam owe karta hai
        var rr = item.rec, ramt = Number(rr.grand_total) || 0;
        bal -= ramt;
        setCell(wsA, rowA, 1, rr.rdate || '', { border: true });
        setCell(wsA, rowA, 2, 'Sales Return ' + (rr.rno || '') + ' \u2014 ' + (partyName[rr.party_id] || ''), { border: true });
        setCell(wsA, rowA, 3, '', { border: true });
        setCell(wsA, rowA, 4, ramt, { bold: true, color: CR_C, align: 'right', border: true, numFmt: INT_FMT });
      }
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
      var qty = Number(l.qty) || 0, rate = Number(l.rate) || 0, amt = Number(l.amount) || (qty * rate);
      setCell(wsB, rowB, 1, idx + 1, { color: MUTE, align: 'center', border: true });
      setCell(wsB, rowB, 2, itemName[l.item_id] || '', { border: true });
      setCell(wsB, rowB, 3, l.unit || '', { align: 'center', border: true });
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
  wsB.getColumn(1).width = 4; wsB.getColumn(2).width = 28; wsB.getColumn(3).width = 8;
  wsB.getColumn(4).width = 10; wsB.getColumn(5).width = 14; wsB.getColumn(6).width = 16;

  /* ─── SHEETS 4-6: DATA (Parties / Items / Firms) — saaf, koi UUID nahi ─── */
  function addPlain(name, headers, rows) {
    const ws = wb.addWorksheet(name);
    ws.columns = headers.map(function (h) { return { header: h, key: h, width: 16 }; });
    ws.getRow(1).font = { bold: true };
    rows.forEach(function (r) { ws.addRow(r); });
  }
  addPlain('Parties', ['Name', 'Type', 'Phone', 'City', 'Opening Amount', 'Opening Side', 'Notes', 'Active'],
    P.map(function (p) { return { Name: p.name, Type: p.kind, Phone: p.phone, City: p.city, 'Opening Amount': Number(p.opening) || 0, 'Opening Side': (p.opening_side === 'dr' ? 'They owe us' : 'We owe them'), Notes: p.notes, Active: p.active === false ? 'No' : 'Yes' }; }));
  /* Opening ke saath ABHI ka stock bhi — asal sawaal yehi hota hai ke aaj
     kitna maal para hai. stock_qty aur avg_cost costing engine khud rakhta
     hai: har purchase, sale, return aur adjustment par. */
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

  return wb.xlsx.writeBuffer();
}

async function sendEmail(buffer, filename) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.BACKUP_TO_EMAIL,
    subject: 'OHT Daily Backup — ' + dataDate(),
    text: 'Backup liya gaya: ' + takenAtText() + '\n' +
          'Data is tareekh tak ka: ' + dataDate() + '\n\n' +
          'Poora OHT accounting data attached hai (Excel file, saaf/formatted).\n' +
          'Ye backup roz khud-b-khud banti hai.',
    attachments: [{ filename: filename, content: buffer }]
  });
}

async function main() {
  console.log('OHT backup starting…');
  await signIn();
  const data = await fetchAll();
  const buffer = await buildExcel(data);
  const stamp = dataDate();                    // jis din ka data hai
  const filename = 'OHT-Backup-' + stamp + '.xlsx';
  await sendEmail(buffer, filename);
  console.log('Backup emailed: ' + filename);
}

main().catch(function (e) {
  console.error('Backup failed:', e.message);
  process.exit(1);
});
