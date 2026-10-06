---
name: Post-booking credit evidence
description: Distinguishing reversal evidence from checkout reductions and overlapping instruments
---
Post-booking Credits must use actual provider evidence, never cancellation status, ticket totals, or checkout voucher/fund amounts. A refund and its accounting credit note can describe the same reversal; matching totals alone do not establish that relationship.

**Why:** Cancellation responses historically returned transient requested amounts while stored credit-note identifiers lacked dependable totals. Summing instruments or treating missing evidence as zero would misstate credits.

**How to apply:** Require durable operation linkage before merging legs; leave unresolved attribution/overlap unavailable. Historical reconciliation must only read financial providers and must never replay cancellation to repair reporting evidence.

Event Registration Report revenue means booked value less confirmed post-booking Credits, not cash received. Checkout vouchers, training funds and account allocations are settlement methods, not further revenue deductions.

**Why:** The user explicitly separated revenue from settlement and requested that missing reversal evidence prevent a definitive total.

**How to apply:** Preserve standard versus complex discount semantics, deduct the authoritative group projection once, and keep incompatible currencies or unresolved evidence unavailable. Do not extend this definition to other reports without approval.

Request safety budgets for browser-driven historical reconciliation must pause resumably, not permanently exhaust the saved session.

**Why:** A report can span all events and booking dates, and provider pagination adds requests beyond its booking count. A lifetime request cap can make an otherwise valid report impossible to finish, even through retries.

**How to apply:** Preserve the completed-work cursor across budget windows and retain cycle detection across resumes. Prove continuation beyond a full budget without replaying completed work.

Completed-empty credit verification is separate from reversal instruments and must describe its provider coverage. Invoice-linked note IDs alone do not establish accounting completeness.

**Why:** A live event had an allocated accounting credit note despite no booking credit-note link or local reversal evidence. Stripe's empty refund list established only the Stripe scope, not the accounting scope.

**How to apply:** Discover invoice/customer credit evidence through read-only provider queries, retain incomplete pagination and unallocated-note ambiguity, and only show checked-empty when all applicable scopes complete. Positive, pending, and ambiguous evidence must supersede an earlier empty check.

QuickBooks Payment links establish memo identity, not how much of the memo applies to the invoice.

**Why:** The accounting flow permits applying less than a memo's total when the invoice balance is smaller. Counting the whole memo can overstate credits and understate revenue.

**How to apply:** Keep discovered memo amounts unavailable unless invoice-specific allocation is established. A later whole-memo refresh must not clear that uncertainty.
