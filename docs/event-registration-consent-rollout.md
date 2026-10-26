# Post-registration communication opt-in

## Scope and deployment

Administrators configure the optional booker-only prompt on the Emails tab of
simple/programme/training events and the combined complex-event editor. The
private configuration has no public projection and is independent of donations.
No configuration row means no prompt; there is no historical booking backfill.
Duplicating an event copies its currently active category selections.

Required migration: `supabase/migrations/202610260001_event_registration_consent.sql`.

- **Pending** on external Supabase **DEST**, project `lvmzliemqnieeoruhkik`.
- **Not applied** to DEST, legacy SOURCE, or Replit's database during development.
- Applied and exercised only in a disposable local PostgreSQL test database.
- On 2026-10-26, `node scripts/check-event-registration-consent-destination.mjs`
  verified the pinned DEST SQL connection with certificate verification and a
  read-only transaction. Both new tables are absent. The existing atomic
  category-consent operation, role table and special-category column exist.
- The Supabase connector denied the metadata query; the documented, pinned
  destination SQL connection completed the same read-only check.

Apply the reviewed migration to DEST through the approved migration process
before releasing the matching application changes. Applying it is a separate
production action requiring approval. Do not apply it to SOURCE or add it to
automatic startup. No application deployment or production data writes were
performed.

## Consent and purchaser authority

Fresh fulfilled registration responses issue a thirty-minute purpose-scoped
capability, once per purchase. Allocation/invitation claims do not issue offers.
Signed-in consent additionally requires the original member's current session.
Guest consent cannot mutate any member, even if its email matches a member.

The browser's random recovery nonce is **not payment or booking authority**.
It can recover only an existing, incomplete offer bound to the same purchase
and purchaser; it cannot create offers for old bookings. It is excluded from
the booking-credit fingerprint so the optional feature does not change payment
idempotency. Raw tokens are sent in POST bodies and kept in tab storage, not URLs.

Display and submission recheck current shared eligibility, subscriptions,
configuration and suppression. The final transaction takes the existing
tenant/email consent lock and rechecks suppression, member/public audience,
roles, active categories and the event selection. It invokes the existing
category consent operation only for explicitly selected IDs. It never invokes
the form-subscription operation, which can clear global opt-outs.

The capability row records the source, purchase, identity, selected categories
and completion timestamp. Skip records completion, not a preference change.
Deleting an event removes its private configuration and incomplete capabilities;
completed consent evidence is retained.

## Verification

- `node --test scripts/event-registration-consent.postgres.test.mjs`
  uses disposable PostgreSQL, including service-role grants, cross-tenant
  category rejection, guest/member collisions, stale selections, expiry,
  replay, deletion and a real concurrent global-opt-out lock test.
- `node scripts/run-isolated-tests.mjs node --test api/_lib/eventRegistrationConsent.test.mjs api/_lib/bookingCreditAttempt.test.mjs api/member/communication-preferences.test.mjs api/_lib/programRegistrationAttempt.test.mjs`
  exercises purchaser/session checks, eligibility and credit retry identity.
- `node scripts/run-isolated-tests.mjs node --test tests/public-group-booking.test.mjs`
  confirms simple and complex group-registration access behavior is unchanged.
- `node scripts/run-isolated-tests.mjs node --test api/public/public-invoice-po.handlers.test.mjs api/_lib/publicInvoicePo.test.mjs`
  exercises exported simple/complex booking handlers with isolated providers:
  free, captured/uncaptured/cancelled card, capacity failure and accepted unpaid
  Invoice/PO. Multi-attendee purchases issue one consent offer for the purchaser.
  The suite retains its pre-existing TODO for the simple handler accepting a
  card request without an intent. Such requests cannot issue a consent offer.
- `npx playwright test --config tests/event-registration-consent.config.mjs`
  mounts the real selector and consent dialog with isolated APIs: hydration,
  unchecked choices, explicit selections, Escape/Skip, duplicate responses,
  refresh, empty responses, saving failure/retry and identity changes.

These are isolated tests, not live Stripe settlement or signed-in tenant
end-to-end evidence. The development preview starts successfully but its root
returns “Tenant not found”; authenticated tenant screens were not visually
verified. Browser tests do not bypass application authentication.
