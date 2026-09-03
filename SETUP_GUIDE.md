# OHT Daily Backup → Email — Setup Guide (bina card ke)

Ye poora tareeqa **GitHub** (jo aap already use kar rahe hain) aur **Gmail**
use karta hai — koi Google Cloud, koi card, koi Render zaroorat nahi.

Har raat 2 AM (Pakistan time) GitHub khud-b-khud script chalayega, jo
Supabase se poora data nikal kar Excel banayega aur aapke email pe
attachment ke tor par bhej dega.

---

## Step 1 — Files apni repo mein daalna

Aapki `Accounting-System` repo mein, `backup-job` folder ke andar ye files
daalein (purani `backup.js`/`package.json` ko REPLACE kar dein in nayi
wali se):

- `backup-job/backup.js`
- `backup-job/package.json`

Aur ek nayi jagah bhi banani hai (folder ka naam bilkul yehi hona chahiye,
GitHub isay khud pehchanta hai):

- `.github/workflows/daily-backup.yml`   ← ye repo ke **root** mein, `backup-job` ke bahar

(Note: `.github` folder ka naam dot se shuru hota hai — GitHub "Create new
file" mein naam yehi type karein: `.github/workflows/daily-backup.yml`,
folder khud ban jayega.)

---

## Step 2 — Gmail "App Password" banana (~3 minute)

Ye ek 16-character special password hota hai jo sirf iss script ke liye
hota hai — aapka asal Gmail password kahin nahi jata.

1. Pehle Gmail mein **2-Step Verification ON honi chahiye** — agar on nahi
   hai, [myaccount.google.com/security](https://myaccount.google.com/security)
   pe ja kar on kar lein (phone number se verify hota hai).
2. Phir [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   kholein.
3. "App name" mein kuch bhi likh dein, jaise `OHT Backup`.
4. **Create** dabayein — 16 characters ka ek password dikhega (jaise
   `abcd efgh ijkl mnop`) — ise **copy kar ke rakh lein** (dobara nahi
   dikhega).

---

## Step 3 — GitHub Secrets set karna

Ye woh jagah hai jahan aapki keys/passwords **chhupi hui, encrypted** rehti
hain — code mein kahin nahi likhi jatin.

1. Apni repo GitHub par kholein
2. **Settings** tab → left menu mein **Secrets and variables → Actions**
3. **"New repository secret"** dabayein, ye 5 secrets ek-ek kar ke banayein:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | wahi jo masters.html mein use hoti hai |
   | `SUPABASE_ANON_KEY` | wahi jo masters.html mein use hoti hai |
   | `GMAIL_USER` | aapka Gmail address (jaise `milad@gmail.com`) |
   | `GMAIL_APP_PASSWORD` | Step 2 wala 16-character password (spaces hata dein) |
   | `BACKUP_TO_EMAIL` | jahan backup email jani hai (aapka apna email bhi ho sakta hai) |

---

## Test karna

1. Repo mein **Actions** tab kholein
2. Left mein **"OHT Daily Backup"** workflow dikhega, us par click karein
3. Right side **"Run workflow"** button dabayein → **Run workflow** (green
   button) dabayein
4. 30-60 second ruk kar page refresh karein — ek naya run dikhega, us par
   click kar ke dekh sakte hain sahi chala ya nahi
5. Agar sab theek raha, apna email check karein — "OHT Daily Backup"
   subject wali email Excel attachment ke sath aani chahiye

Roz raat 2 AM (PKT) ye khud-b-khud chalta rahega, kisi ko yaad rakhne ki
zaroorat nahi.
