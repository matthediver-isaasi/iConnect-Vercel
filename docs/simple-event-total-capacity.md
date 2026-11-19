# Simple-event total capacity

## Contract and safe rollout

`supabase/migrations/202701220001_simple_event_total_capacity.sql` was applied
to verified DEST on **2026-11-19**. The migration depends on the
existing commercial-allocation functions and public-ticket batch helper. Its
function adjustments fail explicitly if the expected contracts have changed.
The schema rollout is complete; this does **not** establish deployment of the
matching API/editor code or verification of live checkout.

### Destination rollout record

- Target: DEST Supabase project `lvmzliemqnieeoruhkik`, database `postgres`,
  via the documented pinned pooler/project user and REST origin. SQL used
  provider-CA and hostname-verified TLS (the actual client socket was verified).
  Independent SQL checks confirmed the destination tenant and database/user;
  separately authenticated DEST REST and SQL event samples matched. SOURCE was
  never connected to or changed.
- Exact merged migration SHA-256:
  `9cf03ac9d3c76c44db45be64b6d7cdf558c3d61299af718bb71c93fcda92f102`.
  The file was unchanged from its merged version.
- Read-only preflight found both columns, all five new functions and all five
  triggers absent. All 12 referenced existing function signatures were present,
  without unexpected overloads; each applicable patch anchor was checked.
- Rollback-only rehearsal passed, then the apply command repeated the rehearsal
  before one atomic application. Only the hash-pinned outer `BEGIN`/`COMMIT` were
  removed so the runner owned the transaction; the SQL body was unchanged.
  Rehearsal left the migration absent. Lock waits were bounded to 5 seconds and
  statement waits to 60 seconds. No unrelated prerequisites were applied.
- Pre-commit verification checked exact bodies of five new functions, exact
  expected changes to existing functions (including retained ownership, security
  context and grants), both column types/defaults/nullability, validated checks,
  all five enabled row triggers, and both initially deferred constraint triggers.
  Aggregate/batch RPC execution is service-only; new trigger helpers are not
  executable by PUBLIC, anon or authenticated. Existing RPC grants were retained,
  not broadly rewritten.
- Under the event table's required DDL lock, all **200 existing events** retained
  `available_seats`, `is_unlimited_registration`, `is_complex`, `pricing_config`,
  IDs, tenant IDs and row versions. All received only `capacity_mode='legacy'`
  and `total_capacity=NULL` defaults; no event UPDATE or conversion occurred.
  This includes Leadership Conference 2027; its counter was not interpreted as
  an intended maximum. The bounded preservation evidence SHA-256 (capacity
  fields plus row versions, with new defaults) was
  `06c2c1bf5086dcdd678825542e932560df7c65ee687c581493f512144c9115bd`
  in both the separate rehearsal and successful application.
- Post-commit catalog verification passed. The committed schema-reload
  notification was confirmed through fresh service-authenticated PostgREST
  OpenAPI discovery of both columns and both RPCs, a read-only event projection,
  and an aggregate capacity GET matching a read-only SQL call as `service_role`.
  No booking, sale, invitation, payment, refund or message writer was invoked.
- No application code was deployed. Signed-in UI, public bundle version and
  live checkout were not verified. Release the matching readers/writers
  everywhere before any explicit administrator opt-in. The unchanged local
  preview still renders its previously documented `Tenant not found` error
  against legacy SOURCE configuration; it is not evidence about DEST rollout.

Runner commands (offline review is the default):

```sh
node scripts/apply-simple-event-total-capacity.mjs
node scripts/apply-simple-event-total-capacity.mjs --preflight
node scripts/apply-simple-event-total-capacity.mjs --rehearse --review-sha256=9cf03ac9d3c76c44db45be64b6d7cdf558c3d61299af718bb71c93fcda92f102
node scripts/apply-simple-event-total-capacity.mjs --apply --review-sha256=9cf03ac9d3c76c44db45be64b6d7cdf558c3d61299af718bb71c93fcda92f102
node scripts/apply-simple-event-total-capacity.mjs --verify
```

A complete installation is verified, never reapplied. Partial installations,
unexpected signatures, changed SQL or incompatible patch anchors stop without
speculative repair. `--preflight` and `--verify` are read-only.

All existing events default to `capacity_mode = 'legacy'`. No event capacities
are backfilled, inferred or converted. Release the matching readers and writers
everywhere before an administrator opts an existing event into total mode.
Do not activate totals while older application instances still serve event
availability.

New simple events use total mode. A finite `total_capacity` is an integer
maximum across all ticket classes, including zero. Null means unlimited.
Administrators enter the complete maximum, never the maximum minus bookings.
Conversion is explicit and one-way; a normal edit of a legacy event retains
its legacy counter.

For total-mode events, `available_seats` is deliberately **null in storage**.
It is not the maximum and must not be read directly as remaining availability.
The database neutralizes old counter writes, including cancellation/reversal
writes. The API projects remaining places from `simple_event_capacity`.

Usage is:

- confirmed booking rows, plus
- unused committed commercial places, using the existing allocation rule
  `greatest(remaining - named - reserved, 0)` per allocation.

Cancelled bookings do not consume places. Named/reserved places already
represented by bookings are not counted twice. Public responses expose only
aggregate availability, not attendee or allocation records. An aggregate read
failure is an error, never zero occupancy.

Reducing a maximum below usage keeps existing bookings but returns zero
remaining. Capacity-producing writes serialize on the event row across
classes. Deferred final checks allow an atomic conversion from committed
commercial capacity to a named booking without temporarily counting twice.
Ordinary total-mode group booking inserts are all-or-nothing. Public batch
capacity failures retain the established compensation marker; booking-credit
rollbacks preserve their existing voucher and provider recovery paths.

## Historical Leadership Conference record

The observed stored counter of 146 is **not evidence of an intended total**.
No change to that live record is authorized by this implementation. Obtain
the owner's confirmation before establishing a total. If 146 is confirmed,
118 confirmed bookings and 19 cancelled bookings imply 28 remaining, less any
additional unused committed commercial places.

## Isolated verification

No live payment, refund, message or customer booking is needed:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --import tsx --test --test-concurrency=1 api/_lib/simpleEventCapacity.test.mjs api/_lib/simpleEventCapacity.postgres.test.mjs client/src/components/events/EventCapacitySummary.test.jsx supabase/migrations/bookingCreditAttempts.test.mjs api/_lib/salesCommercialAllocation.postgres.test.mjs api/_lib/publicTicketMemberCreation.postgres.test.mjs api/public/ticketReleaseSerializers.test.mjs
node_modules/.bin/playwright test --config=tests/create-event-ticket-expansion.config.mjs --grep='explicit total'
node_modules/.bin/playwright test --config=tests/event-card-waiting-lists.config.mjs --grep='total-mode'
```

The PostgreSQL checks create disposable UNIX-socket-only clusters and exercise
real SQL functions, including last-place competition across ticket classes,
ordinary bookings versus commercial sale confirmation, cancellation, public
payment recovery markers, replay and credit reversal.
Browser checks use isolated service fixtures, not a signed-in customer session.

Rollout-runner safeguards and its actual transaction lifecycle are checked with:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test --test-concurrency=1 scripts/apply-simple-event-total-capacity.test.mjs scripts/apply-simple-event-total-capacity.postgres.test.mjs scripts/apply-custom-object-relationship-deleted-members-migration.test.mjs
```

On 2026-11-19 all 11 runner/guard checks passed, including real disposable
PostgreSQL rehearsal rollback, application, preservation, verify-only replay
and rejection of a damaged patch. The three focused capacity-reader and
disposable capacity-behavior checks also passed:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --import tsx --test --test-concurrency=1 api/_lib/simpleEventCapacity.test.mjs api/_lib/simpleEventCapacity.postgres.test.mjs
```
