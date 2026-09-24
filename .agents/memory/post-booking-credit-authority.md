---
name: Post-booking credit evidence
description: Distinguishing reversal evidence from checkout reductions and overlapping instruments
---
Post-booking Credits must use actual provider evidence, never cancellation status, ticket totals, or checkout voucher/fund amounts. A refund and its accounting credit note can describe the same reversal; matching totals alone do not establish that relationship.

**Why:** Cancellation responses historically returned transient requested amounts while stored credit-note identifiers lacked dependable totals. Summing instruments or treating missing evidence as zero would misstate credits.

**How to apply:** Require durable operation linkage before merging legs; leave unresolved attribution/overlap unavailable. Historical reconciliation must only read financial providers and must never replay cancellation to repair reporting evidence.

Request safety budgets for browser-driven historical reconciliation must pause resumably, not permanently exhaust the saved session.

**Why:** A report can span all events and booking dates, and provider pagination adds requests beyond its booking count. A lifetime request cap can make an otherwise valid report impossible to finish, even through retries.

**How to apply:** Preserve the completed-work cursor across budget windows and retain cycle detection across resumes. Prove continuation beyond a full budget without replaying completed work.