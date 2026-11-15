-- Test-mode Stripe Checkout payments for accepted Steadlane rides.
-- Review this migration before applying it. It has not been applied.

create table public.booking_payment_attempts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  passenger_id uuid not null references public.profiles (id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  amount_cents integer not null check (amount_cents between 1 and 500000),
  currency text not null default 'usd' check (currency = 'usd'),
  status text not null default 'pending' check (
    status in ('pending', 'paid', 'failed', 'expired', 'partially_refunded', 'refunded')
  ),
  stripe_checkout_session_id text unique check (
    stripe_checkout_session_id is null or stripe_checkout_session_id ~ '^cs_test_[A-Za-z0-9]+$'
  ),
  stripe_payment_intent_id text unique check (
    stripe_payment_intent_id is null or stripe_payment_intent_id ~ '^pi_[A-Za-z0-9]+$'
  ),
  checkout_url text check (
    checkout_url is null or checkout_url ~ '^https://checkout[.]stripe[.]com/c/pay/cs_test_[A-Za-z0-9]+([?].*)?$'
  ),
  checkout_expires_at timestamptz,
  amount_refunded_cents integer not null default 0 check (amount_refunded_cents between 0 and amount_cents),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint booking_payment_attempts_unique_number unique (booking_id, attempt_number),
  constraint booking_payment_attempts_checkout_fields check (
    (stripe_checkout_session_id is null and checkout_url is null and checkout_expires_at is null)
    or (stripe_checkout_session_id is not null and checkout_url is not null and checkout_expires_at is not null)
  ),
  constraint booking_payment_attempts_refund_state check (
    (status = 'partially_refunded' and amount_refunded_cents > 0 and amount_refunded_cents < amount_cents)
    or (status = 'refunded' and amount_refunded_cents = amount_cents)
    or (status not in ('partially_refunded', 'refunded') and amount_refunded_cents = 0)
  )
);

create index booking_payment_attempts_booking_number_idx
  on public.booking_payment_attempts (booking_id, attempt_number desc);
create unique index booking_payment_attempts_one_pending_idx
  on public.booking_payment_attempts (booking_id)
  where status = 'pending';

alter table public.booking_payment_attempts enable row level security;
revoke all on table public.booking_payment_attempts from public, anon, authenticated, service_role;
grant select on table public.booking_payment_attempts to authenticated;

create policy booking_payment_attempts_select_own_passenger
  on public.booking_payment_attempts
  for select
  to authenticated
  using ((select auth.uid()) = passenger_id);

create table public.stripe_webhook_events (
  event_id text primary key check (event_id ~ '^evt_[A-Za-z0-9]+$'),
  event_type text not null check (event_type in (
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
    'charge.refunded'
  )),
  livemode boolean not null default false check (livemode = false),
  processed_at timestamptz not null default pg_catalog.clock_timestamp()
);

alter table public.stripe_webhook_events enable row level security;
revoke all on table public.stripe_webhook_events from public, anon, authenticated, service_role;

create or replace function public.prepare_booking_checkout(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_booking public.bookings%rowtype;
  v_attempt public.booking_payment_attempts%rowtype;
  v_attempt_found boolean := false;
  v_attempt_number integer;
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
  where booking.id = p_booking_id and booking.passenger_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Booking not found';
  end if;
  if v_booking.status <> 'assigned' then
    raise exception using errcode = 'P0001', message = 'Ride must be accepted before payment';
  end if;
  if v_booking.fare_total_cents not between 1 and 500000
    or v_booking.currency <> 'USD'
    or not v_booking.provisional
  then
    raise exception using errcode = 'P0001', message = 'Stored fare is not payable';
  end if;

  select attempt.* into v_attempt
  from public.booking_payment_attempts as attempt
  where attempt.booking_id = v_booking.id and attempt.passenger_id = v_user_id
  order by attempt.attempt_number desc
  limit 1
  for update;
  v_attempt_found := found;

  if v_attempt_found and v_attempt.status in ('pending', 'paid', 'partially_refunded', 'refunded') then
    return pg_catalog.jsonb_build_object(
      'payment_attempt_id', v_attempt.id,
      'payment_status', v_attempt.status,
      'amount_cents', v_attempt.amount_cents,
      'currency', v_attempt.currency,
      'pickup_at', v_booking.pickup_at,
      'checkout_session_id', v_attempt.stripe_checkout_session_id,
      'checkout_url', v_attempt.checkout_url,
      'checkout_expires_at', v_attempt.checkout_expires_at
    );
  end if;

  v_attempt_number := case when v_attempt_found then v_attempt.attempt_number + 1 else 1 end;
  insert into public.booking_payment_attempts (
    booking_id, passenger_id, attempt_number, amount_cents, currency, status
  ) values (
    v_booking.id, v_user_id, v_attempt_number, v_booking.fare_total_cents,
    pg_catalog.lower(v_booking.currency), 'pending'
  ) returning * into v_attempt;

  return pg_catalog.jsonb_build_object(
    'payment_attempt_id', v_attempt.id,
    'payment_status', v_attempt.status,
    'amount_cents', v_attempt.amount_cents,
    'currency', v_attempt.currency,
    'pickup_at', v_booking.pickup_at,
    'checkout_session_id', null,
    'checkout_url', null,
    'checkout_expires_at', null
  );
end;
$function$;

revoke all on function public.prepare_booking_checkout(uuid) from public, anon, authenticated, service_role;
grant execute on function public.prepare_booking_checkout(uuid) to authenticated;

create or replace function public.record_booking_checkout_session(
  p_payment_attempt_id uuid,
  p_checkout_session_id text,
  p_checkout_url text,
  p_checkout_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_booking_id uuid;
  v_booking public.bookings%rowtype;
  v_attempt public.booking_payment_attempts%rowtype;
begin
  if p_payment_attempt_id is null or p_checkout_session_id is null or p_checkout_url is null
    or p_checkout_expires_at is null
    or p_checkout_session_id !~ '^cs_test_[A-Za-z0-9]+$'
    or p_checkout_url !~ '^https://checkout[.]stripe[.]com/c/pay/cs_test_[A-Za-z0-9]+([?].*)?$'
    or p_checkout_expires_at <= pg_catalog.clock_timestamp()
    or p_checkout_expires_at > pg_catalog.clock_timestamp() + interval '25 hours'
  then
    raise exception using errcode = '22023', message = 'Checkout session details are invalid';
  end if;

  select attempt.booking_id into v_booking_id
  from public.booking_payment_attempts as attempt
  where attempt.id = p_payment_attempt_id;
  if not found then
    raise exception using errcode = '42501', message = 'Payment attempt not found';
  end if;

  select booking.* into v_booking
  from public.bookings as booking
  where booking.id = v_booking_id
  for update;
  if not found or v_booking.status <> 'assigned' then
    raise exception using errcode = 'P0001', message = 'Ride is no longer ready for Checkout';
  end if;

  select attempt.* into v_attempt
  from public.booking_payment_attempts as attempt
  where attempt.id = p_payment_attempt_id and attempt.booking_id = v_booking.id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Payment attempt not found';
  end if;
  if v_attempt.amount_cents <> v_booking.fare_total_cents
    or v_attempt.currency <> pg_catalog.lower(v_booking.currency)
  then
    raise exception using errcode = '22023', message = 'Checkout amount does not match the saved fare';
  end if;
  if v_attempt.status <> 'pending' then
    if v_attempt.stripe_checkout_session_id = p_checkout_session_id then
      return pg_catalog.jsonb_build_object('recorded', true, 'payment_status', v_attempt.status);
    end if;
    raise exception using errcode = 'P0001', message = 'Payment attempt is no longer pending';
  end if;
  if v_attempt.stripe_checkout_session_id is not null
    and v_attempt.stripe_checkout_session_id <> p_checkout_session_id
  then
    raise exception using errcode = 'P0001', message = 'Payment attempt already has a Checkout session';
  end if;

  update public.booking_payment_attempts as attempt
  set stripe_checkout_session_id = p_checkout_session_id,
      checkout_url = p_checkout_url,
      checkout_expires_at = p_checkout_expires_at,
      updated_at = pg_catalog.clock_timestamp()
  where attempt.id = p_payment_attempt_id;

  return pg_catalog.jsonb_build_object('recorded', true, 'payment_status', 'pending');
end;
$function$;

revoke all on function public.record_booking_checkout_session(uuid, text, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.record_booking_checkout_session(uuid, text, text, timestamptz) to service_role;

create or replace function public.expire_booking_checkout_session(
  p_payment_attempt_id uuid,
  p_checkout_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_booking_id uuid;
  v_booking public.bookings%rowtype;
  v_attempt public.booking_payment_attempts%rowtype;
begin
  if p_payment_attempt_id is null or p_checkout_session_id is null
    or p_checkout_session_id !~ '^cs_test_[A-Za-z0-9]+$'
  then
    raise exception using errcode = '22023', message = 'Checkout session details are invalid';
  end if;

  select attempt.booking_id into v_booking_id
  from public.booking_payment_attempts as attempt
  where attempt.id = p_payment_attempt_id;
  if not found then
    raise exception using errcode = '42501', message = 'Payment attempt not found';
  end if;

  select booking.* into v_booking
  from public.bookings as booking
  where booking.id = v_booking_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Booking not found';
  end if;

  select attempt.* into v_attempt
  from public.booking_payment_attempts as attempt
  where attempt.id = p_payment_attempt_id and attempt.booking_id = v_booking.id
  for update;
  if not found or v_attempt.stripe_checkout_session_id <> p_checkout_session_id then
    raise exception using errcode = '42501', message = 'Checkout session is not linked to this attempt';
  end if;

  if v_attempt.status = 'pending' then
    update public.booking_payment_attempts as attempt
    set status = 'expired', updated_at = pg_catalog.clock_timestamp()
    where attempt.id = v_attempt.id;
    v_attempt.status := 'expired';
  end if;

  return pg_catalog.jsonb_build_object('expired', true, 'payment_status', v_attempt.status);
end;
$function$;

revoke all on function public.expire_booking_checkout_session(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.expire_booking_checkout_session(uuid, text) to service_role;

create or replace function public.expire_unlinked_booking_checkout_attempt(p_payment_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_booking_id uuid;
  v_booking public.bookings%rowtype;
  v_attempt public.booking_payment_attempts%rowtype;
begin
  if p_payment_attempt_id is null then
    raise exception using errcode = '22023', message = 'Payment attempt ID is invalid';
  end if;

  select attempt.booking_id into v_booking_id
  from public.booking_payment_attempts as attempt
  where attempt.id = p_payment_attempt_id;
  if not found then
    raise exception using errcode = '42501', message = 'Payment attempt not found';
  end if;

  select booking.* into v_booking
  from public.bookings as booking
  where booking.id = v_booking_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Booking not found';
  end if;

  select attempt.* into v_attempt
  from public.booking_payment_attempts as attempt
  where attempt.id = p_payment_attempt_id and attempt.booking_id = v_booking.id
  for update;
  if not found or v_attempt.passenger_id <> v_booking.passenger_id then
    raise exception using errcode = '42501', message = 'Payment attempt is not linked to this booking';
  end if;
  if v_booking.status <> 'assigned' then
    raise exception using errcode = 'P0001', message = 'Ride is no longer ready for Checkout';
  end if;
  if v_attempt.stripe_checkout_session_id is not null
    or v_attempt.checkout_url is not null
    or v_attempt.checkout_expires_at is not null
  then
    raise exception using errcode = 'P0001', message = 'Payment attempt already has a linked Checkout session';
  end if;

  if v_attempt.status = 'expired' then
    return pg_catalog.jsonb_build_object('expired', true, 'payment_status', 'expired');
  end if;
  if v_attempt.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'Payment attempt is no longer pending';
  end if;

  update public.booking_payment_attempts as attempt
  set status = 'expired', updated_at = pg_catalog.clock_timestamp()
  where attempt.id = v_attempt.id;

  return pg_catalog.jsonb_build_object('expired', true, 'payment_status', 'expired');
end;
$function$;

revoke all on function public.expire_unlinked_booking_checkout_attempt(uuid) from public, anon, authenticated, service_role;
grant execute on function public.expire_unlinked_booking_checkout_attempt(uuid) to service_role;

create or replace function public.process_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_livemode boolean,
  p_payment_attempt_id uuid,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_amount_total integer,
  p_amount_refunded_cents integer,
  p_currency text,
  p_payment_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_booking_id uuid;
  v_booking public.bookings%rowtype;
  v_attempt public.booking_payment_attempts%rowtype;
  v_inserted_event_id text;
  v_effective_refund_cents integer;
  v_new_status text;
begin
  if p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9]+$'
    or p_event_type is null or p_event_type not in (
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.async_payment_failed',
      'checkout.session.expired',
      'charge.refunded'
    )
    or p_livemode is distinct from false
  then
    raise exception using errcode = '22023', message = 'Stripe event is invalid';
  end if;

  if p_event_type = 'charge.refunded' then
    if p_payment_intent_id is null or p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$'
      or p_amount_refunded_cents is null or p_amount_refunded_cents < 0
      or p_currency is null or pg_catalog.lower(p_currency) <> 'usd'
    then
      raise exception using errcode = '22023', message = 'Stripe refund event is invalid';
    end if;
    select attempt.booking_id into v_booking_id
    from public.booking_payment_attempts as attempt
    where attempt.stripe_payment_intent_id = p_payment_intent_id;
  else
    if p_payment_attempt_id is null or p_checkout_session_id is null
      or p_checkout_session_id !~ '^cs_test_[A-Za-z0-9]+$'
    then
      raise exception using errcode = '22023', message = 'Stripe Checkout event is invalid';
    end if;
    select attempt.booking_id into v_booking_id
    from public.booking_payment_attempts as attempt
    where attempt.id = p_payment_attempt_id;
  end if;

  if not found then
    return pg_catalog.jsonb_build_object('duplicate', false, 'applied', false);
  end if;

  select booking.* into v_booking
  from public.bookings as booking
  where booking.id = v_booking_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('duplicate', false, 'applied', false);
  end if;

  if p_event_type = 'charge.refunded' then
    select attempt.* into v_attempt
    from public.booking_payment_attempts as attempt
    where attempt.booking_id = v_booking.id
      and attempt.stripe_payment_intent_id = p_payment_intent_id
    for update;
  else
    select attempt.* into v_attempt
    from public.booking_payment_attempts as attempt
    where attempt.booking_id = v_booking.id and attempt.id = p_payment_attempt_id
    for update;
  end if;
  if not found or v_attempt.passenger_id <> v_booking.passenger_id then
    return pg_catalog.jsonb_build_object('duplicate', false, 'applied', false);
  end if;

  if p_event_type = 'charge.refunded' then
    if p_currency is not null and pg_catalog.lower(p_currency) <> v_attempt.currency then
      raise exception using errcode = '22023', message = 'Stripe refund currency does not match the saved fare';
    end if;
    if p_amount_refunded_cents > v_attempt.amount_cents then
      raise exception using errcode = '22023', message = 'Stripe refund amount is invalid';
    end if;
  else
    if v_attempt.stripe_checkout_session_id is distinct from p_checkout_session_id then
      raise exception using errcode = '22023', message = 'Stripe Checkout session is not linked to this attempt';
    end if;
    if p_amount_total is not null and p_amount_total <> v_attempt.amount_cents then
      raise exception using errcode = '22023', message = 'Stripe Checkout amount does not match the saved fare';
    end if;
    if p_event_type in (
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.async_payment_failed'
    ) and p_amount_total is distinct from v_attempt.amount_cents then
      raise exception using errcode = '22023', message = 'Stripe Checkout amount is missing or invalid';
    end if;
    if p_currency is not null and pg_catalog.lower(p_currency) <> v_attempt.currency then
      raise exception using errcode = '22023', message = 'Stripe Checkout currency does not match the saved fare';
    end if;
    if p_event_type in (
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.async_payment_failed'
    ) and p_payment_status is null then
      raise exception using errcode = '22023', message = 'Stripe Checkout payment status is missing';
    end if;
    if p_event_type in (
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.async_payment_failed'
    ) and p_currency is null then
      raise exception using errcode = '22023', message = 'Stripe Checkout currency is missing';
    end if;
    if p_payment_status is not null and p_payment_status not in ('paid', 'unpaid') then
      raise exception using errcode = '22023', message = 'Stripe Checkout payment status is invalid';
    end if;
    if p_event_type = 'checkout.session.async_payment_succeeded'
      and p_payment_status is distinct from 'paid'
    then
      raise exception using errcode = '22023', message = 'Successful Checkout payment is not marked paid';
    end if;
    if p_event_type = 'checkout.session.async_payment_failed'
      and p_payment_status = 'paid'
    then
      raise exception using errcode = '22023', message = 'Failed Checkout payment is marked paid';
    end if;
    if p_event_type = 'checkout.session.completed' and p_payment_status = 'paid'
      and p_payment_intent_id is null
    then
      raise exception using errcode = '22023', message = 'Paid Checkout is missing its PaymentIntent';
    end if;
    if p_event_type = 'checkout.session.async_payment_succeeded' and p_payment_intent_id is null then
      raise exception using errcode = '22023', message = 'Successful Checkout is missing its PaymentIntent';
    end if;
    if p_payment_intent_id is not null and p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$' then
      raise exception using errcode = '22023', message = 'Stripe PaymentIntent is invalid';
    end if;
    if p_payment_intent_id is not null and v_attempt.stripe_payment_intent_id is not null
      and v_attempt.stripe_payment_intent_id <> p_payment_intent_id
    then
      raise exception using errcode = '22023', message = 'Stripe PaymentIntent does not match this attempt';
    end if;
  end if;

  insert into public.stripe_webhook_events (event_id, event_type, livemode)
  values (p_event_id, p_event_type, false)
  on conflict (event_id) do nothing
  returning event_id into v_inserted_event_id;
  if v_inserted_event_id is null then
    return pg_catalog.jsonb_build_object('duplicate', true, 'applied', false);
  end if;

  if p_event_type = 'charge.refunded' then
    v_effective_refund_cents := greatest(v_attempt.amount_refunded_cents, p_amount_refunded_cents);
    v_new_status := case
      when v_effective_refund_cents = v_attempt.amount_cents then 'refunded'
      when v_effective_refund_cents > 0 then 'partially_refunded'
      else v_attempt.status
    end;
    update public.booking_payment_attempts as attempt
    set status = v_new_status,
        amount_refunded_cents = v_effective_refund_cents,
        updated_at = pg_catalog.clock_timestamp()
    where attempt.id = v_attempt.id;
  else
    if p_payment_intent_id is not null then
      update public.booking_payment_attempts as attempt
      set stripe_payment_intent_id = coalesce(attempt.stripe_payment_intent_id, p_payment_intent_id),
          updated_at = pg_catalog.clock_timestamp()
      where attempt.id = v_attempt.id;
    end if;

    if p_event_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded')
      and p_payment_status = 'paid'
    then
      if v_attempt.status in ('partially_refunded', 'refunded') then
        v_new_status := v_attempt.status;
      else
        v_new_status := 'paid';
      end if;
      update public.booking_payment_attempts as attempt
      set status = v_new_status, updated_at = pg_catalog.clock_timestamp()
      where attempt.id = v_attempt.id;
    elsif p_event_type = 'checkout.session.async_payment_failed' and v_attempt.status = 'pending' then
      v_new_status := 'failed';
      update public.booking_payment_attempts as attempt
      set status = v_new_status, updated_at = pg_catalog.clock_timestamp()
      where attempt.id = v_attempt.id;
    elsif p_event_type = 'checkout.session.expired' and v_attempt.status = 'pending' then
      v_new_status := 'expired';
      update public.booking_payment_attempts as attempt
      set status = v_new_status, updated_at = pg_catalog.clock_timestamp()
      where attempt.id = v_attempt.id;
    else
      v_new_status := v_attempt.status;
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'duplicate', false,
    'applied', true,
    'payment_status', v_new_status,
    'booking_id', v_booking.id,
    'payment_attempt_id', v_attempt.id
  );
end;
$function$;

revoke all on function public.process_stripe_webhook_event(text, text, boolean, uuid, text, text, integer, integer, text, text) from public, anon, authenticated, service_role;
grant execute on function public.process_stripe_webhook_event(text, text, boolean, uuid, text, text, integer, integer, text, text) to service_role;
