# BNMS October collection accounting recovery

## Read-only evidence, 3 November 2026

Queries used the destination pinned by `scripts/annual-meeting-destination.mjs`
(`lvmzliemqnieeoruhkik`), verified TLS, and `BEGIN READ ONLY` / `ROLLBACK`.
Supabase MCP denied access; the existing destination SQL connection succeeded.
No customer records, provider records, configuration, or queue state were changed.

The reported member is `211cfaca-3413-4d97-b492-745d55dacc47`, in BNMS
(`ff2df806-b321-4254-b651-3af11fccf1db`). Persisted evidence contradicts the
initial GoCardless hypothesis:

- Agreement `e05e3b16-8cc3-4f11-a7ad-92eb17725b30`: **Stripe**, live, active.
- Plan `23c66a60-5b3b-4edd-b823-c4ffa081b487`: Stripe, active;
  last payment paid at **2026-10-28 10:25:50.014 UTC**.
- Instalment ledger `af499c18-a34c-4d3e-9bb3-f7ec6271bf71`: £10.66 GBP,
  external invoice `in_1UVU190UfSpC8b2bI0YEvVBx`;
  created **2026-10-28 10:25:48.426 UTC**.
- Membership year `rolling:2026-10-28`, term 28 October 2026–27 October 2027,
  active, payment status partial (monthly plan, not evidence of a failed charge).
- No GoCardless payments linked to this member's plans.

## Timeline and cause

| UTC | Persisted evidence |
| --- | --- |
| 28 October 2026, 10:25 | Instalment ledger created; plan records paid collection. Original webhook/accounting-attempt log was not retrieved. |
| 28 October 2026, 12:25:18.386 | First retained member-specific sweep failure: `Xero contact name collision without a unique matching email; identity review required`. |
| Through 3 November 2026, 06:25:21.237 | **24** member-specific sweep attempts report that same identity conflict, at six-hour intervals. |
| 3 November 2026, 12:25:15.535 | Instalment updated with `[Xero contact-search] HTTP 429 (non-JSON response): `. |
| 3 November 2026, 12:25:17.449 | Latest retained sweep records the same 429 for this instalment. |

The sweep did not stop running or lose eligibility. It repeatedly reached
contact resolution and could not safely select a unique Xero customer. The
latest throttle replaced that older, more useful blocker in the row's error
field. The 429 is **not evidence that the original 28 October attempt was
throttled**. Nor is it evidence of a failed money collection.

Current local accounting state is failed, with null provider, invoice ID,
invoice number and synced timestamp. No central accounting queue row matched
the ledger ID or the Stripe invoice in its snapshot. This is consistent with
the Stripe legacy instalment writer, not the GoCardless queue handoff.

### Evidence limits

No direct Stripe or Xero read was performed, so external invoice/payment absence
is **not proven** by missing local links. No Xero contact names/emails were
exported. The conflicting contact must be reviewed with authorized provider
access; do not adopt a contact by name alone or change its email automatically.
Historical response headers (including Retry-After), original webhook outcome,
deployed code revision, and deployed queue flags were not retrieved.
Stored scheduled-task logs prove execution and outcomes, not exact deployed
source parity. A retained error can be newer than the collection date.

## Recovery paths and corrections

The Stripe cron's current schedule is `25 */6 * * *`, matching observed runs.
It selects failed/pending/invoice_unpaid Stripe instalments and posting claims
older than 15 minutes, ordered by updated_at, at most 100 per batch. It re-reads
the Stripe invoice as paid before accounting. It has no central queue attempt
limit or company-level cooldown. The GoCardless cron and imported-agreement
eligibility are not authorities for this Stripe payment.

Two confirmed source defects were corrected:

1. Returned failed/invoice_unpaid accounting outcomes counted as skipped,
   potentially producing a success audit/heartbeat if no unrelated error
   occurred. They now count as errors; deferred outcomes carry status/reason.
   In the observed runs an unrelated error already caused partial status, so
   this fix is not claimed as the cause of this member's failure.
2. `reclaimStale` admitted all posting rows into the claim CAS, relying on an
   earlier scan. A concurrent worker could renew the claim between scan and
   claim. Recovery now verifies actual staleness and fences the observed
   timestamp; ordinary claims never admit posting. No provider calls occur
   for a fresh or concurrently renewed claim.

Current `safeXeroJson` already preserves status/statusCode/Retry-After for
non-JSON errors; a targeted contact-search regression now verifies it. Central
queue tests verify delayed 429 preparation recovery, cooldown enforcement,
existing invoice/payment discovery after lost responses, and source
finalization. Those queue protections must not be represented as deployed
Stripe legacy behavior.

No financial writer was added or enabled, no identity guard was relaxed, and
no membership/collection state was changed. The member table's failed
accounting label is accurate for the persisted failed operation; it is not
changed to “retrying” without durable scheduled-retry evidence. Its collection
status remains independent. A dedicated durable Stripe retry/cooldown status
would require separate work rather than misleading relabelling.

## Verification and approval-gated next steps

251 focused tests pass across membership instalment invoicing, Stripe sweep,
Xero contact identity, GoCardless queue, queue engine, provider adapters and
GoCardless preparation. Tests cover exact stale-claim fencing, ordinary
concurrent delivery, posted replay, linked unpaid invoices, non-JSON 429,
cooldown, uncertain-write discovery and accounting source finalization.
Tests use isolated fixtures, not live financial retries.

The application restarted and served on port 5000. Browser verification stopped
at the existing workspace “Tenant not found” failure: its legacy SOURCE database
has no tenant table. The signed-in membership UI was not verified; no UI changes
were made and the runtime database target was not changed.

Before any recovery authorization:

1. Review the original member billing identity against Xero's matching
   contacts, identifying a unique correct contact without overwriting others.
2. Read Xero for an existing invoice/payment under the original Stripe
   reference and idempotency identity. Missing local linkage is insufficient.
3. Obtain separate approval for any contact correction, accounting-only replay,
   or configuration change. Preserve the original £10.66 collection and
   membership term. Do not collect again or invoke the GoCardless sweep.
4. After the approved action, verify the external invoice/payment and local
   posted link agree, and verify a repeated accounting run creates nothing.

No migration or live configuration change is required by these narrow fixes.
Source changes still require merge/release; they do not prove live rollout.
