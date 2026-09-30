# Organisation deletion and applicant continuation

## Migration

Applied `migrations/20260925_form_applicant_continuation_organization_detachment.sql`
to verified external Supabase DEST project `lvmzliemqnieeoruhkik`.
The destination-only runner verified project pins and TLS, ran in a transaction,
and checked nullable organisation references, `ON DELETE SET NULL`, the supporting
index, revocation trigger/check, and both binding RPC rejection predicates.
SOURCE was untouched. No database migration remains pending for this change.
Application changes still require the normal deployment/release flow.

## Read-only live inspection

Before applying the migration, the reported organisation still existed and was
not primary. It had zero currently linked members, one consumed applicant grant,
zero linked drafts, and zero submissions linked by `organization_id`.
No tokens, contact details, or draft answers were read or exported.

This snapshot cannot establish which records were changed by the earlier failed
deletion. The existing handler performs cleanup before its final DELETE, so
partial effects remain possible. The organisation was not deleted or retried,
and no restoration was attempted.

## Verification

- Disposable PostgreSQL fixture and migration runner checks: 4 passed.
  The migration was replayed, actual organisation FK deletion exercised, and
  live/expired/revoked/consumed grants and linked draft history checked.
- Form submission compatibility suite: 167 passed.
- Organisation DELETE handler authorization tests: 4 passed, covering tenant
  administrator success, primary protection, cross-tenant and non-admin denial.
- Applicant continuation browser fixture suite: 7 passed.
- Application workflow restarted successfully.

Local root preview displayed `Tenant not found`; logs identify the workspace's
legacy SOURCE schema as missing the tenant table. Browser tests used fixtures,
not authenticated live production verification. No live deletion was used as a
test.