# Task 4371 — BNMS Custom Object discovery diagnosis

## Scope and safety

This investigation used read-only source inspection, the connected Vercel
integration, and the external DEST Supabase environment. No Custom Object,
form, relationship, permission, or tenant data was written. No workflow was
run or restarted, and no workflow logs or application preview was inspected.
The original BNMS live user session was not available, so no authenticated live
API request was attempted.

The workspace's built-in database/deployment checks are not the production
targets for this project. Per `.agents/memory/workspace-db-targets.md`,
production uses DEST Supabase through Vercel; the local runtime's generic
`SUPABASE_URL` can point at a legacy source project.

## Reported question

The question was whether the BNMS Custom Object discovery result (reported as
eight objects) was caused by a backend tenant-context or authorization defect,
including forms that use Custom Objects and objects without relationships.

## Live DEST evidence

The pinned BNMS tenant resolved to the tenant named **BNMS**. Queries used only
tenant-scoped metadata and counts:

- 8 active Custom Object definitions;
- all 8 have an active valid primary display field;
- 11 active relationship definitions;
- all 8 active objects participate in at least one active relationship
  endpoint;
- 43 forms belong to BNMS; and
- every form passed to the in-memory
  `createFormRelationshipService({ db: DEST, tenantId })` returned 8
  `custom_objects` and 18 visible relationship sides for a tenant-user
  author.

The live result therefore independently confirms the existing task context:
eight BNMS objects are the complete active, display-ready tenant catalogue. It
does not show an object disappearing because it lacks a relationship; there
are currently no active relationship-free BNMS objects to exercise. The
regression fixture covers that case independently.

The same read-only script passed a synthetic role with no grants through the
service: it returned 0 Custom Objects and 0 relationship sides. BNMS currently
has 0 `can_view_records` rows in `custom_object_role_permission`, so a
portal/member author without schema access would be denied by the existing
grant policy. The original session was unavailable, so the reported caller
cannot be classified as a tenant user, schema-authorized member, or ordinary
member from live evidence.

The script also selected a form from another tenant and passed it to the
tenant-bound service; discovery rejected it with `404`. No foreign form or
object data was returned.

## Source and route evidence

`listObjects` in `api/_lib/customObjectService.js` applies
`tenant_id = context.tenantId`. A tenant user or schema-authorized caller can
see the tenant catalogue, including objects without relationship definitions.
A caller without schema access is restricted to active objects with a role
grant containing `can_view_records = true`.

The collection route is `GET /api/custom-objects`; its successful response is
the direct envelope `{ data, total, page, pageSize }`. The client reads
`query.data.data` and uses the returned `total` for pagination; it does not
slice the result to eight objects. The relationship-definition graph is a
different route,
`GET /api/custom-objects/:objectId/relationship-definition-graph`, and
requires schema-management access.

`api/_lib/formRelationshipOptions.js` applies `tenant_id = tenantId` when
loading the form, relationship definitions, Custom Object definitions, and
Custom Object fields. It returns relationship sides in `data` and all active
tenant objects with a valid active primary display field in `custom_objects`.
For member authors, object grants and field-level `none` entries filter both
collections. Tenant users are not subjected to that member-role grant filter.

## External Vercel evidence

The connected Vercel project is `vite-migrate-replit-6` (Vite, GitHub
repository `iConnect-Vercel`, production branch `main`).

- The current production deployment is `READY` at commit
  `aaa9e9008ec751cab605ce9a12f98b34dd29c7a6`, with the production aliases
  including `bnms.org.uk` and `iconn.app`.
- `dev.iconn.app` is assigned to a `READY` preview deployment at commit
  `4e9483540dcb37077fc59a9e00e8beedb78f5a66`.
- The newest `mapping` preview deployment at commit
  `e610647af8db9345cff6ee6d1eb3ef6906361b72` was still `BUILDING` and did not
  yet carry the `dev.iconn.app` alias when checked.

This is evidence of a deployed-build parity risk: source changes are not
evidence of what the BNMS user sees, and the latest preview is not yet the
`dev.iconn.app` deployment.

## Regression coverage and test results

`api/_lib/formRelationshipOptions.test.mjs` now verifies in one discovery
fixture that:

1. an authorized member role receives its granted Custom Object while an
   ungranted or field-denied role receives none;
2. an active tenant object with no relationship definition is still returned
   in `custom_objects`;
3. a Custom Object and field belonging to another tenant are excluded; and
4. a form belonging to another tenant is rejected with `404`.

Actual backend test runs completed:

- `node --test api/_lib/formRelationshipOptions.test.mjs`: **34 passed**;
- `node --test api/_lib/customObjectService.test.mjs api/_lib/customObjectRoute.test.mjs api/_lib/formRelationshipRoutes.test.mjs`: **139 passed**.

## Conclusion

The live DEST catalogue and service evaluation do not prove a backend
tenant-context defect or an eight-object hard cap. They show exactly eight
active BNMS objects and the service returns all eight for a tenant-user
author. A member without schema access would receive none because BNMS has no
Custom Object record grants, which is consistent with the documented
authorization policy but cannot be tied to the unavailable original session.

The strongest remaining explanation is deployment/frontend parity or caller
authorization context, not missing tenant predicates. The latest Vercel
preview was still building and the BNMS preview alias still pointed at an
older commit. No backend behavior change is justified by the available
evidence.

## Frontend repairs and final verification

The original query skipped unsaved forms, shared a global cache key, and made
unresolved/error responses look like empty discovery. These are proven frontend
defects, but the original session/request is unavailable, so no single one is
claimed as the uniquely proven cause of the screenshot.

Discovery now scopes its cache by tenant, form, principal, role, and mode. It
sends a UUID tenant header without the public client's cached tenant query.
Invalid response envelopes fail visibly. The editor distinguishes save-first,
loading, error/retry, and confirmed-empty states. Unsaved forms cannot select
identity-dependent source modes; saved-form drafts receive actionable validation.
Server authorization and submission validation remain unchanged.

All six browser scenarios passed using isolated mocked API fixtures (five in
the full run, then save/reopen after correcting a fixture label assertion):
initial create, save-first gating, discovery states/retry, SPA tenant/form
switching, public option states, and direct/distinct configuration with primary
labels and equality filters surviving save/reopen. No production writes occurred.
The success screenshot is `screenshots/discovery-builder.png`.

```sh
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which chromium) \
npx playwright test --config=playwright.task4371.config.mjs
```

The direct development port avoids the preview interstitial for mocked tests.
The normal app preview has no BNMS author session and its default tenant request
fails, so it is not evidence of live BNMS behavior. DEST read-only checks and
Vercel metadata inspection were possible; authenticated live UI verification of
this patch was not.