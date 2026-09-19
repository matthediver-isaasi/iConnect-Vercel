# Member invoice actions: verification and remaining limitation

Verified on 2026-09-19.

## Outcome

The existing member PDF routes and permission checks are retained. Imported DD
rows now explain unavailable/denied invoices instead of silently omitting all
invoice feedback. Both imported DD and ordinary membership retrieval failures
retain visible controls and offer Retry. Ordinary membership downloads use safe
filenames, preview URLs are cleaned up, and loading/error state distinguishes
personal and organisation records even when their IDs coincide.

The supplied screenshot and exact affected URL,
`https://bnms.dev.iconn.app/History`, led to a reproducible projection compatibility
defect: the previous deployed historical-DD API returned persisted invoice IDs
and numbers without `invoice_available`. The current UI required that flag, so
an older response hid both actions even for linked invoices. The compatibility
fix accepts a persisted invoice ID only when the flag is absent; an explicit
false or permission-denied reason remains authoritative. An invoice number or
external URL alone is never treated as an invoice reference.

**The affected browser's exact runtime/response is still unverified.** Either
an older frontend retained in an open tab or a newer frontend receiving the older
response shape can explain the screenshot. The compatibility regression proves
the latter condition and its correction, not which condition the member had.
These changes do not prove that the affected deployed member can now retrieve
their invoices without rollout and a fresh authenticated check.
No permission grants, accounting changes, sessions or financial records were
created or changed.

## Read-only deployed diagnosis

- Vercel's BNMS aliases resolve to the READY production deployment for committed
  baseline `51672802f2bbc317f13c8da8e4f44f4130b4bdde`.
- `https://www.bnms.org.uk/history` responds successfully; the apex redirects
  there. `dev.iconn.app` serves the same baseline commit.
- The exact affected host `bnms.dev.iconn.app` resolves through `*.dev.iconn.app`
  to that same READY preview deployment. Both `/History` and `/history` serve
  `/assets/index-DM-RBOtk.js`, with the current View/Download rendering path.
- The previous preview's frontend lacked PDF controls. Its API projected
  `xero_invoice_id`, `xero_invoice_number` and `xero_invoice_url`, but omitted
  `invoice_available`. This is the old contract reproduced in regression tests.
- Both live JavaScript bundles contain the original member history and
  historical-DD PDF controls. Neither contains this work's new unavailable/retry
  markers. That is expected before rollout, not evidence that a stale baseline
  caused the reported incident.
- All four history/PDF endpoints reject unauthenticated requests with 401.
- Read-only aggregate checks against DEST Supabase found nine imported historical
  DD payments, all with persisted Xero invoice IDs and numbers. Their owner and
  role resolve, with no effective role/member exclusion along the invoice
  permission hierarchy. No personal identifiers are included here.
- There is one historical-DD list handler; Vercel filesystem dispatch and the
  local adapter both select it. No alternative implementation was found.

No authenticated affected-member session was available. The actual member's
historical-DD response, admin/member comparison, and provider PDF bytes were
therefore **not verified live**. Do not treat permitted persisted data or fixture
tests as a substitute for that check.

## Local automated verification

- 42 isolated API tests passed across historical-DD list/PDF, member-history and
  membership-invoice suites. Coverage includes explicit permission denial,
  cross-member/tenant access, admin behavior, missing references, persisted
  accounting providers, safe filenames and provider failures.
- 13 Playwright tests passed against the real `/history` React page with mocked
  sessions/API responses. Coverage includes imported DD View/Download,
  ordinary personal/accounting and organisation/Xero actions, unavailable/denied
  states, retry, source-qualified loading state, and unmount URL cleanup.
- Six HistoricalDdPayments component tests passed, including the old API shape,
  explicit denial with a persisted ID, and number-only records. An additional
  focused Playwright regression passed for old-shape `/history` rows, exercising
  both protected View and Download requests.
- `git diff --check` passed.
- The application workflow restarted successfully. An unmocked local screenshot
  cannot establish the member experience: this workspace's legacy runtime
  database lacks the tenant table and no member is signed in. Fixture screenshots
  show the invoice actions and unavailable state rendering correctly.

Commands:

```sh
node scripts/run-isolated-tests.mjs --shell 'node --test api/membership/historical-dd.test.mjs api/membership/historical-dd-invoice.test.mjs api/membership/member-history.test.mjs "api/membership-invoice/[recordId].test.mjs"'
npx tsx --test client/src/components/membership/HistoricalDdPayments.test.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<available-Nix-Chromium> npx playwright test --config=playwright.task4377-history.config.mjs --output=/tmp/invoice-4543-browser
```

## Required live confirmation

With authorized affected-member browser access, inspect the historical-DD
response's `invoice_available` and `invoice_unavailable_reason`, compare the
same rows in the admin tab, and exercise both actions. Keep cookies/tokens and
invoice contents out of reports. If controls still fail despite an available
response, capture the rendered state and console error before changing code.
Roll out only the intended reviewed changes; no deployment was promoted here.

## Migrations

None needed, none applied to any database, none outstanding for this change.
DEST Supabase was queried read-only; neither DEST nor the legacy runtime
database was migrated.