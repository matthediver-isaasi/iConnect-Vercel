# Renewal payment-method switching

Members use **Change payment method** on a pending renewal. The request includes
the specific election shown in that tab. Server authorization and the database
verify tenant, owner and original payer before any provider calls.

Original and replacement Stripe intents must all be terminally cancelled.
Unfinished hosted card/DD setups must be expired/cancelled and re-read.
Processing, paid, authorized, subscription/mandate-committed and unknown
outcomes do not restore method selection. Unknown transport outcomes retain
the reconciliation fence; retry the same action to reconcile them. Missing
provider identity or unavailable original credentials require administrator
reconciliation, not age-based release or deletion.

Released quotes, attempts, agreements and setup histories remain as audit
records. Existing current-term instalments are not altered. Database guards
reject late writes and prevent retained cancelled rows from blocking a new
reservation. No rollout enablement settings are changed.

## Database and deployment status

- Applied `supabase/migrations/20261207_membership_successor_switch.sql` to
  the verified **DEST** Supabase database using
  `scripts/apply-renewal-payment-switch.mjs`.
- Migration SHA-256:
  `3566c19b1ddace2bea6711cb16096fdc004e4e9339cd15393d2b1e28e26012e9`.
- Installation verified that all financial and rollout rows were unchanged,
  and reconciliation RPCs are service-only. No live provider cancellation
  was performed during implementation or testing.
- No application deployment was performed. There are no remaining schema
  updates for this change. SOURCE and the workspace's legacy runtime database
  were not migrated.

## Verification

- `node scripts/run-regression-suite.mjs rolling-memberships`: 701 passing
  tests, including disposable PostgreSQL races, full rolling-trigger integration,
  immutable retained history, provider refusals/retries and API authorization.
  Replacement tests exercise the actual rolling-card reservation and upfront
  webhook reconciliation helpers with retained cancelled DD/card histories.
- `node scripts/run-bnms-renewal-acceptance.mjs`: browser fixture coverage of
  the real FormView, plus keyboard switching and provider-refusal tests. The two
  switching tests passed after the pending announcement was added; the six
  existing acceptance tests passed in the preceding full run.
- Browser tests use synthetic authentication and blocked external requests;
  they are not evidence of live Stripe/GoCardless cancellation.
- The development workflow starts cleanly. Its unauthenticated preview reports
  “Tenant not found”; the signed-in production UI was not verified.
