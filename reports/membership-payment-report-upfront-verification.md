# Upfront membership report verification

As of 24 September 2026.

## Read-only DEST checks

Used the existing destination-pinned SQL connection with verified TLS and a
`BEGIN READ ONLY` transaction. Verified the pinned tenant resolves to BNMS.
No SOURCE data was substituted.

- Bounded cohort read: 83 upfront histories belonging to 83 members.
- Existing legacy-current recognizer: 82 eligible histories on the report date.
- Updated report projection over the cohort and all its retained histories:
  82 unique members, all labelled Upfront.
- The user-reported example has active/paid reviewed provenance, unknown
  commencement, a known historical amount, and expiry 29 September 2026.
  The old selector classifies it as unknown; the existing legacy recognizer
  accepts it. The updated projection includes it with no next-payment date
  and `not_scheduled`. No additional exclusion was found for that member.
- No database writes or provider calls were made.

## Fixture verification

- `node --test api/admin/membership-payment-report/index.test.mjs`: 24 passed.
- `tests/payment-report.spec.mjs`: 8 Playwright tests passed using system
  Chromium and a temporary configuration selecting this suite.
- Endpoint fixtures enforce selected columns, covering required evidence,
  unknown amounts, expiry inclusivity, invalid provenance, tenant/organisation
  exclusions, deterministic duplicates and commitment precedence, and more than
  1,000 records across filters, pagination, totals and CSV.
- Browser fixtures intercept API calls; they verify the Upfront option, row
  label, unknown next date, Not Scheduled, pagination reset and export request.
  These are not production browser tests.
- Application workflow restarted and is serving on port 5000.

## Limits and migration status

No authenticated deployed browser session was available. The ordinary local
preview shows a tenant-resolution error against the workspace's legacy SOURCE;
the isolated browser fixture renders the report successfully. This does not
establish deployment or live browser rollout of the change.

No database migrations are needed, applied, or pending. No memberships, payment
evidence, entitlements, dates, invoices or collection authority were modified.