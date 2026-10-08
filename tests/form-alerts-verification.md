# Form alerts tenant resolution verification

Verified 2026-10-08.

## Live read-only evidence

Host: `https://gfi.dev.iconn.app`
Route: `/FormBuilder?formId=51db79df-cfbd-46bf-9534-9ab8ed72d5ca`

Unauthenticated HTTP reads found:

- Entry asset `index-SswHYXUi.js` identifies commit
  `c1fe090418efbb7da7df42b0ebf0d601aa5e285e`.
- `FormBuilder-sAA1WK1A.js` contains the waiting-for-active-tenant message.
- `useFormAlerts-CoqTEAoI.js` resolves only the admin singleton and compares
  that singleton before and after alert requests.
- Application bootstrap only populates that singleton for authenticated
  tenant-user-me responses, not ordinary member-portal responses.

This is source/bundle evidence, not a signed-in live reproduction. No authorized
live session was available. No live settings, recipients, links or emails were
changed, and nothing was deployed.

## Isolated local verification

Tested workspace changes based on commit `64e282ab4`, using the development
server at `http://127.0.0.1:5000`; this is not a new published build.
All browser APIs, WebSockets and external requests are intercepted.

- Before the fix, the cold portal save/reopen regression failed at the missing
  recipients control and displayed “Waiting for the active tenant”. No tenant
  setter was used to establish the successful session.
- `npx playwright test --config=tests/form-alerts.config.mjs`: 14 passing.
  Covers independent save/reopen, per-form isolation, validation, Emails
  separation, new forms, real dashboard bootstrap, removal/draft reset, release
  gating, retry, revocation, non-admin authorized portal members, delayed auth,
  server denial, late read after revocation, and excluded members.
  The dashboard-only component browser fixture also checks unsaved recipients,
  enablement and an open submission dialog across tab return, plus unchanged
  successful dashboard revalidation. It obtains identity through mocked HTTP
  authentication responses, not a tenant setter.
- `npx tsx --test client/src/hooks/useFormAlerts.test.jsx`: passing. Covers
  unknown identity, explicit tenant header, same-tenant session changes during
  writes, ABA tenant changes, synchronous work invalidation, paused revocation,
  verified dashboard-only fallback, and tenant removal.
- `node --test api/admin/form-alerts.test.mjs client/src/lib/viewerProtectedWorkGate.test.mjs`:
  17 passing.
- `npx playwright test --config=tests/form-alert-view.config.mjs`: 2 passing.
- `git diff --check`: passing.

The installed Chromium lacks URL.parse, so the fixture supplies a standards-
equivalent polyfill; it does not bypass authentication or authorization.
An unauthenticated app-preview screenshot showed the session-loading shell;
the signed-in controls were verified through the isolated browser tests only.

## Migration and release status

No migrations needed. None applied to SOURCE, DEST, or any other database.
No migrations remain unapplied for this fix. Authenticated live confirmation
remains a release check after an explicitly approved deployment.
