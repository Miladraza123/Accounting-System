-- Purchase Order custom (non-stock) items — run once in the Supabase SQL
-- Editor of the project this app connects to. Same columns quotation_lines
-- already has. Until this runs, a PO with a custom line is refused with
-- "Could not find the 'custom_name' column of 'po_lines'"; ordinary stock
-- POs keep saving either way.
alter table po_lines add column if not exists custom_name text;
alter table po_lines add column if not exists custom_unit text;
