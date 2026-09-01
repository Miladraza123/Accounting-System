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

async function signIn() {
  // Core tables (parties/items/vouchers waghera) ki RLS policy sirf
  // "authenticated" (logged-in) session ko data dekhne deti hai — is liye
  // backup script ko bhi pehle sign-in karna zaroori hai, warna sirf
  // headings milti hain, data nahi.
  var res = await sb.auth.signInWithPassword({
    email: process.env.BACKUP_EMAIL,
    password: process.env.BACKUP_PASSWORD
  });
  if (res.error) throw new Error('Sign-in failed: ' + res.error.message);
}

async function fetchAll() {
  const tables = ['parties', 'items', 'companies', 'vouchers', 'voucher_lines', 'sheets'];
  const out = {};
  for (const t of tables) {
    const { data, error } = await sb.from(t).select('*');
    if (error) throw new Error(t + ': ' + error.message);
    // Poora (deleted samet) data yahan rakhte hain — taake agar koi purana/
    // deleted bill kisi active voucher_line se juda ho to uska naam bhi
    // sahi dikhe. "Active only" list sirf sheet mein dikhane ke waqt banti hai.
    out[t] = data || [];
  }
  return out;
}

async function buildExcel(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OHT Automated Backup';
  wb.created = new Date();

  var notDeleted = function (r) { return !r.deleted_at; };

  // ── ID → naam lookup tables — POORE (deleted samet) data se banate hain,
  // taake koi bhi purana/deleted record bhi apne naam se hi resolve ho ──
  const partyName = {};
  (data.parties || []).forEach(function (p) { partyName[p.id] = p.name; });
  const companyName = {};
  (data.companies || []).forEach(function (c) { companyName[c.id] = c.name; });
  const itemName = {};
  (data.items || []).forEach(function (i) { itemName[i.id] = i.name; });
  const voucherNo = {};
  (data.vouchers || []).forEach(function (v) { voucherNo[v.id] = v.vno; });

  // Sheets mein dikhane ke liye sirf ACTIVE (non-deleted) rows
  const activeVouchers = (data.vouchers || []).filter(notDeleted);
  const activeVoucherLines = (data.voucher_lines || []).filter(notDeleted);

  const readableVouchers = activeVouchers.map(function (v) {
    return {
      vno:v.vno, vtype:v.vtype, vdate:v.vdate,
      party:partyName[v.party_id] || v.party_id || '',
      company:companyName[v.company_id] || v.company_id || '',
      paid:v.paid, notes:v.notes, grand_total:v.grand_total, id:v.id
    };
  });
  const readableVoucherLines = activeVoucherLines.map(function (l) {
    return {
      voucher_no:voucherNo[l.voucher_id] || l.voucher_id || '',
      item:itemName[l.item_id] || l.item_id || '',
      qty:l.qty, rate:l.rate, tax_pct:l.tax_pct, amount:l.amount, id:l.id
    };
  });

  const sheetDefs = [
    { name: 'Parties',   rows: (data.parties || []).filter(notDeleted),
      cols: ['id','name','kind','phone','city','address','ntn','opening','opening_side','active'] },
    { name: 'Items',     rows: (data.items || []).filter(notDeleted),
      cols: ['id','name','unit','buy_rate','sale_rate','opening_qty','opening_rate','hs_code','reorder_level'] },
    { name: 'Companies', rows: (data.companies || []).filter(notDeleted),
      cols: ['id','name','is_default','active'] },
    { name: 'Vouchers',  rows: readableVouchers,
      cols: ['vno','vtype','vdate','party','company','paid','notes','grand_total','id'] },
    { name: 'Voucher Lines', rows: readableVoucherLines,
      cols: ['voucher_no','item','qty','rate','tax_pct','amount','id'] },
    { name: 'Sheets',    rows: (data.sheets || []).filter(notDeleted),
      cols: ['sheet_date','opening','side','page'] }   // 'rows' (JSON) column jaan-boojh kar chhoda hai
  ];

  sheetDefs.forEach(function (def) {
    const ws = wb.addWorksheet(def.name);
    ws.columns = def.cols.map(function (c) { return { header: c, key: c, width: 16 }; });
    ws.getRow(1).font = { bold: true };
    (def.rows || []).forEach(function (r) { ws.addRow(r); });
  });

  // ── Daily Ledger ki har entry (Dr/Cr line) readable form mein ──
  // sheets.rows JSON array hai: [dr_amt, dr_narration, cr_amt, cr_narration,
  // cash_flag_dr, cash_flag_cr, credit_party_id, debit_party_id]
  const led = wb.addWorksheet('Ledger Entries');
  led.columns = [
    { header: 'sheet_date', key: 'd', width: 14 },
    { header: 'dr_amount', key: 'dra', width: 14 },
    { header: 'dr_narration', key: 'drn', width: 28 },
    { header: 'dr_party', key: 'drp', width: 22 },
    { header: 'cr_amount', key: 'cra', width: 14 },
    { header: 'cr_narration', key: 'crn', width: 28 },
    { header: 'cr_party', key: 'crp', width: 22 }
  ];
  led.getRow(1).font = { bold: true };
  (data.sheets || []).filter(notDeleted).forEach(function (s) {
    (s.rows || []).forEach(function (r) {
      var drAmt = r[0], drNar = r[1], crAmt = r[2], crNar = r[3];
      var crParty = r[6], drParty = r[7];
      var blank = !drAmt && !drNar && !crAmt && !crNar;
      if (blank) return;   // khali lines chhor do
      led.addRow({
        d: s.sheet_date, dra: drAmt || '', drn: drNar || '', drp: partyName[drParty] || '',
        cra: crAmt || '', crn: crNar || '', crp: partyName[crParty] || ''
      });
    });
  });

  return wb.xlsx.writeBuffer();
}

async function sendEmail(buffer, filename) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.BACKUP_TO_EMAIL,
    subject: 'OHT Daily Backup — ' + new Date().toISOString().slice(0, 10),
    text: 'Aaj ka poora OHT accounting data attached hai (Excel file). Ye backup roz khud-b-khud banti hai.',
    attachments: [{ filename: filename, content: buffer }]
  });
}

async function main() {
  console.log('OHT backup starting…');
  await signIn();
  const data = await fetchAll();
  const buffer = await buildExcel(data);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = 'OHT-Backup-' + stamp + '.xlsx';
  await sendEmail(buffer, filename);
  console.log('Backup emailed: ' + filename);
}

main().catch(function (e) {
  console.error('Backup failed:', e.message);
  process.exit(1);
});
