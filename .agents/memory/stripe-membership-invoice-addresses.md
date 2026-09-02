---
name: Stripe membership invoice addresses
description: Authority and recovery rules for addresses on Stripe-funded membership invoices
---

Stripe membership payments started from forms must use a normalized, payment-time Stripe billing-address snapshot for every accounting invoice. Never fall back to member, organisation, preference, or form values when that Stripe snapshot is missing or unreadable.

**Why:** Mutable application records can drift after payment, while the payer's verified Stripe address is the authoritative invoice address. Silent fallback creates incorrect accounting documents.

**How to apply:** Annual PaymentIntents snapshot into Stripe payment metadata and form payment metadata where available; monthly Checkout snapshots live with the billing agreement. Initial invoicing, webhooks, reconciliation, renewal cron, instalment posting, and admin retries must recover the same snapshot and fail retryably if it cannot be established. Non-Stripe methods keep their existing resolver.

Form membership payments may not have a valid payer email before payment. A required Stripe Customer must still be created without email using a deterministic idempotency key; never pass the unvalidated source email as `receipt_email`.

**Why:** Stripe Customers can collect the authoritative billing address without an email, while rejecting the payment before Elements opens would make otherwise valid public membership forms unpayable.

**How to apply:** Normalize email once for required Customer preparation and reuse only that normalized value for Stripe receipt fields. Pending pre-change PaymentIntents without a Customer must be cancelled and replaced before reuse.