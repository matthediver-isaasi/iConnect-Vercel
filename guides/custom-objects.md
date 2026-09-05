# Custom Objects

**Author:** Replit Agent  
**Last Updated:** September 2026
**Module:** Admin Data / Custom Objects

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Supported Field Matrix](#supported-field-matrix)
4. [API and Service Contracts](#api-and-service-contracts)
5. [Presentation and Field Authorization Contracts](#presentation-and-field-authorization-contracts)
6. [Lifecycle, Archive, and Audit Guarantees](#lifecycle-archive-and-audit-guarantees)
7. [Relationships](#relationships)
8. [Portal Destinations and Chained Navigation](#portal-destinations-and-chained-navigation)
9. [Security and Tenant Boundaries](#security-and-tenant-boundaries)
10. [Code Paths and Entry Points](#code-paths-and-entry-points)
11. [Safeguards and Error Handling](#safeguards-and-error-handling)
12. [Frontend UI](#frontend-ui)
13. [Database Tables](#database-tables)
14. [Data Flow Diagrams](#data-flow-diagrams)
15. [MVP Limitations and Phase 2 Handoff Contracts](#mvp-limitations-and-phase-2-handoff-contracts)
16. [Configuration Reference](#configuration-reference)
17. [Troubleshooting](#troubleshooting)

---

## Overview

Custom Objects let each tenant define metadata, fields, records, permissions, and relationships for new business entities without adding tenant-specific application code or database tables. All object kinds share one definition store, one JSONB record store, one relationship engine, and one generic API and UI.

The core design principle is **metadata-driven behavior**. “Department” and “Region” are maintained acceptance scenarios, not architectural concepts: their labels and keys are ordinary tenant data. A new “Practice”, “Chapter”, or “Project” follows exactly the same paths. Production code must not add example-specific branches, components, tables, or routes.

Administrators configure draft schemas, select a primary display field, activate
objects, manage typed records, and define relationships to Members,
Organisations, Organisation Groups, or other Custom Objects. Generated CRM lists
can present and query authorized relationship-backed columns alongside ordinary
fields, with matching server-side pagination, totals, and export output. Normal
deletion is archival so historic records and audit history remain available.

---

## Architecture

### Key Files

| File | Purpose |
|------|---------|
| `api/_lib/customObjectDomain.js` | Field coercion, schema/record/relationship validation, lifecycle, permissions, display labels, and audit payloads |
| `api/_lib/customObjectService.js` | Tenant-scoped schema, record, relationship, picker, permission, and audit operations |
| `api/_lib/customObjectRoute.js` | Authentication, feature authorization, generic dispatch, and HTTP errors |
| `api/_lib/formRelationshipOptions.js` | Form-scoped relationship discovery, dependent-option resolution, and submitted-value validation |
| `api/_lib/organizationEligibility.js` | Shared organisation-dropdown filter eligibility used by list and relationship option APIs |
| `api/_lib/relationshipDisplayLabels.js` | Tenant-scoped active-record label lookup for submission output |
| `api/custom-objects/index.js` | Object collection route |
| `api/custom-objects/[objectId].js` | Object item route |
| `api/custom-objects/[objectId]/[resource].js` | Generic nested collection route |
| `api/custom-objects/[objectId]/[resource]/[resourceId].js` | Generic nested item route |
| `client/src/pages/CustomObjectsAdmin.jsx` | Catalogue and schema administration |
| `client/src/pages/CustomObjectRecords.jsx` | Generated record list, detail, form, and permission editor |
| `client/src/pages/customObjects/RelationshipDefinitions.jsx` | Generic relationship-definition editor, including compact previews |
| `client/src/pages/customObjects/RelatedRecordsPanel.jsx` | Definition-driven related-record UI |
| `client/src/pages/customObjects/relationshipHelpers.js` | Relationship-side resolution and safe chained-navigation return paths |
| `client/src/pages/customObjects/recordHelpers.js` | Client layout reconciliation, visibility evaluation, field access, and generated-record helpers |
| `client/src/pages/customObjects/recordListHelpers.mjs` | Unified CRM list reducer, metadata normalization, saved-column reconciliation, and relationship-cell formatting |
| `client/src/hooks/useSavedListViews.js` | Member-scoped named/default list-view persistence, including ordered column state |
| `client/src/pages/customObjects/ContextualRecordCreateDialog.jsx` | Metadata-driven form for creating and linking an opposite Custom Object record in context |
| `client/src/pages/customObjects/RecordFieldControls.jsx` | Shared generated controls used by normal and contextual record creation |
| `client/src/pages/FormBuilder.jsx` | Relationship-dropdown configuration against earlier organisation fields |
| `client/src/components/forms/FormRenderer.jsx` | Shared dependent relationship dropdown used by public, embedded, preview, and manual forms |
| `client/src/lib/formRelationshipDropdown.js` | Pure builder and stale-selection rules |
| `client/src/lib/relationshipDisplayLabels.js` | Safe relationship-value formatting for review and export surfaces |
| `client/src/lib/portalMenuLinks.js` | Portal-menu Custom Object destinations and per-object access identifiers |
| `shared/portalMenuLinks.js` | Canonical Custom Object portal URL/access-ID parsing and external-link validation |
| `supabase/migrations/20260825_custom_object_foundation.sql` | Generic storage, constraints, RLS, audit triggers, and cardinality guard |
| `supabase/migrations/20260826_custom_object_relationship_runtime.sql` | Required-edge and archive propagation guarantees |
| `supabase/migrations/20260925_custom_object_record_relationship_create.sql` | Atomic record-plus-initial-relationships transaction |
| `supabase/migrations/20260928_custom_object_relationship_list_rpc.sql` | Authoritative relationship filtering/sorting/paging plus bounded per-page label projection |
| `supabase/migrations/20260924_bnms_department_type_normalization.sql` | Pinned, idempotent BNMS Department Type schema setup |
| `scripts/import-bnms-organisation-hierarchy.mjs` | Dry-run-first BNMS Department Type classification and preservation verification |

### Design Principles

1. **Shared storage:** every tenant-defined type uses the same platform tables, preventing schema proliferation.
2. **Stable identity:** object keys, field keys, UUIDs, and relationship keys are integration identifiers; labels may change.
3. **Server authority:** tenant, actor, timestamps, endpoint kinds, and object ownership are derived and checked server-side.
4. **Deny by default:** non-administrators need explicit object capabilities and schema features.
5. **Conservative lifecycle:** archive replaces normal hard deletion and archived objects are terminal.
6. **Bounded queries:** list/search/filter/picker work is database-side and paginated.
7. **Definition-driven relationships:** one canonical edge can be presented from either endpoint using source/target labels and visibility/edit flags.
8. **List/export parity:** the interactive CRM list and CSV export use one
   authorized query state and server plan, preventing page-local joins,
   divergent filters, and partial totals.

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
| `GET .../export` | Export bounded pages from the same authorized CRM list query |
| `GET/PATCH/DELETE .../records/{recordId}` | Read, update, or archive a record |
| `GET/POST .../relationship-definitions` | List or create definitions |
| `PATCH/DELETE .../relationship-definitions/{id}` | Update or archive a definition |
| `GET/POST .../relationships` | List or create canonical edges |
| `DELETE .../relationships/{edgeId}` | Archive an edge |
| `GET .../entity-picker` | Search the endpoint derived from definition and side |
| `GET .../initial-relationship-candidates` | Search eligible opposite endpoints before the new record exists |
| `GET .../relationship-filter-options` | Search the permission-pruned opposite endpoint for one authorized CRM relationship filter |
| `GET/POST/PUT .../permissions` | List or upsert role grants |
| `GET .../audit` | List scoped audit events |
| `GET/POST /api/custom-objects/core/...` | Generic Core Object relationship adapters |
| `GET /api/forms/{formId}/relationship-definitions` | Admin discovery of active Organisation-to-Custom-Object relationships eligible for a form field |
| `GET /api/public/form/{slug}/relationship-options` | Form-scoped active related-record options for one saved field and selected organisation |
| `POST /api/admin/relationship-display-labels` | Authorized, submission-scoped batch labels for stored relationship record IDs |

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

Record lists accept `search`, `sortField`, `sortDir`, `filters`, `page`,
`pageSize`, and `includeArchived`. The CRM list state may also select configured
relationship-backed columns and relationship predicates by stable relationship
definition ID and routed side. Field filters are keyed by field UUID, never by
caller-provided JSON paths. Relationship list/picker requests must identify
`definitionId`, `recordId`, and the routed `side` where required. Endpoint kind
and target object are always derived from the relationship definition.

The record-list service owns relationship filtering, sorting, value resolution,
pagination, and totals. It applies every scalar and relationship predicate
before the database range and returns the exact count for that same authorized
query. The browser must not fetch one record page and then join, filter, sort, or
recount relationships locally: doing so produces incomplete pages and incorrect
totals.

The export endpoint consumes the same normalized CRM list state and query plan
as the interactive list. Export changes only the requested page size/page
iteration; it does not silently drop relationship filters, substitute the shared
default columns, or broaden the caller's field/relationship access. Consequently
the concatenated export pages describe exactly the same filtered and sorted row
set as the list, with the same authorized column order and formatted
relationship values.

`POST .../records` also accepts a transactional contextual-create shape:

```json
{
  "data": {
    "name": "Example record"
  },
  "originating_relationship": {
    "relationship_definition_id": "definition-uuid",
    "routed_side": "source",
    "related_record_id": "existing-origin-uuid"
  },
  "initial_relationships": [
    {
      "relationship_definition_id": "other-definition-uuid",
      "routed_side": "target",
      "related_record_id": "selected-candidate-uuid"
    }
  ]
}
```

Here **routed_side** always identifies the side occupied by the new Custom Object record. The originating entry is authorized from the opposite, existing card side; additional entries are authorized from the new record side. The route selects the atomic service path only when relationship initialization is present, so ordinary record creation remains backward compatible.

---

## Presentation and Field Authorization Contracts

Task 4067 implements the **version 2 CRM detail contract**. It replaces the
outdated assumption that a detail view is only an ordered set of sections.
Presentation remains metadata, never a tenant-specific component or route; the
primary display field remains the canonical record identity used for headings,
links, and picker labels.

### Relationship-backed CRM list metadata

The CRM list contract extends the record-list response with a server-authorized inventory of
field and relationship columns. A relationship list column is metadata, not a
copied relationship value in `custom_object_record.data`. `GET .../records`
returns the normal pagination envelope plus `metadata`:

```json
{
  "metadata": {
    "fields": [{
      "id": "field-uuid-a",
      "kind": "field",
      "field_id": "field-uuid-a",
      "key": "status",
      "label": "Status",
      "field_type": "dropdown",
      "value_shape": "scalar",
      "operators": ["any_of", "none_of"],
      "filterable": true,
      "sortable": true
    }],
    "relationships": [{
      "id": "relationship:relationship-uuid:source",
      "kind": "relationship",
      "relationship_definition_id": "relationship-uuid",
      "side": "source",
      "label": "Departments",
      "cardinality": "one_to_many",
      "value_shape": "many",
      "operators": ["any_of", "none_of", "is_empty", "is_not_empty"],
      "filterable": true,
      "sortable": true,
      "endpoint": {
        "kind": "custom_object",
        "custom_object_id": "opposite-object-uuid",
        "display_field": {
          "field_id": "field-uuid-b",
          "key": "name",
          "field_type": "text"
        }
      }
    }],
    "columns": []
  }
}
```

- A field metadata item references one readable, active, scalar field belonging
  to the listed Custom Object. Its list ID is the field UUID. Multi-value fields
  use `value_shape: "array"`; files remain readable columns but advertise no
  filter operators and are not sortable.
- A relationship column references one active definition and the side occupied
  by the listed Custom Object. Its stable identity is
  `relationship:<definition-id>:<source|target>`.
- The side is mandatory for self-relationships and remains explicit for every
  other relationship, so a label or endpoint rename cannot reverse the query.
- The heading comes from the configured label for the routed side. Cell values
  come from active canonical edges and authorized opposite-endpoint display
  metadata; relationship UUIDs and raw record IDs are never display fallbacks.
- Each projected record has a `relationships` map keyed by that stable
  relationship ID. The value is `{ count, records }`; records contain only
  authorized `id`, `kind`, Custom Object ID, primary label, secondary text, and
  compact fields that the endpoint resolver permits.
- Zero matches produce `count: 0` and an empty `records` array. Multiple matches
  are ordered by primary label and then stable record ID. The UI displays at
  most three labels followed by `+N more`; it does not choose an arbitrary
  first edge.
- Relationship data is not denormalized into the record JSON, and a column does
  not create a new relationship, relax cardinality, or grant access.

`metadata.columns` is the concatenated authorized field/relationship inventory.
The client normalizer also accepts the additive aliases `list_metadata`,
`listMetadata`, `relationship_columns`, and camelCase equivalents so the
response contract can evolve safely. Legacy `views.list.field_ids` remains the
shared field-only visibility default; relationship visibility/order lives in
the member's reconciled column state or named saved view.

### Unified CRM list state and export parity

The **CRM list state** is the complete list request: search, typed field and
relationship filters, sort column/direction, archive mode, page, and page size.
Ordered column visibility, filter order, and hidden-filter choices accompany it
in the personal/saved-view snapshot. Shared object presentation supplies the
initial field visibility; `name` is locked visible and `updated_at` is initially
visible. A local preference is scoped by tenant, member, and object, while named
and default views use `useSavedListViews` with page `customObjects` and the object
ID as scope. Neither is a permission mechanism.

Relationship filters use the canonical relationship list ID in either the
unified `filters` object or `relationshipFilters`. Supported operators are
`any_of`, `none_of`, `is_empty`, and `is_not_empty`; the first two carry
opposite endpoint IDs. Relationship sort uses that same ID as `sortField` (or
`relationshipSort`), with `relationshipSortMode` equal to `label` (default) or
`count`.

Filter value search uses
`GET .../relationship-filter-options?fieldId=<stable-list-id>&search=<text>`.
The service resolves `fieldId` only from the permission-pruned list metadata;
the browser cannot choose an endpoint table or linked display field. Custom
Objects, Members, Organisations, and Organisation Groups share this route.
Results are tenant-scoped, server-searched, paginated, and projected through the
same endpoint label adapter as table cells. The optional bounded `selected`
array rehydrates readable labels for a saved filter even when those records are
outside the current search page.

```text
shared list metadata + personal column preference + URL/query controls
  → normalize one CRM list state
  → authorize and prune its fields and relationship sides
  → build one server query plan
  → apply search, filters, and sort before pagination
  → return rows + exact filtered total + effective columns
```

The records table, result count, pagination controls, and CSV export all consume
that effective state. Export calls the same list service through
`GET .../export`, repeats bounded 1,000-row requests until it reaches the
reported total, and writes only the currently visible ordered columns. It
preserves relationship-backed predicates, sort order, archive choice, field
formatting, three-label display bound, and unavailable-value policy.

**Important:** visible columns and predicates are separate. A caller may hide a
column without removing its authorized filter or sort, but cannot filter or sort
by a field/relationship side that authorization has removed. Pagination is
never part of the persisted shared default and export pagination is transport
state only.

### List authorization, fail-closed behavior, and reconciliation

The server resolves list authorization before constructing SQL or returning
column metadata:

1. Require the routed object's `view_records` capability (and
   `export_records` for export).
2. Resolve readable fields for the routed object; remove unreadable field
   columns and reject unreadable field filters/sorts.
3. Re-load every relationship definition by tenant and stable ID, verify that
   the declared side belongs to the routed object, and require that side to be
   active and visible.
4. Apply the corresponding endpoint capability checks. For an opposite Custom
   Object, require an active object plus its `view_records` capability and a
   readable active primary display field, then prune compact fields through that
   object's field grants. Relationship
   columns whose opposite endpoint is a Member, Organisation, or Organisation
   Group are advertised only to tenant administrators, matching the core
   relationship service boundary.
5. Resolve every opposite row through the existing endpoint projector, which
   omits missing/archived rows and prunes inaccessible Custom Object fields and
   secondary text.
6. Build filters, sort expressions, rows, totals, and export output only from
   the resulting allowlist.

Malformed, cross-tenant, inactive, wrong-side, or ambiguous relationship
metadata fails closed. A stale display-only column can be pruned during
reconciliation so the list remains usable. In contrast, a requested filter or
sort whose target is invalid or unauthorized is rejected rather than ignored,
because silently dropping it would broaden the result set. The service never
trusts a client-provided endpoint kind, table, JSON path, label, count, joined
value, or pre-authorized column descriptor.

Read-time reconciliation is non-destructive. `reconcileColumns()` and
`reconcileOrder()` deduplicate saved IDs, remove anything absent from the
server-authorized inventory, preserve the order/visibility of survivors, and
append newly available columns and filters with their default visibility.
`reconcileFilters()` also removes predicates whose field/relationship or
operator no longer exists; an unavailable saved sort returns to `updated_at`.
Hidden-filter IDs are intersected with the effective filter inventory. This does
not rewrite record JSON, relationship edges, shared presentation, local storage,
or a named saved view merely because metadata changed.

### Version 2 CRM detail contract

The object definition stores presentation under `configuration.views`. List
defaults remain an ordered array of field UUIDs. The CRM detail view is
`configuration.views.detail`, whose `version` must be exactly `2`:

```json
{
  "views": {
    "list": { "field_ids": ["field-uuid-a", "field-uuid-b"] },
    "detail": {
      "version": 2,
      "schema_field_ids": ["field-uuid-a", "field-uuid-b"],
      "cards": [{
        "id": "card-details",
        "title": "Details",
        "columns": 2,
        "fields": [
          { "id": "field:field-uuid-a", "type": "field", "field_id": "field-uuid-a", "columnIndex": 0 },
          { "id": "relationship:relationship-uuid:source", "type": "relationship", "relationship_definition_id": "relationship-uuid", "side": "source", "columnIndex": 1 }
        ]
      }],
      "visibility_rules": { "rules": [] }
    }
  }
}
```

- A card has a stable non-empty `id`, string title, one to three columns, and
  ordered elements. An element ID is unique across the entire layout.
- Field elements use stable field UUIDs, not mutable JSON keys or labels. Their
  IDs are derived as `field:<field-id>` or the compatible
  `custom:<field-id>` form used by the generated layout helper.
- Relationship elements use a stable definition UUID plus the viewed side:
  `relationship:<relationship-definition-id>:<source|target>`. The referenced
  definition must be active, visible from that side, and have this Custom
  Object at that side. This permits cards to be placed among fields rather than
  always appearing in a separate related-records area.
- A field may appear once. A relationship card may appear once. Relationship
  cards that are available but unplaced still render after the configured cards,
  so an administrator cannot accidentally make an otherwise visible
  relationship unreachable.
- The former `views.detail.sections` contract remains a read-compatible
  fallback for existing objects. With neither card nor section metadata,
  generated details use readable active fields. List-column choices saved in
  browser storage are personal (`tenant + object` scoped) and override the
  shared list default only for that user.

### Schema snapshots and reconciliation

`schema_field_ids` is a snapshot of the active schema at the time the layout was
saved. It is not a permission mechanism and it does not address fields by
name. On object reads, the service runs
`reconcileCustomObjectPresentationConfiguration()` using current fields and
relationship definitions:

```text
active schema and relationship inventory
  → remove card elements whose field is inactive or relationship side unavailable
  → replace schema_field_ids with the current active field UUIDs
  → append a field that is newly added since the saved snapshot to card-fields
  → remove visibility-rule conditions/actions whose targets no longer exist
  → return the reconciled configuration (without rewriting record JSON)
```

The reconciliation is deliberately non-destructive to record data and is
returned on reads; it does not silently persist an administrator's layout
change. A field that was in the saved snapshot but is deliberately unplaced is
not re-added. In contrast, a field created after that snapshot is placed in
`card-fields` (created as a two-column **Details** card when necessary).
Archived fields, invalid relationship sides, and stale rule targets are safely
removed from the effective view.

Writes reject a non-v2 detail version, invalid card/element IDs, duplicate
elements or fields, invalid column indexes, inactive/cross-object fields, and
unavailable relationship sides. The server loads the complete relationship
inventory before validating; the editor's available-field/card choices are only
a usability aid.

### Visibility rules

Rules are evaluated against readable current-record fields in order. Each rule
has a stable ID, non-empty conditions, non-empty actions, and optional `and`
(default) or `or` logic. A condition references an active field UUID (or its
compatible `custom:`-prefixed layout ID). Validation accepts `equals`,
`not_equals`, `contains`, `not_contains`, `is_empty`,
`not_empty`/`is_not_empty`, `greater_than`, and `less_than`. Actions target a
current card or layout element and are `show`, `hide`, `lock`, or `unlock`;
relationship targets cannot be locked or unlocked.

The generated detail renderer currently applies `show` and `hide`: show-targets
start hidden until a matching show rule reveals them, while hide actions conceal
matching targets. Its evaluator implements every condition operator listed
above, including array-aware `contains`/`not_contains` and both non-empty
spellings. Rules do not bypass field access, lifecycle, or relationship
visibility.
Lock/unlock are validated reserved metadata for editor compatibility; they are
not an authorization grant and must not be represented as a way to write a
field.

### Field authorization and server boundary

Object capabilities continue to answer whether a role can access the record
surface at all. Field authorization answers what that role may do with an
individual active field after object access has been established. A field grant
is scoped by:

```text
tenant_id + custom_object_id + preference_field_id + role_id
```

The effective access vocabulary is deliberately small:

| Effective access | Read response | Create/update request | Generated UI |
|------------------|---------------|-----------------------|--------------|
| `none` | Field definition, label, value, filter option, and compact text are omitted | Supplying the field is rejected | Hidden |
| `read` | Metadata and value may be returned where the record is otherwise visible | Supplying the field is rejected | Visible, with no editable control |
| `edit` | Same as `read` | Value is accepted and normal type/required validation applies | Visible and editable |

`edit` includes read. Invalid permission metadata and an unresolved field grant
fail closed to `none`; a caller must not receive a value merely because a UI
forgot to hide it. Tenant administrators retain the documented administrative
bypass only where the authorization service explicitly grants it. Schema
administration remains separate from record-data access: `manage-data-model`
does not itself grant record field reads or writes.

For backwards compatibility, an object without restrictive field-permission
metadata preserves its pre-existing object-capability behavior: a caller who
can read the object can read its active fields, and a caller who can create/edit
the object can write them. Once an administrator configures restrictive
field-level access for an object, effective access is resolved per role and
field according to the stored grants; it is not inferred from labels or client
state.

### Enforcement surfaces

The API/service is the authorization boundary. It resolves effective field
access before serializing or validating record data. The same resolved set is
used consistently by record reads and writes, relationship rows/pickers,
contextual creation, and exports; the browser cannot obtain access by posting
an omitted/hidden field, changing a layout, or replaying a request.

```text
request
  → authenticate and resolve tenant + object capability
  → load active object fields and role-scoped field grants
  → calculate readable and editable field sets
  → read: prune inaccessible metadata, values, and configured presentation
  → write: reject keys outside editable set, then type/required validate
  → filter/search/export: allow only readable eligible fields
  → serialize only authorized labels, values, and secondary text
```

Required validation is evaluated only for fields the caller may edit. A
required field that is readable but not editable must not make a create/edit
form impossible; administrators must adjust the schema/field grant before
making such a field mandatory for that role. Conversely, an inaccessible value
is never accepted as a hidden preserved write. Existing historic JSON may stay
stored, but it is not a disclosure exception.

**Important:** field authorization is server-side. Client controls must reflect
the resolved access for usability, but neither omitted inputs nor personal
column settings are an authorization mechanism. All response shapes, including
secondary relationship text and export headers, must be pruned before leaving
the service boundary.

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

Entity pickers apply the same matrix before pagination. They always exclude an
already-linked pair. They also exclude a candidate whose endpoint is already
occupied when that endpoint is limited to one active edge. A candidate linked
elsewhere remains available for `many_to_many`, and remains available on the
unlimited side of `one_to_many` or `many_to_one`. The database guard remains the
final concurrency authority if another request creates an edge after the picker
response is returned.

### Contextual record creation

A relationship card offers **Create {singular label}** only when all of the following are true:

1. the card and relationship definition are active, visible, and editable from the current record side;
2. the opposite endpoint is a Custom Object, not a Member, Organisation, Organisation Group, or another core kind;
3. the opposite Custom Object is active and grants `create_records`;
4. the current side has not reached its configured cardinality limit.

The dialog loads only active fields and uses the target object's configured singular label. Field defaults, types, required rules, options, country restrictions, file settings, and length/selection limits use the same generated controls and validation as the full-page record form.

The dialog separates **Record details**, **Parent relationship**, and **Additional relationships**. The originating parent relationship is fixed, named with the label configured for the new record's routed side, and cannot be changed. Additional selectors use that same current-side label rule, are explicitly marked **Required** or **Optional**, and may select multiple initial links. Optional selectors—including a Department's **Members** selector—may remain empty; selected people are initial links and are not stored as the Department field value. Required source relationships must contain at least one selection before submission. Candidate reads use `initial-relationship-candidates`, which does not require a record ID because the record does not exist yet; it still excludes archived, cross-tenant, inaccessible, and candidate-side-cardinality-saturated endpoints.

**Boundary:** contextual creation creates only the opposite Custom Object record. Core records can be the existing origin or an additional selected endpoint, but this flow never creates a Member, Organisation, Organisation Group, or other core record.

Saving calls one database RPC. The RPC inserts the record and every initial edge in one transaction, while the existing relationship triggers enforce endpoint validity, duplicate prevention, and cardinality under transaction-scoped advisory locks. Active required source relationships are checked before commit. Any validation, permission, endpoint, required-relationship, duplicate, or cardinality failure aborts the transaction, including its audit-trigger writes, so no orphan record or partial edge set remains. A corrected retry is therefore safe.

### BNMS Department Type normalization

BNMS Departments remain organisation-specific records. The reusable
classification is a separate active `department_type` Custom Object with a
required text `name` primary field. One required `many_to_one` relationship
links each Department to one Department Type, so many Departments can share a
type while a Department can have only one active type.

The tenant-pinned migration creates or validates only that schema. It fails
closed if an object, field, or relationship with the stable keys already exists
in an incompatible shape. The hierarchy importer then:

1. reads the approved 310-row hierarchy sheet and pins the six source totals;
2. resolves every Department by its existing Organisation edge and normalized
   Department name;
3. refuses missing, duplicate, archived, or conflicting records before writes;
4. creates or reuses the six Type records and adds only missing Type edges; and
5. verifies 310 Department IDs/data payloads, 231 Organisations, all pre-existing
   non-Type relationships, and their audit rows are unchanged.

Apply mode is serialized with a transaction advisory lock. A successful second
run plans zero object, type, or edge creation.

### Form relationship dropdowns

A `relationship_dropdown` form field binds one earlier `organisation_dropdown` directly to one active relationship definition. Its saved configuration contains stable metadata IDs rather than labels:

```json
{
  "type": "relationship_dropdown",
  "parent_field_id": "field_organisation",
  "relationship_definition_id": "relationship-uuid",
  "custom_object_id": "object-uuid",
  "custom_object_primary_display_field_id": "field-uuid"
}
```

The builder discovers only active relationships where one endpoint is `organization`, the other is an active Custom Object, and the relationship is visible from the organisation side. Multiple relationship fields may use the same parent organisation field. Multi-level and multi-select relationships are not supported.

At render time, the field is disabled until its parent has a value. Loaded draft, prefill, and manual-edit values are resolved by the saved field definition: the stable field ID is authoritative, with the legacy field name used only when the ID key is absent or `undefined`. A retained legacy relationship value is normalized through the canonical field ID. The client then requests the saved field's options through the form-scoped endpoint. Changing or clearing the canonical parent still clears the dependent value; a loaded option set also clears a stored value that is no longer valid. The select presents explicit loading, empty, and failure states.

The option endpoint re-loads the active form and validates the exact saved parent field, relationship definition, object, and primary display field. It also enforces the parent organisation field's configured filter, the tenant, organisation-side visibility, active edge, active object, active primary field, and active related record. Every answer-data write path repeats relationship validation before persistence—including public, paid, authenticated Canvas/iEdit, manual, review, due-diligence initialization, and administrative amendment routes—so bypassing a browser control cannot submit an unrelated UUID.

Submission data stores the related record UUID. Review, CSV/Word export, background export, and submitter-copy paths resolve the current active primary display label in the submission tenant. Interactive label reads require the relevant submission/review feature and derive their allowed record IDs from tenant-scoped persisted submissions; caller-supplied IDs are only an intersection filter. Missing, archived, inactive, or cross-tenant records use `Unavailable record`; they never expose the raw UUID as a display fallback.

### Form Structured Record Actions

The FormBuilder **Record Creation** card also provides Structured Record Actions. This editor is additive: existing Member and Organisation pipeline controls remain available and continue to round-trip unchanged.

Primary Member and Organisation pipeline cards also have a subordinate **Related Records** section. Each link stores a stable relationship-definition ID and the ID of a submitted Relationship Dropdown field. After the primary pipeline creates or updates its exact result, processing re-loads the persisted form and submission, verifies the active tenant-owned relationship and compatible endpoint metadata, validates the submitted relationship selection, and inserts the canonical edge. Hidden source fields are skipped. Existing active edges are treated as already linked, so retries are safe. Link failures are returned under `related_records` and written to processing notes without changing a successful primary record operation into a failure. Paid submissions persist a pending marker for failed links; reconciliation retries them independently until the marker is cleared.

Actions are persisted on the Form as `structured_actions`:

```json
{
  "version": 1,
  "actions": [{
    "id": "record_action_stable-id",
    "source": { "scope": "repeatable_row", "repeatable_field_id": "field_people" },
    "target": { "kind": "custom_object", "custom_object_id": "object-uuid" },
    "operation": "upsert",
    "relationship_definition_id": "relationship-uuid",
    "selector_field_id": null,
    "uniqueness_field": "custom-field-uuid",
    "mappings": [{
      "id": "mapping_stable-id",
      "source_field_id": "row_email",
      "target_field_id": "custom-field-uuid",
      "target_type": "custom"
    }]
  }]
}
```

`source.scope` is either `top_level` (one action per submission) or `repeatable_row` (one action per submitted row in the selected repeatable field). Targets are `member`, `organization`, `organization_group`, or `custom_object`; Custom Object targets additionally store the active object UUID. Operations are:

- `create`: always create a new target record;
- `update_selected`: update the record selected through a compatible active Relationship Dropdown. Both the relationship definition and the exact saved `selector_field_id` in the selected source scope are persisted; the selector's definition must match `relationship_definition_id`;
- `upsert`: find by the selected backend-eligible uniqueness field, otherwise create. The uniqueness field must also be mapped. In v1 the eligible core keys are Member email, Organisation name, and Organisation Group name. Custom Objects may use a mapped scalar field (text, email, URL, number, decimal, date, dropdown, or country); processing rejects ambiguous matches instead of choosing one.

The editor queries active object definitions, active fields, and active relationship definitions through the authenticated, tenant-aware Custom Object API. It offers only source fields in the selected scope and supported active core/custom target fields, including active `organization_group` custom fields. Mappings are type-compatible: record IDs from organisation/group/relationship dropdowns can only map to an explicitly supported matching record-reference target (currently Member `organization_id` accepts an Organisation Dropdown); relationship record IDs cannot be written into text or ordinary custom fields. Files and display-only/action fields are not mapping choices. Save validation rejects missing or duplicate action IDs, stale repeatable fields, inactive objects or fields, incompatible relationships/selectors, incompatible types, incomplete/duplicate mappings, and unmapped upsert keys. Stable IDs—not labels—are authoritative.

For repeatable rows, `_row_id` is the stable retry identity. Runtime execution must create an idempotency/ledger entry keyed by the submission ID, action ID, and `_row_id` (top-level actions use one submission/action key), and reuse the completed result on retry. It must not use row position, labels, or submitted values as an idempotency key. Runtime processors must re-resolve and authorize all saved metadata and must not write Custom Object JSONB directly.

---

## Portal Destinations and Chained Navigation

### Portal-menu Custom Object destination

Portal Menu Management loads active Custom Objects page-by-page from the
authenticated catalogue and offers only rows whose returned
`capabilities.view` is `true`. Selecting an object creates an internal list
destination and object-specific role access ID:

```text
URL:       CustomObjectsAdmin/<encoded-object-uuid>/records
access ID: custom-object:<object-uuid>:view-records
```

`getCustomObjectPortalListUrl()` and
`getCustomObjectPortalRoleAccessId()` in `shared/portalMenuLinks.js` are the
canonical builders. Their parsers accept an optional leading slash and
query/hash suffixes, safely decode the ID, and reject malformed paths. Saving a
menu item with the exact list URL generates the access ID; labels, object keys,
and the generic Data Studio feature ID are never substitutes. Portal route
matching recognizes the list and record subpaths for that same object.

This menu/RBAC behavior is defense in depth, not data authorization. Direct
record requests still require the server's tenant-scoped `view_records`
capability and field projection. A stale menu item therefore cannot disclose
an inactive or unauthorized object.

Portal menu entries also support ordinary internal destinations and external
HTTP(S) destinations. External URLs must be complete HTTP(S) addresses.
External parents with sub-items are rejected; only external leaf links can open
in a new tab, using `noopener noreferrer`.

### Relationship cards and chained record navigation

The record detail resolves the v2 placement contract before rendering
relationship panels. A relationship element is looked up by stable definition
ID and viewed side, then renders its definition label, permitted rows, compact
preview, and Add/Create controls in that card column. Available panels not
placed in a card render after the configured cards. Client visibility can hide
a card or element, but it never expands the server-authorized row data.

Selecting an opposite Custom Object row navigates to its generated record route
with an internal `relationshipReturnTo` state. The destination uses
`relationshipBackPath()` for its **Back** link, supporting chained
relationship navigation back to the originating detail. It accepts only an
application-relative path and falls back to the object's list; absolute,
protocol-relative, and backslash-based paths are discarded to prevent open
redirects.

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
11. Public form relationship options are constrained by the persisted form field, parent organisation, definition, object, lifecycle, visibility, and active edge; callers cannot turn the route into a general record browser.
12. Form submission handlers revalidate relationship UUIDs before writes or side effects, and output label lookups omit unavailable records rather than exposing identifiers.
13. Field permissions are resolved tenant-, object-, field-, and role-scoped at the service boundary; inaccessible field definitions, values, filter choices, export columns, and relationship secondary text are pruned before serialization.
14. Presentation metadata is validated against active field ownership and relationship side when saved, then reconciled against the current schema on reads. Client layout/visibility decisions never expand API access.
15. Portal Custom Object access IDs contain the stable object UUID and the `view-records` capability. Portal routing is defense in depth; the generic API remains the final tenant/capability/field authorization boundary.
16. Relationship-backed list columns, filters, sorts, totals, and export cells
    are produced only after server-side definition/side/endpoint authorization;
    a client-provided join or count is never authoritative.

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

### CRM presentation save and record-detail render

**Files:** `client/src/pages/CustomObjectsAdmin.jsx`,
`api/_lib/customObjectService.js`, `client/src/pages/CustomObjectRecords.jsx`,
and `client/src/pages/customObjects/recordHelpers.js`
**Trigger:** An administrator saves Presentation, or a user opens a record.

1. The Presentation tab builds ordered list field UUIDs, v2 cards, stable
   field/relationship element IDs, and visibility rules from the schema and
   relationship inventory.
2. Saving PATCHes the object `configuration`; the service validates the v2
   contract against active tenant-owned fields and available relationship sides.
3. Reading the object reconciles the saved configuration to the current schema.
4. The record page derives the effective card layout, drops unreadable/stale
   elements, evaluates show/hide visibility against the current record, and
   renders placed relationship panels plus remaining visible panels.

**Important:** The browser's layout calculation is presentation only. Record
values, relationship rows, and mutation eligibility are independently
authorized by the service.

### CRM record list and export

**Files:** `api/_lib/customObjectService.js`,
`client/src/pages/CustomObjectRecords.jsx`,
`client/src/pages/customObjects/recordListHelpers.mjs`, and
`client/src/hooks/useSavedListViews.js`

**Trigger:** A user opens a generated Custom Object list, changes its CRM list
state, pages the result, or requests CSV export.

1. Normalize legacy field-only metadata and current CRM list column descriptors
   into stable field/relationship column IDs.
2. Resolve the routed object capability, field grants, relationship sides, and
   opposite-endpoint authorization.
3. Prune display-only columns that are no longer available; reject an invalid
   or unauthorized active filter or sort.
4. Build one tenant-scoped query plan for scalar and relationship predicates.
5. Apply search, predicates, and deterministic sorting to the full eligible
   candidate set before taking the requested page, then return that filtered
   set's exact total and authorized cell data.
6. Call the bounded projection RPC for only the selected record IDs. It returns
   the exact eligible edge count plus at most three linked IDs per
   record/relationship, then the service resolves those IDs through the
   permission-aware endpoint adapters. The browser sends only currently visible
   relationship column IDs in `relationshipColumns`; the service validates them
   against authorized metadata, caps the inventory at 100, and chunks endpoint
   ID reads in batches of 200.
7. Render the table from the server's effective metadata and values; do not
   perform a page-local relationship join or fetch every edge for a high-cardinality row.
8. For export, require `export_records` and replay the same normalized state in
   bounded pages until the exact total is collected.
9. Emit headers and formatted cells from the authorized effective columns,
   including deterministic multi-value relationship cells.

**Key detail:** list and export are two transports over one query contract.
Adding a filter or column to only one path is a parity defect.

### Portal-menu save and access

**Files:** `client/src/pages/PortalMenuManagement.jsx`,
`client/src/lib/portalMenuLinks.js`, and `shared/portalMenuLinks.js`
**Trigger:** An administrator selects and saves a Portal Menu destination.

1. The editor loads only active viewable Custom Object destinations.
2. Selecting one stores the stable list URL.
3. On save, the URL parser recognizes that exact list URL and replaces the
   item feature ID with `custom-object:<object-id>:view-records`.
4. Layout route checks derive the same object ID from list/detail paths before
   applying portal access behavior; the API repeats authorization on every
   request.

### Record mutation

1. Resolve the object in the current tenant and require its capability.
2. Require active status for create/edit.
3. Load active and historic field definitions.
4. Coerce and validate typed JSON data.
5. Add server-authored identity/timestamps and persist the generic record.

### Contextual record-and-relationship creation

**Files:** `client/src/pages/customObjects/ContextualRecordCreateDialog.jsx`, `api/_lib/customObjectService.js`, `supabase/migrations/20260925_custom_object_record_relationship_create.sql`
**Trigger:** A user selects **Create {singular label}** on an eligible relationship card.

1. Resolve the opposite Custom Object and its `create_records` capability.
2. Load active field definitions and visible/editable relationship definitions.
3. Pre-bind the originating relationship and load eligible candidates for other initial relationships.
4. Validate generated field values and required selectors in the browser.
5. Revalidate object lifecycle, capabilities, relationship orientation, side permissions, and endpoint eligibility in the service.
6. Call `create_custom_object_record_with_relationships`.
7. Insert the record and all edges in one transaction; database triggers enforce concurrency-safe invariants and write audit rows.
8. On success, close the dialog and invalidate the originating card plus affected record/list queries. On failure, retain entered values and show field or relationship errors.

### Relationship mutation

1. Resolve the definition and routed side.
2. Check visibility/editability and capabilities on all Custom Object endpoints.
3. Resolve endpoint rows by declared kind and tenant.
4. Validate endpoint kind, object ownership, active state, and tenant.
5. Insert/archive the canonical edge; database guards enforce concurrency-safe cardinality.

### Form dependent-option read

**Files:** `api/_lib/formRelationshipOptions.js`, `api/public/form/[slug]/relationship-options.js`
**Trigger:** A rendered relationship dropdown has a selected parent organisation.

1. Resolve the tenant and active form from the request host and form slug.
2. Enforce form schedule and access policy.
3. Find the saved relationship field and confirm its parent is an earlier organisation dropdown.
4. Validate the selected organisation against the parent field's saved filter.
5. Re-resolve the active relationship definition, Custom Object, and primary display field.
6. Read active edges for that organisation and active related records in the same tenant.
7. Return paginated `{ id, label }` options sorted by display label and stable ID.

### Form submission validation

**Files:** `api/public/form-submission.js`, `api/admin/manual-form-submission.js`
**Trigger:** Public, embedded, iEdit, or manual form submission.

1. Inspect only saved `relationship_dropdown` fields.
2. Require a submitted parent organisation when a relationship value is present.
3. Resolve the currently valid option set using the same form-scoped service.
4. Reject any submitted record ID that is not an active option for that exact field and parent.
5. Persist the UUID unchanged after validation.

---

## Safeguards and Error Handling

### Immutable keys

Object and field internal keys cannot change after creation. Duplicate object, field, relationship, or active edge keys map database uniqueness failures to HTTP 409.

### Schema and endpoint validity

Invalid field metadata, unknown incoming record keys, malformed filters, inactive targets, endpoint mismatches, and cross-tenant references are rejected before useful data is returned. Invalid input is HTTP 400; unavailable lifecycle state is generally 409; missing permission is 403.

### CRM layout integrity

The service accepts a CRM detail layout only at version 2 and validates stable
card/element IDs, uniqueness, columns, active field ownership, and active,
visible Custom Object relationship sides. On reads it reconciles stale metadata
instead of interpreting it as data. Visibility rules are a rendering layer:
they cannot make a hidden/unreadable field visible or turn a read-only field
into an editable one.

### CRM list query integrity

Relationship-backed list columns are re-resolved from tenant-owned definitions;
the client cannot choose endpoint tables or JSON paths. Active edges and
eligible opposite endpoints are evaluated across the full scalar candidate set;
only then are relationship predicates/order, the page slice, and `total`
derived. Invalid display-only metadata is reconciled away, while an invalid
filter or sort fails closed so the service never returns a broader set than
requested. Export delegates to `listRecords()` and therefore receives the same
authoritative rows and total.

### Archive integrity

Database triggers propagate archives so active relationships are not silently orphaned. The relationship archive RPC serializes removals and performs the final-edge required check in the same transaction.

### Atomic contextual creation

The `create_custom_object_record_with_relationships(uuid, uuid, jsonb, jsonb, text)` function is `SECURITY DEFINER`, has a fixed `search_path`, and is executable only by `service_role`. The dated migration is replay-safe and notifies PostgREST to reload its schema cache. It derives the new record endpoint from the trusted object ID and accepts only a definition ID, new-record side, and related record ID for each edge. A failed insert or final required-relationship check rolls back the record, all earlier edges, and their trigger-created audit events. The service never falls back to separate inserts: a missing RPC returns an actionable 503 so operators can apply the destination migration without risking orphan records.

### Public disclosure

Public preference-value routes first build a tenant-scoped allowlist excluding Custom Object fields, then constrain value reads to those IDs. Regression coverage lives in `api/_lib/publicCustomObjectDisclosure.test.mjs`; generic route registration and authentication are covered by `api/_lib/customObjectGenericAcceptance.test.mjs`.

---

## Frontend UI

`CustomObjectsAdmin.jsx` shows the tenant catalogue, schema controls, shared
presentation defaults, and role field-access editor. `CustomObjectRecords.jsx`
renders lists, add/edit forms, details, archive actions, and permissions from
resolved object and field metadata. The list's column chooser includes
authorized field and relationship-backed columns. A user's saved list columns
override the shared list default only for that user and are reconciled whenever
metadata or access changes. The table renders server-resolved relationship
cells and server totals; it never derives either from the current page.
Relationship panels and pickers derive
labels, endpoint kinds, side-aware compact fields, visibility, and edit controls
from definitions. They render only the server-authorized primary/secondary data.
Eligible cards place **Create {singular label}** beside **Add link** and open
the contextual dialog without navigation. FormBuilder's Structured Record
Actions editor uses the same active metadata and stores its configuration under
a versioned Form property.

FormBuilder offers a **Relationship Dropdown** field type. The field settings show an earlier organisation-field picker and an eligible active-relationship picker. The shared `FormRenderer` supplies the respondent experience across normal public forms, embedded forms, builder/iEdit previews, and manual submissions.

| Mutation | Endpoint | Purpose |
|----------|----------|---------|
| POST/PATCH/DELETE object | `/api/custom-objects/...` | Create, configure, archive |
| POST/PATCH/DELETE field | `.../fields/...` | Create, configure, deactivate |
| POST/PATCH/DELETE record | `.../records/...` | Create, edit, archive |
| POST contextual record | `.../records` | Atomically create one Custom Object record and its initial edges |
| POST/PATCH/DELETE relationship definition | `.../relationship-definitions/...` | Configure or archive |
| POST/DELETE relationship | `.../relationships/...` | Add or archive an edge |
| POST/PUT permission | `.../permissions` | Upsert role capabilities |

React Query keys are object-ID based (`custom-objects`, object, fields, records,
relationship definitions/rows), and record-list keys include the normalized CRM
list state. Contextual creation and relationship mutations invalidate affected
record lists because relationship columns, filters, sort order, and totals may
all change even when record JSON did not. They also invalidate the originating
relationship rows, definition counts, and record detail. The dialog closes only
after success; failures leave field and relationship state in place. No cache
key depends on “Department” or “Region”.

The admin object's **Presentation** tab saves the shared field-only list default
and the v2 CRM card layout. The generated list merges that default with
server-advertised relationship columns and reconciled personal/saved-view
state. The generated record page applies the detail layout, evaluates
visibility rules for the opened record, renders relationship cards in their
configured positions, and keeps unplaced relationship cards reachable below
the layout. Portal Menu Management exposes only active Custom Objects the
administrator can view and saves their stable list destinations/access IDs.

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

```text
Open a Custom Object CRM list
  → normalize shared/personal field and relationship columns
    → authorize routed fields and every relationship side
      → compile scalar and relationship predicates
        → query and sort the full tenant-scoped result
          → paginate once and return the exact filtered total
            → render server-resolved cells
```

```text
Export the current CRM list
  → reuse the authorized columns, search, filters, sort, and archive mode
    → request bounded export pages from the same query plan
      → verify progress against the authoritative total
        → emit field and relationship headers/cells in the same order
```

```text
Open an eligible relationship card
  → resolve opposite active Custom Object and singular label
    → load active fields and initial relationship metadata
      → fix the existing record as the originating relationship
        → select any required additional endpoints
          → validate and call one atomic RPC
            → record + all edges + audit events commit together
            → any failure rolls the entire transaction back
```

---

## MVP Limitations and Phase 2 Handoff Contracts

The MVP provides generic schema/record CRUD, generated forms, search, typed
field and relationship-backed CRM list metadata, server-side relationship
querying, sorting, pagination/totals, member-scoped named/default saved views,
permission-aware CSV export, archive/audit behavior, generic pickers,
Core/Custom Object relationships, and direct Organisation-to-Custom-Object
dependent FormBuilder dropdowns. It does **not** provide CSV import,
tenant-published shared saved views beyond the object's field default, arbitrary
multi-hop relationship query composition, multi-level form dependencies,
reporting datasets, or communications segmentation.

Phase 2 must consume stable generic contracts rather than inspect JSON or add example-specific code:

| Integration | Handoff contract |
|-------------|------------------|
| CSV import | Address object by UUID; fetch field metadata; map columns to immutable field keys/IDs; validate through the same typed record service; resolve relationships by controlled IDs; return row-level validation and summary results |
| CSV export extensions | Preserve the existing list/export query-plan parity, exact total checks, stable field/relationship column IDs, deterministic multi-value formatting, and authorization pruning |
| Saved views | Persist object UUID, ordered field/relationship column descriptors, sort, and the existing stable-ID filter grammar; pass every loaded view through the same server reconciliation and authorization path |
| Advanced relationship filtering | Extend the existing definition-ID + routed-side grammar with explicit versioning, opposite endpoint field UUID/operator/value, and bounded traversal depth; preserve tenant and capability checks at every hop |
| FormBuilder | Existing dependent dropdowns use saved object/field/relationship UUIDs and metadata snapshots; later create/update actions must submit to generic record services and never write JSONB directly |
| Reporting | Discover schemas by object UUID; expose typed field metadata and relationship-definition IDs; apply tenant/permission scope and server-side pagination/aggregation |
| Communications | Store segmentation predicates by object/relationship/field IDs; resolve recipients through permission-aware relationship traversal; never copy Department/Region assumptions into campaign code |

**Compatibility rule:** immutable IDs and keys, field types, lifecycle states, cardinalities, capability names, filter grammar, and pagination envelopes are Phase 2 contracts. Extensions belong in versioned configuration or additive response fields. Consumers must ignore unknown additive fields and must not rely on labels as identifiers.

**List extension rule:** add a new column, aggregate, or relationship operator
to the shared list-state normalizer and server query plan first, then expose it
to both interactive list and export. Define deterministic null/multi-value sort
semantics, apply it before pagination, count through the same predicate, add
authorization and reconciliation behavior, and only then add UI controls.
Never implement an extension as a browser join or an export-only branch.

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
| Shared list field default | `configuration.views.list.field_ids` | ordered active field UUIDs | active-field order | Initial field visibility; relationship columns come from authorized response metadata |
| Personal CRM list state | local preference / `useSavedListViews` scope `customObjects:<object-id>` | ordered `{ id, visible }` columns plus query/filter UI state | shared fields + locked Name + Updated | Reconciled against current authorized list metadata |
| Relationship list filter | query `filters` or `relationshipFilters` | `any_of`, `none_of`, `is_empty`, `is_not_empty` | inactive | Key is `relationship:<definition-id>:<side>` |
| Relationship list sort | query `sortField`/`relationshipSort` and `relationshipSortMode` | direction `asc`/`desc`; mode `label`/`count` | label / ascending | Applied before server pagination with stable record-ID tie-break |
| CRM detail layout | `configuration.views.detail` | version `2`, stable cards/elements, columns 1–3, visibility rules | legacy sections/generated detail | Shared field and relationship-card placement |
| Schema snapshot | `views.detail.schema_field_ids` | active field UUIDs | populated/reconciled on read | Distinguishes newly created fields from intentionally unplaced fields |
| Relationship compact preview | relationship configuration | ordered opposite-object field UUIDs per routed side | primary label only | Supporting values for cards and Custom Object pickers |
| Field role access | field permission | `none`, `read`, `edit` per role/field | inherited legacy object capability | Server-enforced read/edit visibility after object access |
| Portal object destination | portal menu item | `CustomObjectsAdmin/<object-id>/records` | none | Canonical encoded list route for one object |
| Portal object access ID | portal menu `feature_id` | `custom-object:<object-id>:view-records` | generated for canonical list URL | Stable object-specific portal access rule |
| Form relationship parent | form field | earlier `organisation_dropdown` field UUID | none | Direct dependency source |
| Form relationship definition | form field | eligible active relationship UUID | none | Constrains related options |
| Structured action source | `Form.structured_actions.actions[]` | `top_level`, `repeatable_row` | `top_level` | Selects one submission or each row; repeatable scope also requires `repeatable_field_id` |
| Structured action target | action target | Member, Organisation, Organisation Group, Custom Object | required | Custom Object also requires an active object UUID |
| Structured action operation | action | `create`, `update_selected`, `upsert` | required | Selected update requires a compatible relationship; upsert requires a mapped uniqueness field |

---

## Troubleshooting

### Problem: Object cannot be activated
**Symptom:** Activation returns HTTP 400.  
**Cause:** The primary display field is missing, inactive, invalid, cross-tenant, or belongs to another object.  
**Fix:** Select a valid active field on this draft object.

### Problem: Related record is missing
**Symptom:** Picker omits it or relationship read reports an unavailable endpoint.  
**Cause:** The endpoint is archived, outside the tenant/object, hidden, inaccessible to the current role, already linked to the routed record, or has exhausted its candidate-side cardinality.
**Fix:** Check definition side, endpoint lifecycle, object grant, tenant ownership, existing active pairs, and the cardinality matrix.

### Problem: Relationship creation returns conflict
**Symptom:** HTTP 409 mentions duplicate or cardinality.  
**Cause:** The active pair already exists or one side exceeds the configured cardinality.  
**Fix:** Reuse the existing edge, archive/replace it safely, or correct the definition.

### Problem: Create action is missing from a relationship card
**Symptom:** The card offers **Add link** but not **Create**.
**Cause:** The opposite endpoint is a core entity, the opposite Custom Object is inactive or not creatable, the card side is hidden/read-only, or the current side has reached its cardinality limit.
**Fix:** Check endpoint kind, object status and `create_records`, side visibility/editability, and current active edge count.

### Problem: Contextual creation cannot be saved
**Symptom:** The dialog retains its values and shows a field, relationship, permission, or conflict error.
**Cause:** Required metadata is incomplete, a selected endpoint became unavailable, permissions changed, or a concurrent request consumed cardinality after candidates loaded.
**Fix:** Correct the highlighted value or reload/reselect the candidate. No record or partial relationships were retained, so the same form can be retried safely.

### Problem: Contextual creation reports a missing atomic database function
**Symptom:** Saving returns HTTP 503 and names `20260925_custom_object_record_relationship_create.sql`.
**Cause:** The destination database has not received the atomic-create migration, or PostgREST has not refreshed the five-argument function signature in its schema cache.
**Fix:** Apply the dated migration to the destination database and verify `create_custom_object_record_with_relationships(uuid, uuid, jsonb, jsonb, text)` is executable by `service_role`. Do not replace it with client-side or server-side sequential inserts.

### Problem: Historic field value appears but cannot be edited
**Symptom:** Read retains a key that write rejects.  
**Cause:** The field was archived or removed from active metadata; historic data is intentionally preserved.  
**Fix:** Reactivate/configure the field or omit the historic key while satisfying current required fields.

### Problem: CRM presentation save is rejected
**Symptom:** Saving the Presentation tab returns “Invalid CRM presentation configuration.”
**Cause:** The layout is not version 2, has duplicate/incorrect stable element IDs, an invalid column, an inactive/wrong-object field, or a relationship side that is no longer active and visible.
**Fix:** Refresh the schema, remove stale elements/rules, and save IDs in the required `field:<field-id>` or `relationship:<definition-id>:<side>` form. Do not substitute labels or internal keys.

### Problem: A newly added field is absent or an old card item disappeared
**Symptom:** The effective layout differs from the saved card configuration.
**Cause:** Read-time reconciliation removes inactive fields/unavailable relationship sides. It appends only fields created after `schema_field_ids` was saved; a snapshot field intentionally left unplaced remains unplaced.
**Fix:** Confirm the field and relationship lifecycle first, then edit and save the v2 layout to place the desired active field/card explicitly.

### Problem: A relationship list column disappeared
**Symptom:** A saved relationship-backed column is missing from the chooser,
table, or export.
**Cause:** Read-time reconciliation removed a definition that is archived,
cross-tenant, wrong-side, hidden, inaccessible at either endpoint, or no longer
valid for the routed object. Personal column state cannot restore it.
**Fix:** Check the definition lifecycle and routed side, `show_on_*` setting,
both endpoint capabilities, and opposite Custom Object field grants. Update the
personal or named saved view after the metadata/access change if the removal is
intentional.

### Problem: Relationship list queries report a missing database function
**Symptom:** Loading a relationship-backed list returns HTTP 503 and names
`20260928_custom_object_relationship_list_rpc.sql`.
**Cause:** The destination database has not received the authoritative list and
bounded-projection functions, or PostgREST still has their signatures cached.
**Fix:** Run
`node scripts/apply-custom-object-relationship-list.mjs` with
`DEST_DATABASE_URL` available. The runner applies the dated migration
transactionally and notifies PostgREST to reload its schema cache. Verify both
`custom_object_record_relationship_list(...)` and
`custom_object_record_relationship_projection(...)` are executable only by
`service_role`. Do not fall back to page-local filtering or unbounded edge
reads.

Run `node scripts/verify-custom-object-relationship-list-live.mjs` for a
read-only destination check of function grants, a real relationship-bearing
list, filtering, projection, sorting, out-of-range totals, export parity, and
selected-option rehydration.

### Problem: List and export counts or rows differ
**Symptom:** CSV output does not match the current CRM list filters, ordering,
relationship values, or authoritative total.
**Cause:** The caller used different normalized list state, metadata/access
changed between bounded pages, or an extension bypassed the shared server query
plan.
**Fix:** Retry from the current list state. If reproducible, verify that records
and export use the same authorized query planner and that relationship
predicates run before pagination. Do not repair parity with client-side
filtering or totals.

### Problem: A relationship filter is rejected after a metadata change
**Symptom:** The list returns an explicit invalid/unauthorized relationship
filter or sort error instead of ignoring the stale control.
**Cause:** The relationship side became inactive, hidden, wrong-object, or
unavailable to the role.
**Fix:** Remove the stale predicate or restore valid metadata/access. This is
intentional fail-closed behavior: silently dropping the predicate could expose
a broader result set.

### Problem: A portal Custom Object menu link is hidden or opens without access
**Symptom:** The object is not selectable in Portal Menu Management, or a saved link is not authorized.
**Cause:** The object is inactive, the current administrator lacks `view_records`, or the menu URL/feature ID is not the canonical stable pair.
**Fix:** Activate the object, grant `view_records`, and save the internal URL as `CustomObjectsAdmin/<object-id>/records`. Let the editor generate `custom-object:<object-id>:view-records`; do not use an object label/key or a generic feature ID.

### Problem: Back from a related record returns to the list
**Symptom:** After following a relationship row, **Back** does not return to the source record.
**Cause:** There is no valid internal `relationshipReturnTo` state, or it was rejected as an unsafe URL.
**Fix:** Follow the relationship row from the generated panel rather than constructing a direct external/deep link. Only application-relative return paths are supported.

### Problem: Relationship dropdown stays disabled
**Symptom:** The respondent cannot select a related record.
**Cause:** No parent organisation is selected, the field configuration is incomplete, options are loading, the endpoint failed, or there are no active related records.
**Fix:** Select the parent organisation, confirm the saved parent/relationship metadata, and verify the active definition, object, primary field, edge, and record.

### Problem: A saved relationship displays “Unavailable record”
**Symptom:** Review or export output does not show the historic UUID or label.
**Cause:** The record, object, or primary field is archived/inactive, missing, cross-tenant, or otherwise unavailable.
**Fix:** Treat the submission UUID as retained history. Restore valid active metadata only if appropriate; output deliberately avoids exposing raw identifiers.