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

Membership invoice notifications require duplicate prevention even across uncertain email outcomes; do not apply the older at-least-once cron-email lease pattern to them.

**Why:** A send lease expiring is not evidence of provider rejection. Retrying it can duplicate an invoice notification after a crash between acceptance and persistence.

**How to apply:** Preserve per-recipient acceptance evidence, retry only definite rejections, and route uncertain sends to review. Never infer unsent from a missing final CRM note.

Load completed notification receipts before spending a worker's provider-request budget.

**Why:** Rechecking every already-delivered recipient against a fixed per-run budget can make a long recipient list retry the same prefix forever.

**How to apply:** Skip durable completed recipients without transport-budget consumption; test progress with a recipient list larger than one invocation can process.

A direct documented invoice/payment POST throttle rejection can be retried with the identical frozen request and original provider key; a throttle response during readback after successful creation cannot.

**Why:** Xero applies limits before idempotency processing, and Intuit instructs retrying rejected 429 requests with the same request ID. Treating every 429 as an uncertain creation strands genuinely rejected invoices, while treating post-success readback throttles as rejection can duplicate them.

**How to apply:** Preserve the provider-write/readback boundary and original keys. Timeouts, server failures and QuickBooks duplicate-request faults remain discovery-only. Provider key retention limits never authorize retrying an older uncertain write.

GoCardless recovery must freeze the dedicated bank setting before accepting the accounting request; provider preparation may resolve that saved value to a provider account ID, never reload today's setting.

**Why:** A rate-limit delay can span a bank-setting change. Replaying against the changed account misstates where an already collected payment was received, even when its amount and invoice are correct.

**How to apply:** Preserve original collection amount, currency, date, reference and bank setting alongside invoice authority. Xero's configured bank code needs bound account lookup; it is not an AccountID. Keep arrears allocation and migration-managed accounting ownership intact rather than treating their aggregate collections as ordinary instalments.

Compare persisted accounting authority structurally, not by JSON object-key order.

**Why:** Live BNMS queued release evidence was semantically identical to reconstructed release evidence but JSONB reordered its keys. Stringified equality incorrectly placed the requests into permanent review before any provider call.

**How to apply:** Preserve array order and exact scalar values while ignoring object-key order. Test a JSONB-style reordered snapshot, retain genuine financial/release change rejection, and separately recover already-stranded review rows after verifying they never reached a financial write.

The accounting sweep is for invoices that should have been created by application transactions, not retrospective invoice creation for imported historical records. The user's stated priority is October GoCardless webhook-triggered invoicing.

**Why:** The user said historical imported invoices will be obtained through another route and must not be included merely because imported records exist.

**How to apply:** Establish the payment transaction's provenance and invoice ownership separately from the membership agreement's import provenance. Resolve any overlap with the other invoicing route before releasing recovery; never send additional GoCardless collection instructions.

The user confirmed that the October 2026 collections against imported BNMS agreements belong in the sweep; the alternative invoice route is not for those collections.

**Why:** Agreement import provenance was being confused with historical invoice backfill.

**How to apply:** Keep original imported accounting ownership and approval guards while recovering the new transactions. A persisted snapshot retains evidence, not the runtime authority of a branded approval context: re-resolve and compare live approval before passing that exact context to provider preparation.

For an approved imported-agreement continuation, the release's pinned bank/contact/revenue authority takes precedence over the ordinary tenant bank-code setting.

**Why:** The original imported invoice writer used that approved mapping; switching to the generic setting during recovery would change the accounting destination.

**How to apply:** Revalidate the pinned provider accounts and live release. Retain the original non-expiring invoice ledger, record the actual queue provider keys in its ownership identity, and never treat a pre-existing legacy claim as permission for a fresh POST.