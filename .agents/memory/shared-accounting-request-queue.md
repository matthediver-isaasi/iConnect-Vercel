---
name: Shared accounting request queue
description: Agreed direction for central invoice recovery across Xero and QuickBooks.
---

The user approved a central durable accounting-request queue for both Xero and QuickBooks invoices, rather than feature-by-feature sweeps reconstructing failed invoices.

**Why:** Same-day GoCardless collection notifications can produce accounting bursts. Saving original invoice details and iConnect source links gives recovery one authoritative source.

**How to apply:** Persist requests before provider calls; retain original financial details and intended provider/company binding. Track invoice creation, local linkage and payment posting independently, with provider-specific cooldown and ambiguous-outcome reconciliation. Include QuickBooks from the outset, not as a later Xero-only extension. This is an agreed design direction, not authorization by itself to implement or migrate.

Rollout controls may govern new queue adoption, but must never release an already accepted operation back to a legacy invoice writer.

**Why:** Turning a flag off after an uncertain provider outcome otherwise lets a manual retry create a second invoice outside the durable operation's ownership.

**How to apply:** Check existing ownership before reconstructing prices or selecting a writer, including when adoption is disabled. Tolerate an absent queue table only for unactivated installations; permission, timeout or column failures are not evidence of absent ownership.

Preparing an invoice and completing its business effects are separate integration obligations, not solved merely by adding a provider adapter.

**Why:** Contact/tax resolution may hit rate limits before a prepared payload is saved; later completion may need source-specific activation, notifications or benefit bookkeeping. Replaying the old combined helper can repeat these effects.

**How to apply:** Explicitly distinguish prepared-invoice coverage from durable preparation and business continuation. Do not claim collection recovery or universal coverage until those paths have one durable owner and verified continuations.

A direct documented invoice/payment POST throttle rejection can be retried with the identical frozen request and original provider key; a throttle response during readback after successful creation cannot.

**Why:** Xero applies limits before idempotency processing, and Intuit instructs retrying rejected 429 requests with the same request ID. Treating every 429 as an uncertain creation strands genuinely rejected invoices, while treating post-success readback throttles as rejection can duplicate them.

**How to apply:** Preserve the provider-write/readback boundary and original keys. Timeouts, server failures and QuickBooks duplicate-request faults remain discovery-only. Provider key retention limits never authorize retrying an older uncertain write.

GoCardless recovery must freeze the dedicated bank setting before accepting the accounting request; provider preparation may resolve that saved value to a provider account ID, never reload today's setting.

**Why:** A rate-limit delay can span a bank-setting change. Replaying against the changed account misstates where an already collected payment was received, even when its amount and invoice are correct.

**How to apply:** Preserve original collection amount, currency, date, reference and bank setting alongside invoice authority. Xero's configured bank code needs bound account lookup; it is not an AccountID. Keep arrears allocation and migration-managed accounting ownership intact rather than treating their aggregate collections as ordinary instalments.

Compare persisted accounting authority structurally, not by JSON object-key order.

**Why:** Live BNMS queued release evidence was semantically identical to reconstructed release evidence but JSONB reordered its keys. Stringified equality incorrectly placed the requests into permanent review before any provider call.

**How to apply:** Preserve array order and exact scalar values while ignoring object-key order. Test a JSONB-style reordered snapshot, retain genuine financial/release change rejection, and separately recover already-stranded review rows after verifying they never reached a financial write.