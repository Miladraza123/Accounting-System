-- ════════════════════════════════════════════════════════════════
-- SERVICE QUOTATIONS
--
-- Ye Billing mein "Service quotation" wale tab ke liye hai. Do tables
-- banti hain, bilkul service_invoices / service_invoice_lines ki tarz
-- par — kyunki quotation bhi wohi cheez hai, bas abhi paisa nahi banta.
--
-- AHEM: quotation SIRF KAGHAZ hai. Us ka party ke balance, ledger,
-- stock ya cost par koi asar NAHI. Paisa tab banta hai jab usay
-- "Convert to Service Invoice" se service invoice banaya jaye — aur wo
-- invoice pehle ki tarah hi kaam karti hai.
--
-- Isay Supabase → SQL Editor mein ek dafa chala dein. Dobara chalane se
-- kuch kharab nahi hota (sab kuch "if not exists" par hai).
-- ════════════════════════════════════════════════════════════════

-- ─── 1. Quotation ka header ───────────────────────────────────────
create table if not exists public.service_quotations (
  id                    uuid primary key default gen_random_uuid(),
  sqno                  text,
  party_id              uuid references public.parties(id),
  company_id            uuid references public.companies(id),
  sqdate                date        not null default current_date,

  -- Quotation kab tak qabil-e-amal hai. Khali chhorein to koi had nahi.
  valid_till            date,

  -- Service ka arsa — service invoice jaisa hi
  billing_from          date,
  billing_to            date,
  billing_label         text,

  narration             text,
  notes                 text,

  tax_on                boolean     not null default false,
  sub_total             numeric     not null default 0,
  discount              numeric     not null default 0,
  tax_total             numeric     not null default 0,
  grand_total           numeric     not null default 0,

  -- open      → abhi tak invoice nahi bani
  -- converted → is se invoice ban chuki (neeche wali id dekhein)
  -- cancelled → party ne mana kar diya
  status                text        not null default 'open',
  converted_invoice_id  uuid references public.service_invoices(id),
  converted_at          timestamptz,

  version               integer     not null default 1,
  created_at            timestamptz not null default now(),
  created_by            uuid references public.app_users(id),
  updated_at            timestamptz,
  updated_by            uuid references public.app_users(id),
  deleted_at            timestamptz
);

-- ─── 2. Quotation ki lines ────────────────────────────────────────
create table if not exists public.service_quotation_lines (
  id            uuid primary key default gen_random_uuid(),
  quotation_id  uuid        not null references public.service_quotations(id) on delete cascade,
  service_id    uuid references public.services(id),
  description   text,
  qty           numeric     not null default 0,
  rate          numeric     not null default 0,
  discount      numeric     not null default 0,
  tax_pct       numeric     not null default 0,
  amount        numeric     not null default 0,
  line_no       integer     not null default 0,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.app_users(id)
);

-- ─── 3. Tez dhoondhne ke liye ─────────────────────────────────────
create index if not exists service_quotations_sqdate_idx
  on public.service_quotations (sqdate desc);
create index if not exists service_quotations_party_idx
  on public.service_quotations (party_id);
create index if not exists service_quotation_lines_quotation_idx
  on public.service_quotation_lines (quotation_id);

-- Ek hi quotation number do dafa na ban sake. Recycle Bin wali
-- (deleted_at bhari hui) is rok se bahar hain — wo number dobara
-- istemal ho sakta hai.
create unique index if not exists service_quotations_sqno_uniq
  on public.service_quotations (sqno) where deleted_at is null;

-- ─── 4. Ijazat ────────────────────────────────────────────────────
-- Ye baqi tables jaisi hi hai: jo sign-in kar chuka hai wo dekh aur
-- likh sakta hai. Asal rok app ke andar hai (Masters → Users mein
-- "Quotation" wali ijazatein) — wohi service quotation par bhi lagti
-- hain, kyunki quotation to quotation hai.
--
-- Agar aap ki baqi tables is se ZYADA sakht hain, to inhein bhi wohi
-- shakl dein — warna ye do tables baqi se dheeli reh jayengi.
alter table public.service_quotations       enable row level security;
alter table public.service_quotation_lines  enable row level security;

drop policy if exists "Allow all access" on public.service_quotations;
create policy "Allow all access" on public.service_quotations
  for all to authenticated using (true) with check (true);

drop policy if exists "Allow all access" on public.service_quotation_lines;
create policy "Allow all access" on public.service_quotation_lines
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.service_quotations      to authenticated;
grant select, insert, update, delete on public.service_quotation_lines to authenticated;

-- ─── 5. Ho gaya ───────────────────────────────────────────────────
-- Ab Billing kholein — sidebar mein "Service quotation" ka tab kaam
-- karne lagega. Backup mein ye tables khud-b-khud shamil hain (dono
-- RESTORE_ORDER mein pehle se likhi hui hain).
