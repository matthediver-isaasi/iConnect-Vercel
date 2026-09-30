# Live Sales access verification — 2026-09-21

- Read-only requests to `https://gfi.dev.iconn.app/sales/dashboard` and `/sales/pipeline` both returned HTTP 200 and referenced the same production bundle: `/assets/index-BLmPEB2K.js`.
- Bundle SHA-256: `887b1817cb82198214d0289e97b26f3f3b5ae4b0dca641d2c37e55a2c1933230`.
- The live Sales component reads `isFeatureExcluded` from the Layout context and immediately navigates to `/Preferences` when the Sales base permission or current destination permission is excluded.
- The live Sales component does **not** read `roleStatus`, render `NavigationRoleState`, or wait for `useMemberAccess` readiness before that redirect. Therefore both Dashboard and Pipeline are serving the stale immediate-redirect implementation.
- The unauthenticated read-only `/api/auth/me` request returned HTTP 200 with a four-byte anonymous response. No already-authorized browser/API session was available, so the target account's effective role/member exclusions were **not verified**.

No deployment, data mutation, authenticated query, or source-code change was performed.

## Local fix verification

- The Sales guard now uses the session-scoped access hook directly, waiting for a ready role before evaluating baseline and destination exclusions or mounting workspaces.
- Combined Sales, session-role, Layout context, portal readiness, and Sales navigation regressions passed (21 tests).
- Development workflow started successfully on port 5000. A browser screenshot of `/sales/dashboard` reached the existing tenant-resolution error (`Tenant not found`) for the local default tenant; it did not establish authenticated end-to-end access.
- No database migrations are required or were applied. No account permissions were changed.