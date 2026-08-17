---
name: Stripe monthly card membership plans
description: Design rules for monthly card (Stripe subscription) membership plans that twin the GoCardless DD plan model.
---

Monthly card membership plans are a provider twin of GoCardless DD plans. Durable rules:

- **Shared monthly config, independent gates.** Card monthly reuses the DD monthly terms (amount, instalments, activation, grace, terms version) behind its own enable flag. Every save path (client serialization AND server column whitelist) must keep the shared fields alive when EITHER provider's monthly option is enabled — gating them on the DD flag alone silently nulls the card offer.
- **Snapshot is the contract.** Terms are snapshotted once at consent on the agreement; webhooks and crons read the snapshot, never live tier config.
- **Counter commit ≠ settlement.** Instalment dedupe commits before settlement, so "duplicate invoice" handling must check for a fully-counted-but-unsettled plan and RESUME settlement (webhook retry AND reconcile cron), or a fully charged plan stays unpaid locally with the subscription still active.
- **Terminal state comes LAST.** A plan is only marked expired/completed after the history paid-flip, the workflow (durable pending marker written before the flip, cleared after), and a CONFIRMED subscription conclusion; unconfirmed cancels leave the plan resumable. Subscriptions also carry a Stripe-side cancel_at boundary so a persistent cancel failure can't bill past the agreed instalments.
- **Replay through one processor.** The reconcile cron repairs missed webhooks by feeding synthetic events through the same shared processor, so dedupe/guarded-settle/workflow-once logic stays single-sourced.
- **Both-ways year guards.** An open agreement for a membership year with either provider blocks starting the other; admin migration/invite paths must honour the card plan's payment method too.
- **Mode-flip tolerance.** Webhook picks the key by event livemode; cron lookups try both mode keys on resource_missing.

**Why:** two providers settling the SAME membership-year row is the core corruption risk; these rules keep settlement exactly-once and recoverable.
**How to apply:** copy this pattern for any new recurring membership payment provider instead of forking settlement logic.
