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
3. **"New repository secret"** dabayein, ye 7 secrets ek-ek kar ke banayein:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | wahi jo masters.html mein use hoti hai |
   | `SUPABASE_ANON_KEY` | wahi jo masters.html mein use hoti hai |
   | `BACKUP_EMAIL` | wahi email jis se aap Masters mein "Sign in" karte hain |
   | `BACKUP_PASSWORD` | usi account ka password |
   | `GMAIL_USER` | aapka Gmail address (jaise `milad@gmail.com`) |
   | `GMAIL_APP_PASSWORD` | Step 2 wala 16-character password (spaces hata dein) |
   | `BACKUP_TO_EMAIL` | jahan backup email jani hai (aapka apna email bhi ho sakta hai) |

   `BACKUP_EMAIL` aur `BACKUP_PASSWORD` ke bina script Supabase mein sign-in
   nahi kar sakti, aur backup khali ya nakaam aayega. Behtar hai is ke liye
   ek alag admin account banayein, taake password badalne par backup na ruke.

   **Doosri jagah copy:** `BACKUP_TO_EMAIL` mein comma laga kar ek se zyada
   pate likhe ja sakte hain, jaise `mera@gmail.com, dusra@gmail.com`. Backup
   dono jagah pahunch jayega. Ek hi mailbox par bharosa na karein.

---

## Step 4 (marzi ki cheez) — backup file ko password se band karna

Backup mein aap ka poora karobar hota hai — parties, bills, ledger, sab —
aur wo file mailbox mein pari rehti hai. Chahein to usay password se band
kiya ja sakta hai.

Ek aur secret banayein:

   | Name | Value |
   |---|---|
   | `BACKUP_PASSPHRASE` | jo password aap rakhna chahein (lamba rakhein) |

Iske baad roz jo file aayegi wo `OHT-Restore-<date>.json.enc` hogi, jo
sirf usi password se khulti hai. Restore karte waqt Masters us ka password
poochh lega.

> **KHABARDAR:** ye password kho gaya to wo file **kabhi** nahi khulegi —
> na hum khol sakte hain, na koi aur. Password kisi mehfooz jagah likh kar
> rakhein (backup se alag jagah). Yaqeen na ho to ye secret set hi na
> karein — set na karne par sab pehle ki tarah chalta rahega.

Ek dafa set karne ke baad **Restore ko aazma zaroor lein** (test data par),
taake pata chal jaye ke password sahi kaam kar raha hai.

### File ki teen shaklein

Masters ka Restore teenon ko pehchan leta hai, naam par nahi — file khud
bata deti hai wo kya hai:

| File | Kab aati hai |
|---|---|
| `OHT-Restore-<date>.json` | app ke apne **Backup** button se |
| `OHT-Restore-<date>.json.gz` | roz ki email se (chhoti rakhne ke liye dabai hui) |
| `OHT-Restore-<date>.json.enc` | roz ki email se, jab `BACKUP_PASSPHRASE` set ho |

Purani saadi `.json` file bhi hamesha ki tarah chalti rahegi.

---

## Step 5 (marzi ki cheez) — database ki banawat (schema) ka backup

Roz ki restore file mein **data** hota hai — har table, poori. Us se
system wapas aa jata hai, **agar** database ki banawat pehle se maujood
ho: tables, RLS policies, aur wo SQL functions jin par app khadi hai
(`trial_balance`, `receivable_aging`, `recompute_all_item_costs`
waghera). Bilkul khali Supabase project par pehle banawat chahiye,
phir restore.

Chahein to ye banawat bhi roz khud utar sakti hai. Ek aur secret
banayein:

   | Name | Value |
   |---|---|
   | `SUPABASE_DB_URL` | Supabase → Project Settings → Database → **Connection string** (URI) |

Iske baad email mein teesri file bhi aayegi: `OHT-Schema-<date>.sql.gz`.
Ye password se band nahi hoti (is mein karobar ka data nahi hota) taake
zaroorat ke waqt kahin bhi khul jaye.

> **Dhyan rahe:** ye connection string poore database ka darwaza hai —
> anon key se kahin zyada taqatwar. Isay sirf GitHub Secrets mein
> rakhein, kabhi kisi file mein nahi. Set na karein to bhi data ka
> backup pehle ki tarah chalta rahega; sirf banawat ki file nahi aayegi.

Agar kabhi ye step nakaam ho (jaise GitHub ka `pg_dump` server se purana
ho) to bhi **data ka backup ruknay nahi paata** — wo step alag hai aur
apne aap aage barh jata hai.

## Backup mein kaun si tables jati hain

Table ka naam **do jagah** likha hota hai, aur dono jagah ek jaisa rehna
chahiye:

- `backup-job/backup.js` → `RESTORE_ORDER`
- `masters.html` → `RESTORE_ORDER`

**Naya table banayen to us ka naam dono jagah daalna zaroori hai** — warna
wo table backup mein aayegi hi nahi, aur kisi ko pata bhi nahi chalega.
Tarteeb ahem hai: pehle wo cheez jis par doosri khadi hai (jaise `items`
`item_units` se pehle, `app_users` sab se upar, `audit_log` sab se neeche).

Roz ki email mein har table ki row count aati hai — wahin se andaza ho
jata hai ke kuch chhoot to nahi raha.

**`audit_log` backup mein jati hai magar restore nahi hoti.** Wo is baat
ka record hai ke kis ne kab kya badla, aur database khud usay app se
likhne nahi deta — likhna wahin ka trigger karta hai. Ye rok jaan boojh
kar hai: jo record baad mein badla ja sake wo record rehta hi nahi.
Guzri hui tareekh file mein mehfooz rehti hai, bas wapas nahi daali
jati.

### Do surtein jo email khud bata deti hai

| Email mein | Matlab | Kya karna hai |
|---|---|---|
| "Ye tables … maujood nahi thin" | Us naam ki table is database mein hai hi nahi. Backup baqi sab utaar kar chala gaya. | Agar us table ka hona chahiye tha to dekhein. Warna kuch nahi. |
| Subject mein **⚠ ADHOORA** | Table maujood thi magar parhi nahi ja saki (jaise ijazat/RLS ka masla). **Backup adhoora hai.** | Foran dekhein. Run bhi nakaam ginta hai, GitHub ittila bhejta hai. |

Pehle ek bhi ghayab table poore backup ko mar deti thi — na Excel aati, na
restore file, kuch bhi nahi. Ab aisa nahi hota.

## Database functions likhte waqt: DELETE/UPDATE ko hamesha WHERE chahiye

Is project ke `authenticator` role (jis se app ki HAR call guzarti hai)
par Postgres ka `safeupdate` extension chalu hai. Wo **koi bhi**
DELETE ya UPDATE rok deta hai jis mein WHERE clause na ho — chahe
maqsad hi "poori table khali kar do" kyun na ho. Error yehi hota hai:

> DELETE requires a WHERE clause

Ye extension sirf `authenticator` ke connection par load hota hai — is
liye Supabase ke **SQL Editor** se, ya `execute_sql`/`apply_migration`
tools se chalai gayi wohi statement **bina kisi error ke chal jati
hai**. Yani agar aap SQL Editor mein test kar ke dekhein, sab theek
lagega — magar app se chalane par ruk jayega. Isi wajah se
`wipe_test_data()` ka asal masla pakarne mein waqt laga.

**Hal:** poori table khali karni ho to `where true` laga dein:

```sql
delete from kisi_bhi_table where true;
update kisi_bhi_table set x = 0 where true;
```

Koi naya "sab kuch saaf karo" jaisa function banayen to isay yaad
rakhein — SQL Editor mein test kaamyab hone ka matlab ye nahi ke app
se bhi chalega.

## Poori tabahi ke baad wapas kaise aayen

Agar Supabase project bilkul khatam ho jaye, tarteeb ye hai:

1. Naya Supabase project banayein.
2. `OHT-Schema-<date>.sql.gz` kholein aur us ka SQL project ke SQL Editor
   mein chalayein (ya jo SQL files aap ne alag mehfooz rakhi hain —
   `trial-balance-function.sql`, `period-locking.sql`, aur repo mein
   maujood `service-quotations.sql`).
3. Masters kholein, naye project ki URL/key daalein, sign in karein.
4. **Restore from backup** → us din ki `OHT-Restore-<date>.json.gz`
   (ya `.enc`, password ke sath) → tareeqa **"Poora replace"** → `RESTORE`
   likh kar chalayein.
5. Restore ke aakhir mein system khud ginti milata hai. "Ginti bhi mil
   gayi" aa jaye to kaam poora hua. Farq dikhe to wo saamne likha aayega
   — usay nazarandaz na karein.

Restore se pehle system khud maujooda halat ki ek file utaar deta hai
(`OHT-Before-Restore-<date>.json`), taake ghalti ho jaye to wapas laut
sakein.

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
