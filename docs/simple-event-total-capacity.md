# Simple-event total capacity

## Contract and safe rollout

Apply `supabase/migrations/202701220001_simple_event_total_capacity.sql`
before releasing the matching API and editor code. The migration depends on the
existing commercial-allocation functions and public-ticket batch helper. Its
function adjustments fail explicitly if the expected contracts have changed.
It is prepared and tested locally, **not applied to a shared or live database**.

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
