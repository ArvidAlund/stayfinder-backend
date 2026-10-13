-- StayFinder schema: tables, RLS, and booking business rules enforced in the database.
-- Rules live here (not only in the API) so they hold even when someone calls the DB/API directly.

create extension if not exists btree_gist;

create type booking_status as enum ('pending', 'confirmed', 'cancelled');

-- ---------- properties ----------
create table public.properties (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  description text not null default '',
  location text not null check (length(trim(location)) > 0),
  price_per_night numeric(10, 2) not null check (price_per_night > 0),
  max_guests int not null check (max_guests > 0),
  created_at timestamptz not null default now()
);
create index properties_owner_idx on public.properties (owner_id);

-- ---------- bookings ----------
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  guest_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  guest_email text not null check (guest_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  check_in date not null,
  check_out date not null,
  guests int not null check (guests > 0),
  status booking_status not null default 'pending',
  price_per_night numeric(10, 2) not null default 0,  -- snapshot, set by trigger
  total_price numeric(12, 2) not null default 0,      -- set by trigger
  created_at timestamptz not null default now(),
  constraint bookings_dates_chk check (check_out > check_in),
  -- VG2: no overlapping, non-cancelled bookings per property (an UPDATE never conflicts with itself)
  constraint bookings_no_overlap exclude using gist (
    property_id with =,
    daterange(check_in, check_out, '[)') with &&
  ) where (status <> 'cancelled')
);
create index bookings_guest_idx on public.bookings (guest_id);

-- ---------- booking rules (VG2-VG6) ----------
create or replace function public.bookings_guard() returns trigger
language plpgsql as $$
declare
  prop public.properties%rowtype;
  uid uuid := auth.uid();
  is_owner boolean;
  is_guest boolean;
begin
  select * into prop from public.properties where id = new.property_id;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND: property does not exist' using errcode = 'P0002';
  end if;

  if tg_op = 'INSERT' then
    new.guest_id := coalesce(uid, new.guest_id);
    new.status := 'pending';
    if new.check_in < current_date then
      raise exception 'CHECKIN_IN_PAST: check-in date has already passed' using errcode = 'P0001';
    end if;
    if new.guests > prop.max_guests then
      raise exception 'CAPACITY_EXCEEDED: property allows at most % guests', prop.max_guests using errcode = 'P0001';
    end if;
    new.price_per_night := prop.price_per_night;             -- VG6: server decides price
    new.total_price := (new.check_out - new.check_in) * prop.price_per_night;
    return new;
  end if;

  -- UPDATE
  if new.property_id <> old.property_id or new.guest_id <> old.guest_id then
    raise exception 'IMMUTABLE_FIELD: property and guest cannot be changed' using errcode = 'P0001';
  end if;

  is_owner := prop.owner_id = uid;
  is_guest := old.guest_id = uid;

  if old.status = 'cancelled' then
    raise exception 'BOOKING_CANCELLED: a cancelled booking cannot be changed' using errcode = 'P0001';
  end if;
  if old.check_in < current_date then
    raise exception 'CHECKIN_PASSED: booking can no longer be changed or cancelled' using errcode = 'P0001';
  end if;

  -- status flow (VG4)
  if new.status <> old.status then
    if new.status = 'confirmed' then
      if old.status <> 'pending' then
        raise exception 'INVALID_TRANSITION: only pending bookings can be confirmed' using errcode = 'P0001';
      end if;
      if uid is not null and not is_owner then
        raise exception 'FORBIDDEN_TRANSITION: only the property owner can confirm' using errcode = 'P0001';
      end if;
    elsif new.status = 'cancelled' then
      if uid is not null and not (is_owner or is_guest) then
        raise exception 'FORBIDDEN_TRANSITION: only guest or owner can cancel' using errcode = 'P0001';
      end if;
    else
      raise exception 'INVALID_TRANSITION: cannot go from % to %', old.status, new.status using errcode = 'P0001';
    end if;
  end if;

  -- the owner may only change status; field edits belong to the guest
  if uid is not null and not is_guest and (
       new.check_in <> old.check_in or new.check_out <> old.check_out
    or new.guests <> old.guests or new.guest_email <> old.guest_email) then
    raise exception 'FORBIDDEN_EDIT: only the guest can edit booking details' using errcode = 'P0001';
  end if;

  if new.check_in <> old.check_in and new.check_in < current_date then
    raise exception 'CHECKIN_IN_PAST: check-in date has already passed' using errcode = 'P0001';
  end if;
  if new.guests > prop.max_guests then
    raise exception 'CAPACITY_EXCEEDED: property allows at most % guests', prop.max_guests using errcode = 'P0001';
  end if;

  -- price is never taken from the client; reuse the snapshot so later price changes don't apply
  new.price_per_night := old.price_per_night;
  new.total_price := (new.check_out - new.check_in) * old.price_per_night;
  return new;
end $$;

create trigger bookings_guard_trg
  before insert or update on public.bookings
  for each row execute function public.bookings_guard();

-- deleting a booking whose check-in has passed is not allowed either (VG5)
create or replace function public.bookings_guard_delete() returns trigger
language plpgsql as $$
begin
  if old.check_in < current_date then
    raise exception 'CHECKIN_PASSED: booking can no longer be changed or cancelled' using errcode = 'P0001';
  end if;
  return old;
end $$;

create trigger bookings_guard_delete_trg
  before delete on public.bookings
  for each row execute function public.bookings_guard_delete();

-- ---------- availability search (VG7) ----------
-- security definer: guests cannot read other people's bookings through RLS, but need to know what is free.
create or replace function public.available_property_ids(p_from date, p_to date)
returns setof uuid
language sql stable security definer set search_path = public as $$
  select p.id from public.properties p
  where not exists (
    select 1 from public.bookings b
    where b.property_id = p.id and b.status <> 'cancelled'
      and daterange(b.check_in, b.check_out, '[)') && daterange(p_from, p_to, '[)')
  );
$$;
grant execute on function public.available_property_ids(date, date) to anon, authenticated;

-- ---------- RLS (G6, G15, VG1) ----------
alter table public.properties enable row level security;
alter table public.bookings enable row level security;

create policy properties_select on public.properties for select using (true);
create policy properties_insert on public.properties for insert to authenticated
  with check (owner_id = auth.uid());
create policy properties_update on public.properties for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy properties_delete on public.properties for delete to authenticated
  using (owner_id = auth.uid());

create policy bookings_select on public.bookings for select to authenticated
  using (guest_id = auth.uid()
         or exists (select 1 from public.properties p where p.id = property_id and p.owner_id = auth.uid()));
create policy bookings_insert on public.bookings for insert to authenticated
  with check (guest_id = auth.uid());
create policy bookings_update on public.bookings for update to authenticated
  using (guest_id = auth.uid()
         or exists (select 1 from public.properties p where p.id = property_id and p.owner_id = auth.uid()))
  with check (guest_id = auth.uid()
         or exists (select 1 from public.properties p where p.id = property_id and p.owner_id = auth.uid()));
create policy bookings_delete on public.bookings for delete to authenticated
  using (guest_id = auth.uid());

revoke all on public.bookings from anon;
