---
name: List pages with custom preference values
description: Why admin list pages must fetch/filter member_preference_value server-side per page, and how to filter across the child table with correct counts.
---

# List pages that show or filter custom (preference) field values

**Rule:** An admin list page (e.g. `/members`) that displays or filters custom
field values (`member_preference_value`, and by analogy `organization_preference_value`)
must fetch those values **server-side, scoped to the current page's row ids**, and
must apply custom-field filters **at the DB level** — never by pulling all values
client-side and filtering the current page.

**Why:** The generic entity `list()` (client/src/api/base44Client.js) and any plain
PostgREST select are capped at PostgREST's default **1000 rows**. A real tenant can
have far more values than that (one affected tenant had ~12.5k `member_preference_value`
rows for ~4k members). Fetching "all" values therefore silently truncates: most
members' custom columns render blank and any client-side custom-field filter only
matches within the current page, so cross-page matches vanish — even though the
single-record detail page looks correct (it only reads one member's values).

**How to apply (server, e.g. api/admin/members/paginated.js):**
- Display values: after computing the page of member ids, run a *second* query
  `member_preference_value` `.in('member_id', pageIds)` (optionally `.in('field_id', requestedFieldIds)`)
  and attach a per-row `custom_fields: {field_id: value}` map.
- Filtering: for each active custom filter add an **aliased inner join** on the child
  table so the join restricts AND counts across the whole tenant, not just the page:
  `select('..., cf0:member_preference_value!inner(field_id,value), cf1:member_preference_value!inner(...)')`
  then `.eq('cf0.field_id', id).eq('cf0.value', v)` for dropdowns, `.ilike('cf0.value', '%substr%')`
  for text-contains. Strip the `cf{n}` aliases from the response before returning.
- Anchor `member.tenant_id = tenantId` on the base query first so custom joins never
  widen tenant access. Cap the number of custom filters accepted (crafted-URL guard).
- Verified: inner-join `{count:'exact'}` equals the direct distinct child-row count
  (no row multiplication for single-value-per-field data), so pagination totals stay correct.
