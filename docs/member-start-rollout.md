# Individual membership Start / Renew

## Deployment

`supabase/migrations/202612310022_member_membership_start.sql` was applied on
2026-10-21 to verified DEST (`lvmzliemqnieeoruhkik`).
SHA256: `9d2cdc7a8701beb6a7a7921491a8e281bd87b6ef761ad859a2d68bfc7fd92870`.
RLS and service-only creation permission were verified. SOURCE was not changed.
No memberships, invoices, emails or provider payments were created by deployment.

Deploy the matching API/UI together. For invoiced purchases, the deployed
environment must have:

- `ACCOUNTING_REQUEST_QUEUE_ENABLED=true`
- `ACCOUNTING_REQUEST_QUEUE_SOURCES` containing `member_membership_history`
  (preserve any other enabled sources).
- The existing accounting-request queue migrations, connected Xero/QuickBooks
  account and scheduled accounting/invoice-payment reconciliation workers.

The prerequisite queue table exists in DEST. Production environment flags were
not changed or verified during this implementation. Do not enable a broader
legacy accounting rollout without reviewing its own rollout requirements.
The UI explicitly disables invoicing when its queue flag is unavailable.

## Supported scope

Tenant administrators with membership finance permission can select an annual
individual structure, tier (where relevant), today/future commencement and reason.
The preview freezes the selected term, price and tax evidence.

- Invoice: saves an unpaid purchase and submits the existing durable accounting
  queue. Payment reconciliation activates/schedules the purchased term.
- Free: permitted only for an authoritative zero total.
- Recovery: saved requests remain discoverable after reload; resume uses the
  saved authority, not a newly calculated quote.

This does not collect card or Direct Debit consent. Existing public fee links
are not reused because they do not reliably preserve these explicit selections.
Current memberships belong in the existing amendment/renewal flows. Unresolved
history, existing payment obligations, overrides and unsupported complex pricing
show blockers rather than inventing dates, payments or approximate prices.
Imported member class/status/expiry fields are not rewritten.

## Verification

55 feature, UI and adjacent reconciliation tests passed across two runs.
PostgreSQL tests use a disposable local database with
`node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/memberStart.postgres.test.mjs`.
Other focused tests:

```
node scripts/run-isolated-tests.mjs node --test \
  api/_lib/memberStartQuote.test.mjs \
  api/membership/member-start.test.mjs \
  api/_lib/membershipPaymentReconciliation.rolling.test.mjs \
  client/src/components/MemberMembershipStart.mounted.test.mjs
```

The app starts. The preview's existing default-tenant lookup returns Tenant not
found; the signed-in production screen and live provider invoice delivery were
not exercised.
