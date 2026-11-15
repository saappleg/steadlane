# Steadlane

Steadlane is a passenger ride-request beta hosted as a Cloudflare Worker with static assets. Supabase Auth and Postgres store accounts and booking data; Geoapify provides address search, place details, driving routes, and map tiles.

This is an early beta. Fare rates are provisional sample values, there is no payment processing or tipping collection, and a ride is not confirmed until an invited driver accepts it.

## Current fare estimate

The Worker calculates the estimate using `src/pricing.js`; public `GET /api/rates` returns the current sample schedule:

- $3 base fare
- $1.80 per mile
- $0.30 per driving minute
- $8 minimum subtotal
- $1 booking fee

The passenger sees the quote as provisional. Approve the fare schedule before describing estimates as final customer prices.

`stopFeePerStop` is currently `null`; no stop fee is assumed. Estimates with intermediate stops show the known subtotal and `bookable: false`, with a null total, until a fee is explicitly configured.

## Cincinnati and Northern Kentucky beta area

The current beta accepts pickup, intermediate stop, and destination addresses within this approximate rectangle:

- Longitude: **-84.92 to -84.20**
- Latitude: **38.82 to 39.60**

It includes Cincinnati and Hamilton, with the west edge near Lawrenceburg, Indiana, the north edge near Franklin, Ohio, and the south edge near Walton, Kentucky. This is a geographic rectangle, not a city, county, or state boundary. Every selected route point must fall inside it. Address suggestions are filtered to this area, and the Worker checks Geoapify's canonical coordinates again when creating a fare estimate.

## Account model

- Anyone can create a passenger account with email and password.
- Email confirmation stays enabled. Set the Supabase Auth Site URL and redirect allowlist to the deployed Steadlane origin. Add the local Wrangler origin when testing locally.
- Configure a custom SMTP provider before inviting external passengers or drivers. Supabase's hosted default email service only sends to addresses on the Supabase organization team and is limited to 2 emails per hour. Keep email confirmation enabled; disabling it would let a user register an address they do not control. See [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp) and [email/password auth](https://supabase.com/docs/guides/auth/passwords).
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

Public address search, route estimates, fare rates, and map tiles work without Supabase configuration or passenger sign-in. To enable accounts and ride requests, create a Supabase project and get its project URL and publishable key from the project's Connect dialog or API Keys settings. Then:

1. Replace the two clearly marked public placeholders in `wrangler.jsonc`: `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. The URL and publishable key are returned by `/api/config`; the publishable key is intended to be public and is protected by Postgres grants and row-level security.
2. In Supabase Auth, enable email signups and email confirmations. Configure Site URL and the deployed and local redirect URLs. Configure custom SMTP before using addresses outside the organization's team.
3. Apply `supabase/migrations/20261115000100_steadlane_bookings.sql` once as the project database owner. The migration is the source-controlled schema definition. For a one-time setup, paste the full file into the Supabase SQL Editor and run it. If the repository is initialized with the Supabase CLI, link it to the project and use `supabase db push` to apply the tracked migration.
4. Confirm that the migration created the Auth signup trigger and the `profiles`, `ride_quotes`, `driver_weekly_availability`, `booking_series`, `bookings`, `booking_contacts`, and `driver_responses` tables. Every public table enables RLS. The migration explicitly grants only the Data API permissions each role needs; new public tables are not automatically exposed by current Supabase defaults.

The signup trigger copies only validated `full_name` and `phone` metadata into a profile. It always writes role `passenger`. Profile updates are limited to the name and phone columns.

## Cloudflare configuration

`wrangler.jsonc` points the Worker at `src/worker.js`, binds the root static asset directory as `ASSETS`, and runs the Worker first for `/api/*`. `.assetsignore` is an allowlist so tests, migrations, README, workflows, Wrangler config, and the Worker implementation are not public assets. It includes the browser app modules, PWA files, and Steadlane icon. The service worker bypasses `/api/*`; API data is never cached for offline use.

Cloudflare Rate Limit bindings enforce approximate per-IP limits: 30 address searches per minute, 8 route estimates per minute, and 120 map tiles per minute. Cloudflare documents that these counters are approximate and per location, so a short burst may exceed the limit. The namespace IDs in `wrangler.jsonc` are user-selected numeric identifiers and must be unique within the Cloudflare account; verify they do not collide with another binding before deploying. These bindings require Wrangler v4.36.0 or later. See [Cloudflare Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Replace the public placeholders in `wrangler.jsonc` before deploying. Set these Worker secrets in Cloudflare; do not commit them or send them in chat:

- `GEOAPIFY_API_KEY` — Geoapify key with access to autocomplete, place details, routing, and map tiles.
- `SUPABASE_SECRET_KEY` — Supabase `sb_secret_...` key. The Worker uses it only to insert a server-calculated quote row. It is not returned by `/api/config`, is never used by browser code, and is not used for passenger/driver reads or booking changes. The database migration grants the `service_role` only the quote insert columns; the secret key still has elevated project access if compromised, so protect and rotate it like any other server credential.

The Geoapify key is sent only from the Worker to Geoapify. Map tiles are served through `/api/map/...`; the page displays Geoapify, OpenMapTiles, and OpenStreetMap attribution as required by the [Geoapify map tile documentation](https://apidocs.geoapify.com/docs/maps/).

`STOP_FEE_CENTS` is an optional positive integer Worker variable. Leave it unset until the stop fee is approved. If configured, the Worker adds that fee for each stop before reporting a total or allowing a booking. Do not set it to zero; an unknown fee is represented as incomplete pricing, not as a free stop.

## Deployment paths

Cloudflare Worker Builds are already connected to this GitHub repository on the `main` production branch. The current dashboard command is `npx wrangler deploy`, with no separate build command. A commit merged to `main` therefore triggers Cloudflare's production deployment automatically. That native Cloudflare path does not run `npm test`; review the pull request checks before merging to `main`.

Cloudflare preview branch builds are enabled, but Preview URLs are disabled. A pull request can run a preview build, but Cloudflare will not publish a separate public preview URL with the current setting.

The repository also has a separate, manually triggered GitHub Actions workflow. It runs `npm test` and then deploys with Wrangler, but only when dispatched from `main`. It requires `CLOUDFLARE_ACCOUNT_ID` and a least-privilege `CLOUDFLARE_API_TOKEN` in GitHub Actions secrets. Use one deployment path for a release; manually dispatching the workflow after Cloudflare has already deployed the same `main` commit would publish it twice. Neither path applies the Supabase migration or creates external resources.

The Cloudflare build connection already has its own build token; do not copy that token into GitHub or the repository. Once the Worker runtime is enabled by a deployment, configure the non-secret Supabase URL and publishable key from `wrangler.jsonc` and add `GEOAPIFY_API_KEY` and `SUPABASE_SECRET_KEY` as Worker secrets in Cloudflare. The placeholders currently in `wrangler.jsonc` intentionally make `/api/config` unavailable until real project values are configured.

To preview the Worker locally, use Wrangler v4.36.0 or later with a local `.dev.vars` file (ignored by Git) containing the Supabase URL and publishable key, `SUPABASE_SECRET_KEY`, and `GEOAPIFY_API_KEY`. The project currently has no local Wrangler dependency or build script; use the Wrangler CLI and run `wrangler dev` from the repository root. The hosted `/api/config` endpoint returns only the Supabase URL and publishable key.

## API used by the browser app

`src/booking-api.js` supplies `createBookingApi(authClient)` and can be created before Supabase is configured. Public address and route estimate requests do not require a Supabase account. If a route estimate includes a valid passenger access token, the Worker validates it and saves a short-lived quote only when its fare is complete. Guest estimates never insert quote rows and cannot be used to request rides. Authenticated booking requests send the current Supabase access token in an Authorization header; the Worker validates it with Supabase Auth and then uses the caller's JWT and publishable key for user-scoped profile, booking, contact, availability, and RPC operations. API requests are same-origin only.

| Request | Purpose |
| --- | --- |
| `GET /api/config` | Public Supabase URL and publishable key only |
| `GET /api/rates` | Current provisional fare schedule, with `stopFeePerStop: null` while unconfigured |
| `GET /api/me` | Current profile and Auth email |
| `PATCH /api/me` | Update the passenger name and phone; role is not writable |
| `GET /api/address?q=...` | Public, rate-limited address suggestions with Geoapify place IDs |
| `POST /api/route-quote` | Public, rate-limited route estimate; a passenger token saves a ten-minute quote only if priced completely |
| `GET /api/bookings` | Passenger history or a driver's open queue and assigned rides, including recurring series IDs, as allowed by RLS |
| `POST /api/bookings` | Create a ride request from a quote ID and idempotency key |
| `POST /api/bookings/{id}/cancel` | Cancel an owned pending ride request |
| `POST /api/driver-response` | Accept or decline a request as an invited driver |
| `GET /api/driver/availability` | Read the driver's weekly schedule |
| `PUT /api/driver/availability` | Replace the driver's weekly schedule atomically |
| `POST /api/recurring-bookings` | Create a weekly series of individual ride requests |
| `POST /api/recurring-bookings/{id}/cancel` | Cancel a series and its remaining pending occurrences |
| `GET /api/map/{z}/{x}/{y}.png` | Same-origin Geoapify raster map tile proxy |

The quote request accepts `{ pickup: { placeId }, stops: [{ placeId }], destination: { placeId }, pickupAt, passengerCount }`; `stops` is optional and limited to three ordered intermediate stops. The Worker resolves canonical labels and coordinates from Geoapify, checks each point against the service rectangle, requests the complete driving route, and prices it on the server. Multi-leg GeoJSON is flattened to a LineString for the map and saved with canonical stop snapshots. The fare response contains `stopCount`, `stopCharge`, `knownSubtotal`, `bookable`, and nullable `total`. Without a configured stop fee, a stopped route returns its known subtotal with `stopCharge: null`, `bookable: false`, and `total: null`; it cannot be booked. The browser cannot create or change quote rows.

Driver availability accepts one window per ISO weekday (Monday 1 through Sunday 7), using local `HH:mm` times in `America/New_York`. Windows cannot cross midnight. Queue visibility and both driver response decisions are checked against the saved availability window for that pickup. Recurring schedules use the same weekday numbering and timezone; their inclusive local date range is limited to 90 calendar days. Missing or repeated daylight-saving times are rejected. Each occurrence is created as an individual request and can be accepted separately. Cancelling the series cancels its pending occurrences; already accepted rides remain assigned.

Booking creation calls `create_booking_from_quote`, which locks the owned quote, checks expiry and unused status, snapshots its server-computed route and fare, writes the passenger contact snapshot, and consumes the quote in one transaction. Retrying with the same idempotency key returns the existing booking. A second key cannot book the same quote. `respond_to_booking` serializes driver decisions under a booking row lock, so only one driver can accept. Driver declines are recorded per driver; the request remains available to other drivers. `cancel_booking` permits only the owning passenger to cancel a pending request; an assigned ride cannot be cancelled through this endpoint.

RLS exposes passenger bookings to their owner, pending requests to promoted drivers who have not declined them and whose availability matches the pickup time, and assigned rides to their assigned driver. Passenger contact is stored separately; drivers can read it only after assignment. Route labels, coordinates, ordered stops, route geometry, pickup time, passenger count, and fare are stored with the quote and each booking. The current beta service area is the approximate Cincinnati and Northern Kentucky rectangle listed above.

## Build and validation

Run the existing tests with:

```sh
npm test
```

The package currently defines no compilation/bundling step. The manual GitHub deploy workflow runs this test command before `wrangler deploy`; the connected Cloudflare Worker Builds path deploys `main` without running it.
