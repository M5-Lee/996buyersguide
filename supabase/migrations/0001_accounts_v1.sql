-- 996 Buyer's Guide — Accounts v1
-- Draft migration. This file is NOT applied to the live Supabase project
-- by the pull request. Lee pastes it into the SQL editor, or runs
-- `supabase db push` only after `supabase link --project-ref iubuiipzegwlzqjoftpj`.
-- No admin role, no admin view, no policies for anon.

-- ---------------------------------------------------------------------------
-- profiles: one row per signed-in user
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  shop_contact_ok boolean not null default false,
  shop_contact_changed_at timestamptz,
  shop_contact_wording_version text,
  phone text,
  privacy_terms_version text,
  demo_imported_at timestamptz,
  created_at timestamptz not null default now(),
  constraint profiles_phone_requires_shop check (phone is null or shop_contact_ok)
);

-- Stamp the shop-contact time when the box changes, and drop the phone
-- when the box is off. The client also clears the phone when unchecked.
create or replace function public.profiles_sync_shop_contact()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.shop_contact_changed_at = coalesce(new.shop_contact_changed_at, now());
    if new.shop_contact_ok is not true then
      new.phone = null;
    end if;
    return new;
  end if;

  if new.shop_contact_ok is distinct from old.shop_contact_ok then
    new.shop_contact_changed_at = now();
  end if;
  if new.shop_contact_ok is not true then
    new.phone = null;
  end if;
  return new;
end;
$$;

create trigger profiles_sync_shop_contact
  before insert or update on public.profiles
  for each row
  execute function public.profiles_sync_shop_contact();

-- ---------------------------------------------------------------------------
-- cars
-- ---------------------------------------------------------------------------
create table public.cars (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  year smallint not null check (year between 1999 and 2005),
  model text not null check (model in (
    'Carrera', 'Carrera 4', 'Carrera 4S', 'Cabriolet', 'Targa',
    'Turbo', 'Turbo S', 'GT3', 'GT2'
  )),
  trans text check (trans in ('6MT', 'Tiptronic') or trans is null),
  color text check (color is null or color in (
    'Black',
    'Basalt Black Metallic',
    'Arctic Silver Metallic',
    'Polar Silver Metallic',
    'GT Silver Metallic',
    'Meridian Grey Metallic',
    'Slate Grey Metallic',
    'Seal Grey Metallic',
    'Vesuvio Metallic',
    'Carrara White',
    'Biarritz White',
    'Firn White',
    'Glacier White',
    'Guards Red',
    'Arena Red Metallic',
    'Orient Red Metallic',
    'Zanzibar Red',
    'Speed Yellow',
    'Pastel Yellow',
    'Fayence Yellow',
    'Ocean Blue Metallic',
    'Zenith Blue Metallic',
    'Lapis Blue Metallic',
    'Cobalt Blue Metallic',
    'Midnight Blue Metallic',
    'Iris Blue Metallic',
    'Violet Blue Metallic',
    'Riviera Blue',
    'Amethyst Metallic',
    'Pine Green Metallic',
    'Ocean Jade Metallic',
    'Wimbledon Green Metallic',
    'Rainforest Green Metallic',
    'Paint to Sample (PTS)',
    'Other / not listed'
  )),
  mileage integer check (mileage >= 0),
  vin text check (vin is null or (vin = upper(vin) and char_length(vin) <= 17)),
  status text not null default 'shopping' check (status in ('own', 'shopping', 'dream')),
  notes text,
  rare_spec_ids text[] not null default '{}',
  imported_from_demo_id text,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cars_rare_spec_ids_known check (
    rare_spec_ids <@ array[
      'R1','R2','R3','R4','R5','R6','R7','R8','R9','R10','R11','R12','R13','R14'
    ]::text[]
  )
);

create or replace function public.cars_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger cars_set_updated_at
  before update on public.cars
  for each row
  execute function public.cars_set_updated_at();

create index cars_user_id_idx on public.cars (user_id);

-- ---------------------------------------------------------------------------
-- inspections: one current inspection per car. answers jsonb is the source of truth.
-- ---------------------------------------------------------------------------
create table public.inspections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  car_id uuid not null references public.cars (id) on delete cascade,
  answers jsonb not null default '{}',
  chassis_key text,
  trans_key text check (trans_key in ('mt', 'at', '') or trans_key is null),
  done integer,
  flags integer,
  total integer,
  verdict text,
  verdict_class text check (
    verdict_class in ('vc-pass', 'vc-caution', 'vc-walk', 'vc-pending')
    or verdict_class is null
  ),
  pct integer,
  weighted_pct integer,
  tier1_walk boolean,
  saved_at timestamptz not null default now(),
  unique (car_id)
);

create index inspections_user_id_idx on public.inspections (user_id);
-- car_id is covered by the unique constraint index.

-- ---------------------------------------------------------------------------
-- photos (table now, UI in v1.1). Cap 5 per car. Path must live under the owner id.
-- ---------------------------------------------------------------------------
create table public.photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  car_id uuid not null references public.cars (id) on delete cascade,
  storage_path text not null,
  caption text,
  size_bytes integer,
  uploaded_at timestamptz default now(),
  constraint photos_storage_path_owner check (
    storage_path like (user_id::text || '/' || car_id::text || '/%')
    and position('..' in storage_path) = 0
  )
);

create index photos_user_id_idx on public.photos (user_id);
create index photos_car_id_idx on public.photos (car_id);

create or replace function public.photos_reject_sixth()
returns trigger
language plpgsql
as $$
declare
  n integer;
begin
  perform pg_advisory_xact_lock(hashtext(new.car_id::text));
  select count(*) into n
  from public.photos
  where car_id = new.car_id;
  if n >= 5 then
    raise exception 'photo cap: a car can have at most 5 photos';
  end if;
  return new;
end;
$$;

create trigger photos_cap_five
  before insert on public.photos
  for each row
  execute function public.photos_reject_sixth();

-- ---------------------------------------------------------------------------
-- Row level security
-- Postgres accepts USING on select/update/delete and WITH CHECK on
-- insert/update. Each table has select, insert, update, and delete policies
-- for `authenticated` only. There are no anon policies and no admin policies.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.cars enable row level security;
alter table public.inspections enable row level security;
alter table public.photos enable row level security;

create policy profiles_select on public.profiles
  for select to authenticated
  using (user_id = auth.uid());
create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (user_id = auth.uid());
create policy profiles_update on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy profiles_delete on public.profiles
  for delete to authenticated
  using (user_id = auth.uid());

create policy cars_select on public.cars
  for select to authenticated
  using (user_id = auth.uid());
create policy cars_insert on public.cars
  for insert to authenticated
  with check (user_id = auth.uid());
create policy cars_update on public.cars
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy cars_delete on public.cars
  for delete to authenticated
  using (user_id = auth.uid());

create policy inspections_select on public.inspections
  for select to authenticated
  using (user_id = auth.uid());
create policy inspections_insert on public.inspections
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.cars c
      where c.id = car_id and c.user_id = auth.uid()
    )
  );
create policy inspections_update on public.inspections
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.cars c
      where c.id = car_id and c.user_id = auth.uid()
    )
  );
create policy inspections_delete on public.inspections
  for delete to authenticated
  using (user_id = auth.uid());

create policy photos_select on public.photos
  for select to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.cars c
      where c.id = car_id and c.user_id = auth.uid()
    )
  );
create policy photos_insert on public.photos
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and storage_path like (auth.uid()::text || '/' || car_id::text || '/%')
    and exists (
      select 1 from public.cars c
      where c.id = car_id and c.user_id = auth.uid()
    )
  );
create policy photos_update on public.photos
  for update to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.cars c
      where c.id = car_id and c.user_id = auth.uid()
    )
  )
  with check (
    user_id = auth.uid()
    and storage_path like (auth.uid()::text || '/' || car_id::text || '/%')
    and exists (
      select 1 from public.cars c
      where c.id = car_id and c.user_id = auth.uid()
    )
  );
create policy photos_delete on public.photos
  for delete to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.cars c
      where c.id = car_id and c.user_id = auth.uid()
    )
  );

revoke all on table public.profiles from anon;
revoke all on table public.cars from anon;
revoke all on table public.inspections from anon;
revoke all on table public.photos from anon;

grant select, insert, update, delete on table public.profiles to authenticated;
grant select, insert, update, delete on table public.cars to authenticated;
grant select, insert, update, delete on table public.inspections to authenticated;
grant select, insert, update, delete on table public.photos to authenticated;

-- ---------------------------------------------------------------------------
-- Private photo bucket. Objects are not removed by row cascades;
-- supabase/functions/delete-account removes the files.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'car-photos',
  'car-photos',
  false,
  614400, -- 600 KiB, about 600 KB
  array['image/jpeg']::text[]
);

-- storage.objects already has row level security on.
-- Supabase rejects `alter table storage.objects enable row level security`.
-- Files live at {user id}/{car id}/{file}.jpg. The second folder must be a car this user owns.

create policy car_photos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'car-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.cars c
      where c.user_id = auth.uid()
        and c.id::text = (storage.foldername(name))[2]
    )
  );
create policy car_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'car-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.cars c
      where c.user_id = auth.uid()
        and c.id::text = (storage.foldername(name))[2]
    )
  );
create policy car_photos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'car-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.cars c
      where c.user_id = auth.uid()
        and c.id::text = (storage.foldername(name))[2]
    )
  )
  with check (
    bucket_id = 'car-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.cars c
      where c.user_id = auth.uid()
        and c.id::text = (storage.foldername(name))[2]
    )
  );
create policy car_photos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'car-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.cars c
      where c.user_id = auth.uid()
        and c.id::text = (storage.foldername(name))[2]
    )
  );

-- ---------------------------------------------------------------------------
-- Verification (Product acceptance check #10)
-- List every public table and whether row level security is on:
-- select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relkind = 'r'
-- order by c.relname;
--
-- List every policy on public and storage:
-- select * from pg_policies where schemaname in ('public', 'storage');
-- ---------------------------------------------------------------------------
