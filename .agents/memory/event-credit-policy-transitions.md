---
name: Event credit policy transitions
description: Payment policy changes must preserve the original paid checkout allocation for safe recovery.
---

After card authentication, preserve the original credit allocation and let the server reject and compensate a now-disallowed payment; do not clear the saved allocation or stop recovery in the browser.

**Why:** A policy can change while card authentication is in progress. Client-side rejection alone strands an already-paid charge, while stripping credits loses the evidence needed to verify a refund safely.

**How to apply:** Bind original credits and purchaser/event/tenant identity at intent creation. Test actual intent metadata against compensation verification, and test the exact card remainder rather than only method visibility.