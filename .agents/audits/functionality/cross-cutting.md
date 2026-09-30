# Internal functionality audit — cross-cutting evidence

Review date: 10 September 2026. Source review only; no tenant, deployment,
database, authentication, download or mutation endpoint was exercised.
This file is an internal audit working paper, not part of the tenant handover.
“Private” here means excluded from the three tenant reports, not a filesystem
security boundary.

## Scope and baseline

- The full supplied brief (304 lines) and guide-writing skill were read.
  The tenant-facing structure overrides the skill's developer architecture
  and schema sections.
- At the start, `replit.md` was already modified and two supplied brief text
  attachments were untracked. These are pre-existing changes, not audit output.
- Allowed output: the three requested guides and notes in this directory only.
- Other papers: `dashboard.md`, `crm.md`, `due-diligence.md` and
  `specialist-reports.md`. Each connects material claims to source behaviour.
- Existing guides and persistent memory are discovery aids, not authoritative
  evidence. No deployment or named-tenant availability is certified.

## Evidence checklist: Data Export & Backup

- [x] Initiating UI: `client/src/pages/DataExport.jsx:18-25,36-75,83-119`.
  Page visibility uses Data Export access. Start calls `exportAllData`, expects
  success plus a ZIP download link and expiry.
- [x] Call dispatch: `client/src/api/functions.js:294-304`, the functions
  invocation in `client/src/api/base44Client.js`, and
  `api/functions/[functionName].js:5127-5129`.
- [x] Actual implementation: handler unconditionally returns `success: false`
  and an error; it does not generate a CSV or ZIP.
- [x] Negative-claim cross-check: repository search for `exportAllData`
  (excluding documentation/attachments) found only the UI, API client and this
  handler. Do not mistake labels advertising “all data”, ZIP or one-hour
  expiry for delivered functionality.
- [x] Tenant wording: **Data Export & Backup is present as a screen, but its
  current export action does not produce a downloadable backup. Use the
  supported screen-specific exports described in this report.**
- [x] Do not reproduce the UI's sensitive-data warning or internal error text
  in tenant documentation. No claim about separate platform backup tools.

## Evidence checklist: AI Report Generator

- [x] UI: `client/src/pages/AIReports.jsx:464-761`.
  Natural-language request, example prompts, conversational refinement, New
  Report reset, title/description, row count, summary cards, chart and table.
  Reports live in screen state; no saved-report or scheduling control.
- [x] Service: `api/ai-reports/generate.js:19-189,336-460,463-518,624-672`.
  Requires authenticated tenant administrator and configured AI provider;
  page also checks AI Reports feature access. Request text max 2,000 characters.
  Supported data is a fixed inventory of records and allowed relationships,
  not arbitrary reportable content or custom fields.
- [x] Dates/filters: expressed in the request, interpreted into permitted
  field comparisons (equality/inequality, numeric/date comparisons, partial
  text, membership in a set, null); no fixed date-picker or universal CRM
  filter parity. No guarantee every natural-language request can be produced.
- [x] Measures: `AIReports.jsx:65-121,126-181`.
  Summary count/sum/average/min/max/distinct count; chart aggregation
  count/sum/average over returned rows, or unaggregated display.
- [x] Views: bar, line, pie and area charts; chart series limited to first
  50 resulting entries; sortable table initially shows 20, with Show all.
  Sorting is in-screen only (`AIReports.jsx:308-435`).
- [x] Material limit: service fetch caps at 500 raw rows
  (`generate.js:189,451-452`); summaries and charts operate on that returned
  subset, not an independently computed whole-population total.
- [x] Export: `AIReports.jsx:532-563`, CSV of all returned result rows and
  generated report columns (or keys from the first row if unspecified).
  Not just 20 visible rows; not a filtered-all CRM export; table sorting is not
  applied to this download. No export field-picker, XLSX or PDF action here.
- [x] Negative-claim cross-check: complete component and service handler,
  plus repository lookup of the generation endpoint; no report persistence
  or scheduled delivery path attached to this screen.

## Evidence checklist: Custom Object shared relationship reports

- [x] Entry and control access:
  `client/src/pages/CustomObjectsAdmin.jsx:520-539,728-733`;
  `client/src/pages/customObjects/CustomObjectReports.jsx:59-113,262-310`.
  Data-model management access and non-archived owner object enable controls.
  Service independently checks object record access/export capability and
  readable related fields; core Member/Organisation/Organisation Group
  participation requires tenant administrator access
  (`api/_lib/customObjectService.js:3740-4015,4563-4569`).
- [x] New definitions: `client/src/pages/customObjects/reportHelpers.mjs`,
  `CustomObjectReports.jsx:208-255,275-304`.
  Choose starting object or connected entity, related row path (what each row
  represents), fields from a path, relationship fields and row-relative
  distinct-related-record counts. Paths max six steps and cannot cycle.
- [x] Presentation: choose/reorder/remove columns, edit headings; multi-values
  joined with semicolons; include starting records without a related row;
  optional empty label applies to missing related record, not a blank field.
  Member report fields: full/first/last name, email, Organisation ID;
  Organisation: name/email; Organisation Group: name; Custom Object:
  active readable configured fields and record ID.
- [x] Saved reports:
  `client/src/hooks/useSavedExportReports.js:35-169`;
  `CustomObjectReports.jsx:264-273`. Shared named configurations support
  create/apply/update/rename/delete; not the personal saved CRM list views.
  Older saved definitions retain their original semantics rather than being
  silently upgraded. Invalid or unavailable saved selections warn and block
  preview/export (`reportHelpers.mjs`, `CustomObjectReports.jsx:274,290,307`).
- [x] Preview: 50 rows per page with total/previous/next, backed by
  `customObjectService.js:4185-4358,4550-4560`.
- [x] Export: `CustomObjectReports.jsx:136-194`;
  `customObjectService.js:4563-4695`.
  CSV of configured report population and column order, not selected CRM rows
  or the preview page. Durable chunked export with progress; return to the
  screen in same browser can resume the recorded job. The browser drives
  processing, so do not call it an unattended background scheduler.
  New-format exports use stored definition and 500-row chunks; no fixed
  overall record count cap is enforced here.
- [x] Expansion limits:
  `customObjectService.js:75-76,4100-4145,4330-4339`.
  New-format field expansion rejects more than 10,000 values in a cell or
  100,000 values in a processed page. A chunk size is not a total export cap.
- [x] Legacy format: `customObjectService.js:4361-4547,4666-4680`
  retains synchronous CSV for older definitions; do not promise identical
  processing or features for all saved definitions.
- [x] Searching/date negative check: full report builder, configuration helper
  and report definition/execution logic. No standalone keyword/date/status
  filter panel on shared relationship reports; relationship path and active
  data determine population. These do not inherit CRM list filters.
- [x] Tenant wording must omit version numbers, handler names, identifiers
  except user-visible record identifiers, schema, SQL and internal errors.

## Reconciliation checklist

Associated CRM scope cross-check (read-only independent explorer):

- Global content search is not CRM search:
  `client/src/pages/SearchResults.jsx:127-176,209-227`;
  `api/public/search.js:45-69,100-146`. Searches published content
  (events, articles, news, resources, pages), not members/organisations;
  minimum two characters, partial case-insensitive matching, default 20 and
  maximum 50 results. No CRM export implied.
- Sales opportunities:
  `client/src/components/sales/OpportunitiesWorkspace.jsx:139-213`;
  `api/opportunities/index.js:27-71`. Opportunity-name partial search,
  stage and My opportunities UI; table/kanban; 20/100 page sizes;
  non-admin sees owned/collaborated records. Backend-only relationship
  predicates must not be presented as visible list controls.
- Related activity:
  `client/src/components/opportunities/RelatedOpportunityActivity.jsx:44-157`;
  `api/opportunities/activity.js:16-74`; member activity timeline separately
  combines bookings, groups and check-ins. Not an exportable generic audit
  ledger.
- Quotes:
  `client/src/components/sales/QuotesWorkspace.jsx:144-168`;
  `api/_lib/salesQuote.js:159-181`. Partial case-insensitive combined search
  over quote number, customer reference and organisation snapshot name.
  Placeholder implies opportunity search but that is not implemented.
  Status filter and 20-row pages. Per-quote PDF through
  `api/sales/quotes/[...path].js:103-113`, not bulk list CSV.
- Detail notes:
  `api/admin/members/[memberId]/notes/index.js:11-161` and
  `api/admin/organizations/[id]/notes/index.js:11-161`; tenant/admin
  controlled, newest-first author-attributed notes with attachments.
- Form-submission exports are an associated extraction path and must not be
  omitted merely because the Due Diligence queue lacks export:
  `client/src/pages/FormSubmissions.jsx:1178-1460,2900-2955`. The Due
  Diligence note now traces CSV/Word extraction separately from review data.

- [x] Dashboard report distinguishes widgets, fixed reporting cards and
  specialist report screens.
- [x] CRM and dashboard agree that Data Export & Backup is not functioning.
- [x] CRM and dashboard distinguish shared relationship reports from Custom
  Object list CSV and personal saved list views.
- [x] All reports distinguish queue/application creation dates from
  historical activity/event dates and record snapshots.
- [x] All exports checked for actual format, population, visible vs chosen
  columns, row caps, selection invalidation, role and module conditions.
- [x] All final headings exactly `Current Limitations`; no unsupported
  generic assertions or deployment/tenant claims.
- [x] Final diff contains only documentation/audit output, apart from
  recorded pre-existing changes.

## Final verification

- Independently reviewed material report claims and corrected inaccuracies
  in the first drafts before handover. Corrections and their sources are in
  the area-specific notes, including DD CSV/card population differences,
  Member anonymisation, count-only export freshness and specialist date rules.
- Static checks passed for all three reports: required section headings,
  final Current Limitations heading, review date, source-only/not-deployment
  disclaimer, consistent Markdown tables, relative links and an internal
  route/code/database-identifier scan.
- The only task outputs are the three requested guides and five internal
  audit notes in this directory. Pre-existing `replit.md` changes and the two
  supplied brief attachments were not edited.
- No app runtime, deployment, tenant database, mutation endpoint, external
  integration or notification was exercised. No workflow, tests, settings,
  schema, permission or application file was changed.
- No follow-up implementation proposals were made because the brief
  explicitly excludes development proposals and remediation.
- No persistent memory entry was appropriate: findings are recoverable
  source evidence, not cross-session decisions; the task's allowed changes
  are restricted to the reports and audit notes.
- Final independent re-review passed the corrected tenant-facing claims.
  Its sole remaining note was a contradictory shorthand date description
  inside the specialist audit itself; this was corrected to source-and-target
  dates, matching the already-correct tenant report and handler evidence.