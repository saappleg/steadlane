-- Steadlane beta: passenger-owned quotes and bookings with invite-only drivers.
-- Apply this migration as the Supabase project database owner.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;
grant usage on schema private to supabase_auth_admin;
grant usage on schema public to authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'passenger' check (role in ('passenger', 'driver')),
  full_name text,
  phone text,
  created_at timestamptz not null default pg_catalog.now(),
  constraint profiles_full_name_length check (
    full_name is null or pg_catalog.length(pg_catalog.btrim(full_name)) between 2 and 120
  ),
  constraint profiles_phone_format check (
    phone is null or (phone ~ '^[+0-9() .-]{7,25}$' and phone ~ '[0-9]')
  )
);

alter table public.profiles enable row level security;
revoke all on table public.profiles from public, anon, authenticated, service_role;
grant select on table public.profiles to authenticated;
grant update (full_name, phone) on table public.profiles to authenticated;

create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

create policy profiles_update_own_contact
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_full_name text;
  v_phone text;
begin
  v_full_name := nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), '');
  if v_full_name is not null and pg_catalog.length(v_full_name) not between 2 and 120 then
    v_full_name := null;
  end if;

  v_phone := nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'phone'), '');
  if v_phone is not null and (v_phone !~ '^[+0-9() .-]{7,25}$' or v_phone !~ '[0-9]') then
    v_phone := null;
  end if;

  insert into public.profiles (id, role, full_name, phone)
  values (new.id, 'passenger', v_full_name, v_phone)
  on conflict (id) do nothing;
  return new;
end;
$function$;

revoke all on function private.handle_new_auth_user() from public, anon, authenticated, service_role;
grant execute on function private.handle_new_auth_user() to supabase_auth_admin;

create trigger steadlane_create_profile_after_signup
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- Backfill accounts that existed before this migration was applied.
insert into public.profiles (id, role)
select users.id, 'passenger'
from auth.users as users
on conflict (id) do nothing;

create table public.ride_quotes (
  id uuid primary key,
  passenger_id uuid not null references public.profiles (id) on delete cascade,
  pickup_label text not null check (pg_catalog.length(pickup_label) between 1 and 240),
  pickup_latitude double precision not null check (pickup_latitude between -90 and 90),
  pickup_longitude double precision not null check (pickup_longitude between -180 and 180),
  destination_label text not null check (pg_catalog.length(destination_label) between 1 and 240),
  destination_latitude double precision not null check (destination_latitude between -90 and 90),
  destination_longitude double precision not null check (destination_longitude between -180 and 180),
  stops jsonb not null default '[]'::jsonb,
  stop_count smallint not null default 0 check (stop_count between 0 and 3),
  pickup_at timestamptz not null,
  passenger_count smallint not null check (passenger_count between 1 and 6),
  distance_meters double precision not null check (distance_meters > 0 and distance_meters <= 4023360),
  duration_seconds integer not null check (duration_seconds between 1 and 86400),
  distance_miles numeric(12, 8) not null check (distance_miles > 0 and distance_miles <= 2500),
  duration_minutes smallint not null check (duration_minutes between 1 and 1440),
  route_geometry jsonb not null check (
    case
      when route_geometry ->> 'type' is distinct from 'LineString' then false
      when pg_catalog.jsonb_typeof(route_geometry -> 'coordinates') is distinct from 'array' then false
      when pg_catalog.jsonb_array_length(route_geometry -> 'coordinates') not between 2 and 10000 then false
      else not pg_catalog.jsonb_path_exists(
        route_geometry,
        '$.coordinates[*] ? (@.type() != "array" || @.size() < 2 || @[0].type() != "number" || @[1].type() != "number" || @[0] < -180 || @[0] > 180 || @[1] < -90 || @[1] > 90)'
      )
    end
  ),
  fare_base_cents integer not null check (fare_base_cents >= 0),
  fare_distance_cents integer not null check (fare_distance_cents >= 0),
  fare_duration_cents integer not null check (fare_duration_cents >= 0),
  fare_minimum_adjustment_cents integer not null check (fare_minimum_adjustment_cents >= 0),
  fare_booking_fee_cents integer not null check (fare_booking_fee_cents >= 0),
  fare_stop_cents integer check (fare_stop_cents is null or fare_stop_cents >= 0),
  fare_known_subtotal_cents integer not null check (fare_known_subtotal_cents between 0 and 500000),
  fare_total_cents integer check (fare_total_cents is null or fare_total_cents between 0 and 500000),
  bookable boolean not null default true,
  currency text not null default 'USD' check (currency = 'USD'),
  pricing_version text not null,
  provisional boolean not null default true check (provisional),
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint ride_quotes_stops_consistent check (
    case
      when pg_catalog.jsonb_typeof(stops) is distinct from 'array' then false
      else pg_catalog.jsonb_array_length(stops) = stop_count
    end
  ),
  constraint ride_quotes_pricing_complete check (
    (
      bookable
      and fare_stop_cents is not null
      and fare_total_cents is not null
      and ((stop_count = 0 and fare_stop_cents = 0) or (stop_count > 0 and fare_stop_cents > 0))
    )
    or (not bookable and fare_stop_cents is null and fare_total_cents is null)
  ),
  constraint ride_quotes_expiry_window check (
    expires_at > created_at and expires_at <= created_at + interval '11 minutes'
  )
);

create index ride_quotes_passenger_id_idx on public.ride_quotes (passenger_id);
alter table public.ride_quotes enable row level security;
revoke all on table public.ride_quotes from public, anon, authenticated, service_role;
grant insert (
  id,
  passenger_id,
  pickup_label,
  pickup_latitude,
  pickup_longitude,
  destination_label,
  destination_latitude,
  destination_longitude,
  pickup_at,
  passenger_count,
  distance_meters,
  duration_seconds,
  distance_miles,
  duration_minutes,
  route_geometry,
  stops,
  stop_count,
  fare_base_cents,
  fare_distance_cents,
  fare_duration_cents,
  fare_minimum_adjustment_cents,
  fare_booking_fee_cents,
  fare_stop_cents,
  fare_known_subtotal_cents,
  fare_total_cents,
  bookable,
  currency,
  pricing_version,
  provisional,
  expires_at
) on table public.ride_quotes to service_role;

create table public.driver_weekly_availability (
  driver_id uuid not null references public.profiles (id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 1 and 7),
  start_time time without time zone not null,
  end_time time without time zone not null,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (driver_id, day_of_week),
  constraint driver_availability_same_day_window check (start_time < end_time)
);

alter table public.driver_weekly_availability enable row level security;
revoke all on table public.driver_weekly_availability from public, anon, authenticated, service_role;
grant select on table public.driver_weekly_availability to authenticated;

create policy driver_weekly_availability_select_own
  on public.driver_weekly_availability
  for select
  to authenticated
  using ((select auth.uid()) = driver_id);

create or replace function public.set_driver_availability(p_availability jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_window jsonb;
  v_day smallint;
  v_start time without time zone;
  v_end time without time zone;
  v_day_text text;
  v_start_text text;
  v_end_text text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  select profile.role into v_role
  from public.profiles as profile
  where profile.id = v_user_id;
  if not found or v_role <> 'driver' then
    raise exception using errcode = 'P0001', message = 'Driver role required';
  end if;

  if p_availability is null then
    raise exception using errcode = '22023', message = 'Availability must have at most seven windows';
  end if;
  if pg_catalog.jsonb_typeof(p_availability) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Availability must have at most seven windows';
  end if;
  if pg_catalog.jsonb_array_length(p_availability) > 7 then
    raise exception using errcode = '22023', message = 'Availability must have at most seven windows';
  end if;

  delete from public.driver_weekly_availability as availability
  where availability.driver_id = v_user_id;

  for v_window in
    select item.value
    from pg_catalog.jsonb_array_elements(p_availability) as item(value)
  loop
    if pg_catalog.jsonb_typeof(v_window) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Availability windows must be objects';
    end if;
    v_day_text := v_window ->> 'day_of_week';
    v_start_text := v_window ->> 'start_time';
    v_end_text := v_window ->> 'end_time';
    if v_day_text !~ '^[1-7]$'
      or v_start_text !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
      or v_end_text !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
    then
      raise exception using errcode = '22023', message = 'Availability fields are invalid';
    end if;
    v_day := v_day_text::smallint;
    v_start := v_start_text::time;
    v_end := v_end_text::time;
    if v_start >= v_end then
      raise exception using errcode = '22023', message = 'Availability windows cannot cross midnight';
    end if;
    insert into public.driver_weekly_availability (driver_id, day_of_week, start_time, end_time)
    values (v_user_id, v_day, v_start, v_end);
  end loop;
end;
$function$;

revoke all on function public.set_driver_availability(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.set_driver_availability(jsonb) to authenticated;

create table public.booking_series (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  passenger_id uuid not null references public.profiles (id) on delete cascade,
  source_quote_id uuid not null unique references public.ride_quotes (id),
  idempotency_key uuid not null,
  weekdays smallint[] not null check (
    pg_catalog.cardinality(weekdays) between 1 and 7
    and weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
  ),
  start_date date not null,
  end_date date not null,
  pickup_time time without time zone not null,
  time_zone text not null default 'America/New_York' check (time_zone = 'America/New_York'),
  status text not null default 'active' check (status in ('active', 'cancelled')),
  created_at timestamptz not null default pg_catalog.now(),
  cancelled_at timestamptz,
  constraint booking_series_date_window check (
    end_date >= start_date and end_date - start_date < 90
  ),
  constraint booking_series_idempotency_key_unique unique (passenger_id, idempotency_key),
  constraint booking_series_cancelled_at_check check (
    (status = 'active' and cancelled_at is null)
    or (status = 'cancelled' and cancelled_at is not null)
  )
);

create index booking_series_passenger_created_idx on public.booking_series (passenger_id, created_at desc);
alter table public.booking_series enable row level security;
revoke all on table public.booking_series from public, anon, authenticated, service_role;
grant select on table public.booking_series to authenticated;

create policy booking_series_select_own_passenger
  on public.booking_series
  for select
  to authenticated
  using ((select auth.uid()) = passenger_id);

create table public.bookings (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  passenger_id uuid not null references public.profiles (id) on delete cascade,
  assigned_driver_id uuid references public.profiles (id) on delete restrict,
  source_quote_id uuid not null references public.ride_quotes (id),
  recurring_series_id uuid references public.booking_series (id) on delete restrict,
  idempotency_key uuid not null,
  pickup_label text not null,
  pickup_latitude double precision not null,
  pickup_longitude double precision not null,
  destination_label text not null,
  destination_latitude double precision not null,
  destination_longitude double precision not null,
  stops jsonb not null default '[]'::jsonb,
  stop_count smallint not null default 0 check (stop_count between 0 and 3),
  pickup_at timestamptz not null,
  passenger_count smallint not null check (passenger_count between 1 and 6),
  distance_meters double precision not null check (distance_meters > 0 and distance_meters <= 4023360),
  duration_seconds integer not null check (duration_seconds between 1 and 86400),
  distance_miles numeric(12, 8) not null check (distance_miles > 0 and distance_miles <= 2500),
  duration_minutes smallint not null check (duration_minutes between 1 and 1440),
  route_geometry jsonb not null check (
    case
      when route_geometry ->> 'type' is distinct from 'LineString' then false
      when pg_catalog.jsonb_typeof(route_geometry -> 'coordinates') is distinct from 'array' then false
      when pg_catalog.jsonb_array_length(route_geometry -> 'coordinates') not between 2 and 10000 then false
      else not pg_catalog.jsonb_path_exists(
        route_geometry,
        '$.coordinates[*] ? (@.type() != "array" || @.size() < 2 || @[0].type() != "number" || @[1].type() != "number" || @[0] < -180 || @[0] > 180 || @[1] < -90 || @[1] > 90)'
      )
    end
  ),
  fare_base_cents integer not null check (fare_base_cents >= 0),
  fare_distance_cents integer not null check (fare_distance_cents >= 0),
  fare_duration_cents integer not null check (fare_duration_cents >= 0),
  fare_minimum_adjustment_cents integer not null check (fare_minimum_adjustment_cents >= 0),
  fare_booking_fee_cents integer not null check (fare_booking_fee_cents >= 0),
  fare_stop_cents integer not null check (fare_stop_cents >= 0),
  fare_known_subtotal_cents integer not null check (fare_known_subtotal_cents between 0 and 500000),
  fare_total_cents integer not null check (fare_total_cents between 0 and 500000),
  currency text not null check (currency = 'USD'),
  pricing_version text not null,
  provisional boolean not null check (provisional),
  status text not null default 'pending' check (status in ('pending', 'assigned', 'cancelled')),
  created_at timestamptz not null default pg_catalog.now(),
  assigned_at timestamptz,
  cancelled_at timestamptz,
  constraint bookings_stops_consistent check (
    case
      when pg_catalog.jsonb_typeof(stops) is distinct from 'array' then false
      else pg_catalog.jsonb_array_length(stops) = stop_count
    end
  ),
  constraint bookings_stop_pricing_check check (
    (stop_count = 0 and fare_stop_cents = 0)
    or (stop_count > 0 and fare_stop_cents > 0)
  ),
  constraint bookings_idempotency_key_unique unique (passenger_id, idempotency_key),
  constraint bookings_driver_status_check check (
    (status = 'assigned' and assigned_driver_id is not null and assigned_at is not null)
    or (status in ('pending', 'cancelled') and assigned_driver_id is null and assigned_at is null)
  ),
  constraint bookings_cancelled_at_check check (
    (status = 'cancelled' and cancelled_at is not null)
    or (status in ('pending', 'assigned') and cancelled_at is null)
  )
);

create index bookings_passenger_created_idx on public.bookings (passenger_id, created_at desc);
create index bookings_driver_created_idx on public.bookings (assigned_driver_id, created_at desc);
create index bookings_source_quote_idx on public.bookings (source_quote_id);
create index bookings_series_pickup_idx on public.bookings (recurring_series_id, pickup_at) where recurring_series_id is not null;
create index bookings_pending_created_idx on public.bookings (created_at desc) where status = 'pending';
alter table public.bookings enable row level security;
revoke all on table public.bookings from public, anon, authenticated, service_role;
grant select on table public.bookings to authenticated;

create table public.booking_contacts (
  booking_id uuid primary key references public.bookings (id) on delete cascade,
  passenger_id uuid not null references public.profiles (id) on delete cascade,
  passenger_name text not null check (pg_catalog.length(pg_catalog.btrim(passenger_name)) between 2 and 120),
  passenger_phone text not null check (
    passenger_phone ~ '^[+0-9() .-]{7,25}$' and passenger_phone ~ '[0-9]'
  ),
  created_at timestamptz not null default pg_catalog.now()
);

create index booking_contacts_passenger_id_idx on public.booking_contacts (passenger_id);
alter table public.booking_contacts enable row level security;
revoke all on table public.booking_contacts from public, anon, authenticated, service_role;
grant select on table public.booking_contacts to authenticated;

create table public.driver_responses (
  booking_id uuid not null references public.bookings (id) on delete cascade,
  driver_id uuid not null references public.profiles (id) on delete cascade,
  decision text not null check (decision in ('accept', 'decline')),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (booking_id, driver_id)
);

create index driver_responses_driver_id_idx on public.driver_responses (driver_id);
alter table public.driver_responses enable row level security;
revoke all on table public.driver_responses from public, anon, authenticated, service_role;
grant select on table public.driver_responses to authenticated;

create policy bookings_select_own_passenger
  on public.bookings
  for select
  to authenticated
  using ((select auth.uid()) = passenger_id);

create policy bookings_select_assigned_driver
  on public.bookings
  for select
  to authenticated
  using (
    (select auth.uid()) = assigned_driver_id
    and exists (
      select 1 from public.profiles as profile
      where profile.id = (select auth.uid()) and profile.role = 'driver'
    )
  );

create policy bookings_select_open_driver_queue
  on public.bookings
  for select
  to authenticated
  using (
    status = 'pending'
    and exists (
      select 1 from public.profiles as profile
      where profile.id = (select auth.uid()) and profile.role = 'driver'
    )
    and exists (
      select 1
      from public.driver_weekly_availability as availability
      where availability.driver_id = (select auth.uid())
        and availability.day_of_week = extract(
          isodow from (bookings.pickup_at at time zone 'America/New_York')
        )::smallint
        and (bookings.pickup_at at time zone 'America/New_York')::time >= availability.start_time
        and (bookings.pickup_at at time zone 'America/New_York')::time < availability.end_time
    )
    and not exists (
      select 1
      from public.driver_responses as response
      where response.booking_id = bookings.id
        and response.driver_id = (select auth.uid())
    )
  );

create policy booking_contacts_select_owner_or_assigned_driver
  on public.booking_contacts
  for select
  to authenticated
  using (
    (select auth.uid()) = passenger_id
    or exists (
      select 1
      from public.bookings as booking
      where booking.id = booking_contacts.booking_id
        and booking.assigned_driver_id = (select auth.uid())
    )
  );

create policy driver_responses_select_own
  on public.driver_responses
  for select
  to authenticated
  using ((select auth.uid()) = driver_id);

create or replace function public.create_booking_from_quote(
  p_quote_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_full_name text;
  v_phone text;
  v_quote public.ride_quotes%rowtype;
  v_booking public.bookings%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  select profile.role, profile.full_name, profile.phone
  into v_role, v_full_name, v_phone
  from public.profiles as profile
  where profile.id = v_user_id;

  if not found or v_role <> 'passenger' then
    raise exception using errcode = 'P0001', message = 'Passenger role required';
  end if;

  if p_quote_id is null or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'Quote and idempotency key are required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select booking.*
  into v_booking
  from public.bookings as booking
  where booking.passenger_id = v_user_id
    and booking.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_booking.source_quote_id <> p_quote_id then
      raise exception using errcode = '23505', message = 'Idempotency key was used for a different quote';
    end if;
    return pg_catalog.to_jsonb(v_booking);
  end if;

  select quote.*
  into v_quote
  from public.ride_quotes as quote
  where quote.id = p_quote_id
    and quote.passenger_id = v_user_id
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'Quote not found';
  end if;

  -- Recheck the idempotency key after acquiring the quote row lock before
  -- creating the booking.
  select booking.*
  into v_booking
  from public.bookings as booking
  where booking.passenger_id = v_user_id
    and booking.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_booking.source_quote_id <> p_quote_id then
      raise exception using errcode = '23505', message = 'Idempotency key was used for a different quote';
    end if;
    return pg_catalog.to_jsonb(v_booking);
  end if;

  if v_quote.expires_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'Quote has expired';
  end if;
  if v_quote.consumed_at is not null then
    raise exception using errcode = 'P0001', message = 'Quote has already been used';
  end if;
  if not v_quote.bookable
    or v_quote.fare_total_cents is null
    or v_quote.fare_stop_cents is null
    or (v_quote.stop_count > 0 and v_quote.fare_stop_cents = 0)
  then
    raise exception using errcode = 'P0001', message = 'Stop pricing is required before booking';
  end if;
  if v_quote.pickup_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '22023', message = 'Pickup time has passed';
  end if;
  if v_full_name is null or v_phone is null then
    raise exception using errcode = 'P0001', message = 'Passenger contact details are required';
  end if;

  insert into public.bookings (
    passenger_id,
    source_quote_id,
    idempotency_key,
    pickup_label,
    pickup_latitude,
    pickup_longitude,
    destination_label,
    destination_latitude,
    destination_longitude,
    stops,
    stop_count,
    pickup_at,
    passenger_count,
    distance_meters,
    duration_seconds,
    distance_miles,
    duration_minutes,
    route_geometry,
    fare_base_cents,
    fare_distance_cents,
    fare_duration_cents,
    fare_minimum_adjustment_cents,
    fare_booking_fee_cents,
    fare_stop_cents,
    fare_known_subtotal_cents,
    fare_total_cents,
    currency,
    pricing_version,
    provisional
  ) values (
    v_user_id,
    v_quote.id,
    p_idempotency_key,
    v_quote.pickup_label,
    v_quote.pickup_latitude,
    v_quote.pickup_longitude,
    v_quote.destination_label,
    v_quote.destination_latitude,
    v_quote.destination_longitude,
    v_quote.stops,
    v_quote.stop_count,
    v_quote.pickup_at,
    v_quote.passenger_count,
    v_quote.distance_meters,
    v_quote.duration_seconds,
    v_quote.distance_miles,
    v_quote.duration_minutes,
    v_quote.route_geometry,
    v_quote.fare_base_cents,
    v_quote.fare_distance_cents,
    v_quote.fare_duration_cents,
    v_quote.fare_minimum_adjustment_cents,
    v_quote.fare_booking_fee_cents,
    v_quote.fare_stop_cents,
    v_quote.fare_known_subtotal_cents,
    v_quote.fare_total_cents,
    v_quote.currency,
    v_quote.pricing_version,
    v_quote.provisional
  ) returning * into v_booking;

  insert into public.booking_contacts (
    booking_id,
    passenger_id,
    passenger_name,
    passenger_phone
  ) values (
    v_booking.id,
    v_user_id,
    v_full_name,
    v_phone
  );

  update public.ride_quotes
  set consumed_at = pg_catalog.clock_timestamp()
  where id = v_quote.id;

  return pg_catalog.to_jsonb(v_booking);
end;
$function$;

revoke all on function public.create_booking_from_quote(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_booking_from_quote(uuid, uuid) to authenticated;

create or replace function public.create_recurring_bookings_from_quote(
  p_quote_id uuid,
  p_idempotency_key uuid,
  p_weekdays smallint[],
  p_start_date date,
  p_end_date date,
  p_pickup_time time without time zone
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_full_name text;
  v_phone text;
  v_today date;
  v_weekday_count integer;
  v_date date;
  v_local_pickup timestamp without time zone;
  v_pickup_at timestamptz;
  v_occurrence_count integer := 0;
  v_quote public.ride_quotes%rowtype;
  v_series public.booking_series%rowtype;
  v_booking public.bookings%rowtype;
  v_booking_list jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  select profile.role, profile.full_name, profile.phone
  into v_role, v_full_name, v_phone
  from public.profiles as profile
  where profile.id = v_user_id;
  if not found or v_role <> 'passenger' then
    raise exception using errcode = 'P0001', message = 'Passenger role required';
  end if;
  if p_quote_id is null or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'Quote and idempotency key are required';
  end if;
  if p_weekdays is null
    or pg_catalog.cardinality(p_weekdays) not between 1 and 7
    or not (p_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[])
    or p_start_date is null
    or p_end_date is null
    or p_pickup_time is null
  then
    raise exception using errcode = '22023', message = 'Weekly schedule fields are invalid';
  end if;
  select pg_catalog.count(distinct selected.day_number)::integer
  into v_weekday_count
  from pg_catalog.unnest(p_weekdays) as selected(day_number);
  if v_weekday_count <> pg_catalog.cardinality(p_weekdays) then
    raise exception using errcode = '22023', message = 'Weekdays must not be repeated';
  end if;
  select pg_catalog.array_agg(selected.day_number order by selected.day_number)
  into p_weekdays
  from pg_catalog.unnest(p_weekdays) as selected(day_number);
  if p_end_date < p_start_date or p_end_date - p_start_date >= 90 then
    raise exception using errcode = '22023', message = 'Weekly schedule cannot cover more than 90 inclusive calendar days';
  end if;

  v_today := (pg_catalog.now() at time zone 'America/New_York')::date;
  if p_start_date < v_today or p_end_date > v_today + 89 then
    raise exception using errcode = '22023', message = 'Weekly schedule dates must be within the next 90 days';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select series.* into v_series
  from public.booking_series as series
  where series.passenger_id = v_user_id
    and series.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_series.source_quote_id <> p_quote_id
      or v_series.weekdays <> p_weekdays
      or v_series.start_date <> p_start_date
      or v_series.end_date <> p_end_date
      or v_series.pickup_time <> p_pickup_time
    then
      raise exception using errcode = '23505', message = 'Idempotency key was used for a different recurring schedule';
    end if;
    select coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(booking) order by booking.pickup_at),
      '[]'::jsonb
    ) into v_booking_list
    from public.bookings as booking
    where booking.recurring_series_id = v_series.id
      and booking.passenger_id = v_user_id;
    return pg_catalog.jsonb_build_object(
      'series', pg_catalog.to_jsonb(v_series),
      'bookings', v_booking_list
    );
  end if;

  select quote.* into v_quote
  from public.ride_quotes as quote
  where quote.id = p_quote_id
    and quote.passenger_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Quote not found';
  end if;
  if v_quote.expires_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'Quote has expired';
  end if;
  if v_quote.consumed_at is not null then
    raise exception using errcode = 'P0001', message = 'Quote has already been used';
  end if;
  if not v_quote.bookable
    or v_quote.fare_total_cents is null
    or v_quote.fare_stop_cents is null
    or (v_quote.stop_count > 0 and v_quote.fare_stop_cents = 0)
  then
    raise exception using errcode = 'P0001', message = 'Stop pricing is required before booking';
  end if;
  if v_full_name is null or v_phone is null then
    raise exception using errcode = 'P0001', message = 'Passenger contact details are required';
  end if;

  insert into public.booking_series (
    passenger_id,
    source_quote_id,
    idempotency_key,
    weekdays,
    start_date,
    end_date,
    pickup_time,
    time_zone
  ) values (
    v_user_id,
    v_quote.id,
    p_idempotency_key,
    p_weekdays,
    p_start_date,
    p_end_date,
    p_pickup_time,
    'America/New_York'
  ) returning * into v_series;

  for v_date in
    select days.local_date::date
    from pg_catalog.generate_series(
      p_start_date::timestamp without time zone,
      p_end_date::timestamp without time zone,
      interval '1 day'
    ) as days(local_date)
    where extract(isodow from days.local_date)::smallint = any(p_weekdays)
    order by days.local_date
  loop
    v_local_pickup := v_date + p_pickup_time;
    v_pickup_at := v_local_pickup at time zone 'America/New_York';
    if (v_pickup_at at time zone 'America/New_York') <> v_local_pickup then
      raise exception using errcode = '22023', message = 'Pickup time does not exist in America/New_York on a selected date';
    end if;
    if (v_pickup_at - interval '1 hour') at time zone 'America/New_York' = v_local_pickup
      or (v_pickup_at + interval '1 hour') at time zone 'America/New_York' = v_local_pickup
    then
      raise exception using errcode = '22023', message = 'Pickup time is ambiguous in America/New_York on a selected date';
    end if;
    if v_pickup_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '22023', message = 'Every recurring pickup must be in the future';
    end if;

    insert into public.bookings (
      passenger_id,
      source_quote_id,
      recurring_series_id,
      idempotency_key,
      pickup_label,
      pickup_latitude,
      pickup_longitude,
      destination_label,
      destination_latitude,
      destination_longitude,
      stops,
      stop_count,
      pickup_at,
      passenger_count,
      distance_meters,
      duration_seconds,
      distance_miles,
      duration_minutes,
      route_geometry,
      fare_base_cents,
      fare_distance_cents,
      fare_duration_cents,
      fare_minimum_adjustment_cents,
      fare_booking_fee_cents,
      fare_stop_cents,
      fare_known_subtotal_cents,
      fare_total_cents,
      currency,
      pricing_version,
      provisional
    ) values (
      v_user_id,
      v_quote.id,
      v_series.id,
      pg_catalog.gen_random_uuid(),
      v_quote.pickup_label,
      v_quote.pickup_latitude,
      v_quote.pickup_longitude,
      v_quote.destination_label,
      v_quote.destination_latitude,
      v_quote.destination_longitude,
      v_quote.stops,
      v_quote.stop_count,
      v_pickup_at,
      v_quote.passenger_count,
      v_quote.distance_meters,
      v_quote.duration_seconds,
      v_quote.distance_miles,
      v_quote.duration_minutes,
      v_quote.route_geometry,
      v_quote.fare_base_cents,
      v_quote.fare_distance_cents,
      v_quote.fare_duration_cents,
      v_quote.fare_minimum_adjustment_cents,
      v_quote.fare_booking_fee_cents,
      v_quote.fare_stop_cents,
      v_quote.fare_known_subtotal_cents,
      v_quote.fare_total_cents,
      v_quote.currency,
      v_quote.pricing_version,
      v_quote.provisional
    ) returning * into v_booking;

    insert into public.booking_contacts (
      booking_id,
      passenger_id,
      passenger_name,
      passenger_phone
    ) values (
      v_booking.id,
      v_user_id,
      v_full_name,
      v_phone
    );
    v_occurrence_count := v_occurrence_count + 1;
  end loop;

  if v_occurrence_count = 0 then
    raise exception using errcode = '22023', message = 'The date range contains none of the selected weekdays';
  end if;

  update public.ride_quotes
  set consumed_at = pg_catalog.clock_timestamp()
  where id = v_quote.id;

  select coalesce(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(booking) order by booking.pickup_at),
    '[]'::jsonb
  ) into v_booking_list
  from public.bookings as booking
  where booking.recurring_series_id = v_series.id
    and booking.passenger_id = v_user_id;

  return pg_catalog.jsonb_build_object(
    'series', pg_catalog.to_jsonb(v_series),
    'bookings', v_booking_list
  );
end;
$function$;

revoke all on function public.create_recurring_bookings_from_quote(uuid, uuid, smallint[], date, date, time without time zone) from public, anon, authenticated, service_role;
grant execute on function public.create_recurring_bookings_from_quote(uuid, uuid, smallint[], date, date, time without time zone) to authenticated;

create or replace function public.respond_to_booking(
  p_booking_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_existing_decision text;
  v_series_id uuid;
  v_series_status text;
  v_booking_status text;
  v_local_pickup timestamp without time zone;
  v_booking public.bookings%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_booking_id is null or p_decision is null or p_decision not in ('accept', 'decline') then
    raise exception using errcode = '22023', message = 'Decision must be accept or decline';
  end if;

  select profile.role into v_role
  from public.profiles as profile
  where profile.id = v_user_id;
  if not found or v_role <> 'driver' then
    raise exception using errcode = 'P0001', message = 'Driver role required';
  end if;

  if p_decision = 'accept' then
    select booking.recurring_series_id, booking.status
    into v_series_id, v_booking_status
    from public.bookings as booking
    where booking.id = p_booking_id;
    if not found then
      raise exception using errcode = '42501', message = 'Booking not found';
    end if;
    if v_series_id is not null and v_booking_status = 'pending' then
      select series.status into v_series_status
      from public.booking_series as series
      where series.id = v_series_id
      for update;
      if not found or v_series_status <> 'active' then
        raise exception using errcode = 'P0001', message = 'Ride request is no longer pending';
      end if;
    end if;
  end if;

  select booking.* into v_booking
  from public.bookings as booking
  where booking.id = p_booking_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Booking not found';
  end if;

  select response.decision into v_existing_decision
  from public.driver_responses as response
  where response.booking_id = p_booking_id
    and response.driver_id = v_user_id;
  if found then
    if v_existing_decision <> p_decision then
      raise exception using errcode = 'P0001', message = 'Driver decision already recorded';
    end if;
    if p_decision = 'accept' and v_booking.assigned_driver_id <> v_user_id then
      raise exception using errcode = 'P0001', message = 'Ride request is no longer pending';
    end if;
    return pg_catalog.to_jsonb(v_booking);
  end if;

  if v_booking.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'Ride request is no longer pending';
  end if;

  v_local_pickup := v_booking.pickup_at at time zone 'America/New_York';
  perform 1
  from public.driver_weekly_availability as availability
  where availability.driver_id = v_user_id
    and availability.day_of_week = extract(isodow from v_local_pickup)::smallint
    and v_local_pickup::time >= availability.start_time
    and v_local_pickup::time < availability.end_time
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'Driver is not available for this pickup';
  end if;

  insert into public.driver_responses (booking_id, driver_id, decision)
  values (p_booking_id, v_user_id, p_decision);

  if p_decision = 'accept' then
    update public.bookings
    set status = 'assigned',
        assigned_driver_id = v_user_id,
        assigned_at = pg_catalog.clock_timestamp()
    where id = p_booking_id
    returning * into v_booking;
  end if;

  return pg_catalog.to_jsonb(v_booking);
end;
$function$;

revoke all on function public.respond_to_booking(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.respond_to_booking(uuid, text) to authenticated;

create or replace function public.cancel_booking(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_booking public.bookings%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  select profile.role into v_role
  from public.profiles as profile
  where profile.id = v_user_id;
  if not found or v_role <> 'passenger' then
    raise exception using errcode = 'P0001', message = 'Passenger role required';
  end if;

  select booking.* into v_booking
  from public.bookings as booking
  where booking.id = p_booking_id
    and booking.passenger_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Booking not found';
  end if;

  if v_booking.status = 'cancelled' then
    return pg_catalog.to_jsonb(v_booking);
  end if;
  if v_booking.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'Ride request is no longer pending';
  end if;

  update public.bookings
  set status = 'cancelled',
      cancelled_at = pg_catalog.clock_timestamp()
  where id = p_booking_id
  returning * into v_booking;

  return pg_catalog.to_jsonb(v_booking);
end;
$function$;

revoke all on function public.cancel_booking(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_booking(uuid) to authenticated;

create or replace function public.cancel_recurring_booking_series(p_series_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_series public.booking_series%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_series_id is null then
    raise exception using errcode = '22023', message = 'Recurring series ID is required';
  end if;

  select profile.role into v_role
  from public.profiles as profile
  where profile.id = v_user_id;
  if not found or v_role <> 'passenger' then
    raise exception using errcode = 'P0001', message = 'Passenger role required';
  end if;

  select series.* into v_series
  from public.booking_series as series
  where series.id = p_series_id
    and series.passenger_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Recurring series not found';
  end if;
  if v_series.status = 'cancelled' then
    return pg_catalog.to_jsonb(v_series);
  end if;

  update public.booking_series
  set status = 'cancelled',
      cancelled_at = pg_catalog.clock_timestamp()
  where id = p_series_id
  returning * into v_series;

  update public.bookings
  set status = 'cancelled',
      cancelled_at = pg_catalog.clock_timestamp()
  where recurring_series_id = p_series_id
    and passenger_id = v_user_id
    and status = 'pending';

  return pg_catalog.to_jsonb(v_series);
end;
$function$;

revoke all on function public.cancel_recurring_booking_series(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_recurring_booking_series(uuid) to authenticated;
