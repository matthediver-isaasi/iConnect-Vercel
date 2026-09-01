---
name: GoCardless account discovery isolation
description: Safety boundary for tenant-triggered scans of existing provider resources.
---

Account-wide GoCardless discovery must require an enabled credential set explicitly owned by the requesting tenant. It must never fall back to platform credentials, and discovered resources remain in private staging until a separate reviewed promotion flow.

**Why:** A normal billing operation can safely use a configured fallback account, but an account-wide scan with fallback credentials could expose another account's mandates. Writing discoveries into live mirrors would also make tentative email matches operational.

**How to apply:** For any discovery or migration scan, fail closed unless credential source and tenant ID both match the authenticated tenant. Store results in tenant-bound staging with recoverable leases, and keep promotion into billing agreements, plans, subscriptions, and mirrors as a separate action.