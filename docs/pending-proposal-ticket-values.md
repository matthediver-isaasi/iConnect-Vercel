# Pending proposal ticket values

Package-priced bundles with absent or all-zero component price weights can be
accepted without inventing a ticket revenue split. Ticket allocations retain a
pending snapshot and delegate claims retain immutable place ordinals with NULL
amounts. Known component weights continue to use the existing exact-penny split.

In Sales → opportunity → Allocations, dashboard administrators can assign the
**total net value of an allocation**, with a required reason. VAT is derived
proportionally from the accepted line, rounding down to whole minor units.
The remaining value/tax belongs to the other bundle benefits. All ticket
allocations together cannot exceed the accepted line net price.

This is a one-time, append-only reporting assignment. It does not modify the
signed proposal, create an invoice, collect payment, or alter checkout balances.
Network retries reuse the same idempotency key. The database serializes
assignments on the shared quote line so competing allocations cannot overspend
the line budget. Existing and future claimed delegates resolve from the same
audited assignment and immutable place ordinals.

Historical allocations without a value snapshot remain historical/unknown;
this change does not infer their value from current catalogue pricing.

## Rollout

Required migration: `20261206_sales_pending_ticket_values.sql`.
Not applied to live DEST during implementation; owner approval required.
SOURCE is unchanged. Deploy the updated API/reporting UI before enabling the
database change so NULL pending values are displayed correctly.

The affected sent proposal does not need its signed snapshot edited: after the
migration, another successful acceptance attempt creates pending allocations.
No real proposal was accepted or email sent by implementation tests.

## Verification

Isolated PostgreSQL tests extend `api/_lib/salesTicketValue.test.mjs`, covering
pending acceptance/claims, known-price compatibility, budget enforcement,
idempotency, tenant boundaries and grants. API/reporting tests are in
`api/_lib/salesPendingTicketValue.test.mjs`. Frontend tests cover the assignment
dialog, exact amount entry, retry payload retention, member-manager exclusion,
and pending/resolved report display.
