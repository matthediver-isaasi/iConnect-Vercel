---
name: GoCardless account discovery isolation
description: Safety boundary for tenant-triggered scans of existing provider resources.
---

Account-wide GoCardless discovery must require an enabled credential set explicitly owned by the requesting tenant. It must never fall back to platform credentials or inherit a live-billing creditor pin, and discovered resources remain in private staging until a separate reviewed promotion flow. Cursor metadata must be validated through explicit exhaustion; ambiguous pagination is an incomplete run, never a successful small result.

**Why:** A normal billing operation can safely use a configured fallback account or creditor filter, but an account-wide scan with either can expose another account's mandates or silently return only one creditor's subset. Writing discoveries into live mirrors would also make tentative email matches operational.

**How to apply:** For any discovery or migration scan, fail closed unless credential source and tenant ID both match the authenticated tenant. Opt out of billing-only resource filters, reject missing/malformed/repeated cursors or data, expose only fixed page-level diagnostics, store results in tenant-bound staging with recoverable leases, and keep promotion into billing agreements, plans, subscriptions, and mirrors as a separate action.