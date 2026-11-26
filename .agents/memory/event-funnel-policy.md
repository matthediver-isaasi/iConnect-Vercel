---
name: Event funnel purchase policy
description: Approved same-checkout orchestration boundaries and production exclusions.
---

Event funnels orchestrate draft selections and one checkout; registrations remain
owned by their individual events. A previously purchased source outside this
journey does not satisfy a funnel-only prerequisite.

Authoring must offer only future events, not completed events; internal record
identifiers are not user-facing labels.

**Why:** The owner explicitly excludes completed events from funnel building and
wants meaningful event names and natural-language labels rather than IDs.

**How to apply:** Preserve saved reference identities internally, but do not
silently remove them when an event becomes unavailable. Explain the selection
problem and require replacement before a new save or preview.

**Why:** The owner explicitly requires same-checkout prerequisites first and
excludes retrospective eligibility, new tax/credit policies, and historical
capacity reinterpretation.

**How to apply:** Preserve standalone flows. Do not implement aggregate checkout
by sequentially calling per-event booking endpoints, or reuse the independent
form Cart stock model. Source stock must survive failed optional additions, and
one fixed reservation expiry must not extend during ordinary edits. Production
migrations and live provider operations require separate explicit approval.

The owner has now authorised installing the migrations for the complete funnel
rollout. Retain the saved migration instructions and backout plan; approval does
not establish technical readiness or authorise bypassing purchasing safeguards.

**Why:** On 2026-11-23 the owner explicitly requested installation for the
complete feature rollout, superseding the earlier instruction to leave migrations
unapplied.

**How to apply:** Do not ask again for the same migration permission. The owner
subsequently explicitly waived a database restore rehearsal and reconfirmed
two-minute PITR. Do not require that rehearsal again or describe it as completed.
Retain migration compatibility checks, transactional rollback where possible,
and explicit treatment of bookings/payments made after deployment. Keep
automatic migrations disabled.

The owner reports Supabase point-in-time recovery with changes logged every two
minutes and up to seven days of retention.

**Why:** This is the owner's reported live recovery coverage, not an independently
verified restore point or a successful restoration rehearsal.

**How to apply:** Recheck the actual recoverable timestamps immediately before
rollout. Never equate the advertised window with zero data loss or a tested
backout, and never restore live merely to rehearse recovery.

Keep aggregate payment identity in the order/allocation authority, not in an
individual booking's event-exclusive payment field, until every affected
cancellation and invoice consumer understands shared charges.

**Why:** Legacy cancellation and settlement paths can interpret an individual
booking's payment intent as authority over the entire charge. Sharing that field
without allocation-aware consumers risks refunding or settling unrelated events.

**How to apply:** Link bookings to immutable event-specific allocations. Adapt
refund, credit-note, report and invoice readers before activation; do not make
legacy readers appear compatible by copying the aggregate intent onto each row.

Unlisting affects event discovery, not event status or ordinary direct-link
eligibility. Funnel-only eligibility is a separate same-checkout prerequisite.

**Why:** The approved scope explicitly separates calendar visibility from
purchase permission; hiding an offer must not make it draft or disable booking.

**How to apply:** Preserve direct ID/slug lookup and administrative management.
Enforce prerequisites at purchase boundaries independently of discovery filters.

Persisted, owned standalone purchase instructions retain their original
prerequisite authority across later funnel publication; a changed purchase
request does not inherit that authority.

**Why:** Rechecking newly published restrictions only after payment can strand
an already-paid or uncertain checkout. The existing request may also be retried
through an insert-on-conflict preparation path, not just a read.

**How to apply:** Serialize new authorizations with publication before payment.
Allow immutable replay without creating another purchase; do not grandfather
arbitrary client order IDs, historical source purchases, or new ticket choices.

Pause admission of new funnel purchases independently of recovering existing
orders. A worker heartbeat is deployment/reachability evidence, not proof of a
successful provider payment, invoice, email or registration.

**Why:** External operations already admitted can finish after new purchasing
is paused. Stopping their reconciliation or treating a heartbeat as delivery
evidence can strand paid purchases or duplicate provider operations.

**How to apply:** Keep a separate recovery authority and retain its immutable
receipts during rollout/backout. Require actual provider outcome evidence for
delivery and reconciliation; never infer it from scheduler health.

Shared invoices require original-purchaser or tenant-administrator authority;
ordinary attendee or same-organisation invoice access must not automatically
extend to the combined document.

**Why:** A combined invoice can reveal other events and attendees outside the
individual registration that established legacy invoice access.

**How to apply:** Apply this boundary to downloads, email attachments and activity
views. Preserve original company/connection identity when reading provider PDFs;
never resolve a shared invoice ID against a newly selected company.

Funnel confirmations must not inherit at-least-once resend behavior from generic
notification leases. An uncertain send requires reconciliation, not automatic
resubmission after its lease expires. Operational provisioning precedes the
confirmation; accounting delivery does not.

**Why:** This feature explicitly requires deduplicated confirmations, and a
successful external send can outlive a failed local checkpoint. Sending before
personal attendance links exist can also give the purchaser incorrect links.

**How to apply:** Track each original registration/template separately, retain
uncertain-send evidence, and permit automatic retry only when non-submission is
known. Do not make accounting outages block an otherwise ready confirmation.

Provider preparation must gate scheduling reminders, not just immediate
confirmations.

**Why:** Once scheduled, reminders have an independent delivery worker. Queuing
them while personal joining access is unresolved can lose the reminder through
that worker's failure handling, even though integration recovery later succeeds.

**How to apply:** Make notification scheduling and its completion checkpoint one
transaction, conditional on the registration's provider preparation. Unrelated
successful preparation should remain reusable on retries.

Shared provider-registration receipts are deduplication evidence, not permanent
proof of current attendee access.

**Why:** An administrator can revoke provider access after an earlier purchase;
a new journey must not adopt the old successful receipt without a fresh check.
Conversely, an empty provider listing after an uncertain write is not proof
that it is safe to repeat the write.

**How to apply:** Verify access separately for each new preparation, retain
uncertain write intent across lease expiry, and adopt observed successes without
submitting a second registration.

Cancellation recovery needs evidence of the stock movement actually committed,
not just the event's latest capacity settings.

**Why:** Capacity configuration can change after purchase, and counted capacity
can supersede a legacy counter. Guessing the original debit risks inventing
stock or treating a cleared counter as an original maximum.

**How to apply:** Preserve actual debit evidence alongside booking commitments.
Reconcile it with the current capacity authority when cancelling; never recreate
a cleared legacy counter or infer missing historical movements.

Freeze each registration's original voucher contributions before payment;
cancellation must not choose replacement funding from a current wallet.

**Why:** Equal monetary totals can have different expiry dates, owners or
accounting backing. Selecting credits again during a refund changes the original
purchase's financial authority.

**How to apply:** Preserve original allocation identities and remaining shares
through partial refunds. Use the existing backed-credit return rules and explicit
expired-voucher replacement approval; missing historical attribution needs
reconciliation, not an invented split.

New invoice evidence requirements must not retroactively change already prepared
invoice instructions.

**Why:** Older preparations may lack per-registration attribution; imposing a new
capture requirement can strand their existing delivery path during a staged
upgrade. Reconstructing attribution from current data would invent authority.

**How to apply:** Keep old prepared invoices deliverable under their original
contract, require reconciliation for unsupported reversals, and activate richer
evidence capture only for preparations that explicitly carry it.

Cancellation limit preparation must not depend on a deliverable accounting
payload. Original purchase and funding authority remain mandatory.

**Why:** A missing or delayed invoice customer/provider payload can require
accounting reconciliation without invalidating the already-confirmed purchase
or its original card/funding refund limits.

**How to apply:** Derive limits from the private purchased allocations and prior
refund reservations. Validate the original invoice/tax/customer evidence in the
credit leg; do not invent that evidence or let its absence block independent
refund preparation.

Approval protection must cover legacy and generic request writers, not only
the new approval endpoint.

**Why:** A legacy reviewer can start an unconditional status update before
approval commits, wait behind its row lock, then overwrite the accepted decision
after stock has been released. Locking only the new path does not prevent this.

**How to apply:** Preserve the database-level accepted-request binding and test
a late legacy update against it. Its guard must see newly committed authority
after waiting; do not change it to a stale statement-snapshot reader.

Cancelling local integration work is not proof that external access was revoked.

**Why:** A provider write admitted before cancellation may finish afterwards.
Discarding its late receipt would hide access that still needs removal, while
revoking a shared registration could remove another booking's entitlement.

**How to apply:** Complete cleanup only with recorded provider absence or scoped
revocation evidence that preserves other entitlements. Keep uncertain sends and
provider writes visible; suppressing future work does not resolve past attempts.

Cross-checkout provider retention requires the shared provider-row admission
lock, matching grant generations and actual resource-scoped entitlements.

**Why:** A checkout lock alone cannot protect another checkout's grant. Matching
only the email can also block unrelated bookings or mistake an unrelated event
for authority to keep access.

**How to apply:** Keep confirmed-grant admission serialized with revocation.
Funnel entitlements need verified current-generation links; ordinary entitlements
must match the resource through their event/session. Preserve pre-existing
external grants and require reconciliation for unknown provenance. The last
funnel-owned entitlement requires actual revocation evidence.

Explicit credit-note email instructions are independent of the switch that
suppresses cancellation notifications.

**Why:** The existing cancellation flow treats document delivery as a separate
reviewer instruction; conflating the two silently drops a requested financial
document or sends one without explicit recipient authority.

**How to apply:** Freeze the requested address at approval, use the original
accounting company for the document, and keep its delivery receipt separate from
cancellation notification receipts. An uncertain send never authorizes resend.

Same-event ticket re-offers (for example later days of a multi-day event) are
allowed only behind a condition that proves the ticket is not selected on every
route; the owner approved this for the BNMS Spring Meeting day-ticket flow.

**Why:** Holds are unique per session/event/ticket, so an unguarded re-offer
could double-reserve or fail at the database constraint.

**How to apply:** Keep the path-aware guard, the evaluator/pending dedupe, the
planner rejection and the checkout assertion together; never relax only one.
