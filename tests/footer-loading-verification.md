# Email footer loading verification

## Production storage evidence — 2026-09-20

Read-only queries used the destination Supabase project pinned in `replit.md`
(`lvmzliemqnieeoruhkik`), not the legacy workspace source. The query selected
tenants with slugs `bnms` and `gfi`, then selected settings for each tenant with
the exact keys `email_footer_html` and `social_icons_config`. Only counts,
nonempty flags and character lengths were printed; HTML was not printed.

| Tenant | Footer rows | Footer nonempty | Footer characters | Social config rows | Social config nonempty |
| --- | ---: | --- | ---: | ---: | --- |
| BNMS | 1 | Yes | 8,532 | 1 | Yes |
| GFI | 1 | Yes | 1,743 | 1 | Yes |

No duplicate rows were found for either key. Both tenants have genuinely
persisted footer content, rather than only the former unsaved branded fallback.
No recovery writes or reseeding were necessary or performed.

## Regression and local verification

The former page gated reads on the tab's active tenant variable, but only
tenant-user authentication bootstrapped that variable. A supported member
session could leave it null indefinitely. The previous unfiltered settings
list also made finding a setting depend on list pagination.

Mounted behavior tests exercise the production hook, QueryClient and editor
state. Browser tests exercise the actual page with intercepted API fixtures.
They are not production authentication or data tests.

Commands:

```sh
node scripts/run-isolated-tests.mjs node --test client/src/lib/emailFooterTenantIsolation.test.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(command -v chromium) npx playwright test --config=playwright.footer-loading.config.mjs
```

Results: 8 mounted tests and 5 browser tests passed. They cover admin/member
direct entry, exact key reads, original HTML preservation, social-link preview,
missing/create/update, delayed loading, failure/retry and save gating. Mounted
tests additionally exercise switching away/back, late reads/saves and draft
preservation. Browser API writes are intercepted; no real emails are sent.

The application workflow was restarted successfully. The unmocked local
preview cannot establish tenant behavior: it uses the legacy source database,
which reports a missing tenant table. The fixture-backed browser checks avoid
that unrelated environment limitation.

## Deployed browser verification and rollout limits

Vercel's project domain API confirmed the BNMS and GFI custom-domain mapping.
Read-only browser visits to the deployed `/EmailTemplateManagement` routes
at `www.bnms.org.uk` and `www.graduatefutures.org` displayed their respective
Member Access sign-in screens. No authenticated session was available, so
deployed footer-editor behavior has **not** been verified.

Screenshots are in `screenshots/task4583-bnms-deployed-access.png` and
`screenshots/task4583-gfi-deployed-access.png`. These prove the access boundary,
not that the repaired editor is deployed. No deployment was initiated.

## Migrations and data changes

No migrations were needed or applied to any database. No production settings,
HTML, sessions or email delivery records were changed.