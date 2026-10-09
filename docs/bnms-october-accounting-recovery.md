# BNMS October accounting recovery

Scope: confirmed October 2026 GoCardless collections against the approved Alpha
and Manual membership agreements. Historical invoice backfill is excluded.
No GoCardless API is called by this recovery path.

The imported-agreement metadata still controls the approved Xero company,
contact, bank and revenue account. Preparation validates those original details.
The queue claims the existing imported invoice ledger before any invoice POST,
with its queue identity included in the claim. Legacy claims remain held.
Queue-owned retries preserve the queue envelope/idempotency key. Uncertain POSTs
use discovery/readback, never a fresh creation attempt.

The sole legacy uncertain-error exception is the exact pre-invoice bank-validation
429, and only when there is no original invoice-operation claim. These writers
commit that claim before attempting the invoice POST. Other uncertain errors,
existing legacy claims, other months, tenants, payment-only operations and
unconfirmed payments are excluded.

## Release procedure

1. Deploy the recovery code to production; verify the live deployment contains it.
2. Run `node scripts/requeue-bnms-october-accounting.mjs` for a read-only preflight.
3. After verifying production, run
   `node scripts/requeue-bnms-october-accounting.mjs --apply --deployed-recovery-confirmed`.
   This releases only pristine held queue requests, not provider payments.
4. Let the existing accounting sweep process them. Check queue stages, provider
   invoice/payment IDs, original ledger linkage and source-payment linkage.
   A pending/retry count is not proof of completed invoicing.

No schema migration or new environment variable is required. Do not reset an
unknown/writing stage or clear original snapshots to force processing.
Do not invoke the legacy combined invoice helper or replay GoCardless webhooks.
