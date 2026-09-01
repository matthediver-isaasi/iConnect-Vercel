---
name: Stripe membership invoice addresses
description: Authority and recovery rules for addresses on Stripe-funded membership invoices
---

Stripe membership payments started from forms must use a normalized, payment-time Stripe billing-address snapshot for every accounting invoice. Never fall back to member, organisation, preference, or form values when that Stripe snapshot is missing or unreadable.

**Why:** Mutable application records can drift after payment, while the payer's verified Stripe address is the authoritative invoice address. Silent fallback creates incorrect accounting documents.

**How to apply:** Annual PaymentIntents snapshot into Stripe payment metadata and form payment metadata where available; monthly Checkout snapshots live with the billing agreement. Initial invoicing, webhooks, reconciliation, renewal cron, instalment posting, and admin retries must recover the same snapshot and fail retryably if it cannot be established. Non-Stripe methods keep their existing resolver.