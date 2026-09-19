---
name: GoCardless account discovery isolation
description: Safety boundary for tenant-triggered scans of existing provider resources.
---

Account-wide GoCardless discovery must require an enabled credential set explicitly owned by the requesting tenant. It must never fall back to platform credentials or inherit a live-billing creditor pin, and discovered resources remain in private staging until a separate reviewed promotion flow. Cursor metadata must be validated through explicit exhaustion; ambiguous pagination is an incomplete run, never a successful small result.

**Why:** A normal billing operation can safely use a configured fallback account or creditor filter, but an account-wide scan with either can expose another account's mandates or silently return only one creditor's subset. Writing discoveries into live mirrors would also make tentative email matches operational.

**How to apply:** For any discovery or migration scan, fail closed unless credential source and tenant ID both match the authenticated tenant. Opt out of billing-only resource filters, reject missing/malformed/repeated cursors or data, expose only fixed page-level diagnostics, store results in tenant-bound staging with recoverable leases, and keep promotion into billing agreements, plans, subscriptions, and mirrors as a separate action.

Do not equate recurring GoCardless payments with provider subscriptions. Xero-driven collection can produce invoice-linked one-off payments without any subscription to adopt.

**Why:** BNMS confirmed Xero owns its recurring collection process; provider reads returned payment histories but no subscriptions. Creating subscriptions merely to fill that absence could introduce a second collector.

**How to apply:** Establish the scheduler and verify its handover before future collection setup. Match historical Xero payments to actual GoCardless payment IDs; an invoice marked PAID but cleared by credit notes is not cash-payment evidence. A repeating invoice's end date and next scheduled date alone do not prove its collection integration is disabled.

Xero list and single-invoice responses can differ in whether zero-credit fields are present.

**Why:** Contact invoice lists supplied `AmountCredited: 0` and an empty credit-note list, while fetching the same fully paid invoice individually omitted both. Treating omission as proof of credit or an unconditional zero is unsafe.

**How to apply:** Permit omitted credit fields only with independent explicit evidence that total equals actual amount paid, amount due is zero, payment IDs reconcile, and there are no credit notes. Explicit null or nonzero credit amounts still require review.

Existing Xero bank accounts can lack an account code while remaining valid payment destinations by AccountID. A BANK account does not require `EnablePaymentsToAccount=true`; that flag permits payments to eligible non-bank accounts.

**Why:** Historical GoCardless payments reconciled consistently to an active GBP BANK account with no Code and a false enable-payments flag. Neither field justified replacing the account or using the Stripe clearing account.

**How to apply:** Preserve the proven accounting destination through an explicitly validated account-ID path. Check connected organisation, account identity, status and currency; never put an AccountID into a setting interpreted as an account code.