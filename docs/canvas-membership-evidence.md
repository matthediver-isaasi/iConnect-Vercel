# Canvas membership-card evidence

The Canvas membership summary is a read-only, self-only projection. It must not
write billing state, call a payment provider, run a pricing simulation, or use a
current tier configuration to reinterpret a retained commitment.

## Evidence precedence

1. Membership state, type and renewal date come from the selected retained
   personal or organisation commitment. Current personal membership wins over
   current organisation membership; future and past records are fallbacks.
2. `memberSince` is an **original membership commencement**, not a term start.
   The investigation checked the repository's `member` schema migrations and
   reads, membership history term/anchor/start fields, rolling commitment and
   quote writers, agreement metadata, and dynamic member preference definitions
   (including tenant-defined fields that may be labelled `join_date`). No
   current production writer persists a tenant-independent original membership
   commencement with provenance. The member table has no such field, quote
   `membership_start_date` is a term commencement, and a tenant preference's
   label does not establish consistent meaning or verification. `memberSince`
   therefore remains `null`. An oldest known
   renewal, a first term retained by this system, a rolling term start, a
   migration cutover, a payment date and a member-row creation date do not prove
   when membership originally began. Supporting this field for genuinely new
   members requires a separately reviewed writer to persist explicit
   new-membership provenance at the consent boundary; the read path does not
   invent a private snapshot convention.
3. A payment plan is used only when its tenant, owner, billing agreement and
   term identity match the selected personal commitment.
4. A future effective collection date retained only on the matched plan is
   `planned`. A future-dated local managed provider-payment row in
   `pending_submission`, `submitted`, `confirmed`, or `paid_out` is stronger
   evidence that the collection has actually been created: it is a `confirmed`
   scheduled collection, not a past confirmed payment. A migration cutover date
   or plan `next_charge_date` alone remains planned and is never upgraded.
5. Planned and retained fixed amounts use the saved-plan and complete arrears
   arithmetic from `shapePlan`. All unresolved arrears are paged. Zero remains
   a known zero; a missing base or any missing arrears amount makes catch-up
   amount unknown rather than silently contributing zero.
6. A past confirmed managed GoCardless collection is shown only from the
   tenant/plan-scoped local payment ledger. No provider lookup is made.
7. BNMS pilot history is used only when an immutable pilot-adoption row exactly
   links the selected history row, agreement, plan, tenant and member. Its
   earliest period is `paymentHistoryFrom`; its latest paid-out row may be shown
   as a historical confirmed payment. It never becomes `memberSince` and never
   becomes a planned next payment.

`nextCollection` is `{ date, amount, currency, status }` for the effective
future collection. Its status is `confirmed` for a persisted managed
provider-payment row and `planned` for plan-only scheduling. `plannedPayment`
continues to contain plan-only scheduling; `confirmedPayment` is a separate
past-payment object. `nextPayment` mirrors only `nextCollection.date`.
Top-level `payment.amount` is the authoritative next amount, or a retained fixed
plan amount when scheduling is currently unscheduled; it never falls back to a
historical or past confirmed payment. `collectionStatus` is one of `confirmed`,
`planned`, `unscheduled`, or `unavailable`.

## Pilot verification boundary

The repository contains immutable, reviewed pilot provenance for nine
historical 2026 payments and an exact adoption link. This implementation does
not assert that those migrations or records are present in any particular live
deployment: no authorized live read was performed for this task. Missing pilot
relations therefore produce no pilot context, while other database errors fail
the private summary closed.