-- ============================================================
-- Riders Miami Motorsports — Supabase Setup  v2
-- Run in: Supabase → SQL Editor → New Query → Run
-- Safe to run multiple times
-- ============================================================

-- 1. PARTS TABLE
create table if not exists public.parts (
  id                text primary key,
  name              text not null default '',
  category          text default '',
  condition         text default 'Used',
  make              text default '',
  model             text default '',
  year              text default '',
  oemnum            text default '',
  location          text default '',
  qty               integer default 1,
  price             numeric(10,2) default 0,
  notes             text default '',
  ebay_listing_id   text,
  ebay_listing_url  text,
  ebay_env          text,
  ebay_sold_qty     integer default 0,
  ebay_last_sold    timestamptz,
  ebay_status       text,
  ebay_status_at    timestamptz,
  pending_review    boolean default false,
  review_note       text default '',
  added_by          text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- Migrate existing tables safely
alter table public.parts add column if not exists ebay_status       text;
alter table public.parts add column if not exists ebay_status_at    timestamptz;
alter table public.parts add column if not exists pending_review    boolean default false;
alter table public.parts add column if not exists review_note       text default '';

-- 2. ACTIVITY LOG TABLE
create table if not exists public.activity_log (
  id          bigserial primary key,
  part_id     text references public.parts(id) on delete set null,
  part_name   text,
  action      text not null,  -- 'added' | 'edited' | 'deleted' | 'listed' | 'flagged' | 'approved'
  user_email  text,
  user_role   text,
  detail      text,
  created_at  timestamptz default now()
);

-- 3. ROW LEVEL SECURITY
alter table public.parts        enable row level security;
alter table public.activity_log enable row level security;

-- Drop and recreate policies cleanly
drop policy if exists "Authenticated users can read parts"        on public.parts;
drop policy if exists "Authenticated users can insert parts"      on public.parts;
drop policy if exists "Authenticated users can update parts"      on public.parts;
drop policy if exists "Authenticated users can delete parts"      on public.parts;
drop policy if exists "Authenticated users can read activity_log" on public.activity_log;
drop policy if exists "Authenticated users can insert activity_log" on public.activity_log;

create policy "Authenticated users can read parts"
  on public.parts for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert parts"
  on public.parts for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can update parts"
  on public.parts for update using (auth.role() = 'authenticated');
create policy "Authenticated users can delete parts"
  on public.parts for delete using (auth.role() = 'authenticated');

create policy "Authenticated users can read activity_log"
  on public.activity_log for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert activity_log"
  on public.activity_log for insert with check (auth.role() = 'authenticated');

-- 4. REALTIME
alter publication supabase_realtime add table public.parts;

-- 5. INDEXES
create index if not exists parts_category_idx    on public.parts(category);
create index if not exists parts_make_idx         on public.parts(make);
create index if not exists parts_location_idx     on public.parts(location);
create index if not exists parts_updated_at_idx   on public.parts(updated_at desc);
create index if not exists parts_ebay_status_idx  on public.parts(ebay_status);
create index if not exists parts_pending_review_idx on public.parts(pending_review);
create index if not exists activity_log_part_idx  on public.activity_log(part_id);
create index if not exists activity_log_time_idx  on public.activity_log(created_at desc);

-- ============================================================
-- ROLES — stored in app_metadata (users can't edit it themselves).
-- After this file, ALSO run supabase/migrations/20261008_roles_and_rls.sql,
-- which tightens the policies above and enforces roles in the database.
--   {"role": "admin"}   — full access
--   {"role": "logger"}  — data entry only
--
-- Set a role with SQL:
--   update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'
--   where email = 'your@email.com';
-- ============================================================

-- 6. STORAGE BUCKET for eBay listing photos
insert into storage.buckets (id, name, public)
values ('parts-photos', 'parts-photos', true)
on conflict (id) do nothing;

drop policy if exists "Public read parts photos"           on storage.objects;
drop policy if exists "Authenticated upload parts photos"  on storage.objects;

create policy "Public read parts photos"
  on storage.objects for select
  using (bucket_id = 'parts-photos');
create policy "Authenticated upload parts photos"
  on storage.objects for insert
  with check (bucket_id = 'parts-photos' and auth.uid() is not null);

-- ============================================================
-- DONE. Next steps:
-- 1. Run supabase/migrations/20261008_roles_and_rls.sql, then set roles in raw_app_meta_data
-- 2. Deploy zip to Netlify
-- 3. Sign in — role is read automatically on login
-- ============================================================
