# Master Build Prompt — OHT Accounting System

Paste this whole document to an AI coding assistant to rebuild this exact
system from scratch (or as the spec for a from-scratch clone in a new
business domain — swap the domain nouns in §8/§10/§11 and everything
else still applies unchanged).

```
Build a small-business accounting system as three standalone,
framework-free HTML/JS apps (Masters, Billing, Daily Ledger) sharing one
Supabase backend, hosted inside a shell app, deployed as a static site
with no custom server and no build step.

═══════════════════════════════════════════════════════════════
1. TECH STACK & HOSTING
═══════════════════════════════════════════════════════════════
- Frontend: plain vanilla JS. No framework, no bundler, no npm frontend
  dependencies. Each app is ONE self-contained .html file — markup, CSS,
  and JS all inline. All JS wrapped in a single IIFE
  `(function () { 'use strict'; ... })();` so nothing leaks globally.
- Backend: Supabase — Postgres + PostgREST (REST API) + Auth + Realtime,
  called directly from the browser via the supabase-js client (loaded
  from a CDN `<script>` tag). No custom backend server at all.
- Client library: `window.supabase.createClient(url, key, { auth: {
  persistSession:true, autoRefreshToken:false } })` — autoRefreshToken is
  OFF by default and turned on only for whichever app is currently the
  foreground tab (see §4), so multiple simultaneously-open apps don't
  fight over refreshing the same session and force each other to sign
  out.
- Hosting: a public static-site host (e.g. GitHub Pages) serving the
  repo directly off its default branch. No server-side rendering, no
  environment variables baked at build time — the Supabase URL/anon key
  are entered once through a small in-app "Connect" screen and stored in
  `localStorage`.
- PWA: a `manifest.json` (name, icons at every standard size incl. two
  maskable variants, theme/background colors, `display:standalone`), a
  `sw.js` service worker, and a full icon set (`favicon.ico` as a real
  multi-resolution ICO, 16/32 PNG favicons, an apple-touch-icon, and
  48–512px PWA icons). The service worker:
  - Precaches the shell HTML files, manifest, and the two largest icons
    on `install`.
  - For HTML requests: ALWAYS try the network first with
    `cache:'no-store'` (so a new deploy is picked up immediately, never
    served stale), falling back to cache only when offline.
  - For everything else (icons, manifest): cache-first, but still kicks
    off a background network fetch to silently refresh the cache for
    next time.
  - Never intercepts or caches any request to the Supabase host, any
    `/rest/v1/`, `/auth/v1/`, or `/rpc/` path, or any non-GET request —
    those always go straight to the network, no offline queueing at the
    service-worker level (offline writes are queued in-app instead, see
    §6).

═══════════════════════════════════════════════════════════════
2. APP / FILE STRUCTURE
═══════════════════════════════════════════════════════════════
- `index.html` — the shell. Top nav bar with a small branded mark plus
  one tab per app. Creates one `<iframe>` per app the FIRST time it's
  opened and keeps it alive (toggle `display` on switch, never destroy
  and recreate it) — so switching tabs never loses in-progress edits in
  a background app. Owns the cross-app postMessage protocol (§4).
- `masters.html` — master data: Parties, Items, Services, Firms
  (Companies), Party Kinds, plus the Recycle Bin, Wipe Test Data tool,
  and Backup/Restore UI.
- `billing.html` — every transaction/document type: Sale & Purchase
  vouchers, Sales Returns, Service Invoices, Service Quotations,
  Purchase Orders, Stock Transfers, Recurring Service Templates.
- `daily-ledger.html` — a day-by-day cash sheet (credit/debit rows),
  works fully offline.
- `backup-job/` — a small Node script + `package.json`, run nightly by
  a scheduled CI workflow, that exports the whole database to Excel +
  JSON and emails it (see §14).
- `.github/workflows/daily-backup.yml` — the nightly cron trigering the
  above, plus a monthly no-op "keepalive" commit so the host's
  scheduled-workflow auto-disable-after-60-days-of-inactivity never
  fires (a real GitHub Actions gotcha, not GitHub Pages).
- A top-level setup guide in the users' own language documenting: how to
  wire the backup job's secrets, what each backup file format means,
  full disaster-recovery steps from an empty database, and — critically
  — a running list of any subtle Postgres/PostgREST behavior discovered
  the hard way (see §18) so future maintainers don't rediscover it by
  losing data.

═══════════════════════════════════════════════════════════════
3. DATABASE SCHEMA (Postgres via Supabase)
═══════════════════════════════════════════════════════════════
Every user-facing table gets: `id uuid primary key default
gen_random_uuid()`, `created_at`/`created_by`, `updated_at`/`updated_by`,
`version integer not null default 1` (bumped every write, used by the
3-way merge in §7), and `deleted_at timestamptz` (soft delete — the UI
never hard-deletes). RLS enabled on every table; policy is "any
authenticated user may select/insert/update/delete" (`for all to
authenticated using (true) with check (true)`) — real access control is
enforced by the app's own permission checks plus the merge/RPC functions,
not by per-row RLS predicates, since this is a single-tenant internal
tool, not multi-tenant SaaS.

Tables, grouped by module:

  Identity/config:
  - app_users (id references auth.users, username, is_admin bool,
    is_active bool, perms jsonb — per-feature flags like masters_edit,
    masters_delete, bill_create, ledger_create, ledger_delete,
    backup_restore)
  - period_lock (single row: locked_before date — see §12)

  Masters:
  - parties (name, kind — customer/vendor/both, city, phone, address,
    opening numeric, opening_side 'dr'|'cr')
  - party_kinds (custom categories beyond the built-in customer/vendor)
  - items (name, unit, sale_rate, avg_cost, stock_qty)
  - item_units (per-item alternate sale units + conversion factor)
  - item_cost_snapshot (item_id, as-of cost — used to avoid
    recalculating full cost history on every load)
  - services (name, default_rate, default_tax)
  - companies (name, address, city, phone, ntn/tax id, is_default bool,
    logo/signature/stamp — each a data: URI string, see §9)
  - warehouses (name — for stock transfers)
  - party_opening_balances (party_id, as_of_date, balance,
    last_txn_date — the snapshot behind period locking, §12)

  Transactions:
  - vouchers + voucher_lines (sale AND purchase, distinguished by a
    vtype column, sharing one pair of tables — not split into four)
  - sales_returns + sales_return_lines
  - service_invoices + service_invoice_lines
  - service_quotations + service_quotation_lines (mirrors
    service_invoices structurally; see §10 for why it's a fully
    separate table pair rather than a status flag on invoices)
  - recurring_service_templates (a saved shape that generates new
    service invoices on a schedule)
  - quotations + quotation_lines, purchase_orders + po_lines (the
    goods-side equivalents of service_quotations/service_invoices)
  - stock_transfers + stock_transfer_lines (warehouse to warehouse)
  - stock_adjustments (manual stock correction: item_id, qty, reason,
    adj_date — positive adds, negative removes)
  - sheets (daily ledger day-sheets — see §11)

  System:
  - audit_log (who changed what, when — written ONLY by a database
    trigger, never by the app directly; see §14 for why it's backed up
    but never restored)

Numbering: every document type gets its own auto-incrementing,
zero-padded number (e.g. `SV-0001`, `SQ-0001`), enforced with a unique
index scoped to `where deleted_at is null` (so a soft-deleted document's
number is reserved forever, but a permanently-purged one's number can be
reused).

═══════════════════════════════════════════════════════════════
4. SHELL & CROSS-APP COMMUNICATION (postMessage protocol)
═══════════════════════════════════════════════════════════════
Apps never talk to each other directly — everything routes through the
shell:
  - `{oht:'goto', app, arg}` — shell opens/focuses an app and hands it a
    deep-link argument (jump straight to one record, e.g. from a report
    row to the bill that produced it).
  - `{oht:'active', on:boolean}` — shell tells every app whether IT is
    currently the visible tab; only the foreground app keeps its
    session's token-auto-refresh running.
  - `{oht:'refresh', kind:<table-name>}` — an app broadcasts this AFTER
    it successfully saves a record in a table other apps also cache
    (parties, items, companies, services, ...); the shell relays it to
    every OTHER open app, which re-fetches just that table into its own
    in-memory list.
    CRITICAL ordering rule: send this ONLY from inside the save's actual
    server-confirmed success callback — never synchronously, before the
    network write even starts. Sending it early races the sibling app's
    re-fetch against your own write actually landing on the server; lose
    that race and the sibling silently stays stale (since only one
    broadcast is ever sent, there's no second chance) until a full
    reload. A failed save must never broadcast at all.

═══════════════════════════════════════════════════════════════
5. AUTH & PERMISSIONS
═══════════════════════════════════════════════════════════════
- Sign-in via Supabase Auth (email+password is enough for a small
  internal team). On sign-in, look up the matching `app_users` row by
  auth user id; if missing → "not set up, contact admin"; if
  `is_active=false` → "access disabled, contact admin".
- Client code gates UI with a `can('permission_key')` helper reading
  `app_users.perms`; this is UX convenience only. Nothing should rely on
  it as the actual security boundary.
- Distinguish, everywhere an error is caught: (a) genuinely offline —
  `navigator.onLine` false, a TypeError from a fetch, or a
  network-error-shaped message; (b) the device's clock is skewed enough
  to fail JWT time-validation (detect by matching "issued at ... future"
  / "clock skew" in the error, auto-retry once after a few seconds
  rather than showing a scary error); (c) a genuine server/validation
  error. Each needs different copy and different retry behavior — never
  collapse all three into one generic "something went wrong".

═══════════════════════════════════════════════════════════════
6. OFFLINE-FIRST & LOCAL CACHE
═══════════════════════════════════════════════════════════════
- Every app keeps a full local copy of its own working set in
  `localStorage` (Daily Ledger caches every day-sheet; Masters/Billing
  cache their master lists), so the app is usable with zero connection.
- Writes are optimistic: update the in-memory model and the screen
  FIRST, persist to localStorage, THEN fire the network write in the
  background. Never block the UI on a round trip.
- No connection when a write is attempted → append the operation
  (table, op type, record id, payload, base version, original snapshot)
  to a persisted offline queue; retry automatically on an interval AND
  on the browser's `online` event; process strictly in submission order;
  drop an item only once its write is confirmed (treat "duplicate key"
  on retry as already-succeeded, not an error).
- Any periodic/background re-sync of a locally-cached dataset must
  RECONCILE, not just add: a record the fresh server pull no longer
  contains must be removed from the local cache too — UNLESS it has a
  genuinely un-synced local edit still pending, or is being actively
  edited this exact moment (guard edits from roughly the last few
  seconds against being clobbered by a slightly-stale pull). Without
  this, anything deleted directly in the database (an admin tool, a
  bulk-wipe utility) leaves "phantom" records on every device that had
  already cached them, forever, until a hard reload.
- Any query meant to read a WHOLE table must explicitly page past
  PostgREST's default ~1000-row response cap — loop on `.range(from,
  from+PAGE-1)` until a page comes back shorter than the page size.
  Audit every "select everything" query for this, including the
  reconciliation logic above: an unpaginated fetch there would
  wrongly treat real rows past row 1000 as "deleted".

═══════════════════════════════════════════════════════════════
7. CONCURRENCY: 3-WAY MERGE, NOT LAST-WRITE-WINS
═══════════════════════════════════════════════════════════════
- A Postgres RPC function `smart_merge_update(p_table, p_id, p_original,
  p_new)` does the real merge server-side: reads the row's CURRENT live
  state, then per changed field — if the incoming "new" value equals
  what the editor originally saw ("original"), the user never actually
  touched that field, so take the database's current value; if the
  database's current value still equals "original", nobody else changed
  it either, so take the user's new value; if new equals current
  already, fine either way; if all three differ, that's a REAL conflict
  on that field. Ignore bookkeeping/derived columns (id, timestamps,
  version, computed totals/stock) from this comparison entirely.
- On a conflict result: the RPC returns the field names in conflict plus
  the row's current state; the client automatically retries the merge
  ONCE using that fresh current state as the new "original" (this
  resolves the common case where the "conflict" was really just a
  concurrent edit to a field the user didn't touch), and only surfaces
  an error to the user if it conflicts again after that retry.
- The "original" snapshot passed into every merge call must be captured
  ONCE, at the moment the editor opens (`editingBaseline = deepClone
  (record)` right when the edit form is built) — never re-derived from
  the live in-memory editing object at save time. Anything that mutates
  the live object as a side effect of an earlier action in the same edit
  session (e.g. picking an image — see §9 — which updates state the
  instant the file is chosen, well before Save is clicked) would
  otherwise make "original" and "new" identical at save time, so the
  merge concludes "nothing changed" and silently discards a real edit —
  while the UI still shows "Saved".
- Client-originated calls always go through the `authenticator`
  Postgres role (whatever RLS/role the app's Supabase client uses) —
  NEVER assume a function that works when run directly against the
  database (via a SQL console or an admin tool) behaves identically when
  called through the app. If any bulk/"clear everything" style function
  is added later, every unconditional `DELETE`/`UPDATE` inside it needs
  an explicit `WHERE TRUE` even when logically unnecessary — some
  Postgres role configurations reject any DELETE/UPDATE whose parser
  doesn't see a WHERE clause at all, and that restriction only applies
  on the app's own connection path, not a direct admin/SQL-console
  connection — so testing only through the console will look fine and
  still break in production.

═══════════════════════════════════════════════════════════════
8. MASTERS MODULE
═══════════════════════════════════════════════════════════════
- One shared list+editor UI pattern reused across Parties / Items /
  Services / Firms, switched by a `tab` variable rather than four
  separate implementations: a left list (search, active/inactive
  filter), tap a row to open a full-screen editor, a single shared
  `saveRec()`/`delRec()` pair of functions branching on `tab` for
  per-type fields.
- Duplicate/near-duplicate name detection while typing a new record's
  name (warn, don't hard-block, in case two genuinely different things
  share a name).
- Soft delete moves a record to a Recycle Bin view (filterable by type)
  with a one-click Restore; a record actually referenced by a
  transaction should stay soft-deleted-but-visible in read contexts
  (old bills must still show the party/item name) rather than vanishing.
- A "Wipe Test Data" utility (admin-only) for clearing everything except
  master setup while developing/piloting — implemented as one Postgres
  function that deletes in strict foreign-key dependency order (topological
  sort by FK constraints — get this order programmatically from
  `pg_constraint`, don't hand-maintain it) and respects the WHERE-clause
  gotcha in §7.

═══════════════════════════════════════════════════════════════
9. MULTI-FIRM BRANDING: LOGO / SIGNATURE / STAMP + PER-PRINT TOGGLE
═══════════════════════════════════════════════════════════════
- The Firms (Companies) master supports multiple firms; one is flagged
  default. Each firm has THREE independent image fields — Logo,
  Signature, Stamp — each with its own Choose / Change / Remove controls
  and a live preview in the editor.
- Picking a file: read it, downsize/compress it client-side via a
  `<canvas>` (cap dimensions, re-encode as JPEG/PNG), and store the
  result as a `data:` URI string directly on the firm record — no
  separate file storage or CDN needed for a small business's worth of
  branding assets.
- Every printed document that ends with a "Prepared by [name]" /
  authorization line uses ONE shared print-footer helper (not duplicated
  per print function) that, directly above that line:
  - shows the firm's signature image if it's set AND turned on for this
    print;
  - shows the firm's stamp image if it's set AND turned on for this
    print — independently of the signature (two separate toggles, not
    one combined switch, since a firm may want the stamp on every
    document but the signature only sometimes);
  - reserves the same vertical space for this block whether or not an
    image actually renders, so the rest of the printed layout never
    shifts document-to-document.
- Before printing: if the firm has at least one of signature/stamp
  configured, show a small dialog with both on/off switches (defaulting
  to whatever was chosen last time ON THIS DEVICE — persisted in
  `localStorage`, not tied to the user account) plus Print/Cancel. If
  the firm has NEITHER image set, skip the dialog and print immediately.
  Build the actual print content INSIDE the dialog's resolve callback,
  not before it, so the toggle choice applies to the print being
  produced right now.
- Wire this into every print function in the system (every document
  type in §10, plus the Statement of Account report in §12).

═══════════════════════════════════════════════════════════════
10. BILLING MODULE (all transaction/document types)
═══════════════════════════════════════════════════════════════
- One editor shell and one print pipeline shared across document types,
  distinguished by a type flag (e.g. `bill.isQuote`, `vtype`) rather than
  duplicating the whole editor per type. A left sidebar tab per document
  type (Sale, Purchase, Sales Return, Service Invoice, Service
  Quotation, Purchase Order, Stock Transfer, Recurring Templates).
- Line items picked via a searchable combobox (type-to-filter, arrow-key
  navigable, mousedown-to-select) reading the live in-memory
  parties/items/services list fresh every time it opens — so it reflects
  a cross-app refresh (§4) the instant it lands, with no extra wiring
  needed at the picker itself.
- A party/item/service that doesn't exist yet: the picker's "no match"
  state says exactly where to go create it (e.g. "No such service — add
  it in Masters → Services first"), rather than a bare "not found".
- Multi-line text fields (e.g. a service line's description) use a real
  `<textarea>`, not a single-line `<input>` — and the print CSS for that
  field needs `white-space:pre-wrap` — otherwise line breaks the user
  typed are silently flattened onto one line when printed, while looking
  fine on screen (this exact class of bug is easy to miss because it
  only shows up in the PRINT output, not the editor).
- A "quotation"-style document (an estimate, not yet a commitment) is a
  FULLY SEPARATE table pair from the real transaction it may become
  (§3) and must touch NOTHING else in the system — no ledger entry, no
  stock movement, no party balance change — until an explicit "Convert
  to [Invoice]" action creates the real transaction from it and marks
  the quotation converted (status + a pointer to the resulting
  document's id). Never model this as a status flag on the real
  transaction table — that lets an unconverted quotation accidentally
  affect real balances.
- Every save goes through the same concurrency-safe path as Masters
  (§7): optimistic local update, then either a plain insert (new record)
  or `smart_merge_update` (existing record) with the baseline captured
  at editor-open time. A concurrent-edit conflict on a document shows
  which fields collided and does the one-retry-then-surface pattern.
- Recurring Service Templates: a saved shape (party, lines, schedule)
  that a scheduled process turns into new real Service Invoices on their
  due dates — the template itself is never billed directly.

═══════════════════════════════════════════════════════════════
11. DAILY LEDGER MODULE
═══════════════════════════════════════════════════════════════
- One row per day (`sheets`, keyed by `sheet_date`), each holding a
  fixed-width array of cash rows: `[debit_amount, debit_remarks,
  credit_amount, credit_remarks, debit_checkmark, credit_checkmark,
  credit_party_id, debit_party_id]` plus an opening balance/side for the
  day. Stored as one JSON array-of-rows per day rather than one SQL row
  per cash entry — keeps the whole day as one unit that's cheap to
  fetch/cache/sync as a whole.
- Linking a cash row's remarks to a party: writing the party's name as a
  literal TEXT PREFIX of the remarks value (`remarks = partyName + ' ' +
  restOfText`), with a `data-pid` attribute tracking the link and a
  visual "chip" overlay (a separate `<div>` positioned over the textarea)
  highlighting that recognized prefix — not a separate structured field.
  Detect the link by re-comparing the current text's prefix against the
  linked party's name (normalized: trim, lowercase, collapse whitespace)
  on every keystroke, and drop the link silently if the user edits the
  prefix away.
  IMPORTANT: any OTHER view that reads this same remarks text for a
  party's OWN records (e.g. that party's own ledger/statement) should
  strip that same leading name-prefix before displaying it — showing a
  party's own name inside its own already-labeled ledger rows is
  redundant. Do this by stripping only within that specific view, using
  the same normalized-prefix-match logic; never mutate the underlying
  stored text, and never change how the Daily Ledger's own sheet view
  itself displays it (the name legitimately belongs there, since a
  sheet mixes many different parties' rows together).
- The whole day-sheet dataset is cached fully offline per §6, including
  the reconciliation rule (a day-sheet deleted server-side must
  disappear from a device's cache on its next sync, not linger forever).

═══════════════════════════════════════════════════════════════
12. REPORTS & PERIOD LOCKING
═══════════════════════════════════════════════════════════════
- Party Ledger / Statement of Account: reconstructs a running balance
  from every source that touches a party — vouchers (sale/purchase),
  sales returns, service invoices, and Daily Ledger cash rows linked to
  that party — merged into one chronological event list, each event
  tappable to jump to its source document. Both a screen view and a
  printed version consume the SAME event-building function, so a fix to
  how an event's line reads (§11's name-stripping, for instance) only
  needs to happen once to cover both.
- Item/Stock Ledger: the same pattern for a single item — every
  purchase, sale, return, and manual stock adjustment affecting it —
  with running quantity balance.
- Period locking: an admin can lock the ledger "before" a chosen date.
  Once locked, a party's opening balance for reporting purposes is
  computed ONCE as of the lock date and cached (`party_opening_balances`)
  instead of re-walking full history on every report load — a real
  speed necessity once transaction history gets large. A snapshot is
  only trusted ("active") when EVERY party's snapshot row matches the
  currently-configured lock date exactly; any mismatch (lock date
  changed, a party's snapshot missing) falls back automatically to the
  full, safe, un-locked calculation and repairs the snapshot in the
  background — never silently show a number computed from a stale or
  partial snapshot.
- Receivable Aging and Trial Balance reports build on the same
  event-list/balance machinery, bucketed by age or grouped by account.

═══════════════════════════════════════════════════════════════
13. PRINT SYSTEM CONVENTIONS
═══════════════════════════════════════════════════════════════
- Print by rendering into a dedicated on-page container styled only for
  `@media print`, then calling the browser's native print — not a
  separate print-preview window/tab.
- Set `document.title` (and the parent shell's title, if running inside
  an iframe, since some browsers take the print filename from the TOP
  window) to a descriptive, filename-safe string right before printing,
  and restore the original title on the `afterprint` event.
- Wait for any print-relevant image (a firm's logo/signature/stamp) to
  finish loading before invoking print — an image still loading at print
  time renders as blank space in most browsers' print pipeline.

═══════════════════════════════════════════════════════════════
14. BACKUP, RESTORE & DISASTER RECOVERY
═══════════════════════════════════════════════════════════════
- One list of every table to back up, in a fixed dependency order
  (independent/parent tables first, e.g. app_users and companies before
  anything referencing them, audit_log last) — this list must be kept
  in exact sync in BOTH the in-app Backup/Restore code and the scheduled
  backup-job script; document prominently, in the setup guide, that
  adding a new table means updating it in both places or it silently
  never gets backed up.
- A scheduled job (cron via CI) exports every table to one JSON file
  (paginating past the §6 1000-row cap), builds a matching Excel
  workbook, and emails both as attachments — optionally gzip-compressed
  and/or passphrase-encrypted (AES, passphrase never stored anywhere but
  the person's own memory/password manager). An in-app "Backup now"
  button uses the EXACT SAME export code path as the scheduled job, not
  a second, divergent implementation that can silently drift out of
  sync with it.
- A table that doesn't exist yet in a given database is noted and
  skipped, not treated as an error. A table that exists but errors out
  (permissions, RLS, a missing column) marks the WHOLE backup run
  "partial" and fails loudly (non-zero exit, a clearly-flagged email
  subject) — never let one bad table produce a silently-incomplete
  backup that looks like a clean success.
- Append-only/trigger-written tables (audit_log) are captured for the
  historical record but deliberately EXCLUDED from restore — restoring
  them would mean writing to a table the app has no write permission on
  by design (only its own trigger may write it), and semantically,
  a log of "what changed and when" shouldn't itself be rewritable.
- Restore always: shows the user what the file actually contains and
  WHEN it was taken (parsed from the file's own metadata, in the user's
  local time zone) before they commit to restoring it; supports the
  three shapes a backup file can be (plain `.json`, gzipped `.json.gz`,
  gzipped-and-encrypted `.json.enc`) transparently by inspecting the
  file rather than trusting its extension; offers "merge" vs "full
  replace" modes; deletes in small batches rather than one giant
  request when replacing a table; takes an automatic "before restore"
  safety snapshot of current data first; and re-counts rows after
  restoring to positively confirm the numbers match, rather than
  assuming success just because no error was thrown.
- Optionally also ride along a schema-only dump (tables/policies/
  functions, no business data, so it never needs the passphrase) so a
  completely empty database can be rebuilt structure-first, then
  restored into.

═══════════════════════════════════════════════════════════════
15. TESTING STRATEGY
═══════════════════════════════════════════════════════════════
- Build a small harness that loads the REAL, unmodified app HTML in a
  DOM environment (e.g. jsdom) with a fake backend client substituted
  in for `window.supabase`, then drives it exactly like a user would:
  click real buttons, type into real inputs, dispatch real events, and
  assert on the real rendered output. Do not unit-test internal
  functions directly — the goal is confidence the actual shipped file
  works end-to-end, DOM wiring included, not just its logic in
  isolation.
- The fake backend must faithfully reproduce the real one's sharp edges
  or tests give false confidence: the same ~1000-row page cap (§6), the
  same 3-way-merge semantics the real RPC has (§7) — not a naive
  overwrite, which would hide exactly the kind of bug most worth
  catching — and a way to make any given table return a
  permission-denied error on demand for a specific test.
- Stub browser APIs jsdom lacks but real code paths need (an image
  decoder + 2D canvas context for the logo/signature/stamp picker in
  §9, DecompressionStream/crypto.subtle for encrypted-backup tests) with
  functioning-enough fakes that the REAL application code runs through
  them unmodified, rather than special-casing the code under test to
  skip those paths in a test environment.
- For any reported bug: first write a test that reproduces it and
  confirm it FAILS against the pre-fix code (proves the test is
  actually catching the real defect, not a fictional version of it),
  then apply the fix, then confirm the same test now passes. Re-run
  the FULL existing suite after every change, not just the new test —
  a fix in one shared function (the merge RPC, the cross-app refresh
  broadcast) can affect every module that uses it.

═══════════════════════════════════════════════════════════════
16. LANGUAGE & UX CONVENTIONS
═══════════════════════════════════════════════════════════════
- If the primary users are not English-first, write ALL user-facing copy
  (labels, toasts, confirmation dialogs, error messages) AND inline code
  comments explaining *why* a piece of logic exists (not just *what* it
  does) in the users'/maintainers' own language/register — this keeps
  the codebase legible to whoever maintains it next, not only to whoever
  wrote it.
- Every destructive action (delete, wipe, restore-and-replace) gets an
  explicit confirmation step stating the actual consequence in plain
  language ("moves to the Recycle Bin, you can restore it later" vs.
  "permanently deleted, cannot be undone" are very different prompts),
  never just a bare "Are you sure?".
- A toast/snackbar pattern for save/error feedback that never gets
  silently replaced mid-read by a later toast — track a small history so
  a fast second event can't hide the first one before the user sees it.

Now build it.
```
