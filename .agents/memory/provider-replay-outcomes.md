---
name: Provider replay outcome semantics
description: Webhook acknowledgement is not a successful administrative recovery outcome.
---

A provider event marked `handled` is acknowledged, not necessarily recovered. Administrative replay must separately reject conflict, blocked, and retryable outcomes, including failures from subsequent payment-processing steps.

**Why:** webhook processors legitimately acknowledge terminal conflicts or compensated checkouts to stop provider retries. Treating that acknowledgement as recovery success gives administrators a false success message even though membership activation did not complete.

**How to apply:** when reusing webhook processors from a browser return, admin recovery, or reconciliation flow, preserve their domain outcome rather than converting `handled` directly to success. Distinguish waiting, already complete, blocked, and retryable states in both server responses and the UI.