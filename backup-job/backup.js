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

const fs = require('fs');
const zlib = require('zlib');
const nodeCrypto = require('crypto');
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

/* ============================================================
   HAR ROW — SIRF PEHLI 1000 NAHI

   Supabase ek request mein zyada se zyada 1000 rows deta hai. Pehle
   yahan sirf ek select chalti thi, to jis din kisi table mein 1000 se
   zyada rows ho jatin, backup khamoshi se kat jata — file poori lagti,
   email bhi aa jati, magar us mein aadha data hota. Ab har table
   qist-qist kar ke poori laate hain.

   Tarteeb 'id' par lagti hai: bina tarteeb ke database do alag
   qiston mein wohi row do dafa bhi de sakta hai aur koi row chhorh
   bhi sakta hai.
   ============================================================ */
const PAGE_ROWS = 1000;

/* Do bilkul alag kharabiyan, jinhein mila dena mehnga parta hai:

     TABLE HI NAHI  — is database mein ye table banayi hi nahi gayi.
                      Backup ko is par rukna nahi chahiye: baqi sab
                      utaar lo aur is ka naam bata do.
     COLUMN NAHI    — table hai, magar jis column par tarteeb lagayi
                      wo nahi. Bina tarteeb ke dobara koshish karte hain.

   Pehle table wali surat dekhte hain, warna "does not exist" dono par
   chaspan ho jata hai. */
function isMissingTable(msg) {
  return /could not find the table|relation .* does not exist|PGRST205|42P01/i.test(msg);
}
function isMissingColumn(msg) {
  return /column .* does not exist|failed to parse order|42703/i.test(msg);
}

/* Zyada tar tables ki chabi 'id' hai, magar kuch ki nahi — un ki chabi
   wo cheez hai jis se wo bandhi hui hain. Restore ko yeh maloom hona
   chahiye, warna wo ghalat column par kaam karta hai. */
const KEY_COL = {
  party_opening_balances: 'party_id',
  item_cost_snapshot: 'item_id'
};
function keyCol(t) { return KEY_COL[t] || 'id'; }

async function fetchPaged(t, orderBy) {
  const rows = [];
  /* Rukte tab hain jab ek qist bilkul khali aaye — "poori qist se kam
     aayi to bas" par nahin. Wajah: project ki apni had 1000 se kam bhi
     ho sakti hai (Supabase settings mein badalti hai), aur us surat
     mein pehli hi qist chhoti aati aur hum baqi data chhorh dete. */
  for (let from = 0; ;) {
    let q = sb.from(t).select('*');
    if (orderBy) q = q.order(orderBy, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE_ROWS - 1);
    if (error) throw new Error(t + ': ' + error.message);
    const part = data || [];
    rows.push(...part);
    if (!part.length) return rows;
    from += part.length;
  }
}

async function fetchTable(t) {
  try {
    return await fetchPaged(t, keyCol(t));
  } catch (e) {
    /* Chabi wala column na mile to bina tarteeb ke dobara. Aisi tables
       choti hoti hain, ek hi qist mein aa jati hain, is liye qisten
       guthne ka sawaal nahi. Baqi har ghalti upar jati hai — backup
       chup-chaap adhoora nahi hona chahiye. */
    if (!isMissingColumn(e.message)) throw e;
    return await fetchPaged(t, null);
  }
}

/* Restore ke liye HAR table chahiye — warna file se system wapas nahi
   aata. Magar "har table" ka matlab ye nahi ke ek table ki khatir poora
   backup mar jaye. Pehle yehi hota tha: RESTORE_ORDER mein ek aisi
   table ka naam tha jo is database mein hai hi nahi, aur us par poora
   backup ruk jata — na Excel, na restore file, kuch bhi nahi.

   Ab teen alag anjaam hain:
     rows    — table mil gayi, poori utar aayi
     absent  — table is database mein hai hi nahi. Skip, magar naam
               email mein likha jata hai taake nazar mein rahe.
     failed  — table hai magar parhi nahi gayi (jaise ijazat na ho).
               Ye asal kharabi hai: backup phir bhi jata hai, magar
               "ADHOORA" likh kar, aur run bhi nakaam ginta hai. */
async function fetchAll() {
  const tables = {}, absent = {}, failed = {};
  for (const t of RESTORE_ORDER) {
    try {
      tables[t] = await fetchTable(t);
    } catch (e) {
      tables[t] = [];
      if (isMissingTable(e.message)) absent[t] = e.message;
      else failed[t] = e.message;
    }
  }
  return { tables, absent, failed };
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

  /* Service invoices \u2014 party ke ledger mein normal receivable ki tarah
     aate hain, is liye statement mein bhi saath chalte hain. */
  const SI = (data.service_invoices || []).filter(notDeleted)
    .filter(function (x) { return x.status !== 'cancelled'; });

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
    // Bills aur Returns dono ko ek hi timeline mein, tareekh ke hisaab se jama karte hain
    var timeline = pB.map(function (v) { return { kind: 'voucher', date: v.vdate, rec: v }; })
      .concat(pR.map(function (rr) { return { kind: 'return', date: rr.rdate, rec: rr }; }))
      .concat(pS.map(function (iv) { return { kind: 'service', date: iv.sidate, rec: iv }; }));
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
      } else if (item.kind === 'service') {
        /* Service Invoice: maal ka bill nahi, magar paisa usi tarah aana
           hai \u2014 is liye ledger mein normal receivable ki tarah chalta hai. */
        var iv = item.rec;
        var sg = Number(iv.grand_total) || 0, sp = Number(iv.paid) || 0;
        bal += sg - sp;
        setCell(wsA, rowA, 1, iv.sidate || '', { border: true });
        setCell(wsA, rowA, 2, 'Service Invoice ' + (iv.sino || '') +
          (iv.billing_label ? ' \u2014 ' + iv.billing_label : ''), { border: true });
        setCell(wsA, rowA, 3, sg, { bold: true, color: DR_C, align: 'right', border: true, numFmt: INT_FMT });
        setCell(wsA, rowA, 4, sp || '', { bold: !!sp, color: CR_C, align: 'right', border: true, numFmt: sp ? INT_FMT : undefined });
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

/* ============================================================
   RESTORE KE LIYE
   Excel insaan ke padhne ke liye hai — us mein na ID hoti hai, na
   rishtay. Us se system wapas nahi aa sakta. Is liye saath mein yeh
   JSON bhi jati hai: har table poori, apni ID aur rishton ke saath,
   bilkul waisi jaisi database mein hai.
   ============================================================ */
function buildRestoreJson(res) {
  const payload = {
    format: 'oht-restore',
    version: 1,
    taken_at: new Date().toISOString(),
    taken_at_karachi: takenAtText(),
    data_date: dataDate(),
    // Tarteeb ahem hai — restore isi tarteeb se daalta hai, taake
    // jis cheez par koi doosri cheez khadi hai wo pehle mojood ho.
    order: RESTORE_ORDER,
    tables: res.tables
  };
  // Jo table thi hi nahi wo kharabi nahi — magar file mein likh dete
  // hain, taake baad mein koi ye na samjhe ke wo khali thi.
  if (Object.keys(res.absent).length) payload.absent = res.absent;
  if (Object.keys(res.failed).length) { payload.partial = true; payload.errors = res.failed; }
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

/* Pehle wo tables jin par baqi khadi hain, phir un par khadi hui
   cheezein. Jo table is list mein nahi, wo backup mein bhi nahi — is
   liye naya table banayen to us ka naam YAHAN aur masters.html ke
   RESTORE_ORDER mein daalna zaroori hai. Dono jagah ek jaisi rehni
   chahiye.

   app_users, item_units, audit_log, party_opening_balances,
   aur item_cost_snapshot pehle is list mein thin hi nahi —
   yani database mein maujood hone ke bawajood kabhi backup nahi hotin
   thin. app_users mein to logon ke permissions rehte hain. Ab shamil
   hain.

   app_users sab se upar hai kyunki taqreeban har table us se bandhi
   hui hai (created_by / updated_by). audit_log sab se neeche, kyunki
   wo app_users par khadi hai. */
/* steel_sizes yahan JAAN BOOJH KAR nahi hai. Wo table maujood to hai
   magar khali hai, poori app mein kahin istemal nahi hoti, aur us par
   SELECT ki ijazat hi nahi di gayi ("permission denied") — yani app
   bhi usay parh nahi sakti. Us ki khatir har raat backup ko "adhoora"
   kehna sirf ye sikhata hai ke warning ko nazarandaz kar do.

   Agar kabhi wo table istemal hone lage to DO kaam karne honge: us par
   SELECT ki ijazat dein, AUR us ka naam yahan aur masters.html dono
   mein wapas daalein. */
const RESTORE_ORDER = [
  'app_settings',
  'app_users',
  'period_lock',
  'warehouses', 'companies', 'parties', 'party_kinds', 'items',
  'item_units', 'item_cost_snapshot',
  'party_opening_balances',
  'services',
  'vouchers', 'voucher_lines',
  'sales_returns', 'sales_return_lines',
  'service_invoices', 'service_invoice_lines',
  'recurring_service_templates',
  'quotations', 'quotation_lines',
  'purchase_orders', 'po_lines',
  'stock_transfers', 'stock_transfer_lines', 'stock_adjustments',
  'sheets',
  'audit_log'
];

/* Har table se kitni rows aayin — email aur log dono mein. Agar kabhi
   koi table ghalti se khali ya adhoori aaye to wo saamne dikhe, chhupe
   nahi. */
function countsText(data) {
  return RESTORE_ORDER
    .filter(function (t) { return (data[t] || []).length; })
    .map(function (t) { return t + ': ' + data[t].length; })
    .join('\n');
}

/* Jo table skip hui ya toot gayi — email mein saaf likhi jati hai.
   Backup ka sab se bura anjaam ye hai ke wo adhoora ho aur dekhne
   wale ko lage ke poora hai. */
function skippedText(res) {
  var out = '';
  var absent = Object.keys(res.absent);
  if (absent.length) {
    out += 'Ye tables is database mein maujood nahi thin, is liye chhorh di gayin:\n' +
           absent.map(function (t) { return '  \u2022 ' + t; }).join('\n') + '\n' +
           '(Agar inhein hona chahiye tha to yeh dekhne wali baat hai.)\n\n';
  }
  var failed = Object.keys(res.failed);
  if (failed.length) {
    out += 'YE TABLES PARHI NAHI JA SAKIN \u2014 BACKUP ADHOORA HAI:\n' +
           failed.map(function (t) { return '  \u2022 ' + t + ': ' + res.failed[t]; }).join('\n') +
           '\n\n';
  }
  return out;
}

/* ============================================================
   RESTORE FILE KO DABANA AUR (CHAHEIN TO) BAND KARNA

   Do khatray thay:

   1) Email ki apni had hai — Gmail par 25 MB. Data barhta gaya to ek
      din backup email bhejna hi nakaam ho jati aur kisi ko pata bhi
      na chalta. Is liye restore file ko ab gzip se daba dete hain;
      is tarah ke data par ye das-pandra guna chhoti ho jati hai.

   2) Backup mein poora karobar hota hai aur wo mailbox mein khula
      para rehta hai. Agar BACKUP_PASSPHRASE set ho to file band bhi
      kar dete hain — khulti sirf usi password se hai.

   KHABARDAR: password kho gaya to file kabhi nahi khulegi. Is liye ye
   apne aap chalu nahi hota — sirf tab jab aap khud passphrase rakhein.
   Masters ka Restore teenon shaklein (saada, dabai hui, band) khud
   pehchan kar khol leta hai.
   ============================================================ */
const PBKDF2_ITERS = 200000;

function encryptBuffer(buf, pass) {
  const salt = nodeCrypto.randomBytes(16), iv = nodeCrypto.randomBytes(12);
  const key = nodeCrypto.pbkdf2Sync(pass, salt, PBKDF2_ITERS, 32, 'sha256');
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  // AES-GCM: browser ka crypto.subtle tag ko ciphertext ke aakhir mein chahta hai
  const body = Buffer.concat([c.update(buf), c.final(), c.getAuthTag()]);
  return Buffer.from(JSON.stringify({
    format: 'oht-restore-encrypted', version: 1,
    kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERS,
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    data: body.toString('base64')
  }), 'utf8');
}

function packRestore(jsonBuffer, stamp) {
  const gz = zlib.gzipSync(jsonBuffer, { level: 9 });
  const pass = process.env.BACKUP_PASSPHRASE;
  if (!pass) return { buffer: gz, name: 'OHT-Restore-' + stamp + '.json.gz', locked: false };
  return { buffer: encryptBuffer(gz, pass),
           name: 'OHT-Restore-' + stamp + '.json.enc', locked: true };
}

/* ============================================================
   DATABASE KI BANAWAT (SCHEMA)

   Restore file mein DATA hota hai — har table, poori. Us se system
   wapas aa jata hai. Magar bilkul khali project par pehle BANAWAT
   chahiye: tables, RLS policies, aur wo SQL functions jin par app
   khadi hai (trial_balance, receivable_aging, recompute_all_item_costs
   waghera). Wo data ke backup mein nahi aatin.

   Agar workflow ne pg_dump chala kar file bana di ho to wo bhi saath
   bhej dete hain. Na bani ho to kuch nahi badalta — data ka backup
   pehle ki tarah jata rehta hai. Ye file dabai to jati hai magar
   password se band nahi ki jati: is mein karobar ka data nahi hota,
   aur zaroorat ke waqt ye har jagah khul jani chahiye.
   ============================================================ */
function schemaAttachment(stamp) {
  const p = process.env.BACKUP_SCHEMA_FILE;
  if (!p) return null;
  let buf;
  try { buf = fs.readFileSync(p); } catch (e) { return null; }
  if (!buf.length) return null;
  return { filename: 'OHT-Schema-' + stamp + '.sql.gz',
           content: zlib.gzipSync(buf, { level: 9 }) };
}

/* Gmail 25 MB par rok deta hai. Agar dono file mil kar us se barh
   jayen to Excel chhorh dete hain — wo sirf parhne ke liye hai aur
   app se dobara ban sakti hai. Restore wali file har haal mein jani
   chahiye, kyunki system sirf usi se wapas aata hai. */
const MAIL_LIMIT = 24 * 1024 * 1024;

async function sendEmail(buffer, filename, jsonBuffer, jsonName, res, note, schema) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  const attachments = [{ filename: jsonName, content: jsonBuffer }];
  let used = jsonBuffer.length;
  if (schema && used + schema.content.length <= MAIL_LIMIT) {
    attachments.push(schema);
    used += schema.content.length;
  }
  if (used + buffer.length <= MAIL_LIMIT) {
    attachments.unshift({ filename: filename, content: buffer });
  } else {
    note = (note ? note + '\n' : '') +
      'NOTE: email ki had ke sabab Excel is dafa nahi bheji ja saki. ' +
      'Restore wali file saath hai — system usi se wapas aata hai, ' +
      'aur Excel Masters \u2192 Backup se kisi bhi waqt bani ja sakti hai.';
  }

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.BACKUP_TO_EMAIL,
    // Adhoora backup subject se hi pata chal jana chahiye, andar khol
    // kar nahi. Warna wo poore backup jaisa lagta hai.
    subject: (Object.keys(res.failed).length ? '\u26A0 ADHOORA \u2014 ' : '') +
             'OHT Daily Backup \u2014 ' + dataDate(),
    text: 'Backup liya gaya: ' + takenAtText() + '\n' +
          'Data is tareekh tak ka: ' + dataDate() + '\n\n' +
          'Do file hain:\n' +
          '\u2022 ' + filename + ' \u2014 padhne ke liye (Excel)\n' +
          '\u2022 ' + jsonName + ' \u2014 system wapas laane ke liye. Isay kholne ki zaroorat nahi, ' +
          'bas mehfooz rakhein. Zaroorat pade to Masters \u2192 Restore se yehi file daali jati hai.\n' +
          (schema ? '\u2022 ' + schema.filename + ' \u2014 database ki banawat (tables, RLS, ' +
                    'SQL functions). Bilkul khali project par pehle yehi chalti hai, phir restore.\n' : '') +
          '\n' +
          'Ye backup roz khud-b-khud banti hai.\n\n' +
          (note ? note + '\n\n' : '') +
          skippedText(res) +
          'Is file mein kitni rows hain:\n' + countsText(res.tables),
    attachments: attachments
  });
}

async function main() {
  console.log('OHT backup starting…');
  await signIn();
  const res = await fetchAll();
  const buffer = await buildExcel(res.tables);
  const stamp = dataDate();                    // jis din ka data hai
  const filename = 'OHT-Backup-' + stamp + '.xlsx';
  const plain = buildRestoreJson(res);
  const packed = packRestore(plain, stamp);
  const note = packed.locked
    ? 'Ye restore file password se BAND hai. Khulne ke liye wohi password chahiye ' +
      'jo BACKUP_PASSPHRASE mein rakha gaya \u2014 wo kho gaya to file kabhi nahi khulegi.'
    : '';
  const schema = schemaAttachment(stamp);
  await sendEmail(buffer, filename, packed.buffer, packed.name, res, note, schema);
  console.log('Liya gaya: ' + takenAtText() + ' | data ' + stamp);
  console.log('Rows: ' + countsText(res.tables).replace(/\n/g, ', '));
  var absent = Object.keys(res.absent), failed = Object.keys(res.failed);
  if (absent.length) console.log('Maujood nahi (chhorh di gayin): ' + absent.join(', '));
  console.log('Restore file: ' + packed.name + ' \u2014 ' +
              Math.round(plain.length / 1024) + ' KB \u2192 ' +
              Math.round(packed.buffer.length / 1024) + ' KB' +
              (packed.locked ? ' (password se band)' : ''));
  if (packed.buffer.length > MAIL_LIMIT) {
    console.warn('WARNING: restore file email ki had (24 MB) se barh chuki hai. ' +
                 'Email nakaam ho sakti hai \u2014 Masters \u2192 Backup se file khud utaar ' +
                 'lein, aur backup kisi aur jagah bhejne ka bandobast karein.');
  }
  console.log('Schema: ' + (schema ? schema.filename : 'nahi (SUPABASE_DB_URL set nahi)'));
  console.log('Backup emailed: ' + filename + ' + ' + packed.name);

  /* Email pehle bhej di — jo mil saka wo haath mein hona chahiye. Magar
     agar koi table toot gayi to run ko kamyab nahi kehte: GitHub is par
     nakami ki ittila bhejta hai, aur wohi chahiye. */
  if (failed.length) {
    console.error('ADHOORA BACKUP: ' + failed.map(function (t) {
      return t + ' (' + res.failed[t] + ')';
    }).join('; '));
    process.exitCode = 1;
  }
}

main().catch(function (e) {
  console.error('Backup failed:', e.message);
  process.exit(1);
});
