# Internal functionality audit — dashboard and reporting

Review date: 10 September 2026. Source review only. No tenant, deployment, database, authentication, report-generation, download or mutation endpoint was exercised. This is an internal claim-to-source working paper, not tenant-facing documentation.

## Scope and method

- Read the complete supplied task brief and `.agents/skills/guide-writing/SKILL.md`. The required tenant-facing headings and language override the skill's developer-oriented guide structure.
- Traced the main dashboard from UI to widget services, permission logic, aggregation, schema and migration; separately traced the fixed Reports Dashboard to all seven reporting handlers.
- Integrated specialist findings from `cross-cutting.md` and the independently corrected `specialist-reports.md` in this directory. The rejected initial specialist matrix is not evidence.
- Existing guides were not used as evidence. No named tenant or live availability is certified.
- Intended output is documentation only: `guides/dashboard-reporting-functionality.md` and this audit note.

## Product surfaces distinguished

| Surface | Material claim | Evidence |
|---|---|---|
| Main dashboard widgets | Configurable shared and personal widgets render above the fixed portal welcome content. The widget area renders nothing when there are no visible widgets and the actor cannot manage either area. | `client/src/pages/Dashboard.jsx:83-87`; `client/src/components/dashboard/DashboardWidgetBuilder.jsx:191-220` |
| Portal summaries | Fixed cards show organisation name, training fund and sum of programme-ticket balances; unread inbox prompt is conditional on feature availability and positive count. | `client/src/pages/Dashboard.jsx:28-30,115-182` |
| Reports Dashboard | Separate fixed-card page with seven cards, Demo Data, show/hide, drag ordering and card-specific controls. | `client/src/pages/ReportsDashboard.jsx:54-64,2126-2503` |
| Specialist screens | AI report generation, custom-object shared relationship reports and Data Export & Backup are separate screens, not dashboard widgets. | `.agents/audits/functionality/cross-cutting.md:22-124` |

## Configurable dashboard claim matrix

### Builder catalogue and validation

| Claim | UI evidence | Service / validation evidence |
|---|---|---|
| Six display types: stat, bar, pie, donut, line, list | `WidgetBuilderModal.jsx:61-68` | `api/dashboard/_lib/validation.js:220-227` |
| Widths one-fifth, one-third, one-half, full; five heights through Huge | `WidgetBuilderModal.jsx:70-83`; grid spans in `WidgetGrid.jsx:23-28` | `validation.js:211-225` |
| Measures count, distinct count, sum, average, minimum, maximum | `WidgetBuilderModal.jsx:85-92` | `validation.js:44-50` |
| Time buckets day/week/month/quarter/year; rolling 1–120 periods | `WidgetBuilderModal.jsx:94-100` and rolling controls in the same component | `validation.js:52-72`; period alignment and zero fill in `api/dashboard/_lib/aggregation.js:1428-1533` |
| Filters: equality, inequality, contains, set membership, numeric/date comparisons, null tests and tenant LMIC/non-LMIC lists | `WidgetBuilderModal.jsx:102-131` | `validation.js:9-30`; matching in `aggregation.js:1326-1426` |
| Number format compact/full and 0–4 decimals; helper text max 1,000 | Builder format/helper controls; defaults at `WidgetBuilderModal.jsx:134-160` | `validation.js:114-120,172-181` |
| Title max 200; conversion target count max 20 and source cannot be target | Client builder save validation | `validation.js:127-141,182-227` |
| Live preview | debounced preview flow in `WidgetBuilderModal.jsx` and `/api/dashboard/widgets/preview` query | `api/dashboard/widgets/preview.js:1-44` invokes the same aggregation path after actor and payload validation |

Shape checks in the builder disallow group and time together; require time for lines; require group or time for bar/pie/donut; and require group for lists. Server schemas constrain accepted primitives, while aggregation errors protect unsupported runtime combinations. Tenant guide states these as user-facing conditions rather than implementation guarantees for arbitrary direct requests.

### Source catalogue

| Source | Verified fields / modes | Evidence |
|---|---|---|
| Organisations | ID, name, domain, country, derived region, created/last-synced dates, training fund, guest settings, purchase-order setting; active custom organisation fields | `api/dashboard/_lib/sources.js:53-82,508-589` |
| Members | ID, email, role, organisation, derived region, derived organisation type, active-in-period, login/directory flags, created and last-activity dates; active custom member fields | `sources.js:157-216,508-589` |
| Due Diligence submissions | current status, organisation, active DD form, org type, submitted/created dates, first-entry date for chosen stage; transition modes | `sources.js:83-156,353-387`; `validation.js:103-112`; DD path in `aggregation.js:1560-1940` |
| Event bookings | union of simple and complex bookings: status, event kind/name, linked organisation/booker, attendee email, ticket type, guest flag and booking date; organisation custom fields filter-only; participation split | `sources.js:217-270,508-589`; booking path in `aggregation.js:2189-2520` |
| Jobs | title/company/poster, status/type/hours/flags/payment/external/application/location/amount and four dates | `sources.js:271-328` |
| Form conversion | source plus up to 20 targets; organisation or lower-cased submitter-email matching; date filter applies to target submission | `sources.js:329-346`; `validation.js:122-141`; conversion path in `aggregation.js:1939-2188` |

Special semantics were verified in aggregation:

- active-in-period accepts one-sided or two-sided inclusive date bounds; null activity is inactive (`aggregation.js:783-816`);
- list-valued custom fields contribute all values for grouping/distinct count and use any-element matching (`aggregation.js:1038-1208,1326-1426`);
- region supports app and World Bank schemes and single Multi-region versus per-region expansion (`sources.js:9-40`; region helpers used in `aggregation.js`);
- DD transitions count history events, with first-entry stage dates for the synthetic field and repeated forward transitions remaining repeated (`aggregation.js:1560-1940`);
- booking participation is organisations with/without matching booking; unlinked bookings are absent from the organisation split (`aggregation.js:2189-2520`).

### Limits

| Limit | Evidence |
|---|---|
| 30 grouped chart rows, 500 list rows, 50 time buckets | `api/dashboard/_lib/aggregation.js:28-38,55-58,1496-1517` |
| 50,000-row scan ceiling; generic/DD/conversion sources reject on reaching it | `aggregation.js:38,216-248,1775-1797,1949-1973`; some booking combined guards use greater-than instead |
| Drill-down returns at most 2,000 IDs and a truncation flag | `api/dashboard/widgets/[id]/drilldown.js:7-9,77-92` |
| Helper text 1,000, title 200, decimals 0–4, rolling amount 1–120, conversion targets 20 | `validation.js:64-71,114-141,172-181,220-227` |

### Widget persistence, permissions and tenant settings

- Permission chain: role catalogue publishes Dashboard Builder plus separate shared/personal management features (`client/src/lib/roleAccessMap.ts:951-956`); server actor maps those three exclusions to `view`, `manageShared`, `managePersonal` (`api/dashboard/_lib/permissions.js:14-50`); widget list and mutations enforce actor/scope/owner checks (`api/dashboard/widgets/index.js`, `api/dashboard/widgets/[id].js`, `api/dashboard/widgets/reorder.js`).
- Shared and personal zones, create/edit/duplicate/delete/resize/reorder UI: `DashboardWidgetBuilder.jsx:63-189,212-349`; `WidgetGrid.jsx:72-147`.
- Persisted model includes tenant, scope, personal owner, title, type, width, height, JSON configuration, separate order and audit timestamps: `shared/schema.ts:1264-1292`.
- Original migration creates the owner/scope invariant and tenant/scope and owner/order indexes: `migrations/create_dashboard_widget.sql:10-36`.
- **Migration caveat:** the original migration's checks list only five types and three widths and lacks height (`create_dashboard_widget.sql:16-18`). A later migration adds fifth width (`migrations/add_fifth_widget_width.sql:10-18`), but the checked migration set contains no dashboard-widget migration adding list type or the height column, while current schema/validation include both. Deployed schema state was not established in this source-only pass. Do not claim deployment readiness from application validation alone.
- Shared managers can hide new builder field choices and configure five palette slots tenant-wide. Existing hidden-field widgets continue to work; slot labels are 1–40 chars and custom colours are six-digit hex: `GroupingFieldSettingsModal.jsx:26-31,144-219,231-299`; `api/dashboard/hidden-fields.js:26-117`; `shared/dashboardWidgetPalette.js:1-75`.

### Widget data, drill and CSV chain

- Loaded widget data: `WidgetCard.jsx` requests `/api/dashboard/widgets/{id}/data`; handler rechecks view/visibility and invokes `runWidgetConfig` (`api/dashboard/widgets/[id]/data.js`).
- Drill switch is shown only for supported groupings in the builder (`WidgetBuilderModal.jsx:1240-1252,1800-1817`); service computes the bucket using the same aggregation and caps IDs (`api/dashboard/widgets/[id]/drilldown.js`). Client destination mapping is in `client/src/components/dashboard/WidgetCard.jsx` and `widgetDrill.jsx`: organisations to organisation list, members to member list, bookings/participation to underlying organisations.
- CSV is generated client-side from already loaded aggregate output, not fetched raw rows (`WidgetCard.jsx:153-205,281-307`). Group/time is Label/Value; total row exists for bar/pie/donut but not line; stat is Metric/Value/Records; conversion is converted, one-decimal rate, source and not-converted.
- Export control is available after successful data load and is independent of `canEdit` (`WidgetCard.jsx:374-409`).

## Fixed Reports Dashboard trace

### Access, layout and preference behavior

- Page waits for member-access readiness and redirects if the page feature is excluded (`ReportsDashboard.jsx:2126-2166`). Role map aliases that page to dashboard view (`client/src/lib/roleAccessMap.ts:1207-1208`).
- The seven fixed-report handlers establish tenant context and reject requests without a tenant, but do not independently evaluate the dashboard-view role feature (`api/reports/member-stats.js:13-20`; `activity-stats.js:13-20`; `article-views-stats.js:61-68`; `resource-views-stats.js:13-20`; corresponding opening blocks in the three organisation-category handlers). Thus the documented role condition is the page/navigation control, unlike configurable widget handlers which re-evaluate widget permissions server-side. This distinction remains private because the tenant guide must omit security internals.
- Seven default visible cards are declared at `ReportsDashboard.jsx:54-64`; rendering dispatch at `2252-2337`; show/hide and drag UI at `2237-2250,2394-2499`.
- Preferences are browser-local and user/tenant-keyed (`2153-2220`). Persisted: card list/order, four headline card periods, Organisation Types selected field and view mode. Not persisted: demo mode, chart types, aggregation, New Organisations or Members-by-Organisation field/view controls. Tenant guide explicitly limits its persistence claim.
- Each card live query has 60-second stale time, no focus refetch, manual retry/refresh, and is disabled in demo mode (representative `395-455`; repeated for all cards).
- Demo datasets for all cards are constants at `83-393`; toggle at `2382-2392`; each query uses `enabled: !demoMode`, data switches to the constant and refresh is hidden. Hence “illustrative, not tenant data” is proven without a network call.

### Card calculations

| Card | UI | Backend and date semantics |
|---|---|---|
| Members | totals, active-status total, comparison and acquisition chart (`395-539`) | Tenant total and status=`active`; created-date rolling 7-day/1/3/12-month comparisons; chart day/day/week/month grouping (`api/reports/member-stats.js:22-125,127-222`) |
| Activity | latest activity counts, 90+-day inactive complement, monthly engagement, comparison/chart (`542-709`) | Last-activity thresholds at 1/7 days, 1/3 months; engagement is latest-month active / all members. “All” comparison value is actually active within latest three months, while all-time chart includes all non-null last activity (`activity-stats.js:22-149,151-252`). |
| Article Views | totals, recent, top five, comparison/chart (`711-897`) | Tenant article IDs; de-duplicate on article+viewer across all time before every count; today is local midnight, week/month rolling; top five all-time. “All” scalar is all time but chart starts two years ago (`article-views-stats.js:4-50,70-149,151-302`). |
| Resource Views | totals, type percentages, top five, comparison/chart (`917-1140`) | Raw view events (not de-duplicated) for tenant resources; distinct resource/viewer sets; today local midnight; top/type all-time; all scalar all-time but chart two years (`resource-views-stats.js:22-134,136-310`). |
| Organisation Types | selectable custom field, category totals, creation charts, client-side category aggregate (`1142-1464`) | All tenant custom organisation fields offered. Values normalised, blanks Unspecified, arrays multi-count; chart time is organisation creation date. Weekly is current Monday week, monthly/quarterly current calendar year, yearly all years, all-time aggregate (`org-type-stats.js:23-38,40-297`). |
| New Organisations | category year/month totals and creation charts (`1466-1799`) | Same field/value behavior; totals by current calendar year/month/Monday week/all-time and creation-date chart (`new-org-stats.js:23-327`). |
| Members by Organisation Type | member totals/categories and member-created chart (`1801-2124`) | Members connected to tenant organisations, grouped by selected organisation field; arrays multi-count and missing Unspecified; chart uses member creation date (`member-org-type-stats.js:23-299`). |

No fixed-card export control exists. Imported `Download` is used as a resource-type icon (`ReportsDashboard.jsx:899-915,1043-1085`), not file export.

## Specialist report evidence integrated

Source of record for this section: `.agents/audits/functionality/cross-cutting.md`.

### AI Report Generator

- Natural-language request/refinement, reset, generated metadata, summaries, chart and sortable table: cross-cutting lines 42-62, citing `client/src/pages/AIReports.jsx:65-181,308-761`.
- Conditional on page access, authenticated tenant administrator and configured AI provider; prompt max 2,000 characters and fixed reportable inventory: cross-cutting lines 48-56, citing `api/ai-reports/generate.js:19-189,336-518,624-672`.
- Material population caveat: fetch caps at 500 raw rows, and summary/chart calculations operate on that subset; chart first 50 entries: cross-cutting lines 57-65.
- CSV includes all returned rows/generated columns, not merely the initial 20 visible table rows; table sort is not applied. No XLSX/PDF, saved report or scheduler: cross-cutting lines 61-72.

### Custom Object shared relationship reports

- Shared named definitions can create/apply/update/rename/delete. Builder selects start/row path, path fields, relationship fields and row-relative distinct-related counts; path max six and no cycle: cross-cutting lines 74-101.
- Column order/headings and missing-related-row behavior are configurable; multi-values are semicolon joined. Preview is 50 rows/page: cross-cutting lines 89-103.
- Current-format CSV is the configured population/order, not preview or selected list rows; 500-row chunked browser-driven job with resumable progress and no fixed total cap found. Expansion guards are 10,000 values/cell and 100,000/page: cross-cutting lines 104-115.
- Older saved definitions retain synchronous semantics and may differ; no independent keyword/date/status filter panel and no inherited CRM filters: cross-cutting lines 116-122.

### Data Export & Backup

- UI advertises ZIP, all data and expiry, but dispatch reaches an unconditional `success: false` stub and generates no CSV/ZIP: cross-cutting lines 22-40, citing `client/src/pages/DataExport.jsx:18-119`, `client/src/api/functions.js:294-304`, `client/src/api/base44Client.js`, `api/functions/[functionName].js:5127-5129`.
- Repository search found no alternative implementation for that action. Tenant guide calls the screen not working while making no claim about external operational backup services.

## Negative-claim checks

Repository searches across `client/src/components/dashboard`, `client/src/pages/ReportsDashboard.jsx` and `api/dashboard` found:

- no dashboard-wide or cross-widget filter state;
- no named saved widget filter/view definitions;
- no raw-record or dashboard-level export endpoint for widgets;
- no fixed Reports Dashboard CSV/export action;
- no widget/fixed-dashboard Excel, PDF or print action;
- no schedule, delivery or automatic refresh configuration;
- no personal-widget sharing mechanism.

Positive controls found were only per-widget aggregate CSV, per-widget drill-down, per-card manual refresh, and the browser-local fixed-card preferences documented above. Specialist negatives are separately backed by cross-cutting lines 32-35, 67-72, 116-122.

## Unverified and deployment-dependent matters

- No deployed schema/migration history was inspected; the migration drift noted above is unresolved.
- No role assignment, custom field inventory, DD form, LMIC list, AI provider, tenant branding/terminology, data volume, data quality or tracking completeness was tested for a tenant.
- The fixed-report service authorization distinction above was identified by source inspection only; no direct-access behavior was exercised.
- No timezone policy beyond code behavior was established. Dashboard widget periods explicitly align in UTC; fixed reports mix rolling `Date` arithmetic, local calendar boundaries and UTC-formatted chart keys.
- Article/resource identity fields can be null; distinct-set behavior may count null as one viewer. This was not elevated into tenant prose because data collection semantics were not independently verified.
- The fixed activity card's “All Time” comparison scalar is the latest-three-month active count, and article/resource all-time charts are two-year views. These are documented as limitations rather than silently treated as all-time calculations.
- The original widget migration does not by itself prove support for every current validated type/size in a deployment.

## Handover status

Dashboard and specialist evidence has been integrated into the tenant guide.

Independent architectural review corrections:

- Fixed member-acquisition (`member-stats.js:127-215`), activity-trend
  (`activity-stats.js:151-240`) and organisation-category detail reads
  (`org-type-stats.js:99-132`) are not fully paginated. Guide now records the
  resulting large-population completeness boundary.
- Article deduplication runs before period filtering and keeps the first
  encountered pair without deterministic view-date ordering
  (`article-views-stats.js:4-49,118-149`). All-time pair counting does not
  establish reliable period pair counts. Guide no longer implies otherwise.
- Due Diligence specialist CSVs are not exact card cohort exports; the
  dedicated Due Diligence guide carries the independently checked rules.
- Form Conversion specialist dates filter both sides, unlike widget target
  date filters. Its per-form scan rejects at 50,000, not only above it.

No runtime or deployed-schema certification is implied.