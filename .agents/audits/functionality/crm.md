# CRM functionality source audit

**Review date:** 10 September 2026

**Scope:** Checked-out source only. No deployment, tenant data, live endpoint or role configuration was exercised.

## Audit outcome

Final list-column catalogue cross-check:
`client/src/pages/OrganisationsList.jsx:108-117` and
`client/src/pages/MembersList.jsx:108-115` supply core column names/defaults
now enumerated in the tenant report. Scope disclaimer explicitly excludes
deployment and named-tenant verification.

The source supports separate administrator-facing Organisation and Member list workflows with search, typed filters, sorting, personal saved views, configurable columns, detail records, explicit-selection deletion, and selected/all-filtered CSV export. Associated CRM data is handled in separate Organisation Group, Custom Object Record, Sales Opportunity and Sales Quote workspaces. Member/Organisation directories and public content search are distinct from administrator CRM search.

The tenant guide is `guides/crm-search-export-functionality.md`.

## Claim-to-source map

### Organisation list: UI to backend

| Claim | UI evidence | Backend / persistence evidence |
|---|---|---|
| 20-row list with list/card display and separate Organisation search | `client/src/pages/OrganisationsList.jsx` (list state, view toggle, pagination) | `api/admin/organizations/paginated.js:51-89` (default limit 20 and request contract) |
| Search is case-insensitive partial matching on name, invoicing email, phone and website | `client/src/pages/OrganisationsList.jsx` (search request construction) | `api/admin/organizations/paginated.js` (search predicate across those fields) |
| Group, core contact/address and configured custom-field filters | `client/src/pages/OrganisationsList.jsx` (filter definitions and serialization) | `api/admin/organizations/paginated.js`; `api/_lib/prefValueOptionFilter.js` |
| Organisation custom operators are text contains/not-contains/equals/empty/not-empty; option/country any-of/none-of/empty/not-empty; boolean Yes/No/empty/not-empty; at most 20 custom filters are applied | `client/src/lib/customFilterUtils.js:52-86`; controls in `client/src/pages/OrganisationsList.jsx` | `api/admin/organizations/paginated.js:115-140` |
| AND between active fields; OR inside any-of; negative option filters include missing values | UI operators: `client/src/lib/customFilterUtils.js` | Shared evaluation/query semantics: `api/_lib/prefValueOptionFilter.js`; export mirror in `api/admin/organisations/export-csv.js:175-183` |
| Sortable core fields but not group/address/custom fields | `client/src/pages/OrganisationsList.jsx` (column sort flags and sort controls) | `api/admin/organizations/paginated.js:45-48` and sort mapping in the same handler |
| Reorderable/hideable columns; name locked; configured custom columns | `client/src/pages/OrganisationsList.jsx` (column manager and required column) | `supabase/migrations/20260507_add_preference_field_admin_column_filter_flags.sql` (independent admin column/filter flags) |
| Personal named views save search, filters, sort, filter arrangement and columns | `client/src/pages/OrganisationsList.jsx:563-658` | `client/src/hooks/useSavedListViews.js` (per-user/per-page create, update, rename, delete and default lifecycle) |
| Current-page selection can become all filtered selectable records; primary organisation is excluded | `client/src/pages/OrganisationsList.jsx` (selection and selectable total logic) | `api/admin/organisations/export-csv.js` (filtered-all query and primary exclusion) |
| Delete applies only to explicit selection and requires typed confirmation | `client/src/pages/OrganisationsList.jsx:680-749,2148-2193` | `client/src/api/base44Client.js:124-128`; `api/entities/[entity]/[id].js:2846-3057` |
| Organisation deletion blocks the primary organisation, invalidates member sessions, removes selected member/organisation side data, anonymises and unlinks retained member rows, nulls preserved references and deletes the Organisation | Confirmation/count UI: `client/src/pages/OrganisationsList.jsx:680-702,2148-2193` | Full downstream branch: `api/entities/[entity]/[id].js:2846-3057`; generic request route: `client/src/api/base44Client.js:124-128` |

### Organisation export

| Claim | Evidence |
|---|---|
| Selected IDs ignore list filters; all-filtered replays search/group/core/custom filters | `client/src/pages/OrganisationsList.jsx:755-800`; `api/admin/organisations/export-csv.js:189-225` and query-building/streaming below |
| The control is available after signed-in access to the Organisation screen and a selected/all-filtered population; no distinct export feature gate is claimed | `client/src/pages/OrganisationsList.jsx:296,751-814,1567-1593`; `api/admin/organisations/export-csv.js:189-203` |
| Fixed core schema plus every active Organisation custom field, independent of visible columns | `api/admin/organisations/export-csv.js` (header construction and active preference-field loading); no visible-column parameter is sent by `client/src/pages/OrganisationsList.jsx` |
| Choice labels, Yes/No booleans and UTC dates | Formatting functions in `api/admin/organisations/export-csv.js` |
| 1,000-row streaming pages, expected-count validation, no discovered fixed total cap | Paging loop and expected-total comparison in `api/admin/organisations/export-csv.js`; exact count-only contract in `api/_lib/organisationExportContract.js:9-13`; UI supplies expected count in `client/src/pages/OrganisationsList.jsx` |
| Expected-total protection compares count only; same-count edits or substitutions are not snapshot-detected | `api/_lib/organisationExportContract.js:9-13`; `api/admin/organisations/export-csv.js:461-463` |
| Endpoint access caveat | `api/admin/organisations/export-csv.js:194-202` establishes authenticated tenant context but does not independently check the Organisation role feature. UI feature visibility is in `client/src/pages/OrganisationsList.jsx:296`. This discrepancy is recorded as unresolved below. |

### Member list: UI to backend

| Claim | UI evidence | Backend / persistence evidence |
|---|---|---|
| 50-row list with list/card display and separate Member search | `client/src/pages/MembersList.jsx` | `api/admin/members/paginated.js:30-48` |
| Search splits whitespace and requires every token to match one of first name, last name, email, mobile or job title | `client/src/pages/MembersList.jsx` request construction | `api/_lib/memberListFilters.js` search plan, consumed by `api/admin/members/paginated.js` |
| Search excludes organisation, department, role, biography, landline and custom fields | Same shared search plan contains no predicates for those values; cross-checked against `client/src/pages/MembersList.jsx` |
| Filters include login state, organisation, department, role, Phone (stored mobile number), job title, member custom fields and related-organisation custom fields | `client/src/pages/MembersList.jsx:414-428,1107-1158` and filter inventory | `api/_lib/memberListFilters.js`; `api/admin/members/paginated.js` |
| Exact operators are organisation/role is/is-not/empty/not-empty; department any selected; Phone/mobile and job-title text contains/not-contains/equals/empty/not-empty; custom fields with configured choices any-of/none-of/empty/not-empty; fields without choices use text operators; booleans use Yes/No/empty/not-empty | `client/src/pages/MembersList.jsx:414-428,1060-1104,1107-1162,1163-1310`; `client/src/lib/customFilterUtils.js:52-86` | `api/_lib/memberListFilters.js` |
| Query bounds are 100 values per organisation/department/role filter, 20 member custom filters, 20 organisation custom filters, 10 direct filters | `api/_lib/memberListFilters.js` validators |
| Configurable columns and personal full-list views | `client/src/pages/MembersList.jsx` | `client/src/hooks/useSavedListViews.js`; `supabase/migrations/20260507_add_preference_field_admin_column_filter_flags.sql` |
| Delete acts on explicit selection and requires `DELETE`; downstream operation anonymises the retained member row and removes or clears related personal-data records | `client/src/pages/MembersList.jsx:704-767,2139-2184` | `client/src/api/base44Client.js:124-128`; `api/entities/[entity]/[id].js:2834-2844`; `api/_lib/memberAnonymize.js:18-158` |
| Standalone Member deletion invalidates sessions, removes listed personal-data/activity rows and magic links, clears selected preserved references, scrubs personal fields, disables login/directory display and keeps the anonymised Member row for history | `api/_lib/memberAnonymize.js:4-16,18-158` |

### Member export

| Claim | Evidence |
|---|---|
| Selected IDs and all-filtered modes; list/export filtering stays aligned | `client/src/pages/MembersList.jsx:769-814`; shared `api/_lib/memberListFilters.js`; `api/admin/members/export-csv.js:190-229` |
| The control is available after signed-in access to the Member screen and a selected/all-filtered population; no distinct export feature gate is claimed | `client/src/pages/MembersList.jsx:769-814,1804-1829`; `api/admin/members/export-csv.js:190-203` |
| Fixed core schema plus all active Member custom fields | Header construction and custom-field loading in `api/admin/members/export-csv.js` |
| Member custom option fields serialize stored values rather than resolving configured display labels; arrays are semicolon-separated; custom booleans become Yes/No | `api/admin/members/export-csv.js:45-69` |
| Related Organisation custom fields can filter but are not output columns | Filtering uses `api/_lib/memberListFilters.js`; export header/value construction in `api/admin/members/export-csv.js` includes Member custom fields only |
| 1,000-row pages, expected-count mismatch protection, no discovered fixed total cap | Export paging/count logic in `api/admin/members/export-csv.js`; exact count-only contract in `api/_lib/memberExportContract.js:9-13` |
| Expected-total protection compares count only; same-count edits or substitutions are not snapshot-detected | `api/_lib/memberExportContract.js:9-13`; `api/admin/members/export-csv.js:325-328` |
| Endpoint access caveat | `api/admin/members/export-csv.js:195-203` establishes authenticated tenant context but does not independently check the Member role feature. UI access is role-gated in `client/src/pages/MembersList.jsx`. |

### Detail, history and activity

| Claim | Evidence |
|---|---|
| Organisation tabs and conditional Commercial, Notes, Forms, Documents, Membership and configured relationships | `client/src/components/OrganisationDetailView.jsx` |
| Organisation admin edit/layout/rules/logo controls; role-filtered members and add/invite | `client/src/components/OrganisationDetailView.jsx` |
| Organisation recent activity is bounded: 15 displayed; booking loading samples first 10 members and retains up to 20 before final rendering | Activity loading/render logic in `client/src/components/OrganisationDetailView.jsx` |
| Organisation notes have search, attachments, edit/delete and 5-per-page presentation | Notes section in `client/src/components/OrganisationDetailView.jsx` |
| Member tabs cover Overview, Activity, Roles, Categories, Opening Balances, Notes, Communications and conditional Membership/relationships | `client/src/components/MemberDetailView.jsx` |
| Member activity includes bookings, check-ins, group join/leave and opportunity activity; unified booking/group/check-in stream is latest 50 | `client/src/components/MemberActivityTimeline.jsx` |
| Member notes are searchable/editable/deletable and shown 5 per page | `client/src/components/MemberDetailView.jsx` |

### Organisation Groups

| Claim | Evidence |
|---|---|
| Separate role-gated list/card workspace; group name/description search; description/custom filters; sorting; 20/page; create/edit/delete | `client/src/pages/OrganisationGroups.jsx:42-60,134-176,285-390,567-740` |
| Description and text-like/number/date custom fields use contains/not-contains/equals/empty/not-empty; choice/country fields use any/none/empty/not-empty; booleans use Yes/No/empty/not-empty. Filters combine with AND and positive multi-value choices with OR. | `client/src/lib/customFilterUtils.js:52-86`; `client/src/pages/OrganisationGroups.jsx:291-362,567-740` |
| Sorting is ascending/descending by name, description, organisation count or created date; custom fields are not sortable; page size is 20 | `client/src/pages/OrganisationGroups.jsx:42-60,364-390,1000-1009` |
| Group deletion detaches organisations rather than deleting them | Deletion confirmation/action in `client/src/pages/OrganisationGroups.jsx` and its group mutation path |
| No named saved views; columns are browser-local | `client/src/pages/OrganisationGroups.jsx` has local column persistence and no `useSavedListViews` usage |
| Export button ignores list query and calls whole-hierarchy export | `client/src/pages/OrganisationGroups.jsx:497-521,871-880` |
| Hierarchy export requires authenticated admin plus Organisation Group feature access | `api/admin/organisation-groups/export-hierarchy-csv.js:8-18` |
| Export includes all tenant groups, grouped organisations and active linked departments; empty levels remain represented | `api/_lib/organisationGroupHierarchyExport.js:19-77,95-161` |
| CSV columns are Group, Group UUID, Organisation, Organisation UUID, Department, Department UUID | `api/_lib/organisationGroupHierarchyExport.js:79-92` |
| Source data is paged by 1,000 with no fixed total cap found | `api/_lib/organisationGroupHierarchyExport.js:3-13,95-141` |

### Custom Object Records

| Claim | UI evidence | Backend / persistence evidence |
|---|---|---|
| Separate configured record-type lists with 10/25/50/100 page sizes, archive toggle, columns, filters and personal scoped views | `client/src/pages/CustomObjectRecords.jsx:343-543`; `client/src/pages/customObjects/recordListHelpers.mjs:169-221` | `api/_lib/customObjectService.js:1239-1325` |
| Search is one case-insensitive partial phrase across readable active text, textarea, email, URL, dropdown and country fields | Search UI/query: `client/src/pages/CustomObjectRecords.jsx`; exact type set and server plan: `api/_lib/customObjectService.js:60-70,303-405` |
| Scalar filter operators are type-specific; separate field filters combine through sequential predicates | `client/src/pages/CustomObjectRecords.jsx` filter controls | `api/_lib/customObjectService.js:310-405` |
| Relationship any/none/empty/not-empty filters and supported relationship sorting | Metadata/control consumption in `client/src/pages/CustomObjectRecords.jsx` | `api/_lib/customObjectService.js:672-803,1239-1315`; relationship-list RPC migration is the authoritative database implementation |
| Records are active-only by default; archive option includes archived rows | `client/src/pages/customObjects/recordListHelpers.mjs:169-220` | `api/_lib/customObjectService.js:1256-1259` |
| View/create/edit/archive/export and field read/write are separately governed | Capability-driven UI in `client/src/pages/CustomObjectRecords.jsx`; permission editor at `:1331-1337` | `api/_lib/customObjectService.js:631-669,913-945,1330-1360,3630-3709` |
| Archive, rather than hard delete | Detail action in `client/src/pages/CustomObjectRecords.jsx:1235-1326` | record update/archive path in `api/_lib/customObjectService.js:1801-1831` |
| Export follows current query, collects 1,000-row pages to total and emits visible columns | `client/src/pages/CustomObjectRecords.jsx:580-624` | `api/_lib/customObjectService.js:1328-1360` |
| Relationship labels are projected with a limit of three; CSV represents overflow | `api/_lib/customObjectService.js:823-877`; `client/src/pages/customObjects/recordListHelpers.mjs:97-114`; CSV use at `client/src/pages/CustomObjectRecords.jsx:603-609` |
| No fixed whole-export cap was found | UI loops until reported total (`client/src/pages/CustomObjectRecords.jsx:587-600`); server bounds each page, not total (`api/_lib/customObjectService.js:1328-1341`) |

### Associated Sales scope

| Claim | Evidence |
|---|---|
| Opportunities are separate from core Organisation/Member lists and offer table/kanban, stage, “My opportunities,” name search and personal browser-saved views | `client/src/components/sales/OpportunitiesWorkspace.jsx:139-229` |
| Opportunity search is name-only | `api/opportunities/index.js:61-64` |
| Non-admin list scope is owned or collaborator records; administrators get that scope when “My opportunities” is selected | `api/opportunities/index.js:27-43` |
| Opportunity detail includes collaborators, contacts, notes, documents, tasks, activity, stage history, quotes and allocations | `client/src/components/sales/OpportunitiesWorkspace.jsx:375-461` |
| Notes/tasks and relationship management use Opportunity edit/manage capabilities | `client/src/components/sales/OpportunitiesWorkspace.jsx:324-371,375-461`; capability projection through `client/src/lib/opportunityCapabilities.js` and `api/_lib/opportunityService.js:31-44` |
| No Opportunity list CSV control or endpoint was found | Cross-check of `client/src/components/sales/OpportunitiesWorkspace.jsx`, `api/opportunities/index.js`, `api/opportunities/[id].js` |
| Quotes provide 20-row pagination, text search and status filter | `client/src/components/sales/QuotesWorkspace.jsx:144-169` |
| Quote search covers quote number, customer reference and snapshotted organisation name | `api/_lib/salesQuote.js:161-180` |
| Quote status choices are draft, issued, sent, accepted, converted, rejected, declined, expired and superseded | `client/src/components/sales/QuotesWorkspace.jsx:144-169` |
| PDF is per non-draft quote, not list export | `client/src/components/sales/QuotesWorkspace.jsx:50-70,362-365,379-386`; `api/sales/quotes/[...path].js` PDF action |
| Sales read/manage capabilities are checked server-side | `api/opportunities/index.js:22-25`; `api/sales/quotes/[...path].js:45-63` |

### Directory and public-search distinction

| Claim | Evidence |
|---|---|
| Member Directory requires a logged-in member and filters out deleted/opted-out records; display fields and roles are configured separately | `client/src/pages/MemberDirectory.jsx:22-40,117-180,290-322`; `client/src/pages/MemberDirectorySettings.jsx` |
| Organisation Directory has separate display, exclusion, status/type, member-role, custom-field and filter settings | `client/src/pages/OrganisationDirectory.jsx:36-142`; `client/src/pages/OrganisationDirectorySettings.jsx:23-158` |
| Organisation Directory uses a dedicated result/metadata path rather than the administrator Organisation list | `client/src/pages/OrganisationDirectory.jsx:271-327`; `client/src/hooks/useOrganisationDirectory.js`; `api/organisation-directory/filters.js` |
| Public SearchResults is site/microsite content search, not joined CRM search | `client/src/pages/SearchResults.jsx:30-75`; public header search wiring in `client/src/components/layouts/PublicHeader.jsx` |

### Cross-cutting report/export facts

Evidence is owned by `.agents/audits/functionality/cross-cutting.md` and consumed without modifying that file:

- Data Export & Backup is visible but its current action returns failure and no file.
- AI report generation caps source retrieval at 500 raw rows.
- AI CSV contains all returned rows and generated columns (or first-row keys), not just the initial 20-row table; screen sorting does not change it (`client/src/pages/AIReports.jsx:532-563`).
- Shared Custom Object relationship reports can choose a start/row grain, relationship path up to six non-cycling steps, configured fields, relationship fields and distinct-related-record counts; columns can be reordered and relabelled. They have shared named configurations, 50-row previews and configured-population CSV export. Current exports are resumable 500-row chunks with no fixed overall row cap, subject to 10,000 expanded values per cell and 100,000 per processed page (`client/src/pages/customObjects/CustomObjectReports.jsx:59-194`; `api/_lib/customObjectService.js:3740-4015,4100-4145,4185-4560,4563-4695`).

## Negative-claim cross-checks

| Negative claim | Cross-check performed | Result |
|---|---|---|
| No combined Organisation/Member CRM search | Reviewed the two list pages and handlers; searched CRM/global search references; inspected `SearchResults` scope | Supported. Lists and contracts are separate. Global SearchResults is content-oriented. |
| No dedicated date-range filters in main CRM lists | Reviewed Organisation/Member filter definitions, operator utility and backend parsers | Supported. Date custom fields on these two lists do not receive range controls. |
| No XLSX/PDF list export for Organisations/Members | Searched both list pages and their export endpoints for XLSX/PDF and alternate export controls | Supported. CSV only. Per-quote PDF is separate Sales functionality. |
| No bulk update/archive in main lists | Reviewed selection/action toolbars and deletion flows on both list pages | Supported. Explicit-selection delete is the only list bulk mutation found. |
| Organisation Groups have no saved views | Searched the page for saved-view hook/component and reviewed local persistence | Supported. |
| Main CSVs have no fixed overall row cap | Reviewed export loops/page sizing and searched for terminal limits | No fixed total cap found; this is a source finding, not a performance guarantee. |
| No main-list export field chooser | Reviewed column dialogs, export handlers and backend parameters | Supported. Main exports use fixed schemas plus active same-entity custom fields. |
| Opportunities have no list CSV | Reviewed workspace and Opportunity API files; searched export controls | Supported. |

## Schema and migration evidence

- `supabase/migrations/20260507_add_preference_field_admin_column_filter_flags.sql` establishes separate administrator flags for custom fields as CRM columns and CRM filters, preserving prior visibility by default.
- Current Organisation and Member list endpoints use direct query/helper logic rather than a CRM filter RPC. No relevant Organisation/Member “filter RPC” migration was found.
- Custom Object relationship filtering/sorting does use dedicated relationship-list/projection RPCs, wired in `api/_lib/customObjectService.js:823-840,1260-1292`; the corresponding migrations define database semantics and bounded projection.
- Organisation Group hierarchy department rows depend on the active configured Department record type and its required Organisation relationship (`api/_lib/organisationGroupHierarchyExport.js:108-160`).

## Unresolved or unverified points

1. **Core CRM list/export role enforcement:** Organisation and Member pages are feature-gated in the UI, but the reviewed paginated and CSV handlers independently require authenticated tenant context only. No server-side Organisation/Member feature check is visible in those four handlers. The guide therefore states role dependence at product level without claiming those endpoints enforce the role restriction.
2. **Runtime scale:** “No fixed total cap found” means no terminal source limit was identified. Runtime, infrastructure, browser memory and timeout constraints were not tested.
3. **Directory exposure:** Directory configuration and source separation were checked sufficiently to distinguish directories from CRM. All possible tenant-specific field combinations and dynamic-directory variants were not catalogued.
4. **Custom Object relationship RPC internals:** Service wiring and bounded projections were reviewed. Database migrations were used as schema evidence, but no database was invoked.
5. **Sales Quote list access scope:** The Quotes endpoint requires Sales view capability and tenant scope. Unlike Opportunities, the reviewed quote list does not add owner/collaborator row scoping.
6. **Deployment state:** Migrations, configuration, permissions, custom fields, record types and feature flags may differ in any deployed environment; none were inspected.