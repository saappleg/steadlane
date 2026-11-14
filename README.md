# Steadlane

Steadlane is a mobile-first private transportation booking platform.

## Beta goals
- Upfront fare quotes based on actual route distance and duration
- Passenger booking requests and confirmation
- Driver dashboard with accept/decline actions
- Repeat customer experience
- Cloudflare deployment using Workers and D1

## Safety and launch
This repository is under active development and is not yet a live booking service. No real passenger data should be entered until authentication, privacy controls, and server-side validation are deployed.

## Pricing model
Fare = max(minimumFare, baseFare + distanceMiles * perMile + durationMinutes * perMinute) + bookingFee. Server computes and stores the quote; clients never set their own final fare. Route distance and duration must come from a routing provider before a customer-facing firm quote is displayed.

## Hosting
GitHub stores the source; Cloudflare will host the web app/API and D1 database. Production credentials must be stored in Cloudflare secrets, never in this public repository.
