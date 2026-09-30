# Membership payment report search verification

As of 24 September 2026 (UTC).

## Scope and targets

- The affected tenant hostname checked was
  `https://bnms.dev.iconn.app/MembershipPaymentReport`.
- This is the Vercel preview alias documented for the `eventemb2` branch, not a
  Replit deployment. Replit deployment metadata reports no active Replit
  deployment for this workspace, so it cannot identify the Vercel build.
- Database evidence came only from the pinned destination project
  `lvmzliemqnieeoruhkik`, after independently validating the REST origin, SQL
  pooler project identity, database/user, BNMS tenant ID and slug, and verified
  TLS. The workspace's legacy SOURCE database was not used.
- The SQL inspection ran in a repeatable-read, read-only transaction and was
  rolled back. It made no writes and performed no Stripe, GoCardless, Xero or
  other provider operations.

## Exact member evidence

The destination contains exactly one BNMS member with the normalized email
`samal@cesnet.cz`:

- Member: Martin Samal
- Member ID: `d91d8aa3-4981-4ba0-b923-ab6ccb092f9f`
- Tenant matches BNMS, the account is not paused, and the deleted-identity
  exclusion does not apply.
- There is one retained personal membership history:
  `0ff50f40-15b1-567f-a4d1-c353d9342fae`.
- Its evidence is active, paid, annual, GBP, `upfront`, tier
  `Full Membership Overseas`, membership year `2025/2026`, with reviewed
  `bnms_non_dd_current_backfill` provenance.
- Commencement and renewal remain unknown. Expiry is 29 September 2026, so it
  is still eligible on the 24 September report date.
- The stored final cost and VAT-inclusive total both equal GBP 109. There is no
  billing agreement, as expected for this reviewed upfront record.

Running the current report projection over the endpoint's complete BNMS input
shape produced 342 rows: 260 monthly direct debit and 82 upfront. The sample
projects as:

- payment method: Upfront
- status: Active
- next payment: Unknown
- schedule: Not Scheduled

No current/scheduled commitment supersedes its legacy-current evidence.

## Why the member is difficult to find

The report sorts dated payments first, then unknown dates alphabetically by
member name and member ID. With the current 25-row page size:

- In the unfiltered 342-row report, Martin is row 216 and appears on page 9
  (the 16th row on that page).
- With the Upfront method selected, Martin is row 48 of 82 and appears on page
  2 (the 23rd row on that page).

This establishes a pagination explanation for first-page absence in the
read-only projection, with no demonstrated eligibility or payment-method
failure. It does not prove the cause of the user's authenticated deployed
result, which remains inaccessible below. The existing deployed interface has payment-method
filtering and pagination but no member-name/email search.

## Live frontend and API evidence

The exact affected hostname returned HTTP 200 from Vercel and served
`/assets/index-C7JP0oiQ.js`. That asset contains the previously merged Upfront
report behavior, including the Upfront method option and the payment-report
page, so the earlier upfront correction described in
`membership-payment-report-upfront-verification.md` has reached this preview
frontend.

The same live asset does **not** contain the new report labels `Find member` or
`Search name or email`, and its report request/query key contains only page and
payment method. Thus the member-search change is not yet rolled out on
`bnms.dev.iconn.app`. A merge or workspace change must not be treated as public
rollout.

Unauthenticated GETs to the exact hostname's JSON and CSV report URLs, both
with and without `search=samal%40cesnet.cz`, correctly returned HTTP 401
`Authentication required`. Consequently this check cannot prove the rendered
row or authenticated API search response on the deployed preview. It also
cannot identify the Vercel deployment commit without authenticated Vercel
deployment metadata. The static asset and unauthenticated API results establish
only the rollout/authentication facts stated above.

For comparison, `bnms.iconn.app` served a different older asset,
`/assets/index-Csr7kx8-.js`, whose report fallback options do not include
Upfront. That production hostname must not be substituted for the affected
preview hostname.

## Migration status

No schema or data migration is required, applied, or pending for member
search. The destination already contains eligible evidence for the sample.
This investigation changed no membership, payment, date, entitlement,
invoice, credential, provider or deployment state.

## Search verification in this workspace

- `node scripts/run-isolated-tests.mjs node --test api/admin/membership-payment-report/index.test.mjs`:
  27 passed. Covers bounded validation, literal special characters, mixed-case
  names/emails, records beyond the 1,000-row fetch boundary, matching totals,
  method intersections, full CSV, deleted/foreign identities and expiry.
- `npx playwright test --config=tests/payment-report.config.mjs`: 11 passed.
  These isolated fixtures intercept all API traffic; they exercise debounce,
  pagination reset, clear, empty/error/loading states, search export parameters,
  cancelled stale exports, and permission behavior. They are not live sign-in tests.
- The application workflow restarted successfully on port 5000. The ordinary
  preview still returns the pre-existing tenant-not-found screen against the
  workspace configuration. The isolated fixture screenshot renders the actual
  report component and new search controls successfully.

## Remaining rollout verification

No deployment promotion was performed. The exact pending check is an authorized
session on `bnms.dev.iconn.app/MembershipPaymentReport` after the intended branch
build is deployed: confirm the Find member control, then search the sample email
under All payment methods and Upfront, inspect the authenticated JSON total and
CSV, and confirm clearing preserves the method filter. If checked after
29 September 2026, this historical evidence legitimately no longer qualifies;
do not extend its dates to make the sample appear.