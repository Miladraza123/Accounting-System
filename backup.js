// OHT Daily Backup — Supabase se data nikal kar Excel banata hai aur Google Drive ke
// ek folder mein upload kar deta hai. Render "Cron Job" ke tor par roz chalta hai.
//
// ZAROORI env variables (Render dashboard -> Environment mein set karni hain):
//   SUPABASE_URL              - jaisa masters.html mein use hoti hai
//   SUPABASE_ANON_KEY         - jaisa masters.html mein use hoti hai
//   GOOGLE_SERVICE_ACCOUNT_JSON - service account ki poori JSON key (ek line mein, quotes ke sath)
//   DRIVE_FOLDER_ID           - Google Drive folder ka ID jahan backup jani hai

const { createClient } = require('@supabase/supabase-js');
const ExcelJS = require('exceljs');
const { google } = require('googleapis');
const { Readable } = require('stream');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function fetchAll() {
  const tables = ['parties', 'items', 'companies', 'vouchers', 'voucher_lines', 'sheets'];
  const out = {};
  for (const t of tables) {
    // deleted_at wali (soft-deleted) rows backup mein nahi chahiye — sirf 'sheets' mein
    // deleted_at column nahi hoti agar us table par yeh column na ho to poora data le lo
    let q = sb.from(t).select('*');
    const { data, error } = await q;
    if (error) throw new Error(t + ': ' + error.message);
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
      cols: ['id','vtype','vno','vdate','party_id','company_id','paid_now','notes'] },
    { name: 'Voucher Lines', rows: data.voucher_lines,
      cols: ['id','voucher_id','item_id','qty','rate','tax_pct','amount'] },
    { name: 'Sheets',    rows: data.sheets,
      cols: ['sheet_date','opening','side','page'] }   // 'rows' (JSON) column jaan-boojh kar chhoda hai — poori sheet ki tafseel bohot lambi hoti
  ];

  sheetDefs.forEach(function (def) {
    const ws = wb.addWorksheet(def.name);
    ws.columns = def.cols.map(function (c) { return { header: c, key: c, width: 16 }; });
    ws.getRow(1).font = { bold: true };
    (def.rows || []).forEach(function (r) { ws.addRow(r); });
  });

  return wb.xlsx.writeBuffer();
}

async function uploadToDrive(buffer, filename) {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });
  const drive = google.drive({ version: 'v3', auth });

  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);

  await drive.files.create({
    requestBody: {
      name: filename,
      parents: [process.env.DRIVE_FOLDER_ID],
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    },
    media: {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: stream
    }
  });
}

async function main() {
  console.log('OHT backup starting…');
  const data = await fetchAll();
  const buffer = await buildExcel(data);
  const stamp = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
  const filename = 'OHT-Backup-' + stamp + '.xlsx';
  await uploadToDrive(buffer, filename);
  console.log('Backup uploaded: ' + filename);
}

main().catch(function (e) {
  console.error('Backup failed:', e.message);
  process.exit(1);
});
