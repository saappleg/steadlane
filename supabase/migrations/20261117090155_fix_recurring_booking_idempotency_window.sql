-- Make recurring booking retries idempotent after their original date window passes.

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

  v_today := (pg_catalog.now() at time zone 'America/New_York')::date;
  if p_start_date < v_today or p_end_date > v_today + 89 then
    raise exception using errcode = '22023', message = 'Weekly schedule dates must be within the next 90 days';
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
