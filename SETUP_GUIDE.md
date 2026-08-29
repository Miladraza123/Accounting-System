# OHT Daily Backup → Google Drive — Setup Guide

Ye job roz khud-b-khud chalega, Supabase se poora data (parties, items,
companies, vouchers, voucher lines, sheets) nikalega, ek Excel file banayega,
aur aapke Google Drive ke ek folder mein daal dega.

---

## Step 1 — GitHub repo mein daalna

`backup.js`, `package.json` — ek nayi private GitHub repo banayein (jaise
`OHT-Daily-Backup`), ya jo `Whatsapp-Service` repo pehle se hai usi mein ek
naya folder bana kar daal dein.

---

## Step 2 — Google Cloud "Service Account" banana (ek dafa ka kaam, ~5 minute)

Ye ek "robot account" hota hai jo aapke Drive mein sirf ek specific folder
tak access rakhta hai — aapka apna Google account password kahin nahi jata.

1. [console.cloud.google.com](https://console.cloud.google.com) kholein,
   Google se login karein (jo bhi account aap Drive ke liye use karna chahte
   hain).
2. Upar left mein **"New Project"** bana lein (naam kuch bhi rakh dein, jaise
   `OHT Backup`).
3. Search bar mein **"Google Drive API"** dhoondhein, us par click karein,
   **Enable** dabayein.
4. Left menu mein **IAM & Admin → Service Accounts** kholein.
5. **"Create Service Account"** dabayein — naam `oht-backup-bot` rakh dein,
   baaki sab default rehne dein, **Done** dabayein.
6. Bani hui service account par click karein → **Keys** tab → **Add Key →
   Create new key → JSON** → Download ho jayegi.
7. Wo download hui `.json` file **kholein** (Notepad se), poora content copy
   kar lein — isay Step 4 mein use karenge.

---

## Step 3 — Google Drive mein folder banana aur access dena

1. Google Drive mein ek naya folder banayein — jaise `OHT Backups`.
2. Us folder ko **right-click → Share** karein.
3. Downloaded JSON file mein `"client_email"` wali line dhoondhein — kuch
   aisi dikhegi: `oht-backup-bot@oht-backup-xxxxx.iam.gserviceaccount.com`
4. Yehi email address Drive folder ke Share box mein daal kar **Editor**
   access de dein.
5. Folder khol kar URL dekhein — usme jo lamba code hota hai wo
   **Folder ID** hai:
   `https://drive.google.com/drive/folders/`**`1AbCdEfGhIjKlMnOpQrSt`**
   — ye ID Step 4 mein chahiye hoga.

---

## Step 4 — Render pe "Cron Job" banana

1. [Render dashboard](https://dashboard.render.com) kholein.
2. **New → Cron Job** dabayein.
3. Wahi GitHub repo select karein jahan `backup.js` daala hai.
4. **Build Command:** `npm install`
5. **Command:** `npm start`
6. **Schedule:** `0 21 * * *` (ye roz raat 2 AM Pakistan time pe chalega —
   Render ka schedule UTC time mein hota hai, PKT = UTC+5, is liye 21:00
   UTC = 2:00 AM PKT)
7. **Environment** tab mein ye 4 variables daalein:

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | wahi jo masters.html mein use hoti hai |
   | `SUPABASE_ANON_KEY` | wahi jo masters.html mein use hoti hai |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | Step 2 wali poori JSON file ka content (ek line mein paste kar dein) |
   | `DRIVE_FOLDER_ID` | Step 3 wala folder ID |

8. **Create Cron Job** dabayein.

---

## Test karna

Render dashboard mein us Cron Job ko kholein, **"Trigger Run"** ya **"Run
Now"** button dabayein (agar available ho) — ya schedule wale time ka
intezar karein. Logs mein `Backup uploaded: OHT-Backup-2026-08-30.xlsx`
dikhna chahiye, aur Drive folder mein file aani chahiye.

---

## Purani backups khud saaf karna (optional)

Agar chahte hain ke 60 din se purani backup files khud delete ho jayein
(Drive space bachane ke liye), bata dijiye — chhota sa addition kar denge
script mein.
