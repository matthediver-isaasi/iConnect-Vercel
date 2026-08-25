# Custom Objects

**Author:** Replit Agent  
**Last Updated:** August 2026  
**Module:** Admin Data / Custom Objects

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Supported Field Matrix](#supported-field-matrix)
4. [API and Service Contracts](#api-and-service-contracts)
5. [Lifecycle, Archive, and Audit Guarantees](#lifecycle-archive-and-audit-guarantees)
6. [Relationships](#relationships)
7. [Security and Tenant Boundaries](#security-and-tenant-boundaries)
8. [Code Paths and Entry Points](#code-paths-and-entry-points)
9. [Safeguards and Error Handling](#safeguards-and-error-handling)
10. [Frontend UI](#frontend-ui)
11. [Database Tables](#database-tables)
12. [Data Flow Diagrams](#data-flow-diagrams)
13. [MVP Limitations and Phase 2 Handoff Contracts](#mvp-limitations-and-phase-2-handoff-contracts)
14. [Configuration Reference](#configuration-reference)
15. [Troubleshooting](#troubleshooting)

---

## Overview

Custom Objects let each tenant define metadata, fields, records, permissions, and relationships for new business entities without adding tenant-specific application code or database tables. All object kinds share one definition store, one JSONB record store, one relationship engine, and one generic API and UI.

The core design principle is **metadata-driven behavior**. “Department” and “Region” are maintained acceptance scenarios, not architectural concepts: their labels and keys are ordinary tenant data. A new “Practice”, “Chapter”, or “Project” follows exactly the same paths. Production code must not add example-specific branches, components, tables, or routes.

Administrators configure draft schemas, select a primary display field, activate objects, manage typed records, and define relationships to Members, Organisations, Organisation Groups, or other Custom Objects. Normal deletion is archival so historic records and audit history remain available.

---

## Architecture

### Key Files

| File | Purpose |
|------|---------|
| `api/_lib/customObjectDomain.js` | Field coercion, schema/record/relationship validation, lifecycle, permissions, display labels, and audit payloads |
| `api/_lib/customObjectService.js` | Tenant-scoped schema, record, relationship, picker, permission, and audit operations |
| `api/_lib/customObjectRoute.js` | Authentication, feature authorization, generic dispatch, and HTTP errors |
| `api/custom-objects/index.js` | Object collection route |
| `api/custom-objects/[objectId].js` | Object item route |
| `api/custom-objects/[objectId]/[resource].js` | Generic nested collection route |
| `api/custom-objects/[objectId]/[resource]/[resourceId].js` | Generic nested item route |
| `client/src/pages/CustomObjectsAdmin.jsx` | Catalogue and schema administration |
| `client/src/pages/CustomObjectRecords.jsx` | Generated record list, detail, form, and permission editor |
| `client/src/pages/customObjects/RelationshipDefinitions.jsx` | Generic relationship-definition editor |
| `client/src/pages/customObjects/RelatedRecordsPanel.jsx` | Definition-driven related-record UI |
| `supabase/migrations/20260825_custom_object_foundation.sql` | Generic storage, constraints, RLS, audit triggers, and cardinality guard |
| `supabase/migrations/20260826_custom_object_relationship_runtime.sql` | Required-edge and archive propagation guarantees |

### Design Principles

1. **Shared storage:** every tenant-defined type uses the same platform tables, preventing schema proliferation.
2. **Stable identity:** object keys, field keys, UUIDs, and relationship keys are integration identifiers; labels may change.
3. **Server authority:** tenant, actor, timestamps, endpoint kinds, and object ownership are derived and checked server-side.
4. **Deny by default:** non-administrators need explicit object capabilities and schema features.
5. **Conservative lifecycle:** archive replaces normal hard deletion and archived objects are terminal.
6. **Bounded queries:** list/search/filter/picker work is database-side and paginated.
7. **Definition-driven relationships:** one canonical edge can be presented from either endpoint using source/target labels and visibility/edit flags.

---

## Supported Field Matrix

Fields reuse `preference_field` with `entity_scope = custom_object`. All incoming record keys must correspond to active fields; typed values are stored in `custom_object_record.data`.

| Type | Stored shape | Validation / behavior | Filter support |
|------|--------------|-----------------------|----------------|
| `text` | string | Length limits | contains, equals, empty/not empty |
| `textarea` | string | Length limits | contains, equals, empty/not empty |
| `email` | string | Email syntax | contains, equals, empty/not empty |
| `url` | string | HTTP/HTTPS only | contains, equals, empty/not empty |
| `date` | `YYYY-MM-DD` string | Real calendar date | equals, greater/equal, less/equal |
| `boolean` | boolean | Existing Yes/No coercion | equals |
| `number` | integer | Finite whole number | equals, greater/equal, less/equal |
| `decimal` | number | Finite number | equals, greater/equal, less/equal |
| `picklist` | string array | Values must be configured options; selection limits | any/none of |
| `dropdown` | string | Value must be a configured option | any/none of |
| `country` | ISO-2 string | Canonical configured country | any/none of |
| `countries` | ISO-2 string array | Canonical configured countries; selection limits | any/none of |
| `list` | string array | Selection limits | any/none of |
| `file` | file reference or array | Requires allowed file categories; optional public-access metadata | not filterable |

Required fields are enforced on create. On edit, a required field is enforced when the record already carries that key or the update explicitly supplies it; historic rows created before a field became required can therefore still be edited without a forced backfill. A schema change does not erase inactive or unknown historic JSON keys during read. Search covers active text, textarea, email, URL, dropdown, and country fields. File data is a reference; this module does not implement a separate upload transport.

---

## API and Service Contracts

### Generic routes

| Method and route | Contract |
|------------------|----------|
| `GET/POST /api/custom-objects` | List or create definitions |
| `GET/PATCH/DELETE /api/custom-objects/{objectId}` | Read, update, or archive a definition |
| `GET/POST /api/custom-objects/{objectId}/fields` | List or create fields |
| `PATCH/DELETE .../fields/{fieldId}` | Update or deactivate a field |
| `GET/POST .../records` | List or create records |
| `GET/PATCH/DELETE .../records/{recordId}` | Read, update, or archive a record |
| `GET/POST .../relationship-definitions` | List or create definitions |
| `PATCH/DELETE .../relationship-definitions/{id}` | Update or archive a definition |
| `GET/POST .../relationships` | List or create canonical edges |
| `DELETE .../relationships/{edgeId}` | Archive an edge |
| `GET .../entity-picker` | Search the endpoint derived from definition and side |
| `GET/POST/PUT .../permissions` | List or upsert role grants |
| `GET .../audit` | List scoped audit events |
| `GET/POST /api/custom-objects/core/...` | Generic Core Object relationship adapters |

There are no `/api/departments` or `/api/regions` families. IDs in paths identify metadata; keys and labels never select code.

### Pagination envelope

All paginated catalogue, field, record, relationship, picker, permission, and audit reads return:

```json
{
  "data": [],
  "total": 0,
  "page": 1,
  "pageSize": 25
}
```

`page` defaults to 1. `pageSize` defaults to 25, is at least 1, and is capped at 100. `total` is the count before the requested range. Non-paginated discovery responses use `{ "data": [] }`; item and mutation responses return the resource directly. Errors use `{ "error": "message" }` and may include `details`.

Record lists accept `search`, `sortField`, `sortDir`, `filters`, `page`, `pageSize`, and `includeArchived`. Filters are keyed by field UUID, never by caller-provided JSON paths. Relationship list/picker requests must identify `definitionId`, `recordId`, and the routed `side` where required. Endpoint kind and target object are derived from the relationship definition.

---

## Lifecycle, Archive, and Audit Guarantees

### Object lifecycle

```text
draft → active → archived
```

- Creation always starts in `draft`.
- Activation requires a valid, active primary display field belonging to the same tenant and object.
- Active objects cannot return to draft.
- Archived objects cannot be reactivated or mutated.
- Archived objects remain retrievable to authorized users, but create/edit capabilities are disabled.

Object, record, definition, and edge archive operations are idempotent where the service contract permits. Records are not hard-deleted. Archiving a record archives its active edges; archiving a relationship definition archives its edges; archiving an object archives relationship definitions that reference it. Required relationship rules prevent removal of the final required edge.

Audit rows are server-authored for schema, record, permission, and relationship mutations. They carry tenant, actor, action, entity IDs, related object/record/relationship IDs, and before/after data where applicable. Callers cannot choose the authoritative actor, timestamp, or tenant. Audit reads are tenant- and object-scoped and do not themselves emit audit events.

---

## Relationships

Supported endpoint kinds are `member`, `organization`, `organization_group`, and `custom_object`. Supported cardinalities are `one_to_one`, `one_to_many`, `many_to_one`, and `many_to_many`.

A relationship definition owns source/target kinds, optional Custom Object IDs, cardinality, labels, required state, visibility from each side, editability from each side, lifecycle, and extensible configuration. One edge stores one source ID and one target ID. The same edge is queried from either side; the routed side determines the opposite endpoint and presentation label.

### Maintained acceptance scenarios

**Department** validates generic Custom Object → Core Object and generated-record behavior. **Region → Department** validates Custom Object → Custom Object behavior:

```text
Region "North West"
  → definition cardinality: one_to_many
    → Department "Radiology"
```

“Departments” on the Region and “Region” on the Department come from the two labels on one definition. They do not justify special React components, SQL tables, API routes, or conditional branches.

Cardinality is enforced atomically in the database under an advisory transaction lock. Active pair uniqueness rejects duplicate edges. `one_to_one` limits both source and target; `one_to_many` limits reuse of a target; `many_to_one` limits reuse of a source; `many_to_many` limits only duplicate pairs. All endpoint rows must exist, be active, match the declared kind/object, and belong to the tenant.

---

## Security and Tenant Boundaries

1. The route obtains authenticated tenant context before constructing the service.
2. Browser-supplied tenant and actor fields are ignored in favor of context.
3. Every definition, field, record, permission, audit, and edge query is scoped by `tenant_id`.
4. Composite tenant foreign keys prevent cross-tenant references.
5. Object/field/record IDs are additionally checked against their owning object.
6. Schema viewing uses `data.custom-objects`; schema mutation uses `data.custom-objects.manage-data-model`.
7. Per-object grants cover view, create, edit, archive, and export; grants deny by default and non-view capabilities also require view.
8. Member feature exclusions override broad role/admin access. Trusted tenant users and tenant administrators follow the documented bypass rules.
9. Public custom-field and form-prefill routes exclude `entity_scope = custom_object`; Custom Object APIs are authenticated, non-public routes.
10. Picker endpoint types are definition-derived, preventing arbitrary table selection.

Cross-tenant resources are deliberately indistinguishable from missing resources where appropriate. RLS and grants restrict direct table access; the service remains responsible for application-level permission and object checks.

---

## Code Paths and Entry Points

### Schema mutation

**File:** `api/_lib/customObjectRoute.js` → `createCustomObjectRouteHandler()`  
**Trigger:** An authenticated schema POST, PATCH, or DELETE.

1. Resolve authentication and tenant context.
2. Resolve view/manage feature access and member exclusions.
3. Construct `createCustomObjectService()` with trusted context.
4. Validate lifecycle, ownership, immutable keys, and metadata.
5. Write through generic tables; database triggers emit audit history.

### Record mutation

1. Resolve the object in the current tenant and require its capability.
2. Require active status for create/edit.
3. Load active and historic field definitions.
4. Coerce and validate typed JSON data.
5. Add server-authored identity/timestamps and persist the generic record.

### Relationship mutation

1. Resolve the definition and routed side.
2. Check visibility/editability and capabilities on all Custom Object endpoints.
3. Resolve endpoint rows by declared kind and tenant.
4. Validate endpoint kind, object ownership, active state, and tenant.
5. Insert/archive the canonical edge; database guards enforce concurrency-safe cardinality.

---

## Safeguards and Error Handling

### Immutable keys

Object and field internal keys cannot change after creation. Duplicate object, field, relationship, or active edge keys map database uniqueness failures to HTTP 409.

### Schema and endpoint validity

Invalid field metadata, unknown incoming record keys, malformed filters, inactive targets, endpoint mismatches, and cross-tenant references are rejected before useful data is returned. Invalid input is HTTP 400; unavailable lifecycle state is generally 409; missing permission is 403.

### Archive integrity

Database triggers propagate archives so active relationships are not silently orphaned. The relationship archive RPC serializes removals and performs the final-edge required check in the same transaction.

### Public disclosure

Public preference-value routes first build a tenant-scoped allowlist excluding Custom Object fields, then constrain value reads to those IDs. Regression coverage lives in `api/_lib/publicCustomObjectDisclosure.test.mjs`; generic route registration and authentication are covered by `api/_lib/customObjectGenericAcceptance.test.mjs`.

---

## Frontend UI

`CustomObjectsAdmin.jsx` shows the tenant catalogue and generated schema controls. `CustomObjectRecords.jsx` renders lists, add/edit forms, details, archive actions, and permissions from object and field metadata. Relationship panels and pickers derive labels, endpoint kinds, visibility, and edit controls from definitions.

| Mutation | Endpoint | Purpose |
|----------|----------|---------|
| POST/PATCH/DELETE object | `/api/custom-objects/...` | Create, configure, archive |
| POST/PATCH/DELETE field | `.../fields/...` | Create, configure, deactivate |
| POST/PATCH/DELETE record | `.../records/...` | Create, edit, archive |
| POST/PATCH/DELETE relationship definition | `.../relationship-definitions/...` | Configure or archive |
| POST/DELETE relationship | `.../relationships/...` | Add or archive an edge |
| POST/PUT permission | `.../permissions` | Upsert role capabilities |

React Query keys are object-ID based (`custom-objects`, object, fields, records, relationship definitions/rows). Mutations invalidate the affected catalogue/detail/resource keys so counts and related panels refresh. No cache key depends on “Department” or “Region”.

---

## Database Tables

| Table | Key data | Purpose |
|-------|----------|---------|
| `custom_object_definition` | tenant, key, labels, primary field, status, configuration, authored/archive fields | Object metadata |
| `preference_field` | tenant, `custom_object_id`, `entity_scope`, key, type, validation/display settings | Reused field metadata |
| `custom_object_record` | tenant, object ID, JSONB data, authored/archive fields | Generic records |
| `custom_object_relationship_definition` | tenant, endpoint kinds/object IDs, cardinality, labels, flags, status | Relationship metadata |
| `custom_object_relationship` | tenant, definition ID, source/target record IDs, authored/archive fields | Canonical edges |
| `custom_object_role_permission` | tenant, object, role, five capability booleans | Per-object grants |
| `custom_object_audit_event` | tenant, actor/action/entity IDs, before/after JSONB, metadata, timestamp | Immutable audit history |

All high-value lookup paths have tenant-leading indexes. Relationship definitions and edges use composite tenant foreign keys; records and fields are similarly bound to their owning object.

---

## Data Flow Diagrams

```text
Create Department metadata (acceptance example)
  → generic object definition in draft
    → generic fields validated
      → primary display field selected
        → object activated
          → typed generic record created
```

```text
Open Region "North West"
  → load definitions where Region is source or target
    → apply show_on_source and source label
      → query canonical edges by tenant + definition + Region record
        → resolve opposite Department endpoints
          → display "Departments: Radiology"
```

---

## MVP Limitations and Phase 2 Handoff Contracts

The MVP provides generic schema/record CRUD, generated forms, search, typed field filters, sorting, pagination, permissions, archive/audit behavior, generic pickers, and Core/Custom Object relationships. It does **not** provide CSV import/export workflows, persisted saved views, cross-relationship query composition, FormBuilder controls, reporting datasets, or communications segmentation.

Phase 2 must consume stable generic contracts rather than inspect JSON or add example-specific code:

| Integration | Handoff contract |
|-------------|------------------|
| CSV import | Address object by UUID; fetch field metadata; map columns to immutable field keys/IDs; validate through the same typed record service; resolve relationships by controlled IDs; return row-level validation and summary results |
| CSV export | Require `export_records`; preserve tenant/object scope; consume the same filter/sort/view specification; emit labels for headers while retaining stable metadata mapping |
| Saved views | Persist object UUID, visible field UUIDs/order, sort, and the existing field-ID-keyed filter grammar; tolerate archived fields without rewriting record data |
| Advanced relationship filtering | Express predicates with relationship-definition UUID, routed side, endpoint field UUID/operator/value, and bounded traversal depth; preserve tenant and capability checks at every hop |
| FormBuilder | Use object/field/relationship UUIDs and metadata snapshots; lookup uses the generic picker envelope; create/update submits to generic record services and never writes JSONB directly |
| Reporting | Discover schemas by object UUID; expose typed field metadata and relationship-definition IDs; apply tenant/permission scope and server-side pagination/aggregation |
| Communications | Store segmentation predicates by object/relationship/field IDs; resolve recipients through permission-aware relationship traversal; never copy Department/Region assumptions into campaign code |

**Compatibility rule:** immutable IDs and keys, field types, lifecycle states, cardinalities, capability names, filter grammar, and pagination envelopes are Phase 2 contracts. Extensions belong in versioned configuration or additive response fields. Consumers must ignore unknown additive fields and must not rely on labels as identifiers.

---

## Configuration Reference

| Setting | Location | Values | Default | Description |
|---------|----------|--------|---------|-------------|
| Object status | definition | draft, active, archived | draft | Object lifecycle |
| Relationship status | relationship definition | draft, active, archived | draft | Definition lifecycle |
| Cardinality | relationship definition | four supported cardinalities | required input | Edge uniqueness semantics |
| Visibility/editability | relationship definition | boolean per side | show both; edit source | Related-record UI behavior |
| Pagination | query | page ≥ 1, pageSize 1–100 | 1 / 25 | Server-side range |
| Include archived | query | `"true"` or omitted | omitted | Include archived resources |
| Record capabilities | role permission | five booleans | false | Per-object authorization |

---

## Troubleshooting

### Problem: Object cannot be activated
**Symptom:** Activation returns HTTP 400.  
**Cause:** The primary display field is missing, inactive, invalid, cross-tenant, or belongs to another object.  
**Fix:** Select a valid active field on this draft object.

### Problem: Related record is missing
**Symptom:** Picker omits it or relationship read reports an unavailable endpoint.  
**Cause:** The endpoint is archived, outside the tenant/object, hidden, or inaccessible to the current role.  
**Fix:** Check definition side, endpoint lifecycle, object grant, and tenant ownership.

### Problem: Relationship creation returns conflict
**Symptom:** HTTP 409 mentions duplicate or cardinality.  
**Cause:** The active pair already exists or one side exceeds the configured cardinality.  
**Fix:** Reuse the existing edge, archive/replace it safely, or correct the definition.

### Problem: Historic field value appears but cannot be edited
**Symptom:** Read retains a key that write rejects.  
**Cause:** The field was archived or removed from active metadata; historic data is intentionally preserved.  
**Fix:** Reactivate/configure the field or omit the historic key while satisfying current required fields.