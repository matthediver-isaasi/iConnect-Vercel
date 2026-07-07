# Member AI Structured Q&A

**Author:** Replit Agent
**Last Updated:** July 2026
**Module:** Member AI Assistant

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [How a Question Flows Through the System](#how-a-question-flows-through-the-system)
4. [The Whitelist Catalog (STRUCTURED_ENTITIES)](#the-whitelist-catalog-structured_entities)
5. [Query Spec Validation](#query-spec-validation)
6. [Visibility Predicates](#visibility-predicates)
7. [Executors](#executors)
8. [Preference (Custom) Fields](#preference-custom-fields)
9. [Aggregations](#aggregations)
10. [Security Invariants](#security-invariants)
11. [How to Add a New Entity](#how-to-add-a-new-entity)
12. [How to Add a Field to an Existing Entity](#how-to-add-a-field-to-an-existing-entity)
13. [Database Tables](#database-tables)
14. [Data Flow Diagrams](#data-flow-diagrams)
15. [Tests](#tests)
16. [Troubleshooting](#troubleshooting)

---

## Overview

Structured Q&A lets the member AI assistant answer numerical and aggregate questions — "how many schools are in South Africa?", "what's the average available seats per event type?", "breakdown of members by region" — from **live database records** rather than from the indexed text used by the RAG (retrieval) side of the assistant.

The core design principle is: **the LLM never writes SQL**. Instead, an LLM "planner" fills in a small, whitelisted **query spec** (entity + approved filter fields + aggregation + optional group-by and date range). That spec is validated against a hand-maintained catalog (`STRUCTURED_ENTITIES`) and then executed by a tenant-scoped executor that applies the asking member's visibility rules — mirroring exactly what that member could see by browsing the portal directly. If the planner produces anything outside the whitelist, the assistant says plainly that it can't answer, rather than guessing.

The user-facing behaviour: a member asks a count/total/breakdown-style question in the AI assistant; the answer comes back as a short natural-language reply (with a markdown list for breakdowns), and the numbers in it always come straight from the executor — never computed or estimated by the model. Content questions (and any planner failure) fall through to the normal RAG path unchanged.

**Scope note:** this guide covers the structured (database-count) path only. The RAG side — content indexing, embeddings, vector search, and the chunk-level visibility boundary — is a separate system: see `api/_lib/memberContentVisibility.js`, `api/_lib/memberAiRanking.js`, and the indexer under `api/_lib/`. Its security model is analogous (retrieval IS the boundary) but implemented independently.

---

## Architecture

### Key Files

| File | Purpose |
|------|---------|
| `api/_lib/memberAiStructured.js` | Everything structured: the `STRUCTURED_ENTITIES` catalog, `validateQuerySpec`, visibility predicates, filter matching, aggregation helpers, executors, `executeQuerySpec`, planner prompt builders, `templateStructuredAnswer` |
| `api/member-ai/ask.js` | The endpoint. Routes questions: regex pre-gate → planner LLM → validate → execute → synthesize. Falls back to RAG for content questions |
| `api/_lib/memberAiStructured.test.mjs` | Unit tests for all pure exports (validation, visibility, matching, aggregation, templating, catalog) |
| `api/_lib/memberAiStructuredSchemaDrift.test.mjs` | Schema drift guard: introspects the destination DB and asserts every whitelisted table/column still exists |
| `api/_lib/memberFeatureAccess.js` | Resolves the member's RBAC exclusions; provides `canAccessFeature(key)` used for the per-entity feature gate |

### Design Principles

1. **The whitelist is the boundary** — the LLM can only reference entities and fields in `STRUCTURED_ENTITIES`; anything else is rejected before any query runs, so prompt injection cannot reach arbitrary data.
2. **Visibility filtering happens BEFORE aggregation** — rows the asking member could not see in the portal are removed before any count/sum is computed, so aggregates can never leak the existence of hidden records.
3. **Feature gating per viewer** — each entity carries a `featureKey` mirrored against the member's RBAC exclusions; a member whose role excludes the events feature cannot count events either.
4. **Fail closed** — unknown entity, unknown field, unmappable question, unpublished directories, executor error: every failure path returns a refusal or a plain "can't answer" message, never a partial or guessed number.
5. **Numbers come from the executor, never the model** — the synthesis LLM only phrases results; if it fails, a deterministic template (`templateStructuredAnswer`) phrases them instead.
6. **Always paginate** — PostgREST caps responses at 1000 rows; `fetchAllRows` pages through results (hard cap 25 pages = 25k rows) so a truncated page is never counted as a full set.

---

## How a Question Flows Through the System

All of this lives in the handler of `api/member-ai/ask.js` (Task #2419 section) plus the exports of `memberAiStructured.js`.

1. **Regex pre-gate** — `looksLikeStructuredQuestion(question)` tests the question against `STRUCTURED_HINT_RE` (phrases like "how many", "breakdown", "average", "sum of", "highest capacity"…). Content questions skip straight to RAG with zero extra cost.
2. **Fetch preference fields** — `fetchStructuredPrefFields(supabase, tenantId)` loads the tenant's active, directory-visible custom fields so the planner can resolve tenant vocabulary ("schools" → a custom field value).
3. **LLM planner** — `planStructuredQuery` (in `ask.js`) sends `buildPlannerMessages(question, prefFields)` to the chat model at temperature 0. The prompt embeds a human-readable catalog (`buildPlannerCatalog`) of every entity, field, and custom field. The planner returns either `{structured: false}` (fall through to RAG), or `{structured: true, spec: {...}}`, or `{structured: true, spec: null}` (structured but unmappable).
4. **Validation** — `validateQuerySpec(spec, { prefFields })` normalises and whitelists the spec (see [Query Spec Validation](#query-spec-validation)). Rejection → the assistant answers with `STRUCTURED_UNMAPPABLE_ANSWER` (a plain refusal), never a guess.
5. **Execution** — `executeQuerySpec({ supabase, tenantId, spec, viewer })` runs the feature gate, dispatches to the entity's executor, and returns `{ok: true, result}` or `{ok: false, reason}`.
6. **Synthesis** — `synthesizeStructuredAnswer` (in `ask.js`) asks the chat model to phrase the result JSON, under strict instructions to only state numbers present in the results. On any failure, `templateStructuredAnswer(result)` produces a deterministic phrasing.
7. **Response** — `{ answer, sources: [], grounded: true, structured: true }`. Refusals return `grounded: false`.

**Key details:**
- Any planner LLM/parse failure returns `null` → the question silently falls through to RAG. Structured routing can never break content answering.
- Execution refusals and spec rejections are logged with `console.warn` (tenant id + reason) so production stock answers are diagnosable.

---

## The Whitelist Catalog (STRUCTURED_ENTITIES)

`STRUCTURED_ENTITIES` in `api/_lib/memberAiStructured.js` is the single source of truth for what the assistant may query. Each entry has this shape:

```text
<entityKey>: {
  table:               the real Postgres table name
  label:               human description embedded in the planner prompt
                       (this is how the LLM picks the entity — make it rich
                       with synonyms, e.g. "organizations / companies / institutions")
  featureKey:          RBAC feature key gated per viewer (or omit for ungated)
  prefScope:           'organization' | 'member' | null — whether tenant
                       custom fields apply, and from which scope
  directoryEntityType: (directory entities only) 'member' | 'organization'
  aggregateOnly:       true for bookings — counts only, never row values
  nativeFields: {      whitelisted columns usable as filters / group-by
    <column>: { type: 'text'|'array'|'numeric', groupable: bool }
  },
  dateFields: {        whitelisted date columns usable for dateRange
    <column>: true
  },
}
```

The current entities (post Task #2424):

| Entity | Table | Feature key | Notes |
|--------|-------|-------------|-------|
| `organization` | `organization` | `membership.organisation-directory` | Directory-gated; org custom fields; excluded-org list applies |
| `member` | `member` | `membership.member-directory` | Directory-gated; member custom fields; deleted placeholders always excluded |
| `event` | `event` | `events.browse-events` | `available_seats` numeric field; `start_date` date range |
| `complex_event` | `complex_event` | `events.browse-events` | Same as event plus stricter `event_state` visibility |
| `resource` | `resource` | `content.resources` | Group + role gated; `release_date` date range |
| `booking` | `booking` | `events.browse-events` | **aggregateOnly** — see below |
| `complex_event_booking` | `complex_event_booking` | `events.browse-events` | **aggregateOnly** |

**Note:** the booking entities' `event_title` / `event_start_date` fields are **derived** — they are not columns on the booking tables. The executors resolve them by joining visible events in JS. The drift test's `DERIVED_FIELDS` map records which real (table, column) each derived field resolves from.

The planner prompt is generated from this catalog by `buildPlannerCatalog(prefFields)`, so adding a field or entity here **automatically advertises it to the LLM** — numeric fields are annotated "usable with sum/avg/min/max", groupable fields "groupable", and each tenant's custom fields are listed with their options.

---

## Query Spec Validation

`validateQuerySpec(raw, { prefFields })` is pure (no DB) and returns `{ok: true, spec}` (normalised) or `{ok: false, reason}`. Rules:

- **Entity** must exist in `STRUCTURED_ENTITIES`.
- **Aggregation** must be `count`, `count_by`, or one of `NUMERIC_AGGREGATIONS` (`sum`/`avg`/`min`/`max`).
- **Numeric aggregations**:
  - refused outright on `aggregateOnly` entities (min/max would expose row-level values from other members' bookings);
  - require `field` to resolve to a native column with `type: 'numeric'` (preference fields are never numeric);
  - `field` is forbidden for `count`/`count_by`.
- **groupBy**: required for `count_by`, optional for numeric aggregations (grouped sum/avg/min/max), forbidden for plain `count`. Native columns must be `groupable: true`; preference fields are always groupable.
- **Filters**: max `MAX_FILTERS` (4). Each must resolve via `resolveField` — a native column, or (only when the entity has a `prefScope`) a preference field referenced as `pref:<id>`, raw id, or case-insensitive label. Ops limited to `eq`/`contains`. Values must be non-empty strings/numbers, max `MAX_FILTER_VALUE_LEN` (200) chars — object values (e.g. `{$ne: null}` injection attempts) are rejected.
- **dateRange**: only on columns listed in the entity's `dateFields`; requires a parseable `from` and/or `to`.

The normalised spec's filters and groupBy carry a `kind` discriminator (`'column'` vs `'preference'`) that the executors branch on.

---

## Visibility Predicates

Each predicate is a pure exported function that **mirrors an existing member-facing browse surface**. This mirroring is the contract: if the portal page would not show a row to this member, the count must not include it.

| Predicate | Mirrors | Rules |
|-----------|---------|-------|
| `isMemberRowVisible(row)` | `api/public/dynamic-directory.js` member base filter | Hidden when `show_in_directory === false`, `login_enabled === false`, or the email matches the soft-deleted pattern `deleted_*@deleted.local` |
| `isOrgRowVisible(row, {excludedOrgIds})` | Org directory surface | Hidden when the org id is in the tenant's `org_directory_excluded_orgs` system setting |
| `isEventRowVisible(row, {isAdmin, groupIds})` | `api/public/events.js` + `memberContentVisibility.js` | Status must be `published`/`tbc`; `event_state === 'draft'` never visible (even to admins); group events visible only to group members unless `group_event_public === true` (admins bypass group gating) |
| `isComplexEventRowVisible(row, ctx)` | `api/public/complex-events.js` | All event rules, plus `event_state` restricted to `null`/`active`/`closed` |
| `isResourceRowVisible(row, {isAdmin, roleId, groupIds})` | `api/public/resources.js` | Status must be `active` (even for admins); group-gated by `member_group_id`; role-gated by non-empty `allowed_role_ids` (admins bypass member gating) |
| `isPrefFieldDirectoryVisible(field)` | Directory pages' `parseVisibility` / `isVisibleInMain` | A custom field is member-visible when its `directory_visibility` JSON includes `'main'`, falling back to `show_in_directory_card` (org scope) / `show_in_member_directory` (member scope); inactive fields never visible; malformed JSON falls back to the flags |

Directory entities (member/organization) additionally go through `resolveDirectoryRestriction`, which reproduces what the tenant's `dynamic_directory` rows expose:

- **No `dynamic_directory` rows** → legacy directory: unrestricted (subject to the base predicates + feature gate).
- **Rows exist but none active** → the tenant has deliberately unpublished the directories: the executor **refuses** with `no_directory` ("This data is not exposed in any directory").
- **An active unfiltered directory exists** → unrestricted.
- **Only filtered directories** → the visible set is the union of the entity ids whose preference values match each directory's `filter_field_id`/`filter_value`.

---

## Executors

`executeQuerySpec` first applies the **feature gate** (`catalogEntry.featureKey` vs `viewer.canAccessFeature(key)`), then dispatches. Every executor:

1. fetches rows tenant-scoped (`.eq('tenant_id', tenantId)`) via `fetchAllRows` (paginated),
2. applies the visibility predicate (skipped/relaxed for admins where the surface allows),
3. applies the spec's native/date filters (`applyNativeAndDateFilters`) and preference filters (`applyPrefFilters`),
4. builds the result via `buildResult`.

### `execDirectoryEntity` (organization, member)

- Non-admins: resolves the directory restriction and (orgs only) the excluded-org set, then filters by the row predicate and restriction set.
- Admins: skip directory gating, but soft-deleted member placeholders are still excluded ("even admins shouldn't count deleted accounts").
- Preference value maps are fetched only for the fields the spec actually references (`prefFieldIdsInSpec`).

### `execEvents` (event, complex_event)

- `fetchVisibleEvents` selects only `status IN ('published','tbc')` at the DB level, then applies the row predicate per viewer. Selected columns include `available_seats` for the numeric aggregations.

### `execResources`

- Selects `status = 'active'` at the DB level, then applies group/role gating per viewer.

### `execBookings` (booking, complex_event_booking) — aggregate-only

Bookings never expose attendee identities or row values:

- **Defense-in-depth throw**: the executor re-checks `NUMERIC_AGGREGATIONS.has(spec.aggregation)` and throws even though `validateQuerySpec` already refuses it.
- First resolves the **visible events** for this viewer, applies event-level filters (`event_title`, `event_start_date` — the derived fields), then counts only `status = 'confirmed'` booking rows whose `event_id` is in the visible set. Only `event_id, status` are ever selected from the booking tables.
- `count_by` groups by event title (via the id→title map from the visible events), never by any attendee attribute.
- Zero visible events short-circuits to a zero result without touching the booking tables.

**Error handling:** the `no_directory` error code becomes a clean refusal; any other executor error is logged and returned as a generic `Query failed` refusal — never a partial number.

---

## Preference (Custom) Fields

Tenant custom fields (`preference_field`) participate as filters and group-bys on the two directory entities:

- **Which fields qualify**: `fetchStructuredPrefFields` loads active fields scoped `member`/`organization` and keeps only those passing `isPrefFieldDirectoryVisible` — i.e. **only fields a member could see in the directory pages**. A field an admin hid from the directory cannot be queried through the AI either.
- **Storage semantics**: values live in `organization_preference_value` / `member_preference_value` (`field_id`, `organization_id`/`member_id`, `value`). Values are TEXT: plain strings or JSON-stringified arrays for multi-selects. `prefValueEntries` normalises both shapes; `matchesPrefValue` implements case-insensitive `eq` (exact entry match) and `contains` (substring).
- **Multi-select group-by**: a row with several selected values counts once **per value** (same semantics as the directory filters). Empty/null values bucket under `(not set)`.
- **Planner exposure**: `buildPlannerCatalog` lists up to 40 custom fields per scope with up to 20 options each, as `"pref:<id>" = "<label>" (options: ...)`, so the planner maps tenant vocabulary to field references.

---

## Aggregations

### `count`
`{ total, groups: null, truncated: false, appliedFilters }` — the row count after all filtering.

### `count_by` (`groupAndCount`)
Groups sorted by count desc, then value asc. Truncated to `MAX_GROUPS` (25) **with** an `(other)` bucket summing the tail (safe for counts).

### `sum` / `avg` / `min` / `max` (`computeNumericAggregate`, `groupAndAggregate`) — Task #2424
- Only on native columns declared `type: 'numeric'` (currently `available_seats` on event/complex_event).
- Null/empty/non-numeric values are **skipped**; `valueCount` reports how many rows actually contributed. Empty input → `value: null` (never `NaN`, never 0-as-average).
- Ungrouped shape: `{ total, aggregation, field, value, valueCount, groups: null, ... }`.
- Grouped shape: groups `{ value, count, aggregate }` sorted by aggregate desc; truncated to `MAX_GROUPS` **without** an `(other)` bucket — a combined bucket is meaningless for avg/min/max.

### Deterministic fallback (`templateStructuredAnswer`)
Handles every result shape (count, breakdown, ungrouped numeric, grouped numeric, zero-contributor numeric) with fixed phrasing, including the applied-filters note and truncation notes. Exported from the lib so it is unit-tested.

---

## Security Invariants

State these plainly; every change to this module must preserve them:

1. **The whitelist is the security boundary.** The LLM only ever fills a spec; `validateQuerySpec` rejects anything not in `STRUCTURED_ENTITIES` / the tenant's visible preference fields. No spec, no query.
2. **Visibility filtering happens BEFORE aggregation.** Every executor filters rows down to what the asking member could browse, then aggregates. A count can never reveal hidden rows' existence.
3. **Feature gating is per viewer.** `executeQuerySpec` refuses when the viewer's RBAC excludes the entity's `featureKey` — mirroring the browse surfaces' gating.
4. **Tenant hard scope.** Every fetch is `.eq('tenant_id', tenantId)` off the authenticated session's tenant context. No cross-tenant reads.
5. **Aggregate-only entities never expose row values.** Bookings support only `count`/`count_by`; numeric aggregations are refused at validation AND thrown in the executor; only `event_id, status` are selected.
6. **Fail closed.** Unmappable question → plain refusal answer. Unpublished directories → refusal. Executor error → generic refusal. Never a guess, never a partial result.
7. **Numbers never come from the model.** Synthesis is phrasing-only; the deterministic template is the fallback.

---

## How to Add a New Entity

Follow these steps in order. The example throughout is a hypothetical `news_post` entity.

### 1. Choose the member browse surface to mirror

Before writing anything, identify the **member-facing page/endpoint** that lists this entity (e.g. `api/public/news.js`). Its filtering rules are your visibility contract. If there is no member-facing surface, the entity does not belong in this catalog.

### 2. Add the catalog entry

In `STRUCTURED_ENTITIES`:

```js
news_post: {
  table: 'news_post',
  label: 'news posts / announcements',        // rich synonyms — this is how the planner picks it
  featureKey: 'content.news',                  // the RBAC key gating the browse surface
  prefScope: null,                             // custom fields only apply to member/organization
  nativeFields: {
    title: { type: 'text', groupable: false },
    category: { type: 'text', groupable: true },
    // numeric fields get sum/avg/min/max automatically:
    // view_count: { type: 'numeric', groupable: false },
  },
  dateFields: { published_at: true },
},
```

Decisions to make:
- **`label`**: include the synonyms members actually use — the planner prompt is built from this.
- **`featureKey`**: must match the key the browse surface is gated by (see `roleAccessMap` / `memberFeatureAccess`). Wrong key = wrong members can/can't count.
- **`nativeFields`**: only columns the member surface actually exposes. Mark `groupable: true` only for low-cardinality categorical columns (grouping by a free-text title produces junk). `type: 'array'` for Postgres arrays / JSON-stringified arrays (matching uses per-entry semantics). `type: 'numeric'` opts the field into sum/avg/min/max.
- **`dateFields`**: date columns members can meaningfully range over.
- **`aggregateOnly: true`** if row values must never surface (see bookings): numeric aggregations will be auto-refused, and your executor must only ever return counts.

### 3. Write (or reuse) a visibility predicate

Add an exported pure predicate `isNewsPostRowVisible(row, ctx)` that reproduces the browse surface's rules exactly — status flags, group gating, role gating, whatever the surface does. Keep it pure so it is unit-testable without a DB.

### 4. Write the executor and register it in `executeQuerySpec`

```js
async function execNewsPosts({ supabase, tenantId, spec, viewer, catalogEntry }) {
  let rows = await fetchAllRows(() =>
    supabase
      .from('news_post')
      .select('id, title, category, status, published_at')  // whitelist + visibility columns ONLY
      .eq('tenant_id', tenantId)                             // tenant hard scope
      .eq('status', 'published')                             // push cheap visibility into the DB query
  );
  rows = rows.filter((r) => isNewsPostRowVisible(r, viewerCtx));
  rows = applyNativeAndDateFilters(rows, spec, catalogEntry);
  return buildResult(spec, rows, catalogEntry, new Map());   // empty prefMaps when prefScope: null
}
```

Then add the dispatch branch in `executeQuerySpec`. Rules:
- Select only the columns you need (catalog fields + visibility columns + `id`). Every selected column must be added to the drift test (step 6).
- Always use `fetchAllRows` — never a bare `.select()` (1000-row cap).
- Visibility filter **before** `applyNativeAndDateFilters` / `buildResult`.
- If the entity has `prefScope`, fetch `fetchPrefValueMaps(supabase, scope, prefFieldIdsInSpec(spec))` and run `applyPrefFilters` (see `execDirectoryEntity`).
- If `aggregateOnly`, start the executor with the defense-in-depth throw on `NUMERIC_AGGREGATIONS.has(spec.aggregation)` (see `execBookings`).

### 5. Check the regex pre-gate

`STRUCTURED_HINT_RE` gates whether the planner runs at all. If the new entity introduces question phrasings the regex misses (e.g. "how many announcements"), extend the regex — generic "how many X" is already covered, but aggregation nouns (like "total seats") were added explicitly for numerics.

### 6. Update the schema drift guard

In `api/_lib/memberAiStructuredSchemaDrift.test.mjs`:

- Add the entity's table to `EXECUTOR_SELECTED_COLUMNS` with **exactly** the columns your `.select(...)` string uses. There is a test asserting every catalog table is declared here, so forgetting it fails loudly.
- If any catalog field is **not** a real column on the entity's own table (derived via a join, like `booking.event_title`), map it in `DERIVED_FIELDS` to the real `{table, column}` it resolves from.

### 7. Write unit tests

In `api/_lib/memberAiStructured.test.mjs` (pure exports only, no DB mocking):

- `validateQuerySpec` accepts/rejects specs for the new entity (fields, ops, groupability, date fields, pref behaviour).
- The visibility predicate: every rule of the mirrored surface, including the admin bypasses and the cases admins do NOT bypass.
- `buildPlannerCatalog` advertises the new entity/fields as expected.

Run the whole suite: `node --test api/_lib/*.test.mjs` (also registered as the `ai-assistant-tests` validation step). The drift tests skip locally without `DEST_DATABASE_URL`; they run for real in CI/validation.

### 8. Sanity-check the planner end to end

Ask the assistant a few phrasings ("how many news posts this year?", "breakdown of news by category") and confirm: structured routing fires, the spec validates, counts match what the member surface shows, and a member whose role excludes the feature gets the refusal.

---

## How to Add a Field to an Existing Entity

The `available_seats` addition (Task #2424) is the reference example:

1. **Confirm member visibility first.** The column must be returned to members by the browse surface (for `available_seats`: `api/public/events.js` returns it unconditionally). If the surface hides or conditions it, the AI must not aggregate it.
2. Add it to the entity's `nativeFields` (or `dateFields`) with the right `type`/`groupable`. A `numeric` type automatically enables sum/avg/min/max and advertises that in the planner catalog.
3. Add the column to the executor's `.select(...)` string if it isn't already fetched.
4. Add the column to `EXECUTOR_SELECTED_COLUMNS` in the drift test.
5. Extend `STRUCTURED_HINT_RE` if the field brings new aggregate phrasings (e.g. "total seats", "highest capacity").
6. Unit tests: validation accepts the field where it should, rejects it where it shouldn't (e.g. numeric field on `count_by` groupBy if not groupable).

---

## Database Tables

The structured path **reads** these tables (it writes nothing):

### Entity tables
`organization`, `member`, `event`, `complex_event`, `resource`, `booking`, `complex_event_booking` — only the columns listed in `EXECUTOR_SELECTED_COLUMNS` (drift test) are ever selected.

### `preference_field`
Tenant custom field definitions.

| Column | Type | Use here |
|--------|------|----------|
| `id` | uuid | Referenced as `pref:<id>` in specs |
| `label` | text | Case-insensitive resolution + planner catalog |
| `entity_scope` | text | `member` / `organization` — must match the entity's `prefScope` |
| `field_type`, `options` | text | Options surfaced to the planner |
| `is_active` | bool | Inactive fields never resolvable |
| `directory_visibility` | text (JSON) | Member-visibility source of truth (`'main'` id) |
| `show_in_directory_card` / `show_in_member_directory` | bool | Per-scope fallback flags |

### `organization_preference_value` / `member_preference_value`
| Column | Type | Use here |
|--------|------|----------|
| `organization_id` / `member_id` | uuid | Join key back to the entity row |
| `field_id` | uuid | **Note:** the column is `field_id` (not `preference_field_id`) |
| `value` | text | Plain string or JSON-stringified array |

### `dynamic_directory`
| Column | Type | Use here |
|--------|------|----------|
| `entity_type` | text | `member` / `organization` |
| `is_active` | bool | Zero rows = legacy/unrestricted; rows-but-none-active = refuse |
| `filter_field_id`, `filter_value` | uuid / text | Defines the visible subset per directory |

### `system_settings`
Row `setting_key = 'org_directory_excluded_orgs'` — JSON array of org ids excluded from the org directory (and therefore from org counts for non-admins).

---

## Data Flow Diagrams

### Happy path (count question)

```text
Member asks "how many schools are in South Africa?"
  → looksLikeStructuredQuestion? ✓ (regex pre-gate)
    → fetchStructuredPrefFields (active + directory-visible custom fields)
    → planner LLM fills spec:
        {entity: organization, aggregation: count,
         filters: [{field: "pref:<school-type-id>", op: eq, value: "School"},
                   {field: address, op: contains, value: "South Africa"}]}
      → validateQuerySpec ✓ (whitelist + pref scope + ops + value length)
        → executeQuerySpec
          → feature gate: viewer.canAccessFeature('membership.organisation-directory') ✓
          → resolveDirectoryRestriction (dynamic_directory rows)
          → fetchAllRows(organization, tenant-scoped, paginated)
          → visibility filter (excluded orgs, directory restriction)   ← BEFORE aggregation
          → native + preference filters
          → buildResult → { total: 42, appliedFilters: [...] }
        → synthesis LLM phrases it (numbers from result JSON only)
          → LLM failed? → templateStructuredAnswer (deterministic)
        → { answer, structured: true, grounded: true }
```

### Refusal paths

```text
Planner says structured but spec invalid (unknown field, bad op, ...)
  → validateQuerySpec {ok: false}
    → log warn (tenantId + reason)
    → answer = STRUCTURED_UNMAPPABLE_ANSWER, grounded: false   ← never a guess

Directories exist but all unpublished
  → resolveDirectoryRestriction throws {code: 'no_directory'}
    → executeQuerySpec {ok: false, reason: "not exposed in any directory"}
    → STRUCTURED_UNMAPPABLE_ANSWER

Planner LLM error / parse failure / says "content question"
  → planStructuredQuery returns null
    → falls through to the RAG path (structured routing can never break RAG)
```

### Aggregate-only (bookings)

```text
"How many people booked the Annual Conference?"
  → spec {entity: booking, aggregation: count,
          filters: [{field: event_title, op: contains, value: "Annual Conference"}]}
    → execBookings
      → throw if numeric aggregation (defense-in-depth; validation already refused)
      → fetchVisibleEvents for THIS viewer          ← visibility first
      → filter events by event_title / event_start_date (derived fields)
      → no visible events? → zero result, booking tables untouched
      → fetch bookings: select event_id, status only, status = confirmed,
        event_id IN (visible ids)                    ← no attendee data ever selected
      → count (or group by event title)
```

---

## Tests

### Unit suite — `api/_lib/memberAiStructured.test.mjs`

Runs with `node --test api/_lib/*.test.mjs` (no DB, no LLM mocking — only pure exports). Covers: whitelist validation (entities, fields, ops, value shapes, filter caps, pref scope/inactive rejection, groupability, date fields, numeric-agg rules), every visibility predicate against its mirrored surface's rules, pref value parsing/matching, `groupAndCount` / `computeNumericAggregate` / `groupAndAggregate` (including truncation semantics), `templateStructuredAnswer` for every result shape, the regex pre-gate, and `buildPlannerCatalog`.

### Schema drift guard — `api/_lib/memberAiStructuredSchemaDrift.test.mjs`

The catalog is a hand-maintained whitelist; if a migration renames or drops a whitelisted column, the assistant silently degrades to "I can't answer that" with no signal. This suite introspects the **real destination database** (`DEST_DATABASE_URL` pooler, or `DATABASE_URL` fallback) and asserts:

- every catalog table exists;
- every `nativeFields`/`dateFields` entry is a real column — or, for derived fields, that the real `{table, column}` in `DERIVED_FIELDS` exists;
- every column in `EXECUTOR_SELECTED_COLUMNS` (the executors' `.select(...)` strings) is real;
- every catalog table is declared in `EXECUTOR_SELECTED_COLUMNS` (forces the map to be updated when an entity is added).

Without DB credentials (or with an unreachable host) the suite **skips with an explicit warning** rather than passing silently.

**Maintenance rule:** any change to a `.select(...)` string or the catalog must update `EXECUTOR_SELECTED_COLUMNS` / `DERIVED_FIELDS` in lockstep.

### Validation step

The whole `api/_lib` suite is registered as the `ai-assistant-tests` validation step, so it runs automatically on task completion.

---

## Troubleshooting

### Problem: Assistant answers "I can't answer that from the data I have access to"
**Symptom:** A count-style question gets the stock refusal instead of a number.
**Cause:** The planner produced a spec outside the whitelist (check the `structured spec rejected` warn log for the reason), or execution was refused (`structured execution refused` log — e.g. feature gate, `no_directory`).
**Fix:** If the field genuinely should be queryable, add it to the catalog (see [How to Add a Field](#how-to-add-a-field-to-an-existing-entity)). If directories are unpublished, that refusal is intentional.

### Problem: Count-style question gets a RAG answer (or the content fallback) instead of a number
**Symptom:** No `structured: true` in the response; answer cites documents.
**Cause:** Either the regex pre-gate didn't match the phrasing (`looksLikeStructuredQuestion` returned false), or the planner classified it as a content question / errored (check `structured planner failed` warn logs).
**Fix:** Extend `STRUCTURED_HINT_RE` for legitimate phrasings; keep it narrow — every match costs a planner LLM call.

### Problem: AI count differs from what the member sees in the portal
**Symptom:** Directory shows N rows, the assistant says M.
**Cause:** A visibility predicate has drifted from its browse surface (the surfaces evolve; the predicates are mirrors, not shared code), or the directory restriction logic doesn't match the tenant's `dynamic_directory` setup. For members: remember multi-select group-bys count once per value, and `(not set)` buckets exist.
**Fix:** Diff the predicate against the current surface filter (files named in [Visibility Predicates](#visibility-predicates)); update predicate + unit tests together.

### Problem: Assistant silently stopped answering a previously-working question after a migration
**Symptom:** Stock refusal on questions that used to work; `Query failed` in logs.
**Cause:** A whitelisted column was renamed/dropped. This is exactly what the schema drift suite exists for.
**Fix:** Run `node --test api/_lib/memberAiStructuredSchemaDrift.test.mjs` from an environment with `DEST_DATABASE_URL`; fix the catalog/executor/drift-map to match the new schema.

### Problem: Numeric aggregation returns "None of the N matching records have a value"
**Symptom:** sum/avg/min/max answer says no values, even though rows matched.
**Cause:** All matching rows have null/empty/non-numeric values in the field — `computeNumericAggregate` skips them by design and reports `valueCount: 0` rather than treating nulls as 0.
**Fix:** Working as intended; check the underlying data if values were expected.

### Problem: A tenant custom field isn't usable in questions
**Symptom:** Planner rejects or never uses a custom field.
**Cause:** The field is inactive, scoped to the wrong entity, or not directory-visible (`isPrefFieldDirectoryVisible` — the AI only exposes fields members can see in directories). Also note the planner catalog caps at 40 fields per scope.
**Fix:** Make the field directory-visible if members should query it; that's the visibility contract, not a bug.
