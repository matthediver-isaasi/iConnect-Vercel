# BNMS Department Relationship Setup

**Author:** Replit Agent
**Last Updated:** September 2026
**Module:** Data Studio — Custom Object relationships

---

## Table of Contents

1. [Overview](#overview)
2. [Live BNMS Audit](#live-bnms-audit)
3. [Required Relationship Graph](#required-relationship-graph)
4. [Data Studio Setup](#data-studio-setup)
5. [Picker Path Reference](#picker-path-reference)
6. [Verification Procedure](#verification-procedure)
7. [Safeguards and Existing Data](#safeguards-and-existing-data)
8. [Frontend and API Behaviour](#frontend-and-api-behaviour)
9. [Database Reference](#database-reference)
10. [Troubleshooting](#troubleshooting)

---

## Overview

BNMS limits the **Organisation Departments** offered on a Member record to Departments owned by that Member's **secondary Organisations**. It does not use the Member's primary Organisation for this restriction. The same card displays each Department's directly linked owning **Organisation** in a separate column so duplicate Department names remain distinguishable.

The picker compares two relationship paths. Starting from an **Organisation department**, one path reaches its owning **Organization**. Starting from a **Member**, the other path reaches the Member's secondary **Organization** records through **Member organisation assignments**. A Department is eligible only when the paths intersect at the same Organization record.

This guide records the BNMS configuration audited on 5 September 2026 and the repository-managed Organisation-column update. The column migration changes relationship presentation metadata only; it does not alter Department, Member, Organisation, or relationship-edge records.

---

## Live BNMS Audit

### Tenant

| Property | Live value |
|---|---|
| Tenant name | BNMS |
| Tenant slug | `bnms` |
| Tenant ID | `ff2df806-b321-4254-b651-3af11fccf1db` |

### Relevant Custom Objects

| Permanent key | Singular label | Plural label | Status | Assessment |
|---|---|---|---|---|
| `org_department` | Organisation department | Organisation departments | Active | Correct Department endpoint |
| `member_organisation_assignment` | Member organisation assignment | Member organisation assignments | Active | Correct bridge between Member and secondary Organisation |
| `department_type` | Department Type | Department Types | Active | Related to Departments, but not part of picker scoping |

Both required objects have active primary display fields, so they can define and participate in relationships.

### Relevant Relationship Definitions

| Key | Source endpoint | Source panel label | Target endpoint | Target panel label | Cardinality | Required | Display | Editing | Status | Assessment |
|---|---|---|---|---|---|---|---|---|---|---|
| `organisation` | Organisation department | Organisations | Organization | Departments | Many to one | Yes | Both sides | Both sides | Active | Correct Department → owning Organization path |
| `members` | Organisation department | Members | Member | Organisation Departments | Many to many | No | Both sides | Both sides | Active | Correct direct relationship; picker scope is configured |
| `assignment_member` | Member organisation assignment | Member | Member | Secondary organisation assignments | Many to one | Yes | Both sides | Both sides | Active | Correct Member bridge |
| `assignment_organisation_v2` | Member organisation assignment | Secondary organisation | Organization | Secondary member assignments | Many to one | Yes | Both sides | Source only | Active | Correct secondary Organization bridge |
| `assignment_organisation` | Member organisation assignment | Secondary organisation | **Member** | Secondary members | Many to one | Yes | Both sides | Source only | Archived | Incompatible legacy definition; do not use or reactivate |
| `department_type` | Organisation department | Department Type | Department Type | Departments | Many to one | Yes | Both sides | Both sides | Active | Unrelated to picker scope |

**Important:** Data Studio displays the core endpoint as **Organization** even though BNMS panel labels use British spelling such as **Organisations**.

### Current Picker Scope

The live `members` definition already has **Limit choices through linked records** enabled with picker-scope version 2 and intersection matching.

```text
Source: Organisation department
  -- Organisations → Departments -->
Organization

Target: Member
  -- Secondary organisation assignments → Member -->
Member organisation assignment
  -- Secondary organisation → Secondary member assignments -->
Organization
```

Both paths end at the core **Organization** endpoint. The graph is therefore compatible and saveable.

### Current Card Columns

The Member-side **Organisation Departments** card uses the Department as its primary **Record** column and configures one direct-relationship preview column:

| Column | Source | Stored identity |
|---|---|---|
| Organisation | Active `organisation` relationship traversed from its Department/source side | Relationship definition ID plus `side: source` |

The value is resolved from active relationship edges at read time. It is not copied into Department JSON, so Organisation renames and relationship changes appear without synchronizing duplicate data.

### Live Data Findings

| Check | Result |
|---|---:|
| Active Departments with an owning Organisation | 324 |
| Active secondary-Organisation assignments | 1 |
| Incomplete assignments missing either Member or Organization link | 0 |
| Members represented by a secondary-Organisation assignment | 1 |
| Active direct Member–Department links | 353 |
| Active direct links not supported by a current secondary-Organisation assignment | 353 |
| Linked Departments missing an owning Organisation | 0 |

The 353 existing direct links are grandfathered. Enabling the graph rule does not automatically archive or remove existing links. New links and restored archived links must satisfy the scope.

---

## Required Relationship Graph

The required model has three active path definitions plus the direct relationship being restricted:

```text
Organisation department
  ├─ organisation ───────────────→ Organization
  └─ members ────────────────────→ Member

Member organisation assignment
  ├─ assignment_member ──────────→ Member
  └─ assignment_organisation_v2 ─→ Organization
```

The direct `members` relationship compares:

```text
Department's Organizations
INTERSECT
Member's Secondary organisations
```

The result must contain at least one identical Organization record. Matching labels or names is not sufficient; both paths must reach the same stored Organization ID.

### Primary Organisation Is Deliberately Excluded

The source path does not compare against `member.organization_id`. A Member's primary Organisation neither grants nor removes Department choices under this configuration. Only active **Member organisation assignment** records linked through `assignment_member` and `assignment_organisation_v2` participate.

---

## Data Studio Setup

The live BNMS tenant is already in the desired state. Use these instructions to inspect or reconstruct the configuration; do not save changes unless a separately approved change request authorises it.

### 1. Confirm the Custom Objects

1. Open **Data Studio**.
2. Open **Custom Objects**.
3. Open **Organisation departments**.
4. On **Overview**, confirm:
   - status is **Active**;
   - permanent key is `org_department`;
   - an active primary display field is selected.
5. Return to **All custom objects**.
6. Open **Member organisation assignments**.
7. On **Overview**, confirm:
   - status is **Active**;
   - permanent key is `member_organisation_assignment`;
   - an active primary display field is selected.

An archived or draft object cannot supply selectable active relationship steps.

### 2. Confirm the Department Ownership Relationship

1. In **Organisation departments**, open the **Relationships** tab.
2. Find the active relationship with key `organisation`.
3. Open **Edit** and confirm:
   - **Direction A — source**
     - Record type: **Custom object**
     - Custom object: **Organisation departments**
     - Panel label: **Organisations**
     - Show panel: on
     - Allow editing here: on
   - **Direction B — target**
     - Record type: **Organization**
     - Panel label: **Departments**
     - Show panel: on
     - Allow editing here: on
   - Cardinality: **Many to one**
   - Required link: on
   - Availability: **Active**

### 3. Confirm the Secondary Assignment Relationships

In **Member organisation assignments** → **Relationships**, confirm both definitions.

#### Member side

| Field | Selection |
|---|---|
| Relationship key | `assignment_member` |
| Source | Custom object: Member organisation assignments |
| Source panel label | Member |
| Target | Member |
| Target panel label | Secondary organisation assignments |
| Cardinality | Many to one |
| Required link | On |
| Show panels | Both on |
| Editing | Both sides on |
| Availability | Active |

#### Secondary Organisation side

| Field | Selection |
|---|---|
| Relationship key | `assignment_organisation_v2` |
| Source | Custom object: Member organisation assignments |
| Source panel label | Secondary organisation |
| Target | Organization |
| Target panel label | Secondary member assignments |
| Cardinality | Many to one |
| Required link | On |
| Show panels | Both on |
| Editing | Source on; target off |
| Availability | Active |

Do not select the archived `assignment_organisation` definition. Its target is **Member**, not **Organization**, so it cannot produce the required endpoint.

### 4. Confirm the Direct Member–Department Relationship

1. Return to **Organisation departments** → **Relationships**.
2. Find the active relationship with key `members`.
3. Open **Edit** and confirm:
   - source is **Organisation departments**, panel label **Members**;
   - target is **Member**, panel label **Organisation Departments**;
   - cardinality is **Many to many**;
   - Required link is off;
   - both panels are shown;
   - editing is allowed from both sides;
   - Availability is **Active**.
4. Confirm **Limit choices through linked records** is on.
5. Confirm the exact source and target paths in the next section.
6. Under **Related record preview** → **Relationship columns**, confirm **Organisations (Organization)** is selected.
7. On a Member record, confirm the card has separate **Record** and **Organisation** headings and that Organisation names are clickable.

---

## Picker Path Reference

### Source Path

The source starts at **Organisation department**.

1. Add **Organisations → Departments**.
2. Confirm the path reports that it reaches **Organization**.

Actual live stored traversal:

```json
[
  {
    "relationship_definition_id": "30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e",
    "from_side": "source"
  }
]
```

### Target Path

The target starts at **Member**.

1. Add **Secondary organisation assignments → Member**.
   - This traverses `assignment_member` in reverse, from its target Member endpoint to its source assignment endpoint.
2. Add **Secondary organisation → Secondary member assignments**.
   - This traverses `assignment_organisation_v2` forward, from assignment to Organization.
3. Confirm the path reports that it reaches **Organization**.

Actual live stored traversal:

```json
[
  {
    "relationship_definition_id": "601544ca-9db9-498e-bd03-0af5e2c2e8a0",
    "from_side": "target"
  },
  {
    "relationship_definition_id": "184b26ff-c918-4162-98c4-1e16fde737ad",
    "from_side": "source"
  }
]
```

The editor stores these immutable relationship-definition IDs, while the UI presents the labels above. Both paths must be non-empty, contain no unavailable or disconnected step, avoid loops, use no definition twice, and finish at the same endpoint type.

---

## Verification Procedure

Use dedicated test records where possible. Do not change a real Member's primary Organisation as part of this test.

### Test Data

Prepare:

- **Organization A** with **Department A1** and optionally **Department A2**;
- **Organization B** with **Department B1**;
- a test **Member M**;
- one **Member organisation assignment** linking Member M to Organization A.

Ensure each Department has exactly one active `organisation` link to its owning Organization. Ensure the assignment has both required links: `assignment_member` to Member M and `assignment_organisation_v2` to Organization A.

### Expected Picker Results

1. Open Member M.
2. Open the **Organisation Departments** relationship panel.
3. Choose the action to add a related Department.
4. Confirm:
   - Department A1 is offered;
   - Department A2 is offered, if created;
   - Department B1 is not offered.
5. Add Department A1 and save. The link should succeed.
6. Attempt to add Department B1 through any available write path. It should be absent from the picker; a direct write should be rejected as outside the configured picker scope.
7. Add a second complete secondary assignment from Member M to Organization B.
8. Reopen the picker and confirm Department B1 is now offered.
9. Archive or remove the Organization B assignment.
10. Reopen the picker and confirm Department B1 is no longer offered for a new link.

### Expected Card Results

1. Link two Departments with the same primary label to different Organisations.
2. Open a Member linked to both Departments.
3. Confirm both rows retain the shared Department label in the **Record** column.
4. Confirm the **Organisation** column shows the correct, distinct owning Organisation for each row.
5. Confirm each available Organisation name opens its Organisation record.
6. Temporarily test a Department without an accessible owning link and confirm the cell displays `—` without exposing a hidden record or breaking the rest of the card.

**Existing-link note:** If Department B1 was linked before the assignment was removed, the picker rule does not automatically remove that historical active link. Cleanup requires a separate reviewed operation.

### Member with No Secondary Organisations

A Member with no complete active secondary assignment should see no eligible Departments. This is expected under the secondary-only rule, even if the Member has a primary Organisation.

---

## Safeguards and Existing Data

### Data Studio Validation

The editor permits saving version 2 scope only when:

- matching mode is `intersects`;
- source and target paths are both non-empty;
- every relationship step is active and connected in the selected direction;
- both terminal endpoints match.

### Database Write Guard

Migration `supabase/migrations/20260929_relationship_picker_graph_paths.sql` adds a deferred constraint trigger that evaluates both paths for every new or restored active relationship edge. If there is no common terminal record, the write fails with:

```text
Related record is outside the configured picker scope
```

### Existing Links Are Not Reconciled

The migration intentionally applies the new generic guard to new or restored links. It removes the earlier primary-Organisation-specific triggers because those would reject valid secondary-Organisation links and could archive links when a primary Organisation changes.

The live audit found 353 active links unsupported by current secondary assignments. This guide does not alter them. Review and cleanup, if desired, must be separately approved.

### Prerequisite Outside Data Studio

Data Studio can configure picker paths but cannot install the database enforcement function and trigger. The destination database must have `20260929_relationship_picker_graph_paths.sql` applied.

The live picker configuration matches that migration's BNMS setup, but a REST configuration audit cannot independently prove that the trigger exists. Verify migration history or inspect the destination database trigger before relying on direct-SQL enforcement. Do not silently apply the migration during a tenant configuration task.

---

## Frontend and API Behaviour

### Key Files

| File | Purpose |
|---|---|
| `client/src/pages/CustomObjectsAdmin.jsx` | Data Studio object workspace and Relationships tab |
| `client/src/pages/customObjects/RelationshipDefinitions.jsx` | Relationship editor and source/target path controls |
| `client/src/pages/customObjects/relationshipHelpers.js` | Endpoint matching, traversal direction, loop prevention, and active-step resolution |
| `api/_lib/customObjectService.js` | Tenant-scoped relationship definition and record operations |
| `client/src/pages/customObjects/RelatedRecordsPanel.jsx` | Responsive headed relationship-card columns and related-record links |
| `client/src/pages/customObjects/recordHelpers.js` | Normalizes stable relationship-column metadata |
| `supabase/migrations/20260930_bnms_department_card_organisation_column.sql` | Pinned, idempotent BNMS Organisation-column configuration |
| `supabase/migrations/20260929_relationship_picker_graph_paths.sql` | Generic path-intersection write guard and pinned BNMS picker configuration |
| `supabase/migrations/20260926_bnms_member_departments_many_to_many.sql` | Earlier many-to-many conversion and legacy primary-Organisation picker restriction |
| `supabase/migrations/20260827_bnms_department_many_to_one.sql` | Department ownership cardinality conversion |

### UI Behaviour

- Relationship endpoints and cardinality are immutable after creation.
- Only active Custom Objects appear as selectable endpoints.
- Only active relationship definitions can be added to a path.
- A path can contain at most three hops.
- The relationship currently being edited is excluded from its own scope paths.
- Selecting a hop in reverse displays its target label first.
- A legacy picker restriction appears as **Legacy picker restriction** and must be explicitly replaced with relationship paths.
- Relationship columns are limited to active one-hop relationships attached directly to the related Custom Object.
- Existing cards without relationship columns retain their legacy compact secondary-text preview.
- On narrow screens, each value repeats its column label within the row; on wider screens, labels appear in a shared header.

### API Entry Points

The Relationships tab loads all definitions, including inactive history, for the current object. The editor separately loads the active relationship graph so the path controls cannot select draft or archived definitions. Saving sends the complete relationship definition configuration through the tenant-scoped Custom Object API.

---

## Database Reference

### `custom_object_definition`

Stores tenant-owned Custom Object schemas.

| Relevant column | Purpose |
|---|---|
| `tenant_id` | Tenant isolation |
| `object_key` | Immutable object identity |
| `singular_label`, `plural_label` | Data Studio labels |
| `primary_display_field_id` | Record label field required for activation |
| `status` | Draft, active, or archived lifecycle |
| `configuration` | Presentation configuration |

### `custom_object_relationship_definition`

Stores the graph schema and picker scope.

| Relevant column | Purpose |
|---|---|
| `relationship_key` | Immutable relationship identity |
| `source_kind`, `target_kind` | Core or Custom Object endpoint types |
| `source_custom_object_id`, `target_custom_object_id` | Custom Object endpoint IDs where applicable |
| `cardinality` | One/many limits in each direction |
| `source_label`, `target_label` | Panel and path labels |
| `is_required` | Whether a source record requires a link |
| `show_on_source`, `show_on_target` | Panel visibility |
| `edit_from_source`, `edit_from_target` | Editing availability |
| `status` | Draft, active, or archived |
| `configuration.picker_scope` | Versioned intersection paths |
| `configuration.compact_preview.<side>_columns` | Ordered scalar/direct-relationship card columns |

### `custom_object_relationship`

Stores relationship edges.

| Relevant column | Purpose |
|---|---|
| `tenant_id` | Tenant isolation |
| `relationship_definition_id` | Definition governing the edge |
| `source_record_id`, `target_record_id` | Endpoint record IDs |
| `archived_at` | Null for an active edge |

---

## Troubleshooting

### Problem: No relationship step is available

**Symptom:** A path editor says, "No active relationship continues from this record type."

**Cause:** The needed definition is missing, draft, archived, starts at a different endpoint, or uses the wrong Custom Object.

**Fix:** Confirm the exact active definitions in the audit table. For the Member path, use `assignment_member` from its **target** side, then `assignment_organisation_v2` from its **source** side.

### Problem: The target path ends at Member

**Symptom:** The path cannot be saved because its endpoint does not match the source path's Organization endpoint.

**Cause:** The archived `assignment_organisation` definition was used or re-created with target **Member**.

**Fix:** Use active `assignment_organisation_v2`, whose target endpoint is **Organization**. Do not reactivate the incompatible legacy definition.

### Problem: The path is reversed or disconnected

**Symptom:** The editor reports an unavailable or disconnected relationship.

**Cause:** A hop was selected from the wrong side.

**Fix:** Use these directions exactly:

- `organisation`: from **source**;
- `assignment_member`: from **target**;
- `assignment_organisation_v2`: from **source**.

### Problem: Legacy picker restriction is shown

**Symptom:** The relationship editor shows **Legacy picker restriction** instead of two path editors.

**Cause:** The definition still contains the earlier core-field restriction based on `organization_id`.

**Fix:** Choose **Replace with relationship paths**, then configure the exact BNMS source and target paths above. Save only after both paths end at **Organization**.

### Problem: No Departments appear for a Member

**Symptom:** The Organisation Departments picker is empty.

**Cause:** The Member has no complete active secondary assignment, the assignment uses the archived relationship, the Department has no active owning Organisation link, or the paths do not share the same Organization record.

**Fix:** Confirm a complete **Member organisation assignment** exists with active links to both the Member and the intended Organization. Confirm the Department's **Organisations** link points to that exact Organization.

### Problem: Unrelated existing Departments remain linked

**Symptom:** A Member still displays a Department that is no longer reachable through a secondary Organisation.

**Cause:** Existing links are grandfathered; picker scoping does not reconcile them.

**Fix:** Do not assume the configuration failed. Review those links separately and archive only through an approved cleanup process.

### Problem: Picker filtering works but a direct write succeeds

**Symptom:** The UI excludes an unrelated Department, but another write path creates the link.

**Cause:** The database path-guard migration or trigger may be absent.

**Fix:** Verify `20260929_relationship_picker_graph_paths.sql` in destination migration history and inspect the `custom_object_picker_scope_v2_guard_trigger`. This prerequisite cannot be repaired through Data Studio.

### Problem: Organisation column is empty

**Symptom:** The Department row appears, but its **Organisation** cell displays `—`.

**Cause:** The Department has no active `organisation` edge, the relationship definition is inactive, or the current user cannot view the linked endpoint.

**Fix:** Confirm the Department has one active owning Organisation relationship and that the viewing role can access every Custom Object endpoint involved. Inaccessible values are intentionally omitted rather than leaked.