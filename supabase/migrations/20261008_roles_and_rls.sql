-- ============================================================
-- Redline IMS — enforce roles in the database
-- Run ONCE in: Supabase → SQL Editor → New Query → Run   (safe to re-run)
-- Run it BEFORE deploying the matching app build (see SECURITY_DEPLOY.md).
--
-- Why: roles used to live in user_metadata, which every signed-in user can edit
-- for themselves (supabase.auth.updateUser({ data: { role: 'admin' } })), and every
-- RLS policy allowed any signed-in user to insert/update/delete anything.
-- After this migration the role lives in app_metadata (only the service role / SQL
-- can change it) and the database enforces what the app UI already implies.
-- ============================================================

-- 1. Copy each user's existing role from user_metadata into app_metadata.
--    Users with no role become Data loggers (the app's existing default).
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                        || jsonb_build_object('role', coalesce(raw_user_meta_data->>'role', 'logger'))
where (raw_app_meta_data->>'role') is null;

-- 2. Helper: is the caller an admin? (reads the signed JWT, not editable by users)
create or replace function public.is_admin()
returns boolean
language sql stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
$$;

-- 3. PARTS: everyone signed in can read, add and update (loggers add parts and flag them);
--    only admins can delete.
drop policy if exists "Authenticated users can read parts"   on public.parts;
drop policy if exists "Authenticated users can insert parts" on public.parts;
drop policy if exists "Authenticated users can update parts" on public.parts;
drop policy if exists "Authenticated users can delete parts" on public.parts;
drop policy if exists "Signed-in users can read parts"       on public.parts;
drop policy if exists "Signed-in users can add parts"        on public.parts;
drop policy if exists "Signed-in users can update parts"     on public.parts;
drop policy if exists "Admins can delete parts"              on public.parts;

create policy "Signed-in users can read parts"
  on public.parts for select using (auth.role() = 'authenticated');
create policy "Signed-in users can add parts"
  on public.parts for insert with check (auth.role() = 'authenticated');
create policy "Signed-in users can update parts"
  on public.parts for update using (auth.role() = 'authenticated');
create policy "Admins can delete parts"
  on public.parts for delete using (public.is_admin());

-- Only admins may change a part's price once it exists (the app shows price as read-only to loggers).
-- SQL editor / service-role changes are not affected.
create or replace function public.parts_guard()
returns trigger
language plpgsql
as $$
begin
  if auth.role() = 'authenticated' and not public.is_admin()
     and new.price is distinct from old.price then
    raise exception 'Only admins can change prices' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists parts_guard on public.parts;
create trigger parts_guard before update on public.parts
  for each row execute function public.parts_guard();

-- 4. ACTIVITY LOG: everyone signed in can write entries; only admins can read the log.
--    Who did it is stamped from the JWT, so it can't be spoofed by the browser.
drop policy if exists "Authenticated users can read activity_log"   on public.activity_log;
drop policy if exists "Authenticated users can insert activity_log" on public.activity_log;
drop policy if exists "Admins can read activity_log"                on public.activity_log;
drop policy if exists "Signed-in users can add activity_log"        on public.activity_log;

create policy "Admins can read activity_log"
  on public.activity_log for select using (public.is_admin());
create policy "Signed-in users can add activity_log"
  on public.activity_log for insert with check (auth.role() = 'authenticated');

create or replace function public.activity_log_stamp()
returns trigger
language plpgsql
as $$
begin
  if auth.role() = 'authenticated' then
    new.user_email := auth.jwt() ->> 'email';
    new.user_role  := case when public.is_admin() then 'admin' else 'logger' end;
    new.created_at := now();
  end if;
  return new;
end
$$;
drop trigger if exists activity_log_stamp on public.activity_log;
create trigger activity_log_stamp before insert on public.activity_log
  for each row execute function public.activity_log_stamp();

-- 5. STORAGE: only admins upload eBay listing photos (public read is unchanged).
drop policy if exists "Authenticated upload parts photos" on storage.objects;
drop policy if exists "Admins upload parts photos"        on storage.objects;
create policy "Admins upload parts photos"
  on storage.objects for insert
  with check (bucket_id = 'parts-photos' and public.is_admin());

-- ============================================================
-- Managing roles from now on (user_metadata.role is ignored by the app):
--   update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'
--   where email = 'someone@yourshop.com';
--   update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"logger"}'
--   where email = 'counter@yourshop.com';
-- A role change takes effect the next time that person signs in.
-- ============================================================
