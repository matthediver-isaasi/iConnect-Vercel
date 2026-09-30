---
name: Provider replay outcome semantics
description: Webhook acknowledgement is not a successful administrative recovery outcome.
---

A provider event marked `handled` is acknowledged, not necessarily recovered. Administrative replay must separately reject conflict, blocked, and retryable outcomes, including failures from subsequent payment-processing steps.

**Why:** webhook processors legitimately acknowledge terminal conflicts or compensated checkouts to stop provider retries. Treating that acknowledgement as recovery success gives administrators a false success message even though membership activation did not complete.

**How to apply:** when reusing webhook processors from a browser return, admin recovery, or reconciliation flow, preserve their domain outcome rather than converting `handled` directly to success. Distinguish waiting, already complete, blocked, and retryable states in both server responses and the UI.

Durable failure states and recovery scan predicates must change together. A released lease represented by a new `retryable` object is no longer eligible for a scan that only selects absent lease keys.

**Why:** adding a useful saved failure reason can otherwise disable the background path that is supposed to recover it when the applicant closes the page.

**How to apply:** test selection and reclaimability for every new lease state, while keeping blocked/conflict states distinct from transient failures.

Identity and accounting-context failures before a provider-operation claim need their own durable blocked outcome; an attempt limit applied after the claim cannot bound them.

**Why:** A membership history and its result agreed on a member, but the submission lacked the authoritative member link. Settlement correctly rejected it before incrementing its attempt counter, leaving the same error eligible forever.

**How to apply:** Reload and tenant-validate persisted submission links before creating or resuming memberships. Do not repair missing links from caller IDs. Save integrity failures once, exclude blocked rows before sweep limits, and keep the paid receipt distinct from membership or settlement completion.