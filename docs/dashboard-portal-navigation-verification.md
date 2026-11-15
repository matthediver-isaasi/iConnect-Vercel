# Dashboard portal navigation verification

## Confirmed scope

The owner confirmed Global Schools Forum (GSF), not BNMS, is the affected
tenant. No saved menu, role, member, or tenant configuration was changed.

## Read-only destination evidence

Bounded queries against the documented destination project
`lvmzliemqnieeoruhkik` used the existing destination-pinned SQL connector,
verified provider TLS, and `BEGIN READ ONLY`.

GSF's saved Dashboard row has:

- URL `Dashboard`, feature `system.dashboard`, section `user`.
- Active status, no parent, and no children.
- The reported account's tenant-specific role is Super Admin, with `sales`
  excluded and no individual exclusions.
- Neither `system.dashboard` nor its `system` permission parent is excluded.
- The shared permission catalogue places `system.dashboard` under `system`.

The screenshot matches these GSF fields. BNMS has a separate saved Dashboard
row tagged `sales.dashboard`; it is not evidence about GSF and was left alone.

## Cause and correction

Layout builds the active user menu and calls `getSalesPortalPermission` before
honouring a saved feature ID. That helper passed the bare `Dashboard` page name
to `getSalesDestination`, whose shorthand contract interprets it as
`/sales/Dashboard`. Its case-insensitive key lookup returned the Sales dashboard.
The Sales parent restriction then hid the entry, overriding the correct saved
`system.dashboard` permission.

The portal helper now treats authored URLs as paths rather than Sales keys.
`Dashboard` resolves as `/Dashboard` for classification and receives no Sales
permission override. Genuine `/sales/...` destinations keep their existing
permission checks. The Sales helper's shorthand contract for other callers
is unchanged. Layout's active/section/parent admission, exclusion hierarchy,
and shared desktop/mobile filtering remain unchanged.

## Verification

Passed:

- `node --import tsx --test client/src/lib/salesNavigation.test.mjs client/src/lib/dashboardPortalNavigation.test.ts client/src/hooks/usePortalNavigation.test.jsx`
  — 15 checks, including permission exclusions, navigation invalidation,
  tenant/account switches, and failed reads.
- `PLAYWRIGHT_BASE_URL="https://$REPLIT_DEV_DOMAIN" npx playwright test --config=tests/portal-session-boundaries.config.mjs --grep='portal Dashboard is independent'`
  — desktop and mobile passed against the actual Layout with isolated,
  intercepted API responses. Verified link visibility, `/Dashboard` click
  destination, role/member/permission-parent denial, fresh reads after changes,
  restored access, and inactive-menu denial.
- Source regression verifies the existing GSF MemberDemo login override remains.

## Limits

These are local fixture passes plus live saved-data evidence, not a deployed
authenticated browser pass. No affected-account session was available; no
session was created or impersonated. The unauthenticated preview screenshot
remained on Loading with tenant-resolution errors and does not verify the
signed-in UI. The development runtime uses a different database target from
the documented destination. The application workflow starts on port 5000.

No deployment was performed. The affected deployed browser's menu and role
responses, deployed bundle version, and post-release visibility have not been
observed. These limits do not establish additional causes such as stale cache
or deployed-code divergence.
