-- ════════════════════════════════════════════════════════════════
-- 2026-10-21 — Deep-test fixes (database side)
--
-- Isay Supabase → SQL Editor mein ek dafa chala dein. Dobara chalane se
-- kuch kharab nahi hota (sab "if not exists" / "create or replace" hai).
-- Koi purana data nahi badalta — sirf naye columns, nayi table, aur
-- functions/policies ki hifazat.
--
--  1. Missing columns jo app 26 Sep se likh rahi hai (description,
--     custom_name, custom_unit, walkin_name) + item_specs table. In ke
--     baghair naya Sale/Purchase/Quotation/PO/Service Quotation save
--     nahi hota tha (header ban jata, lines nahi).
--  2. apply_merged_lines: edit mein nayi line add karna hamesha fail
--     hota tha (id/parent/line_no NULL jate the). Ab table ke sahi
--     parent column aur permission ke saath chalta hai.
--  3. SECURITY DEFINER functions (smart_merge_*, apply_merge*,
--     fetch_lines_json, recompute_all_item_costs, log_manual_audit)
--     bina login (anon key) ya bina permission ke chal jate the aur RLS
--     ko bypass karte the. Ab sirf active user + sahi permission.
--  4. Deactivated user ab koi data nahi parh sakta; service_quotations
--     par baaki documents jaisi permission.
--  5. Purane test/debug functions hata diye.
-- ════════════════════════════════════════════════════════════════

-- ─── 1. Missing columns + item_specs ─────────────────────────────
alter table public.voucher_lines   add column if not exists description text;
alter table public.po_lines        add column if not exists description text;
alter table public.quotation_lines add column if not exists description text;
alter table public.quotation_lines add column if not exists custom_name text;
alter table public.quotation_lines add column if not exists custom_unit text;
alter table public.quotations      add column if not exists walkin_name text;
alter table public.service_quotations add column if not exists walkin_name text;

create table if not exists public.item_specs (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.items(id) on delete cascade,
  label      text not null,
  value      text not null default '',
  line_no    integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists item_specs_item_idx on public.item_specs(item_id);

-- supabase-js upsert naye rows ke liye id = NULL bhejta hai; yahan bhar do
create or replace function public.fill_uuid_id()
returns trigger language plpgsql as $$
begin
  if NEW.id is null then NEW.id := gen_random_uuid(); end if;
  return NEW;
end; $$;
drop trigger if exists trg_item_specs_id on public.item_specs;
create trigger trg_item_specs_id before insert on public.item_specs
  for each row execute function public.fill_uuid_id();

alter table public.item_specs enable row level security;
-- SQL Editor se bani nayi table ko Supabase khud grant nahi deta — RLS policies tabhi chalti hain
grant select, insert, update, delete on public.item_specs to authenticated, service_role;

-- ─── helper: sirf active app user ────────────────────────────────
create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_active from app_users where id = auth.uid()), false);
$$;

drop policy if exists "item_specs select" on public.item_specs;
drop policy if exists "item_specs write"  on public.item_specs;
create policy "item_specs select" on public.item_specs for select using (is_active_user());
create policy "item_specs write"  on public.item_specs for all
  using (is_app_admin() or has_perm('masters_edit')) with check (is_app_admin() or has_perm('masters_edit'));

-- ─── 4. RLS: deactivated user kuch na parh sake ─────────────────
-- Har policy jis mein sirf "auth.role() = 'authenticated'" tha, ab
-- is_active_user() maangti hai. app_users par apni row hamesha dikhe
-- (login par app usi se "account band hai" batati hai).
do $$
declare p record; q text; c text; cmd text;
begin
  for p in select * from pg_policies
            where schemaname = 'public'
              and (qual like '%auth.role()%' or with_check like '%auth.role()%')
  loop
    q := replace(p.qual, '(auth.role() = ''authenticated''::text)', 'is_active_user()');
    c := replace(p.with_check, '(auth.role() = ''authenticated''::text)', 'is_active_user()');
    if p.tablename = 'app_users' and p.cmd = 'SELECT' then
      q := '(id = auth.uid()) or is_active_user()';
    end if;
    cmd := format('alter policy %I on public.%I', p.policyname, p.tablename);
    if q is not null then cmd := cmd || ' using (' || q || ')'; end if;
    if c is not null then cmd := cmd || ' with check (' || c || ')'; end if;
    execute cmd;
  end loop;
end $$;

drop policy if exists "Allow all access" on public.service_quotations;
drop policy if exists "Allow all access" on public.service_quotation_lines;
drop policy if exists "service_quotations select" on public.service_quotations;
drop policy if exists "service_quotations write"  on public.service_quotations;
drop policy if exists "service_quotation_lines select" on public.service_quotation_lines;
drop policy if exists "service_quotation_lines write"  on public.service_quotation_lines;
create policy "service_quotations select" on public.service_quotations for select using (is_active_user());
create policy "service_quotations write" on public.service_quotations for all
  using (is_app_admin() or has_perm('bill_create') or has_perm('bill_edit'))
  with check (is_app_admin() or has_perm('bill_create') or has_perm('bill_edit'));
create policy "service_quotation_lines select" on public.service_quotation_lines for select using (is_active_user());
create policy "service_quotation_lines write" on public.service_quotation_lines for all
  using (is_app_admin() or has_perm('bill_create') or has_perm('bill_edit'))
  with check (is_app_admin() or has_perm('bill_create') or has_perm('bill_edit'));

-- ─── 3. Merge functions: permission + table/column hifazat ──────
-- table → zaroori permission (koi ek bhi ho to chalega). Admin ko sab.
create or replace function public._can_write(p_table text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare perms text[];
begin
  if not is_active_user() then return false; end if;
  if is_app_admin() then return true; end if;
  perms := case p_table
    when 'vouchers'                    then array['bill_edit']
    when 'sales_returns'               then array['bill_edit']
    when 'stock_transfers'             then array['bill_edit']
    when 'service_invoices'            then array['bill_create','bill_edit']
    when 'recurring_service_templates' then array['bill_create','bill_edit']
    when 'voucher_lines'               then array['bill_create','bill_edit']
    when 'sales_return_lines'          then array['bill_create','bill_edit']
    when 'stock_transfer_lines'        then array['bill_create','bill_edit']
    when 'quotations'                  then array['quotation_edit']
    when 'quotation_lines'             then array['quotation_create','quotation_edit']
    when 'purchase_orders'             then array['po_edit']
    when 'po_lines'                    then array['po_create','po_edit']
    when 'parties'  then array['masters_edit']
    when 'items'    then array['masters_edit']
    when 'companies' then array['masters_edit']
    when 'services' then array['masters_edit']
    else array[]::text[] end;
  return exists (select 1 from unnest(perms) k where has_perm(k));
end; $$;

-- line table → us ka parent column (caller apni marzi ka column na de sake)
create or replace function public._line_fk(p_line_table text)
returns text language sql immutable as $$
  select case p_line_table
    when 'voucher_lines'        then 'voucher_id'
    when 'sales_return_lines'   then 'return_id'
    when 'stock_transfer_lines' then 'transfer_id'
    when 'quotation_lines'      then 'quotation_id'
    when 'po_lines'             then 'po_id'
  end;
$$;

create or replace function public.fetch_lines_json(p_line_table text, p_fk_col text, p_fk_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if public._line_fk(p_line_table) is null or p_fk_col <> public._line_fk(p_line_table) then
    raise exception 'fetch_lines_json is table/column par nahi chal sakta: %.%', p_line_table, p_fk_col;
  end if;
  if not is_active_user() then raise exception 'Permission denied'; end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(t.*) order by t.line_no), ''[]''::jsonb) from %I t where %I = $1',
                 p_line_table, p_fk_col)
     into result using p_fk_id;
  return result;
end; $$;

create or replace function public.apply_merge(p_table text, p_id uuid, merged jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare kv record; parts text[] := array[]::text[]; set_clause text; updated_row jsonb;
begin
  if not public._can_write(p_table) then
    raise exception 'Permission denied: % edit karne ki ijazat nahi', p_table;
  end if;
  for kv in select key, value from jsonb_each_text(merged)
             where key in (select column_name from information_schema.columns
                            where table_schema = 'public' and table_name = p_table)
               and key not in ('id','created_at','created_by','updated_at','updated_by','version')
  loop
    parts := array_append(parts, format('%I = %L', kv.key, kv.value));
  end loop;
  set_clause := array_to_string(parts, ', ');
  if set_clause is null or set_clause = '' then return null; end if;
  execute format('update %I set %s, version = coalesce(version,1)+1, updated_at = now(), updated_by = $1 where id = $2 returning to_jsonb(%I.*)',
                 p_table, set_clause, p_table)
     into updated_row using auth.uid(), p_id;
  return updated_row;
end; $$;

create or replace function public.smart_merge_update(p_table text, p_id uuid, p_original jsonb, p_new jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  current_row jsonb; diff jsonb; updated_row jsonb;
  ignore_fields text[] := array['id','created_at','created_by','updated_at','updated_by','version',
                                'avg_cost','stock_qty','sub_total','subtotal','tax_total','grand_total'];
  MERGE_TABLES text[] := array['vouchers','sales_returns','stock_transfers','service_invoices',
                               'recurring_service_templates','quotations','purchase_orders',
                               'parties','items','companies','services'];
begin
  if not (p_table = any (MERGE_TABLES)) then
    raise exception 'smart_merge_update is table par nahi chal sakta: %', p_table;
  end if;
  if not public._can_write(p_table) then
    raise exception 'Permission denied: % edit karne ki ijazat nahi', p_table;
  end if;
  execute format('select to_jsonb(t.*) from %I t where id = $1 for update', p_table) into current_row using p_id;
  if current_row is null then return jsonb_build_object('status', 'missing'); end if;
  diff := merge_diff(p_original, p_new, current_row, ignore_fields);
  if (diff->>'conflict')::boolean then
    return jsonb_build_object('status', 'conflict', 'fields', diff->'fields', 'current', current_row);
  end if;
  updated_row := apply_merge(p_table, p_id, diff->'merged');
  if updated_row is null then return jsonb_build_object('status', 'ok', 'row', current_row); end if;
  return jsonb_build_object('status', 'ok', 'row', updated_row);
end; $$;

create or replace function public.smart_merge_lines(p_line_table text, p_fk_col text, p_fk_id uuid,
  p_original_lines jsonb, p_new_lines jsonb, p_ignore_fields text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  current_lines jsonb; orig_map jsonb; cur_map jsonb; final_lines jsonb := '[]'::jsonb;
  conflict_items text[] := array[]::text[]; handled_ids text[] := array[]::text[];
  elem jsonb; lid text; orig_line jsonb; cur_line jsonb; one_result jsonb;
begin
  if not public._can_write(p_line_table) then
    raise exception 'Permission denied: % edit karne ki ijazat nahi', p_line_table;
  end if;
  current_lines := fetch_lines_json(p_line_table, p_fk_col, p_fk_id);
  select coalesce(jsonb_object_agg(e->>'id', e), '{}'::jsonb) into orig_map
    from jsonb_array_elements(p_original_lines) e where e->>'id' is not null;
  select coalesce(jsonb_object_agg(e->>'id', e), '{}'::jsonb) into cur_map
    from jsonb_array_elements(current_lines) e where e->>'id' is not null;
  for elem in select * from jsonb_array_elements(p_new_lines) loop
    lid := elem->>'id';
    if lid is null then final_lines := final_lines || jsonb_build_array(elem - 'id'); continue; end if;
    handled_ids := array_append(handled_ids, lid);
    orig_line := orig_map -> lid; cur_line := cur_map -> lid;
    if cur_line is null then continue; end if;
    if orig_line is null then final_lines := final_lines || jsonb_build_array(cur_line); continue; end if;
    one_result := merge_one_line(orig_line, elem, cur_line, p_ignore_fields);
    if (one_result->>'conflict')::boolean then
      conflict_items := array_append(conflict_items, coalesce(cur_line->>'item_id', 'item'));
    else
      final_lines := final_lines || jsonb_build_array(one_result->'merged');
    end if;
  end loop;
  for elem in select * from jsonb_array_elements(current_lines) loop
    lid := elem->>'id';
    if lid is not null and not (orig_map ? lid) and not (lid = any(handled_ids)) then
      final_lines := final_lines || jsonb_build_array(elem);
    end if;
  end loop;
  if array_length(conflict_items, 1) > 0 then
    return jsonb_build_object('status', 'conflict', 'items', to_jsonb(conflict_items));
  end if;
  return jsonb_build_object('status', 'ok', 'lines', final_lines);
end; $$;

create or replace function public.apply_merged_lines(p_line_table text, p_fk_col text, p_fk_id uuid, p_final_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  elem jsonb; lid text; keep_ids text[] := array[]::text[]; parts text[]; set_clause text; kv record;
  cols text[]; ins_cols text; ord int := 0; lock_date date; doc_date date;
begin
  if public._line_fk(p_line_table) is null or p_fk_col <> public._line_fk(p_line_table) then
    raise exception 'apply_merged_lines is table/column par nahi chal sakta: %.%', p_line_table, p_fk_col;
  end if;
  if not public._can_write(p_line_table) then
    raise exception 'Permission denied: % edit karne ki ijazat nahi', p_line_table;
  end if;
  -- band (locked) mahine ke bill ki lines bhi na badlein
  if p_line_table = 'voucher_lines' then
    select locked_before into lock_date from period_lock where id = 1;
    select vdate into doc_date from vouchers where id = p_fk_id;
    if lock_date is not null and doc_date < lock_date then
      raise exception 'Yeh bill % se pehle ka hai, jo band ho chuka hai (locked before %). Change nahi ho sakta.', doc_date, lock_date;
    end if;
  end if;
  select array_agg(column_name::text) into cols from information_schema.columns
   where table_schema = 'public' and table_name = p_line_table;

  for elem in select * from jsonb_array_elements(p_final_lines) loop
    lid := elem->>'id';
    if lid is not null then
      keep_ids := array_append(keep_ids, lid);
      parts := array[]::text[];
      for kv in select key, value from jsonb_each_text(elem - 'id' - p_fk_col)
                 where key = any (cols) loop
        parts := array_append(parts, format('%I = %L', kv.key, kv.value));
      end loop;
      set_clause := array_to_string(parts, ', ');
      if set_clause is not null and set_clause <> '' then
        execute format('update %I set %s where id = %L::uuid and %I = $1', p_line_table, set_clause, lid, p_fk_col)
          using p_fk_id;
      end if;
    end if;
  end loop;

  if array_length(keep_ids, 1) > 0 then
    execute format('delete from %I where %I = $1 and not (id = any($2::uuid[]))', p_line_table, p_fk_col)
      using p_fk_id, keep_ids;
  else
    execute format('delete from %I where %I = $1', p_line_table, p_fk_col) using p_fk_id;
  end if;

  -- nayi lines: id, parent aur line_no server khud bharta hai; jo column
  -- nahi bheja gaya us ka default lagta hai (NULL nahi)
  for elem in select e from jsonb_array_elements(p_final_lines) e loop
    ord := ord + 1;
    if elem->>'id' is not null then continue; end if;
    elem := (elem - 'id') || jsonb_build_object('id', gen_random_uuid(), p_fk_col, p_fk_id,
                                                'line_no', coalesce(elem->'line_no', to_jsonb(ord)));
    select string_agg(quote_ident(k), ', ') into ins_cols
      from jsonb_object_keys(elem) k where k = any (cols);
    execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)',
                   p_line_table, ins_cols, ins_cols, p_line_table) using elem;
  end loop;
  return jsonb_build_object('status', 'ok');
end; $$;

create or replace function public.log_manual_audit(p_table text, p_record_id uuid, p_label text, p_action text, p_changes jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_active_user() then raise exception 'Permission denied'; end if;
  if p_table !~ '^[a-z_]{1,40}$' then raise exception 'Bad table name'; end if;
  insert into audit_log (table_name, record_id, record_label, action, changed_by, changes)
  values (p_table, p_record_id, left(p_label, 200), left(p_action, 40), auth.uid(), p_changes);
end; $$;

-- ─── 6. Period lock ke baad stock/cost double-count ──────────────
-- Pehle snapshot mein AAJ tak ka stock "lock date" ke naam se save hota
-- tha, phir recompute lock date ke baad wale bills dobara jor deta tha
-- (stock 47 → 44). Ab snapshot sirf lock date se PEHLE ke bills se banta
-- hai (app.cost_until), phir asal recompute snapshot + baad wale bills.
create or replace FUNCTION public.recompute_item_cost(p_item_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  it     record;
    snap   record;
      ln     record;
        run_qty      numeric;
          run_cost     numeric;
            cutoff       date;
              extra        numeric;
                voucher_total numeric;
                  landed_rate  numeric;
                    new_qty      numeric;
 until        date := nullif(current_setting('app.cost_until', true), '')::date;
                    begin
                      select * into it from items where id = p_item_id;
                        if not found then return; end if;

                          select locked_before into cutoff from period_lock where id = 1;
                            select * into snap from item_cost_snapshot where item_id = p_item_id;

                              if snap.item_id is not null and cutoff is not null and snap.as_of_date = cutoff then
                                  run_qty := snap.stock_qty; run_cost := snap.avg_cost;
                                    else
                                        run_qty := coalesce(it.opening_qty, 0); run_cost := coalesce(it.opening_rate, 0); cutoff := null;
                                          end if;

                                            for ln in
                                                (select vl.id as line_id, vl.qty, vl.rate, v.vtype, v.vdate, v.id as voucher_id,
                                                            v.loading_amt, v.cartage_amt, v.cutting_amt, v.loading_on, v.cartage_on, v.cutting_on,
                                                                        null::numeric as ret_cost
                                                                               from voucher_lines vl join vouchers v on v.id = vl.voucher_id
                                                                                     where vl.item_id = p_item_id and v.deleted_at is null and (cutoff is null or v.vdate >= cutoff) and (until is null or v.vdate < until))
                                                                                         union all
                                                                                             (select srl.id, srl.qty, srl.rate, 'return'::text, sr.rdate, sr.id,
                                                                                                         0::numeric, 0::numeric, 0::numeric, false, false, false, srl.cost_amount
                                                                                                                from sales_return_lines srl join sales_returns sr on sr.id = srl.return_id
                                                                                                                      where srl.item_id = p_item_id and sr.deleted_at is null and (cutoff is null or sr.rdate >= cutoff) and (until is null or sr.rdate < until))
                                                                                                                          union all
                                                                                                                              -- Stock Adjustment: sirf quantity badalti hai, bhaao nahi
                                                                                                                                  (select sa.id, sa.qty, 0::numeric, 'adjust'::text, sa.adj_date, sa.id,
                                                                                                                                              0::numeric, 0::numeric, 0::numeric, false, false, false, null::numeric
                                                                                                                                                     from stock_adjustments sa
                                                                                                                                                           where sa.item_id = p_item_id and (cutoff is null or sa.adj_date >= cutoff) and (until is null or sa.adj_date < until))
                                                                                                                                                               order by vdate asc, line_id asc
                                                                                                                                                                 loop
                                                                                                                                                                     if ln.vtype = 'purchase' then
                                                                                                                                                                           select coalesce(sum(qty * rate), 0) into voucher_total
                                                                                                                                                                                   from voucher_lines where voucher_id = ln.voucher_id;
                                                                                                                                                                                         extra := (case when ln.loading_on then ln.loading_amt else 0 end)
                                                                                                                                                                                                      + (case when ln.cartage_on then ln.cartage_amt else 0 end)
                                                                                                                                                                                                                   + (case when ln.cutting_on then ln.cutting_amt else 0 end);
                                                                                                                                                                                                                         if voucher_total > 0 and ln.qty > 0 then
                                                                                                                                                                                                                                 landed_rate := ln.rate + (extra * (ln.qty * ln.rate) / voucher_total) / ln.qty;
                                                                                                                                                                                                                                       else
                                                                                                                                                                                                                                               landed_rate := ln.rate;
                                                                                                                                                                                                                                                     end if;
                                                                                                                                                                                                                                                           new_qty := run_qty + ln.qty;
                                                                                                                                                                                                                                                                 if new_qty > 0 then
                                                                                                                                                                                                                                                                         run_cost := round(((run_qty * run_cost) + (ln.qty * landed_rate)) / new_qty, 4);
                                                                                                                                                                                                                                                                               end if;
                                                                                                                                                                                                                                                                                     run_qty := new_qty;

                                                                                                                                                                                                                                                                                         elsif ln.vtype = 'sale' then
                                                                                                                                                                                                                                                                                               update voucher_lines set cost_amount = round(ln.qty * run_cost, 2) where id = ln.line_id;
                                                                                                                                                                                                                                                                                                     run_qty := run_qty - ln.qty;

                                                                                                                                                                                                                                                                                                         elsif ln.vtype = 'return' then
                                                                                                                                                                                                                                                                                                               new_qty := run_qty + ln.qty;
                                                                                                                                                                                                                                                                                                                     if new_qty > 0 and ln.qty > 0 then
                                                                                                                                                                                                                                                                                                                             run_cost := round(((run_qty * run_cost) + ln.ret_cost) / new_qty, 4);
                                                                                                                                                                                                                                                                                                                                   end if;
                                                                                                                                                                                                                                                                                                                                         run_qty := new_qty;

                                                                                                                                                                                                                                                                                                                                             elsif ln.vtype = 'adjust' then
                                                                                                                                                                                                                                                                                                                                                   -- mojooda average par aata/jata hai, is liye bhaao nahi badalta
                                                                                                                                                                                                                                                                                                                                                         run_qty := run_qty + ln.qty;
                                                                                                                                                                                                                                                                                                                                                             end if;
                                                                                                                                                                                                                                                                                                                                                               end loop;

                                                                                                                                                                                                                                                                                                                                                                 perform set_config('app.system_write', 'true', true);
                                                                                                                                                                                                                                                                                                                                                                   update items set avg_cost = round(run_cost, 4), stock_qty = run_qty where id = p_item_id;
                                                                                                                                                                                                                                                                                                                                                                     perform set_config('app.system_write', 'false', true);
                                                                                                                                                                                                                                                                                                                                                                     end;
                                                                                                                                                                                                                                                                                                                                                                     $function$;

create or replace function public.recompute_all_item_costs(lock_date date)
returns void language plpgsql security definer set search_path = public as $$
declare it_id uuid;
begin
  if not (is_app_admin() or has_perm('period_lock') or has_perm('backup_restore')) then
    raise exception 'Permission denied';
  end if;
  delete from item_cost_snapshot where true;
  if lock_date is not null then
    perform set_config('app.cost_until', lock_date::text, true);
    for it_id in select id from items loop perform recompute_item_cost(it_id); end loop;
    insert into item_cost_snapshot (item_id, as_of_date, avg_cost, stock_qty)
    select id, lock_date, avg_cost, stock_qty from items;
    perform set_config('app.cost_until', '', true);
  end if;
  for it_id in select id from items loop perform recompute_item_cost(it_id); end loop;
end; $$;

-- ─── 7. Period lock: band mahine se bill/din "nikalna" ───────────
-- Pehle sirf NAYI tareekh dekhi jati thi, to locked bill ki date badal
-- kar usay khule mahine mein le jaya ja sakta tha. Ab purani ya nayi,
-- koi bhi tareekh band ho to change mana. Recycle Bin (sirf deleted_at)
-- ab bhi allowed hai — audit columns (updated_at/by, version) ko chhor kar.
create or replace function public.check_period_lock_vouchers()
returns trigger language plpgsql as $$
declare lock_date date; d_old date; d_new date;
begin
  select locked_before into lock_date from period_lock where id = 1;
  if lock_date is null then return coalesce(NEW, OLD); end if;
  if TG_OP = 'UPDATE' then
    d_old := OLD.vdate; d_new := NEW.vdate;
    if d_old < lock_date or d_new < lock_date then
      if to_jsonb(NEW) - 'deleted_at' - 'updated_at' - 'updated_by' - 'version'
         = to_jsonb(OLD) - 'deleted_at' - 'updated_at' - 'updated_by' - 'version' then
        return NEW;   -- sirf soft-delete/restore tha, ijazat hai
      end if;
      raise exception 'Yeh bill % se pehle ka hai, jo band ho chuka hai (locked before %). Change nahi ho sakta.', least(d_old, d_new), lock_date;
    end if;
    return NEW;
  end if;
  if coalesce(NEW.vdate, OLD.vdate) < lock_date then
    raise exception 'Yeh tareekh (%) band ho chuki hai (locked before %). Naya bill nahi ban sakta ya permanently delete nahi ho sakta.', coalesce(NEW.vdate, OLD.vdate), lock_date;
  end if;
  return coalesce(NEW, OLD);
end; $$;

create or replace function public.check_period_lock_sheets()
returns trigger language plpgsql as $$
declare lock_date date; d_old date; d_new date;
begin
  select locked_before into lock_date from period_lock where id = 1;
  if lock_date is null then return coalesce(NEW, OLD); end if;
  if TG_OP = 'UPDATE' then
    d_old := OLD.sheet_date; d_new := NEW.sheet_date;
    if d_old < lock_date or d_new < lock_date then
      if to_jsonb(NEW) - 'deleted_at' - 'updated_at' - 'updated_by' - 'version'
         = to_jsonb(OLD) - 'deleted_at' - 'updated_at' - 'updated_by' - 'version' then
        return NEW;
      end if;
      raise exception 'Yeh din (%) band ho chuka hai (locked before %). Change nahi ho sakta.', least(d_old, d_new), lock_date;
    end if;
    return NEW;
  end if;
  if coalesce(NEW.sheet_date, OLD.sheet_date) < lock_date then
    raise exception 'Yeh tareekh (%) band ho chuki hai (locked before %).', coalesce(NEW.sheet_date, OLD.sheet_date), lock_date;
  end if;
  return coalesce(NEW, OLD);
end; $$;

-- Sales return, service invoice, stock transfer par koi lock tha hi nahi —
-- band mahine mein peeche ki tareekh se naya return/invoice ban jata tha.
create or replace function public.check_period_lock_doc()
returns trigger language plpgsql as $$
declare lock_date date; col text := TG_ARGV[0]; d_old date; d_new date;
begin
  select locked_before into lock_date from period_lock where id = 1;
  if lock_date is null then return coalesce(NEW, OLD); end if;
  if TG_OP <> 'INSERT' then d_old := (to_jsonb(OLD)->>col)::date; end if;
  if TG_OP <> 'DELETE' then d_new := (to_jsonb(NEW)->>col)::date; end if;
  if TG_OP = 'UPDATE' and (d_old < lock_date or d_new < lock_date)
     and to_jsonb(NEW) - 'deleted_at' - 'updated_at' - 'updated_by' - 'version'
       = to_jsonb(OLD) - 'deleted_at' - 'updated_at' - 'updated_by' - 'version' then
    return NEW;
  end if;
  if d_old < lock_date or d_new < lock_date then
    raise exception 'Yeh tareekh (%) band ho chuki hai (locked before %). Change nahi ho sakta.', least(d_old, d_new), lock_date;
  end if;
  return coalesce(NEW, OLD);
end; $$;
drop trigger if exists trg_period_lock_sales_returns on public.sales_returns;
create trigger trg_period_lock_sales_returns before insert or update or delete on public.sales_returns
  for each row execute function public.check_period_lock_doc('rdate');
drop trigger if exists trg_period_lock_service_invoices on public.service_invoices;
create trigger trg_period_lock_service_invoices before insert or update or delete on public.service_invoices
  for each row execute function public.check_period_lock_doc('sidate');
drop trigger if exists trg_period_lock_stock_transfers on public.stock_transfers;
create trigger trg_period_lock_stock_transfers before insert or update or delete on public.stock_transfers
  for each row execute function public.check_period_lock_doc('tdate');

-- ─── 8. Numbering: 9999 ke baad number kat jata tha ──────────────
-- lpad(x, 4) "10000" ko "1000" bana deta hai (purane number se takrao).
create or replace function public.assign_voucher_number()
returns trigger language plpgsql as $$
declare n bigint;
begin
  if NEW.vno is null or trim(NEW.vno) = '' then
    if NEW.vtype = 'sale' then
      n := nextval('voucher_sale_seq');
      NEW.vno := 'S-' || case when n > 9999 then n::text else lpad(n::text, 4, '0') end;
    else
      n := nextval('voucher_purchase_seq');
      NEW.vno := 'P-' || case when n > 9999 then n::text else lpad(n::text, 4, '0') end;
    end if;
  end if;
  return NEW;
end; $$;
create or replace function public.assign_service_invoice_number()
returns trigger language plpgsql as $$
declare n bigint;
begin
  if NEW.sino is null or trim(NEW.sino) = '' then
    n := nextval('service_invoice_seq');
    NEW.sino := 'SV-' || case when n > 9999 then n::text else lpad(n::text, 4, '0') end;
  end if;
  return NEW;
end; $$;

-- ─── 9. Wipe Test Data lock lagne par fail hota tha ─────────────
create or replace FUNCTION public.wipe_test_data(p_include_masters boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_app_admin() then
    raise exception 'Sirf admin ye kar sakta hai';
  end if;

  -- lock pehle hatao, warna band mahine ke bill delete nahi hote aur wipe fail
  update period_lock set locked_before = null where id = 1;

  delete from sales_return_lines where true;
  delete from voucher_lines where true;
  delete from quotation_lines where true;
  delete from po_lines where true;
  delete from stock_adjustments where true;
  delete from audit_log where true;
  delete from item_cost_snapshot where true;
  delete from party_opening_balances where true;
  delete from sales_returns where true;
  delete from vouchers where true;
  delete from quotations where true;
  delete from purchase_orders where true;
  delete from sheets where true;

  delete from service_quotation_lines where true;
  delete from service_quotations where true;
  delete from service_invoice_lines where true;
  delete from service_invoices where true;
  delete from recurring_service_templates where true;

  update items set avg_cost = 0, stock_qty = 0 where true;

  if p_include_masters then
    delete from item_units where true;
    delete from parties where true;
    delete from items where true;
    delete from companies where true;
  end if;

  return jsonb_build_object('status', 'ok');
end;
$function$;

-- ─── 10. Return wapas laane (restore) par had se zyada return ─────
-- Return 10, delete, dobara return 10, phir pehla restore → 20 wapas,
-- jab ke 10 hi bika tha. Restore par har line ki had dobara check ho.
-- Saath hi sale line ko lock karte hain taake do returns ek saath
-- had paar na kar sakein.
create or replace function public.trg_check_return_restore()
returns trigger language plpgsql security definer set search_path = public as $$
declare l record; avail numeric;
begin
  if OLD.deleted_at is not null and NEW.deleted_at is null then
    for l in select sale_line_id, sum(qty) q from sales_return_lines
              where return_id = NEW.id and sale_line_id is not null group by sale_line_id loop
      perform 1 from voucher_lines where id = l.sale_line_id for update;
      avail := returnable_qty(l.sale_line_id);   -- yeh return abhi deleted hai, is liye shamil nahi
      if l.q > avail then
        raise exception 'Ye return wapas nahi aa sakta: sirf % tak hi return ho sakta hai (baaki pehle hi wapas ho chuka)', avail;
      end if;
    end loop;
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_return_restore_qty on public.sales_returns;
create trigger trg_return_restore_qty before update of deleted_at on public.sales_returns
  for each row execute function public.trg_check_return_restore();

create or replace function public.trg_check_returnable_qty()
returns trigger language plpgsql security definer set search_path = public as $$
declare avail numeric;
begin
  if NEW.sale_line_id is null then
    raise exception 'Return line ko original sale-line se juda hona zaroori hai';
  end if;
  perform 1 from voucher_lines where id = NEW.sale_line_id for update;
  avail := returnable_qty(NEW.sale_line_id);
  if TG_OP = 'UPDATE' and OLD.sale_line_id = NEW.sale_line_id then avail := avail + OLD.qty; end if;
  if NEW.qty > avail then
    raise exception 'Sirf % tak hi return ho sakta hai (baaki pehle hi wapas ho chuka)', avail;
  end if;
  return NEW;
end; $$;

-- ─── 11. Chhoti hifazatein ───────────────────────────────────────
-- Daily Ledger: Recycle Bin wali (deleted) sheet usi tareekh par nayi sheet na banne deti thi
alter table public.sheets drop constraint if exists sheets_sheet_date_key;
create unique index if not exists sheets_sheet_date_live_uniq on public.sheets(sheet_date) where deleted_at is null;

-- Restore period_lock row ko insert kar sake (sirf admin / period_lock wala)
drop policy if exists "period_lock insert" on public.period_lock;
create policy "period_lock insert" on public.period_lock for insert
  with check (is_app_admin() or has_perm('period_lock'));

-- Clerk (sirf bill_create) ka bill aadha save ho (header bana, lines fail)
-- to wo apna KHALI header 10 minute ke andar hata sake
drop policy if exists "vouchers delete own empty" on public.vouchers;
create policy "vouchers delete own empty" on public.vouchers for delete using (
  created_by = auth.uid() and created_at > now() - interval '10 minutes'
  and not exists (select 1 from voucher_lines l where l.voucher_id = vouchers.id));
drop policy if exists "po delete own empty" on public.purchase_orders;
create policy "po delete own empty" on public.purchase_orders for delete using (
  created_by = auth.uid() and coalesce(updated_at, now()) > now() - interval '10 minutes'
  and not exists (select 1 from po_lines l where l.po_id = purchase_orders.id));
drop policy if exists "quotations delete own empty" on public.quotations;
create policy "quotations delete own empty" on public.quotations for delete using (
  created_by = auth.uid() and coalesce(updated_at, now()) > now() - interval '10 minutes'
  and not exists (select 1 from quotation_lines l where l.quotation_id = quotations.id));
drop policy if exists "sales_returns delete own empty" on public.sales_returns;
create policy "sales_returns delete own empty" on public.sales_returns for delete using (
  created_by = auth.uid() and coalesce(updated_at, now()) > now() - interval '10 minutes'
  and not exists (select 1 from sales_return_lines l where l.return_id = sales_returns.id));
drop policy if exists "stock_transfers delete own empty" on public.stock_transfers;
create policy "stock_transfers delete own empty" on public.stock_transfers for delete using (
  (is_app_admin() or created_by = auth.uid()) and coalesce(updated_at, now()) > now() - interval '10 minutes'
  and not exists (select 1 from stock_transfer_lines l where l.transfer_id = stock_transfers.id));

-- Sequence app ke haath se diye numbers se peeche reh jata tha → recurring
-- invoice "number pehle se hai" par fail. Sirf aage barhta hai, kabhi peeche nahi.
select setval('public.service_invoice_seq', greatest(
  (select last_value from public.service_invoice_seq),
  (select coalesce(max(substring(sino from 4)::bigint), 1) from public.service_invoices where sino ~ '^SV-\d+$')));
select setval('public.voucher_sale_seq', greatest(
  (select last_value from public.voucher_sale_seq),
  (select coalesce(max(substring(vno from 3)::bigint), 1) from public.vouchers where vtype = 'sale' and vno ~ '^S-\d+$')));
select setval('public.voucher_purchase_seq', greatest(
  (select last_value from public.voucher_purchase_seq),
  (select coalesce(max(substring(vno from 3)::bigint), 1) from public.vouchers where vtype = 'purchase' and vno ~ '^P-\d+$')));

-- ─── 5. purane debug functions ───────────────────────────────────
drop function if exists public.test_fn(integer, integer);
drop function if exists public.test_fn2(text, uuid);
drop function if exists public.test_fn3(jsonb);
drop function if exists public.test_fn4(jsonb);
drop function if exists public.test_fn5(text, uuid, text);
drop function if exists public.audit_trigger_fn();

-- ─── 3b. EXECUTE: bina login (anon) koi function nahi ────────────
do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p where p.pronamespace = 'public'::regnamespace loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
-- andar se hi chalne wale (seedha RPC se nahi)
revoke execute on function public.apply_merge(text, uuid, jsonb) from authenticated;
revoke execute on function public.fetch_lines_json(text, text, uuid) from authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

notify pgrst, 'reload schema';
select 'FIXES 2026-10-21 OK' as result;
