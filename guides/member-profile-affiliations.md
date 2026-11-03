# Member Profile Affiliations

**Author:** Replit Agent
**Last Updated:** November 2026
**Module:** Member Preferences / Custom Objects

---

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Configuration](#configuration)
4. [Replacement and recovery](#replacement-and-recovery)
5. [Safeguards](#safeguards)
6. [Frontend UI](#frontend-ui)
7. [Database tables](#database-tables)
8. [Data flow](#data-flow)
9. [Verification and rollout](#verification-and-rollout)
10. [Troubleshooting](#troubleshooting)

## Overview

An administrator can explicitly enable existing-record affiliation editing on
`/about-me` through `/PreferenceSettings`. It is off by default. Members may
change their primary organisation, configured secondary assignments and ordinary
department links. They cannot create or edit shared organisations/departments,
edit edge metadata, or grant respondent access.

The profile transaction is independent of renewal forms, submissions and Due
Diligence. It reuses the read-only affiliation graph representation, not the form
write boundary. Ordinary profile fields retain their existing save mechanism.
Existing organisation-based access, session revocation, automatic groups and
billing rules are not replaced: changing the primary organisation still has the
consequences those existing policies specify.

## Architecture

| File | Purpose |
|---|---|
| `api/member-affiliation-settings.js` | Administrator-only policy discovery/save |
| `api/member-affiliations.js` | Session-derived member snapshot, search and save |
| `api/_lib/profileAffiliationPolicy.js` | Supported bindings, immutable signature, strict proposal validation |
| `api/_lib/profileAffiliations.js` | Live validation and minimal snapshot projection |
| `api/_lib/profileAffiliationEntityBoundary.js` | Generic member mutation guard |
| `api/_lib/serverOwnedEntityBoundary.js` | Denies generic access to policy and audit tables |
| `api/entities/[entity]/{index,[id]}.js` | Invokes generic member mutation guard |
| `client/src/components/MemberAffiliations.jsx` | Independent draft/review/retry UI |
| `client/src/components/MemberAffiliationSettings.jsx` | Administrative configuration UI |
| `client/src/pages/{Preferences,PreferenceSettings}.jsx` | Existing-page integration |
| `supabase/migrations/20261103_profile_member_affiliations.sql` | Private policy, operations and atomic RPCs |
| `scripts/profile-affiliations.postgres.test.mjs` | Isolated PostgreSQL fixtures |
| `api/_lib/profileAffiliationPolicy.test.mjs` | Policy and generic bypass regressions |
| `api/member-affiliations.test.mjs` | HTTP authority/disabled-setting contracts |
| `client/src/components/MemberAffiliations.mounted.test.mjs` | Mounted member/admin UI contracts |
| `tests/about-me-profile-save.spec.mjs` | Actual page browser regressions with blocked external traffic |

Design principles:
1. Session identity owns the write; browser-supplied member/tenant IDs are rejected.
2. Explicit replacements own removals; omitted fields preserve the current set.
3. All affiliation mutations commit in one transaction, including the audit record.
4. Unsupported graphs fail closed instead of guessing or changing shared records.

## Configuration

| Setting | Values | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | false | Explicit tenant opt-in |
| `memberDepartmentDefinitionId` | definition UUID | null | Many-to-many member/department link |
| `departmentOrganizationDefinitionId` | definition UUID | null | Exactly one owning organisation per department |
| `secondaryMemberDefinitionId` | definition UUID | null | Optional assignment/member bridge |
| `secondaryOrganizationDefinitionId` | definition UUID | null | Required with the other secondary binding |
| `secondaryLabelFieldId` | text-field UUID | null | Optional label for newly created member-owned assignments |
| `bindingSignature` | server-generated string | absent | Pins endpoint, scope, cardinality and field meaning |
| `version` | monotonically increasing integer | 0 before first save | Settings concurrency token |

Selectors display the definition sides. Either orientation is supported, but the
department object must be the same on both direct bindings. The secondary object
must be distinct, with one member and one organisation per assignment. Additional
required assignment fields and secondary edge metadata are unsupported.

Department picker scope, when configured, must exactly represent direct ownership
intersected with primary plus the configured secondary bridge. Arbitrary graph
paths are not opened. Boolean department-edge defaults must be false. Definitions
must be active and have active display fields. A semantic schema change requires
an administrator to review and resave the configuration.

## Replacement and recovery

```text
Verify session member and tenant
  → Validate enabled policy and pinned binding semantics
  → Capture private complete graph + role/schema snapshot
  → Member edits proposed primary + secondary + departments
  → Review explicit clears/removals
  → Lock graph, schema, policy and member
  → Compare snapshot, expiry, policy version and permissions
  → Preserve grandfathered and unchanged edges
  → Archive explicitly removed ordinary links
  → Reconcile member-owned assignment bridges
  → Change primary; add eligible departments with false metadata
  → Verify legacy triggers did not alter retained edges
  → Commit operation/audit and return confirmed result
```

Searches use stable ordering, literal substring matching and pages of 25 rows.
Department results are qualified by owning organisation and evaluated against the
proposed primary/secondary set, not just the original primary.

A two-hour snapshot is also the idempotency token. Identical retries return the
committed result without reapplying a historical proposal. Different retry
payloads are rejected. Revoked settings and permissions still deny retries.
An unconfirmed response leaves the draft intact. A stale draft requires explicit
discard/reload; it is never automatically rebased onto new links.

## Safeguards

### Member and tenant isolation

The endpoint compares `session.data.memberId` with the authenticated member and
tenant context. Every SQL operation binds all of `tenant_id`, `member_id`, and
the private token. Generic member writes cannot set `organization_id` unless the
caller has administrator access.

### Protected and grandfathered links

Existing metadata is never rewritten. A non-false/non-null edge metadata value
protects its removal. New department links explicitly write false boolean values;
historically protected archived pairs cannot be recreated by the member.

Out-of-scope historical links are retained. A previously valid link made invalid
by the proposal must be explicitly removed; protected cases need administrator
assistance. Secondary assignments with shared ownership, ambiguous owners or
unrelated edges cannot be silently disposed of.

### Private database authority

New policy/operation tables have RLS and no browser grants. Only dedicated
service-role functions can write them. Graph/record browser DML is revoked and
guarded against surviving column-level grants. Direct browser primary changes
are denied; normal profile fields are unaffected. Existing form and administrative
services remain service-role writers.

### Role restrictions and rollback

Restrictive organisation/member field permissions deny editing. Hidden display
field permissions deny label access. Role/schema snapshots and locks prevent a
permission/schema race from silently applying an earlier draft. Any SQL exception
rolls back primary, bridge, department and audit writes together.

## Frontend UI

The affiliation card is separate from the existing profile save. Organisation
changes never clear departments automatically. Protected links have no removal
button. Explicit removal confirmation is required in the review dialog.
Failed loads do not expose an empty editable set. Cancel performs no writes.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/member-affiliation-settings` | GET / PUT | Admin discovery and versioned configuration |
| `/api/member-affiliations` | GET | Snapshot; disabled returns `{active:false}` |
| `/api/member-affiliations` | POST | Bounded choice search, not a mutation |
| `/api/member-affiliations` | PATCH | Atomic explicit proposal |

After confirmation the component reloads its snapshot, invalidates organisation,
member-department and exact profile queries, then merges only confirmed
organisation identity into the cached session. Existing field-wise reconciliation
preserves unrelated unsaved profile inputs.

## Database tables

### `profile_affiliation_policy`
| Column | Type | Meaning |
|---|---|---|
| `tenant_id` | uuid PK | Exactly one policy per tenant |
| `version` | bigint | First-insert and update CAS |
| `config` | jsonb | Explicit enablement and pinned bindings |
| `updated_at` | timestamptz | Last administrative save |

### `profile_affiliation_operation`
| Column | Type | Meaning |
|---|---|---|
| `id` | uuid PK | Private snapshot/idempotency token |
| `tenant_id`, `member_id` | uuid | Immutable owner binding |
| `policy_version`, `config` | bigint, jsonb | Captured policy |
| `snapshot` | jsonb | Complete graph, schema and role evidence |
| `request`, `result` | jsonb | Committed proposal and confirmation |
| `created_at`, `expires_at`, `committed_at` | timestamptz | Snapshot lifetime and audit stamp |

These rows contain private affiliation evidence and are not a public log.

## Data flow

```text
PreferenceSettings → admin API → singleton policy
about-me → own-member API → private graph snapshot
Draft → bounded choices (read only)
Reviewed proposal → profile RPC → member + bridge + edges + operation
Confirmed response → refreshed snapshot + narrow identity/cache reconciliation
```

## Verification and rollout

Read-only destination inspection on 3 November 2026 confirmed graph-scope
constraint triggers and relationship-field defaults were deployed. The historical
primary-only cleanup functions were absent. BNMS's member-department definition
had `survey_respondent` with false default, and the scope combined the primary core
field with a two-edge secondary path. A historical relationship key named
`assignment_organisation` did **not** identify an organisation endpoint; choose
definitions by endpoint identity and scope, never by name alone.

The migration was exercised in isolated PostgreSQL with BNMS-shaped and reversed
generic fixtures; no live member/tenant rows were changed. Apply the reviewed
migration through the normal destination deployment process before configuring
any tenant. It depends on the existing read-only
`form_member_affiliation_graph(uuid,uuid)` helper from the form snapshot migration.
The migration itself creates no enabled policy.

Browser tests intercept all API/provider traffic. They verify the actual page,
but are not a live authenticated BNMS session. The unauthenticated workspace
preview cannot verify signed-in rendering against the destination database.

## Troubleshooting

- **Settings unavailable:** confirm migration prerequisites and database target;
  failures must not be treated as enabled or as an empty current set.
- **Definitions changed:** administrator reviews endpoints, scopes and labels and
  saves settings again; members then reload.
- **Protected link conflict:** administrator reconciles respondent permissions;
  do not clear metadata to make a member save pass.
- **Stale snapshot:** explicitly discard/reload and review again.
- **Legacy cleanup changed retained links:** transaction has rolled back; inspect
  deployed triggers rather than disabling the retained-edge check.
- **Unconfirmed network response:** retry the unchanged draft/token first.
  Never submit a different proposal under an already committed token.
