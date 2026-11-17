# Steadlane

Steadlane is a passenger ride-request beta hosted as a Cloudflare Worker with static assets. Supabase Auth and Postgres store accounts and booking data; Geoapify provides address search, place details, driving routes, and map tiles.

This is an early beta. Fare rates are provisional sample values. Test-mode Stripe Checkout is available only after an invited driver accepts a ride; each accepted ride in a recurring series is paid separately. Live payments and tipping are not enabled. A ride is not confirmed until a driver accepts it.

## Current fare estimate

The Worker calculates the estimate using `src/pricing.js`; public `GET /api/rates` returns the current sample schedule:

- $3 base fare
- $1.80 per mile
- $0.30 per driving minute
- $8 minimum subtotal
- $1 booking fee

The passenger sees the quote as provisional. Approve the fare schedule before describing estimates as final customer prices.

`stopFeePerStop` is currently `null`; no stop fee is assumed. Estimates with intermediate stops show the known subtotal and `bookable: false`, with a null total, until a fee is explicitly configured.

## Ohio, Kentucky, and Indiana beta area

The current beta accepts pickup, intermediate stop, and destination addresses in Ohio, Kentucky, and Indiana. Address search is limited to the United States and filters results to those three states. Before requesting a route or fare, the Worker checks each selected place against Geoapify's canonical state and country details. A suggestion outside the three-state area cannot be used to request a ride.

## Account model

- Passenger email/password signup is enabled in the confirmed beta staging project. Email confirmation remains required; drivers stay invite-only.
- The exact Preview root is in Supabase Auth's redirect allowlist. The project's existing Site URL was left unchanged; signup and password-recovery flows specify the Preview URL directly. Add local and production redirects only when those origins are ready.
- Custom SMTP is not configured yet. Configure a provider before inviting passengers or drivers outside the Supabase team's test addresses. Keep email confirmation enabled; disabling it would let a user register an address they do not control. See [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp) and [email/password auth](https://supabase.com/docs/guides/auth/passwords).
- New profiles always start with the `passenger` role. Signup metadata can set the passenger's name and phone, but cannot set a role.
- Invite drivers from Supabase Auth after SMTP is working. After the invited user exists, inspect its profile and promote it through the Supabase SQL Editor as an administrator:

  ```sql
  select users.email, profiles.id, profiles.role
  from auth.users as users
  join public.profiles as profiles on profiles.id = users.id
  where lower(users.email) = lower('invitee@example.com');
  ```

  Verify the account and then update the exact UUID shown above:

  ```sql
  update public.profiles
  set role = 'driver'
  where id = 'AUTH_USER_UUID'::uuid;
  ```

  Do not run that update for an unverified address. Passenger clients have no database permission or API endpoint to change `profiles.role`.

## Supabase project setup

Public address search, route estimates, fare rates, and map tiles work without passenger sign-in. Preview values in `wrangler.jsonc` point to the Supabase project confirmed for beta staging; production values remain placeholders. Do not use production data in the Preview.

1. The Preview `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are already set in `wrangler.jsonc`. The URL and publishable key are returned by `/api/config`; the publishable key is intended to be public and is protected by Postgres grants and row-level security.
2. Supabase Auth has email signup and email confirmation enabled. The exact Preview root is in the redirect allowlist; the existing Site URL was left unchanged. Custom SMTP is still disabled, so configure a provider before external passengers rely on confirmation or password-reset emails.
3. The initial migrations were run successfully in the confirmed staging project's Supabase SQL Editor: `20261115000100_steadlane_bookings.sql` and `20261115000200_steadlane_stripe_payments.sql`. Do not run them again. SQL Editor runs do not add entries to the migration history table; retain the tracked files as the schema source of truth and establish the CLI migration baseline before using `supabase db push` on this existing database.
4. `20261117090155_fix_recurring_booking_idempotency_window.sql` is a prepared follow-up migration and has not been applied. It lets retries return an existing recurring series after its original date window has passed. Review and apply it once through the beta staging project before relying on this fix.
5. Read-only catalog checks confirmed all nine public tables exist with RLS enabled. The ride quote table has no direct client policy because the Worker writes server-verified quotes; Stripe webhook events are service-only. RPC grants were checked: no anonymous execution, seven authenticated booking RPCs, and four payment RPCs limited to `service_role`.

The signup trigger copies only validated `full_name` and `phone` metadata into a profile. It always writes role `passenger`. Profile updates are limited to the name and phone columns.

## Cloudflare configuration

`wrangler.jsonc` points the Worker at `src/worker.js`, binds the root static asset directory as `ASSETS`, and runs the Worker first for `/api/*`. `.assetsignore` is an allowlist so tests, migrations, README, workflows, Wrangler config, and the Worker implementation are not public assets. It includes the browser app modules, PWA files, and Steadlane icon. The service worker bypasses `/api/*`; API data is never cached for offline use.

Cloudflare Rate Limit bindings enforce approximate per-IP limits: 30 address searches per minute, 8 route estimates per minute, and 120 map tiles per minute. Cloudflare documents that these counters are approximate and per location, so a short burst may exceed the limit. Production and Preview use separate namespace IDs. All namespace IDs must be unique within the Cloudflare account; verify the production and Preview IDs do not collide with other bindings before deploying. These bindings require Wrangler v4.36.0 or later. See [Cloudflare Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Replace the public placeholders in `wrangler.jsonc` before deploying. Set the service credentials as Cloudflare Worker secrets; do not commit them or send them in chat:

- `GEOAPIFY_API_KEY` — Geoapify key with access to autocomplete, place details, routing, and map tiles.
- `SUPABASE_SECRET_KEY` — Supabase `sb_secret_...` key. The Worker uses it only for server-calculated quote inserts and the narrowly allowlisted payment-session and signed-webhook RPCs. It is not returned by `/api/config`, is never used by browser code, and is not used for passenger/driver reads or ride changes. It remains a powerful project credential if compromised; protect and rotate it like any other server secret.
- `STRIPE_SECRET_KEY` — a rotated Stripe test API key. The Stripe helper accepts `sk_test_` and `rk_test_` keys and rejects live-mode keys. Prefer a restricted `rk_test_` key with Checkout Sessions write permission (which includes read); use it after the Worker configuration gate accepts that prefix. Never place this key in browser code, GitHub, or chat.
- `STRIPE_WEBHOOK_SECRET` — the signing secret for the Stripe test-mode webhook pointed at `/api/stripe/webhook`.

The current Preview still needs `SUPABASE_SECRET_KEY` before signed-in quote storage and ride requests can work. The Geoapify key is configured for Preview; rotate it before inviting broader beta use because it was shared in chat. Stripe Checkout remains disabled until the pasted test secret is rotated and the test webhook signing secret is added.

Stripe Checkout requires the `steadlane_stripe_payments` migration before passenger payments can be enabled. Add `STRIPE_PAYMENTS_ENABLED=true` as a Preview-only Worker variable only after the migration is applied and all three payment secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `SUPABASE_SECRET_KEY`) are configured. The app reports payments enabled only when those test-mode credentials are present and Stripe Tax remains off. Keep payment secrets in Cloudflare Preview; do not configure production secrets for this beta. Configure a Stripe test-mode webhook for `/api/stripe/webhook` and subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, and `charge.refunded`.

Stripe Tax is not enabled by this beta. Setting `STRIPE_AUTOMATIC_TAX_ENABLED=true` keeps Checkout unavailable until a later tax implementation is reviewed. Before adding it, confirm where Steadlane is registered to collect tax and verify the correct product tax code, tax behavior, and location basis with a tax professional. Stripe Tax uses customer location and product tax configuration to calculate tax. See [Stripe Tax registrations](https://docs.stripe.com/tax/registrations), [automatic tax settings](https://docs.stripe.com/tax/checkout), and [tax calculation inputs](https://docs.stripe.com/tax/invoicing).

The Geoapify key is sent only from the Worker to Geoapify. Map tiles are served through `/api/map/...`; the page displays Geoapify, OpenMapTiles, and OpenStreetMap attribution as required by the [Geoapify map tile documentation](https://apidocs.geoapify.com/docs/maps/).

`STOP_FEE_CENTS` is an optional positive integer Worker variable. Leave it unset until the stop fee is approved. If configured, the Worker adds that fee for each stop before reporting a total or allowing a booking. Do not set it to zero; an unknown fee is represented as incomplete pricing, not as a free stop.

## Deployment paths

Cloudflare Worker Builds are already connected to this GitHub repository on the `main` production branch. The current dashboard command is `npx wrangler deploy`, with no separate build command. Workers Builds uses the Wrangler version from `package.json`; Wrangler is pinned to `4.161.0` and locked in `package-lock.json` to match the manual workflow. A commit merged to `main` therefore triggers Cloudflare's production deployment automatically. That native Cloudflare path does not run `npm test`; review the pull request checks before merging to `main`.

Cloudflare preview branch builds and public Preview URLs are enabled. After a successful build, each branch has a public, branch-specific `workers.dev` URL; preview settings and secrets must be configured separately from production. The current working-beta preview address is `https://codex-steadlane-working-beta-steadlane.sapplegater.workers.dev/`. Treat this as a public test site, and use staging data only.

The repository also has a separate, manually triggered GitHub Actions workflow. It runs `npm test` and then deploys with Wrangler, but only when dispatched from `main`. It requires `CLOUDFLARE_ACCOUNT_ID` and a least-privilege `CLOUDFLARE_API_TOKEN` in GitHub Actions secrets. Use one deployment path for a release; manually dispatching the workflow after Cloudflare has already deployed the same `main` commit would publish it twice. Neither path applies the Supabase migration or creates external resources.

The Cloudflare build connection already has its own build token; do not copy that token into GitHub or the repository. Preview deployments use the separate `previews` settings in `wrangler.jsonc`; those values point to the supplied Supabase project, while production values remain placeholders. Add `GEOAPIFY_API_KEY` and `SUPABASE_SECRET_KEY` as secrets for this Preview in Cloudflare. Add the rotated Stripe test secret and webhook signing secret only after reviewing the migration and configuring the Stripe test endpoint; then set `STRIPE_PAYMENTS_ENABLED=true` in this Preview. Previews Base secrets seed new previews only, so configure this existing preview directly. Keep production secrets and values separate. The production placeholders currently in `wrangler.jsonc` intentionally make `/api/config` unavailable until real project values are configured.

To preview the Worker locally, run `npm ci`, then create a local `.dev.vars` file (ignored by Git) containing the Supabase URL and publishable key, `SUPABASE_SECRET_KEY`, and `GEOAPIFY_API_KEY`. Run `npm exec wrangler -- dev` from the repository root. The hosted `/api/config` endpoint returns the Supabase URL, publishable key, and a boolean indicating whether test Checkout is fully configured; it never returns a secret.

## API used by the browser app

`src/booking-api.js` supplies `createBookingApi(authClient)` and can be created before Supabase is configured. Public address and route estimate requests do not require a Supabase account. If a route estimate includes a valid passenger access token, the Worker validates it and saves a short-lived quote only when its fare is complete. Guest estimates never insert quote rows and cannot be used to request rides. Authenticated booking requests send the current Supabase access token in an Authorization header; the Worker validates it with Supabase Auth and then uses the caller's JWT and publishable key for user-scoped profile, booking, contact, availability, and RPC operations. API requests are same-origin only.

| Request | Purpose |
| --- | --- |
| `GET /api/config` | Public Supabase URL and publishable key, plus a boolean indicating whether test Checkout is fully configured |
| `GET /api/rates` | Current provisional fare schedule, with `stopFeePerStop: null` while unconfigured |
| `GET /api/me` | Current profile and Auth email |
| `PATCH /api/me` | Update the passenger name and phone; role is not writable |
| `GET /api/address?q=...` | Public, rate-limited address suggestions with Geoapify place IDs |
| `POST /api/route-quote` | Public, rate-limited route estimate; a passenger token saves a ten-minute quote only if priced completely |
| `GET /api/bookings` | Passenger history or a driver's open queue and assigned rides, including recurring series IDs, as allowed by RLS |
| `POST /api/bookings` | Create a ride request from a quote ID and idempotency key |
| `POST /api/bookings/{id}/checkout-session` | Create a hosted test Checkout session for an accepted unpaid ride owned by the signed-in passenger |
| `POST /api/stripe/webhook` | Verify and process Stripe payment events; this endpoint uses Stripe's signature instead of a passenger session |
| `POST /api/bookings/{id}/cancel` | Cancel an owned pending ride request |
| `POST /api/driver-response` | Accept or decline a request as an invited driver |
| `GET /api/driver/availability` | Read the driver's weekly schedule |
| `PUT /api/driver/availability` | Replace the driver's weekly schedule atomically |
| `POST /api/recurring-bookings` | Create a weekly series of individual ride requests |
| `POST /api/recurring-bookings/{id}/cancel` | Cancel a series and its remaining pending occurrences |
| `GET /api/map/{z}/{x}/{y}.png` | Same-origin Geoapify raster map tile proxy |

The quote request accepts `{ pickup: { placeId }, stops: [{ placeId }], destination: { placeId }, pickupAt, passengerCount }`; `stops` is optional and limited to three ordered intermediate stops. The Worker resolves canonical labels and coordinates from Geoapify, verifies that each selected point is in Ohio, Kentucky, or Indiana, requests the complete driving route, and prices it on the server. Multi-leg GeoJSON is flattened to a LineString for the map and saved with canonical stop snapshots. The fare response contains `stopCount`, `stopCharge`, `knownSubtotal`, `bookable`, and nullable `total`. Without a configured stop fee, a stopped route returns its known subtotal with `stopCharge: null`, `bookable: false`, and `total: null`; it cannot be booked. The browser cannot create or change quote rows.

Driver availability accepts one window per ISO weekday (Monday 1 through Sunday 7), using local `HH:mm` times in `America/New_York`. Windows cannot cross midnight. Queue visibility and both driver response decisions are checked against the saved availability window for that pickup. Recurring schedules use the same weekday numbering and timezone; their inclusive local date range is limited to 90 calendar days. Missing or repeated daylight-saving times are rejected. Each occurrence is created as an individual request and can be accepted separately. Cancelling the series cancels its pending occurrences; already accepted rides remain assigned.

Booking creation calls `create_booking_from_quote`, which locks the owned quote, checks expiry and unused status, snapshots its server-computed route and fare, writes the passenger contact snapshot, and consumes the quote in one transaction. Retrying with the same idempotency key returns the existing booking. A second key cannot book the same quote. `respond_to_booking` serializes driver decisions under a booking row lock, so only one driver can accept. Driver declines are recorded per driver; the request remains available to other drivers. `cancel_booking` permits only the owning passenger to cancel a pending request; an assigned ride cannot be cancelled through this endpoint.

RLS exposes passenger bookings to their owner, pending requests to promoted drivers who have not declined them and whose availability matches the pickup time, and assigned rides to their assigned driver. Passenger contact is stored separately; drivers can read it only after assignment. Route labels, coordinates, ordered stops, route geometry, pickup time, passenger count, and fare are stored with the quote and each booking. Pickup, stop, and destination points must be in Ohio, Kentucky, or Indiana.

When the payment migration is applied and Preview test secrets are set, only the passenger who owns an accepted booking can open Checkout. Checkout amount and currency come from the stored server fare snapshot. The app shows payment as complete only after a signed, deduplicated Stripe webhook updates the payment record; a browser redirect alone never marks a ride paid. Each recurring occurrence is its own ride and its own payment. Refunds and ride cancellations after acceptance are not automated in this beta; handle them in the Stripe Dashboard and contact the passenger directly. Passengers can read only their own payment attempts; drivers do not receive the passenger's payment status.

## Build and validation

Run the existing tests with:

```sh
npm test
```

The package currently defines no compilation/bundling step. The manual GitHub deploy workflow runs this test command before `wrangler deploy`; the connected Cloudflare Worker Builds path deploys `main` without running it.
