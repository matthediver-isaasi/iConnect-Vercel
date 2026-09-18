---
name: GoCardless form origin and review states
description: Why pending form lookups must retain original provider context and distinguish lookup failure from payment failure.
---

Pending form payments must stay bound to the provider context used at creation. Never assign the current integration context retrospectively to an old request whose origin is unknown.

**Why:** Sandbox test requests were repeatedly queried against a subsequently live integration. A missing provider resource can indicate account/environment mismatch, not failed payment.

**How to apply:** Verify origin before provider reads in both reconciliation and browser confirmation. Credential-set fingerprints intentionally fail closed on token rotation; a new token is not proof that it owns old resources. Keep unknown/mismatched origins in review without changing payment status or silently selecting another account.

Failure backoff must not delay a legitimate browser return merely because an earlier successful lookup found payment still pending.

**Why:** Applying the scheduled polling interval to a fresh return from provider checkout can hide successful completion until the next polling window.

**How to apply:** Browser confirmation may refresh a successful waiting state, but must not bypass error backoff or blocked review. Store diagnostics atomically without replacing unrelated payment metadata, and filter deferred/blocked rows before pagination limits.