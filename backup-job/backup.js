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
    // soft-deleted (Recycle Bin) rows backup mein nahi chahiye
    out[t] = (data || []).filter(function (r) { return !r.deleted_at; });
  }
  return out;
}

async function buildExcel(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OHT Automated Backup';
  wb.created = new Date();

  const sheetDefs = [
    { name: 'Parties',   rows: data.parties,
      cols: ['id','name','kind','phone','city','address','ntn','opening','opening_side','active'] },
    { name: 'Items',     rows: data.items,
      cols: ['id','name','unit','buy_rate','sale_rate','opening_qty','opening_rate','hs_code','reorder_level'] },
    { name: 'Companies', rows: data.companies,
      cols: ['id','name','is_default','active'] },
    { name: 'Vouchers',  rows: data.vouchers,
      cols: ['id','vtype','vno','vdate','party_id','company_id','paid','notes','grand_total'] },
    { name: 'Voucher Lines', rows: data.voucher_lines,
      cols: ['id','voucher_id','item_id','qty','rate','tax_pct','amount'] },
    { name: 'Sheets',    rows: data.sheets,
      cols: ['sheet_date','opening','side','page'] }   // 'rows' (JSON) column jaan-boojh kar chhoda hai
  ];

  sheetDefs.forEach(function (def) {
    const ws = wb.addWorksheet(def.name);
    ws.columns = def.cols.map(function (c) { return { header: c, key: c, width: 16 }; });
    ws.getRow(1).font = { bold: true };
    (def.rows || []).forEach(function (r) { ws.addRow(r); });
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
