---
name: Cancelled Direct Debit restart supersession
description: Owner decision and DB design for restarting straight after a confirmed-cancelled individual GoCardless Direct Debit or Stripe monthly card plan.
---
A confirmed-cancelled individual GoCardless DD (agreement + plan payment_plan_cancelled, mandate mirror cancelled/failed/expired) qualifies for the payment-dated post-grace restart immediately: no failed payment, grace expiry, admin approval or payment-grace exit.

**Why:** owner decision (Nov 2026); members who cancel at their bank otherwise had no route back.

**How to apply:**
- Never reuse the payment-grace-exit receipt for this; use the separate insert-only supersession receipt, linked to the prior history at reservation so the pending successor passes the rolling overlap exclusion.
- At confirmed payment the prior becomes status 'expired' only; dates, payment status, debt, agreement and plan stay untouched as evidence.
- Arrears pipeline must skip flag/restrict/grace-exit once superseded; a reserved-only receipt blocks grace exit but keeps the review flag.
- Applying the restart migration to the live database is a financial schema change that needs explicit owner approval.
- Every overlap/conflict guard (history exclusion, commitment trigger, upfront-quote guard, renewal evidence, Canvas agreement check) must recognise the bound supersession, narrowly; never ignore cancelled obligations globally.
- Stripe monthly card plans follow the same policy. "Confirmed" means Stripe itself reported the subscription ended (webhook or reconciliation); an admin/local cancellation is not confirmation. Completed plans, duplicate-checkout conflicts and switch cancellations never qualify.
- Stripe ending a subscription does NOT cancel the card agreement, which can stay 'active'. So ordinary renewal may look eligible; a possibly-cancelled card plan must be checked for restart first, and card agreements are recognised only via bound evidence, never by status.
- Organisation plans remain out of scope.
- Card-plan restart schema is live (Nov 2026). Many Stripe-cancelled card histories lack term dates; evidence intentionally returns NULL for them (no Restart button). Do not "fix" by relaxing the date requirement without owner approval.
