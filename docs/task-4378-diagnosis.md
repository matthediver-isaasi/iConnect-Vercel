# Task 4378 — BNMS Custom Object access and deployment diagnosis

## Scope, safety, and observation time

This was a read-only investigation observed at **2026-09-11T13:10:38Z**. It
used:

- the deployment skill's Replit deployment metadata check;
- the added Vercel connection, through Vercel `GET` requests only;
- the added Supabase connection metadata and the existing destination-only
  read clients for `DEST_*` (the Supabase MCP callbacks were not mounted in
  this delegated sandbox);
- direct source inspection; and
- read-only `SELECT` queries against the destination (DEST) database.

The workspace memory `workspace-db-targets.md` was applied: the generic local
runtime `SUPABASE_URL` points at the legacy SOURCE project, while Vercel
production and the destination-only readers point at DEST
(`lvmzliemqnieeoruhkik`). All BNMS counts and access findings in this report
come from DEST; no local SOURCE result was treated as production evidence.

No Vercel deployment was started, canceled, or changed. No deployment logs were
read. No Supabase row, schema, permission, role, session, or tenant data was
written. Credentials were used only inside connector/database clients and were
never printed or recorded. No session cookie, token, or member identity was
provided, recovered, or impersonated.

The original BNMS report session is unavailable in this context. In particular,
there is no authenticated request trace, session cookie, resolved member ID,
resolved tenant-user ID, role snapshot, or timestamped response from that
original caller. Consequently, this report distinguishes facts about persisted
BNMS policy and representative contexts from claims about the caller.

## Executive conclusion

Two different facts are established:

1. **An expected permission denial is proven for a non-schema member context with no
   object grant.** DEST currently has zero BNMS
   `custom_object_role_permission` rows, including zero `can_view_records`
   grants. The live service returns no Custom Objects for a synthetic
   non-tenant member context with the actual BNMS **Point of Contact** role,
   whose persisted role capabilities do not include schema access. That is the
   behavior required by the current authorization policy, not evidence of a
   missing tenant predicate.
2. **The original session cause is not proven.** The unavailable caller might
   have been a tenant user, a Super Admin member, an ordinary member, a stale
   or expired session, or an unauthenticated request. A session-specific
   explanation cannot be selected without the original request/session
   context.

There is also a current deployment split: `bnms.org.uk` is assigned to an
older READY Vercel production deployment at commit `aaa9e900…`, while
`dev.iconn.app` is assigned to the newest READY `mapping` deployment at
commit `fe8db6ff…`. The latter contains the Task 4371 discovery changes; the
production commit predates that commit in the local Git graph. Therefore a
report from BNMS production cannot be treated as a report from the current
mapping build. This is a proven parity risk, but does not identify the
original caller's authorization context.

## Connected deployment evidence

### Replit publishing status

`getDeploymentInfo()` succeeded and returned:

| Field | Value |
|---|---|
| `isDeployed` | `false` |
| `primaryUrl` | empty |
| `deploymentType` | empty |
| `hasSuccessfulBuild` | `false` |

This is the Replit publishing service, not the Vercel project used by this
application. It does not contradict the Vercel evidence below; it means there
is no active Replit-publishing deployment to use as the production reference.

### Vercel project and aliases

The connected Vercel integration is present with status `added`. The project
metadata `GET` succeeded for **`vite-migrate-replit-6`**:

- framework: `vite`;
- build command: `cd client && npx vite build --outDir ../dist/public`;
- output directory: `dist/public`;
- GitHub repository: `matthediver-isaasi/iConnect-Vercel`;
- production branch: `main`; and
- project domains include `bnms.org.uk`, `www.bnms.org.uk`,
  `60-years-of.bnms.org.uk`, `dev.iconn.app`, `*.dev.iconn.app`, and
  `gfi.dev.iconn.app`.

The project domain metadata associates `dev.iconn.app`, `*.dev.iconn.app`, and
`gfi.dev.iconn.app` with the `mapping` branch. The BNMS production domains have
no preview branch association.

The current deployment and alias reads were:

| Surface | Vercel deployment | State | Commit/ref | Current aliases |
|---|---|---|---|---|
| `dev.iconn.app` | `dpl_6Ub4JCmL5t4QC9dPMEDWZwgKXggT` | `READY` | `fe8db6ff3ca5739937283b11bdcedfe3f9c45b64` / `mapping` | `dev.iconn.app`, `*.dev.iconn.app`, `gfi.dev.iconn.app`, and the generated `mapping` alias |
| `bnms.org.uk` | `dpl_216D9K59eK2y8ZzdXvxX9eibQ5ea` | `READY` / production | `aaa9e9008ec751cab605ce9a12f98b34dd29c7a6` / `object` | `bnms.org.uk`, `www.bnms.org.uk`, plus the production project aliases and other configured production domains |

The mapping deployment was created at `2026-09-11T11:58:45.925Z` and became
READY at `2026-09-11T12:12:25.807Z`. The production deployment became READY
at `2026-08-26T08:52:22.694Z`. The current alias endpoint, rather than an
embedded historical alias field on older deployment records, was used for the
assignment above.

The local Git graph confirms that `aaa9e900…` is an ancestor of
`fe8db6ff…`, not the reverse. The `fe8db6ff…` deployment is the commit that
contains the Task 4371 diagnosis and discovery lifecycle changes. Thus:

- a user on `dev.iconn.app` is currently reaching the newest READY mapping
  deployment identified above; and
- a user on `bnms.org.uk` is currently reaching the older production build,
  not that mapping deployment.

No Vercel build log was inspected, so this report asserts metadata state
(`READY`) only, not the contents of an execution log or an end-user HTTP
response.

## Fresh BNMS DEST metadata

The destination tenant resolved by slug/name is:

| Field | Value |
|---|---|
| tenant name | `BNMS` |
| slug | `bnms` |
| status | `active` |
| configured domain | `60-years-of.bnms.org.uk` |
| tenant ID | `ff2df806-b321-4254-b651-3af11fccf1db` |

The tenant-scoped metadata query found:

| Metadata | Result |
|---|---:|
| active, non-archived Custom Object definitions | 8 |
| active objects with an active valid primary display field | 8 |
| active relationship definitions | 11 |
| active forms | 43 |
| live Custom Object records | 1,668 |
| `custom_object_role_permission` rows | 0 |
| rows with `can_view_records = true` | 0 |
| `custom_object_field_role_permission` rows with `access_level = 'none'` | 0 |

The eight active object keys were:

`department_type`, `equipment_model`, `equipment_register`,
`equipment_type`, `member_organisation_assignment`, `org_department`,
`workforce_survey`, and `workforce_survey_row`.

Every one of those eight objects currently participates in at least one active
relationship. There is no current BNMS relationship-free active object with
which to reproduce a “missing because it has no relationship” result. The
service's tenant-user evaluation returned 18 visible relationship sides from
the 11 definitions after endpoint and visibility filtering.

## Fresh access-policy evidence

The destination contains 13 BNMS roles. Evaluating the persisted role
exclusions with the same schema-capability rules used by
`resolveTrustedSchemaCapabilities` produced this summary:

| Role class | Schema view | Schema management |
|---|---:|---:|
| `Super Admin` | yes | yes |
| every other BNMS role, including `Point of Contact`, `BNMS Staff`, `Member`, `Trainee`, and the other member roles | no | no |

The role data shows `admin` excluded for the ordinary non-schema roles. The
role-access implementation treats the parent module exclusion as excluding
`admin.data-studio` and
`data.custom-objects.manage-data-model`. This was evaluated from persisted
role metadata, not from a member session.

The active tenant-user summary is two `owner` rows. Active members with
`login_enabled = true` are distributed across 54 `Point of Contact`, five
`Super Admin`, one `Trainee`, 15 `Member`, and 3,678 rows without a role.
These counts identify possible persisted contexts only; they do not identify
the person who made the original report.

The relevant backend policy is visible in
`api/_lib/formRelationshipOptions.js`:

- tenant-user authors are not subjected to the member-role object-grant
  filter;
- a non-tenant author with schema access can see the display-ready active
  object catalogue; and
- a non-tenant author without schema access is restricted to active objects
  with a matching `custom_object_role_permission.can_view_records = true`
  grant.

Because BNMS has no such grants, a normal member role without schema access is
expected to receive no Custom Objects. This is a proven permission mismatch
only when the caller is known to be such a member context.

## Representative service evaluations (synthetic, not impersonation)

To compare the persisted metadata with the service, one active BNMS form was
passed to `createFormRelationshipService({ db: DEST, tenantId })`. No HTTP
session, cookie, bearer token, or member identity was used. The contexts below
are constructed test inputs, not impersonated users:

| Synthetic author context | Custom Objects | Relationship sides | Interpretation |
|---|---:|---:|---|
| tenant user (`isTenantUser: true`) | 8 | 18 | sees the full active, display-ready BNMS catalogue |
| actual BNMS `Point of Contact` role, no schema access, no object grant | 0 | 0 | denied by the persisted grant policy |
| member with schema access explicitly enabled | 8 | 18 | sees the full catalogue without object grants |

The second row proves expected denial, not a permission mismatch:
the role has no schema capability and DEST has zero object-view grants. It is
not evidence that the original report used that role. The repaired mismatch is
instead the former discovery route omitting server-resolved schema capabilities
for schema-authorized member authors, unlike the catalogue route.

## What is proven versus unresolved

### Proven

- BNMS is active in the DEST database and has eight active display-ready
  Custom Objects.
- All eight currently participate in active relationships; a current
  relationship-free object cannot explain a missing catalogue item.
- The tenant-user and schema-authorized service paths return all eight objects
  and 18 relationship sides.
- BNMS has zero object-level `can_view_records` grants.
- A non-schema, non-tenant member context therefore returns zero objects under
  the current policy. This is proven with the actual Point of Contact role
  metadata as a synthetic input.
- `bnms.org.uk` and `dev.iconn.app` currently serve different READY Vercel
  deployments. The production deployment is older than the mapping deployment
  containing the Task 4371 changes.

### Not proven

- The original caller's role, tenant-user/member status, tenant context, or
  session validity.
- Whether the original screenshot/report came from `bnms.org.uk`,
  `dev.iconn.app`, another alias, or a cached/older browser bundle.
- Whether the original caller saw zero objects, a stale eight-object result, an
  error rendered as empty, or a result from another lifecycle state.
- Any causal claim that an expired session caused the report. A stale or
  missing session remains a possible explanation, but there is no session
  evidence to establish it.
- Any runtime or deployment-log explanation; logs were intentionally not
  inspected.

## Recommended next evidence (read-only)

To resolve the remaining ambiguity without impersonation, obtain from the
original report or a user-supplied browser trace:

1. the exact hostname used;
2. the request timestamp in UTC;
3. the non-secret response status/envelope for the Custom Object discovery
   request;
4. whether the authenticated context was a tenant user or member; and
5. the role/schema capability result as observed by the server for that
   request.

The safe server-side correlation should use a request/session diagnostic that
returns only tenant-user/member mode, role ID or a redacted role label,
schema-capability booleans, and response counts. It should not return cookies,
tokens, email addresses, or full member records. Until those facts exist, the
appropriate conclusion is: **denial is proven for
non-schema/no-grant member contexts, while the original session cause remains
unresolved; the production-versus-mapping deployment split is separately
proven.**

## Repair verification

- Shared server-resolved schema capabilities now feed catalogue and form
  discovery. Form discovery still requires authenticated admin access.
- Schema-authorized member authors no longer need object-level record grants
  for discovery, but explicit field denials still remove filter fields and
  primary-field-denied objects and relationship sides.
- Public options and submission eligibility code is unchanged.
- Focused backend suites: 64 passed; Custom Object service suite: 110 passed.
- `playwright.task4378.config.mjs`: 1 passed. The real discovery handler and
  service ran against fixture metadata with a representative member-admin
  context, not a tenant-user response. Selection, primary labels, relationship
  configuration, distinct values, equality filters, save and reopen passed.
  Authentication resolution and form persistence were fixture-controlled;
  this is not a live BNMS authenticated or database-persistence test.
- Screenshot: `screenshots/task4378-member-admin-discovery.png`.
- Application workflow started successfully. Unauthenticated default preview
  still reports Tenant not found and cannot verify BNMS. Existing broad workflow
  logs also contain unrelated payment-quote, reserved-slug and form-access
  source-assertion failures; the focused suites above passed.
- Independent backend review approved with no blockers. No production forms,
  roles, grants, records or deployments were changed.