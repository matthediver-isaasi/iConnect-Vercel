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
| `api/_lib/formRelationshipOptions.js` | Form-scoped relationship discovery, dependent-option resolution, and submitted-value validation |
| `api/_lib/organizationEligibility.js` | Shared organisation-dropdown filter eligibility used by list and relationship option APIs |
| `api/_lib/relationshipDisplayLabels.js` | Tenant-scoped active-record label lookup for submission output |
| `api/custom-objects/index.js` | Object collection route |
| `api/custom-objects/[objectId].js` | Object item route |
| `api/custom-objects/[objectId]/[resource].js` | Generic nested collection route |
| `api/custom-objects/[objectId]/[resource]/[resourceId].js` | Generic nested item route |
| `client/src/pages/CustomObjectsAdmin.jsx` | Catalogue and schema administration |
| `client/src/pages/CustomObjectRecords.jsx` | Generated record list, detail, form, and permission editor |
| `client/src/pages/customObjects/RelationshipDefinitions.jsx` | Generic relationship-definition editor |
| `client/src/pages/customObjects/RelatedRecordsPanel.jsx` | Definition-driven related-record UI |
| `client/src/pages/customObjects/ContextualRecordCreateDialog.jsx` | Metadata-driven form for creating and linking an opposite Custom Object record in context |
| `client/src/pages/customObjects/RecordFieldControls.jsx` | Shared generated controls used by normal and contextual record creation |
| `client/src/pages/FormBuilder.jsx` | Relationship-dropdown configuration against earlier organisation fields |
| `client/src/components/forms/FormRenderer.jsx` | Shared dependent relationship dropdown used by public, embedded, preview, and manual forms |
| `client/src/lib/formRelationshipDropdown.js` | Pure builder and stale-selection rules |
| `client/src/lib/relationshipDisplayLabels.js` | Safe relationship-value formatting for review and export surfaces |
| `supabase/migrations/20260825_custom_object_foundation.sql` | Generic storage, constraints, RLS, audit triggers, and cardinality guard |
| `supabase/migrations/20260826_custom_object_relationship_runtime.sql` | Required-edge and archive propagation guarantees |
| `supabase/migrations/20260925_custom_object_record_relationship_create.sql` | Atomic record-plus-initial-relationships transaction |
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
| `GET .../initial-relationship-candidates` | Search eligible opposite endpoints before the new record exists |
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

Record lists accept `search`, `sortField`, `sortDir`, `filters`, `page`, `pageSize`, and `includeArchived`. Filters are keyed by field UUID, never by caller-provided JSON paths. Relationship list/picker requests must identify `definitionId`, `recordId`, and the routed `side` where required. Endpoint kind and target object are derived from the relationship definition.

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

The originating relationship is fixed and cannot be changed. Other active relationships visible and editable from the new record's side appear as metadata-driven selectors. Required source relationships must be selected before submission. Candidate reads use `initial-relationship-candidates`, which does not require a record ID because the record does not exist yet; it still excludes archived, cross-tenant, inaccessible, and candidate-side-cardinality-saturated endpoints.

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

### Archive integrity

Database triggers propagate archives so active relationships are not silently orphaned. The relationship archive RPC serializes removals and performs the final-edge required check in the same transaction.

### Atomic contextual creation

The `create_custom_object_record_with_relationships` function is `SECURITY DEFINER`, has a fixed `search_path`, and is executable only by `service_role`. It derives the new record endpoint from the trusted object ID and accepts only a definition ID, new-record side, and related record ID for each edge. A failed insert or final required-relationship check rolls back the record, all earlier edges, and their trigger-created audit events.

### Public disclosure

Public preference-value routes first build a tenant-scoped allowlist excluding Custom Object fields, then constrain value reads to those IDs. Regression coverage lives in `api/_lib/publicCustomObjectDisclosure.test.mjs`; generic route registration and authentication are covered by `api/_lib/customObjectGenericAcceptance.test.mjs`.

---

## Frontend UI

`CustomObjectsAdmin.jsx` shows the tenant catalogue and generated schema controls. `CustomObjectRecords.jsx` renders lists, add/edit forms, details, archive actions, and permissions from object and field metadata. Relationship panels and pickers derive labels, endpoint kinds, visibility, and edit controls from definitions. Eligible cards place **Create {singular label}** beside **Add link** and open the contextual dialog without navigation. FormBuilder's Structured Record Actions editor uses the same active metadata and stores its configuration under a versioned Form property.

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

React Query keys are object-ID based (`custom-objects`, object, fields, records, relationship definitions/rows). Contextual creation invalidates the target object's record lists, the originating relationship rows and definition counts, and the originating record detail. The dialog closes only after success; failures leave field and relationship state in place. No cache key depends on “Department” or “Region”.

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

The MVP provides generic schema/record CRUD, generated forms, search, typed field filters, sorting, pagination, permissions, archive/audit behavior, generic pickers, Core/Custom Object relationships, and direct Organisation-to-Custom-Object dependent FormBuilder dropdowns. It does **not** provide CSV import/export workflows for Custom Object records, persisted saved views, cross-relationship query composition, multi-level form dependencies, reporting datasets, or communications segmentation.

Phase 2 must consume stable generic contracts rather than inspect JSON or add example-specific code:

| Integration | Handoff contract |
|-------------|------------------|
| CSV import | Address object by UUID; fetch field metadata; map columns to immutable field keys/IDs; validate through the same typed record service; resolve relationships by controlled IDs; return row-level validation and summary results |
| CSV export | Require `export_records`; preserve tenant/object scope; consume the same filter/sort/view specification; emit labels for headers while retaining stable metadata mapping |
| Saved views | Persist object UUID, visible field UUIDs/order, sort, and the existing field-ID-keyed filter grammar; tolerate archived fields without rewriting record data |
| Advanced relationship filtering | Express predicates with relationship-definition UUID, routed side, endpoint field UUID/operator/value, and bounded traversal depth; preserve tenant and capability checks at every hop |
| FormBuilder | Existing dependent dropdowns use saved object/field/relationship UUIDs and metadata snapshots; later create/update actions must submit to generic record services and never write JSONB directly |
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

### Problem: Historic field value appears but cannot be edited
**Symptom:** Read retains a key that write rejects.  
**Cause:** The field was archived or removed from active metadata; historic data is intentionally preserved.  
**Fix:** Reactivate/configure the field or omit the historic key while satisfying current required fields.

### Problem: Relationship dropdown stays disabled
**Symptom:** The respondent cannot select a related record.
**Cause:** No parent organisation is selected, the field configuration is incomplete, options are loading, the endpoint failed, or there are no active related records.
**Fix:** Select the parent organisation, confirm the saved parent/relationship metadata, and verify the active definition, object, primary field, edge, and record.

### Problem: A saved relationship displays “Unavailable record”
**Symptom:** Review or export output does not show the historic UUID or label.
**Cause:** The record, object, or primary field is archived/inactive, missing, cross-tenant, or otherwise unavailable.
**Fix:** Treat the submission UUID as retained history. Restore valid active metadata only if appropriate; output deliberately avoids exposing raw identifiers.