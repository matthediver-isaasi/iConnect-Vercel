# Proposal draft resaving

## Diagnosis and rollout

On 2026-10-27 a read-only inspection of verified DEST (`lvmzliemqnieeoruhkik`)
confirmed the reported proposal was a draft at row version 1, with two lines and
three persisted bundle components. The installed exhibition wrapper called the
underlying save implementation that deleted parent lines first. The component
guard correctly rejects missing parents, including during cascaded deletes.

Applied `supabase/migrations/202610270001_sales_draft_component_replacement.sql`
to DEST using `scripts/apply-sales-draft-component-replacement.mjs` with reviewed
SHA256 `585aa77c13c5bab6268c9f66ca7c1723fff6b12cf5e06da2f698820e62c87996`.
No migration remains outstanding for this fix. SOURCE was untouched.

Only the underlying draft replacement order changes: tenant-scoped components
are deleted before their draft parent lines. The wrapper, locks, concurrency
check, billing schedule assignment, exhibition synchronization, and both-parent
immutability guards remain intact. The runner verified unchanged wrapper/guard
definitions and ACLs, private helper execution, service-only public entrypoint,
and unchanged persisted contents of the reported proposal.

No live proposal was saved, issued, accepted or deleted as a test. No inventory
was changed, invoices issued, messages sent, or application deployed.

## Verification

- `node --test api/_lib/salesBillingLifecycle.postgres.test.mjs`: passed. The
  disposable PostgreSQL suite applies the real Sales migration chain through the
  exhibition wrapper. It reproduces the original immutable-component error,
  checks complete rollback, applies/replays the fix, then checks repeat saves,
  ordinary and bundle removal, persisted totals/snapshots, invalid/stale and
  cross-tenant saves, held-space retention/release and synchronization rollback,
  issued child updates/deletes/reparenting, plus existing billing lifecycle tests.
- `node --test api/_lib/salesQuote.test.mjs`: 15 tests passed.
- `node --test client/src/components/sales/QuotesWorkspace.exhibition.mounted.test.mjs`:
  8 tests passed. Includes ordinary-line removal while retaining a bundle, then
  another save using freshly reloaded line IDs and row version. Mounted tests
  use controlled HTTP fixtures; they are not live database/browser proof.
- The unauthenticated local preview capture reached the Sales route's loading
  state, not the signed-in editor. The signed-in live UI was **not verified**.
  Live confirmation remains a normal authorized user save; the reported proposal
  was deliberately left unchanged. No API/UI production-code change is needed.

## Rechecking deployment

`node scripts/apply-sales-draft-component-replacement.mjs --preflight` is read-only
and reports installed patch and execution grants. Default execution is offline
and prints the migration digest. Applying requires both the reviewed digest and
explicit pinned destination arguments; no generic or SOURCE connection fallback
is supported.
