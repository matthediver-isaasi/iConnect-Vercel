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
Applied to live DEST (`lvmzliemqnieeoruhkik`) with owner approval after verifying
the live allocation API and the allocation/reporting JavaScript bundles.
SOURCE is unchanged. No further migration is pending for this feature.

Applied SQL SHA-256:
`9b72878f5d228ee011ef65e90dba435526764bbaef058f5e4f4d2f4d4c41d0e8`.
Before commit, verified RLS, the append-only trigger, the pinned SECURITY DEFINER
search path, no anonymous/authenticated access, and service-role read/RPC access
without direct insert/update/delete privileges. Allocation and ticket-value
table fingerprints were unchanged (both contained zero records). The affected
proposal remained sent; no acceptance, email, invoice or payment was triggered.

The affected sent proposal does not need its signed snapshot edited: after the
migration, another successful acceptance attempt creates pending allocations.
No real proposal was accepted or email sent by implementation tests.

### Stage-history compatibility repair

After rollout, the live stage-history table was found to lack the nullable
`note` column already expected by the commercial acceptance functions.
With owner approval, `20261207_opportunity_stage_history_note_repair.sql`
was applied to DEST only. SQL SHA-256:
`ff3893b76dd133bf0203cf9cb4c1e388fd1363975405baa315d4f59c18b96438`.

Verification before commit confirmed an idempotent replay, unchanged contents
of all 12 existing history records (excluding the newly added null column),
unchanged RLS/policies/grants/triggers, and successful EXPLAIN planning of the
history insert, opportunity update and activity insert. EXPLAIN did not execute
acceptance or its triggers. The proposal remained sent, with no customer
decision or commercial sale. End-to-end customer signing was not performed.

## Verification

Isolated PostgreSQL tests extend `api/_lib/salesTicketValue.test.mjs`, covering
pending acceptance/claims, known-price compatibility, budget enforcement,
idempotency, tenant boundaries and grants. API/reporting tests are in
`api/_lib/salesPendingTicketValue.test.mjs`. Frontend tests cover the assignment
dialog, exact amount entry, retry payload retention, member-manager exclusion,
and pending/resolved report display.
