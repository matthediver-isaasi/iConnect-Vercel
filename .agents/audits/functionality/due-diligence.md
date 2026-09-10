# Due Diligence functionality evidence note

**Review basis:** checked-out source as at 10 September 2026. No live calls, workflow runs, tenant data inspection or deployment verification were performed. Existing guides were not used as proof.

## Deliverable

Tenant-facing report: `guides/due-diligence-functionality.md`.

The tenant report intentionally omits identifiers, route names, database names and security implementation details. This private note records those details for claim traceability.

## Material claim map

| Topic / claim | UI evidence | Backend or data evidence | Conclusion |
|---|---|---|---|
| Queue listing and columns | `client/src/pages/DueDiligenceDashboard.jsx:163-278, 1028-1271` | `api/due-diligence/list-submissions.js:33-236` | Reference, stage, form, risk, created/updated, owner, swap and actions are displayed; server enriches form/config/owner/reviewer context. |
| Search scope | `DueDiligenceDashboard.jsx:693-746, 1037-1048` | Display reference enrichment in `list-submissions.js`; relationship display-label queries at dashboard lines 524-606 | Case-insensitive substring matching is local and restricted to `application_uid` and computed display reference. No answer-wide search. |
| Display-reference fallback | `DueDiligenceDashboard.jsx` display-reference memo; `ReviewSubmission.jsx:1275-1303` | `list-submissions.js` config/organisation enrichment | Configured field, linked organisation, common organisation/company/name/email values, then application UID. |
| Queue filters | `DueDiligenceDashboard.jsx:319-352, 482-518, 693-751, 1028-1168` | `list-submissions.js:64-142` | Form, current stage, risk and independent inclusive creation bounds are server filters; owner/search/reviewer/stage-age are local. Filters combine by AND. Visible reviewer/stage-age controls are absent; they enter via URL drill-through. |
| Date bounds | Dashboard date application code around lines 353-395 and request parameters around 489-496 | `list-submissions.js` creation-date comparisons | Start is beginning of selected date and end is inclusive through end of selected date. Either bound can be applied independently. |
| Queue limits and pagination | `DueDiligenceDashboard.jsx:484-515, 747-757, 1219-1267` | `list-submissions.js` supports limit/offset and defaults to 50 | UI requests 200 per batch for at most 100 loops: 20,000 fetched maximum. Local display uses exactly 25 rows. Endpoint default 50 is not the queue's effective request size. |
| Configurable dashboard source | `client/src/components/dashboard/WidgetBuilderModal.jsx:500-580, 1105-1180`; `WidgetCard.jsx:153-204, 284-295` | `api/dashboard/_lib/sources.js:83-154, 353-387`; `aggregation.js:1550-1922` | DD source is active-config forms/non-archived records. Dimensions are canonical current status, linked organisation/current org type, form, underlying submission creation, DD creation and first recorded selected-stage entry. Count/count-distinct only; no form-answer custom fields. |
| Dashboard stage transitions | `WidgetBuilderModal.jsx:1105-1180` | `aggregation.js:1608-1713, 1716-1741, 1861-1867` | Breakdown counts each recorded from/to history event; single mode counts a chosen pair. Repeated moves count repeatedly. In transition mode any date-typed filters are evaluated against the transition timestamp; grouping/time bucket is neutralised. First-stage date is first matching transition only, with no creation/initial fallback. |
| Dashboard aggregate CSV and limits | `WidgetCard.jsx:153-204, 284-295` | `aggregation.js:29-38, 1703-1706, 1775-1797` | Widget CSV serialises the loaded aggregate payload, not record detail. Scalar has metric/value/records; grouped data has label/value and chart total where shown. Refuses scans reaching 50,000 rows; transition breakdown max 30 pairs. |
| Columns and sorting | `DueDiligenceDashboard.jsx:40-57, 1190-1204`; resize code around lines 760-789 | Not applicable | Minimum width 60px; widths stored locally. No sort control or comparator found. No column chooser/reorder control. |
| Summary-card population | `DueDiligenceDashboard.jsx:606-691, 1000-1027` | Listing endpoint provides server-filtered population | Cards are computed before local keyword, owner, reviewer and outstanding-day filtering. Approved and high/critical use literal normalized values. |
| Archive exclusion | No include-archived UI parameter in dashboard fetch (`DueDiligenceDashboard.jsx:482-518`) | `list-submissions.js:93-94, 130-133`; reports consistently filter `archived_at` null | Archived excluded by default. Endpoint can include archived when requested, but dashboard never exposes or sends it. |
| Public creation | None: public form | `api/public/form-submission.js:97-101, 1595-1690` | Identified public submission for a DD-enabled form creates record at configured initial stage and can execute initial actions. Anonymous survey response is explicitly excluded. |
| Manual creation | `client/src/pages/FormManagement.jsx:650-702, 989`; `client/src/components/ManualSubmissionDialog.jsx:128-218` | `api/admin/manual-form-submission.js:71-222` | Manual entry is opened against a selected form from Form Management. It creates the associated DD record but intentionally runs neither normal workflows nor stage actions. |
| Explicit initialisation | General form-submission administration path references DD state; no standalone queue create | `api/due-diligence/init-submission.js:25-163` | Authenticated, tenant-scoped and idempotent; creates from existing form submission and executes initial actions on new creation. |
| Organisation association | Organisation context displayed/fallback in dashboard/review; owner/member action text in config | Public/manual/init paths copy `organization_id` on underlying form submission; `get-submission.js` enriches organisation; swap preserves it | DD association is mediated by its form submission. No dedicated organisation filter or direct organisation-link control found in review. |
| Member association | Review owner picker (`ReviewSubmission.jsx:1247-1273, 2513-2542`); create-member stage config (`DueDiligenceConfig.jsx:2217+`) | `update-owner.js`; `_stageActions.js:1387+` | Existing members can own records; entering configured stages can create members associated with the submission's organisation. DD is not itself a member-owned child record beyond owner assignment. |
| Review fields and notes | `ReviewSubmission.jsx:120-360, 1311-1471, 1568-1590, 2302-2454` | `save-review.js:33-180` | Original/reviewed side-by-side, approved/amended state, field notes, DD-only fields and general notes persist. Locked/linking organisation fields are forced approved. |
| Form dependencies | Review uses `FormRenderer`, page structure, visibility and relationship labels (`ReviewSubmission.jsx:1204-1245, 1926-1995`) | `save-review.js:61-131` validates effective values against visibility, repeatable-row and relationship-selection rules | Review editing respects current form structure and validates dependent values. |
| Reviewer and review date | `ReviewSubmission.jsx:2493-2506` | `save-review.js:133-141` | Saving records reviewer email and current review timestamp. |
| Scoring modes | `DueDiligenceConfig.jsx:1329-1547`; score view/questions at `ReviewSubmission.jsx:1997-2074, 2457-2485, 2768-2825` | `save-review.js:182-235`; `calculate-score.js`; `_scoring.js` | Dynamic rule scoring or configurable traffic-light questions. Relevant saves recalculate score/risk. N/A questions excluded. |
| Risk levels | `DueDiligenceConfig.jsx:3192-3283` | `_scoring.js`; persisted fields in `shared/schema.ts` | Configurable name, colour and 0-100 lower threshold. |
| Workflow defaults/configuration | Defaults at `DueDiligenceConfig.jsx:43-48`; settings/workflow at lines 1124-1326 and 1549-1789 | Config persisted through entity API/schema; status backend reads configured stages | New/In Review/Verified/Approved/Rejected are defaults only. Stages are reorderable/customisable and one is initial. |
| Stage sequence and conditions | `DueDiligenceConfig.jsx:1233-1247, 1665-1778`; `ReviewSubmission.jsx:2076-2147, 2220-2279` | `update-status.js:46-72, 153-215`; first-edit check duplicated in `save-review.js:555-617` | Picker applies current score/signature/document conditions and forward-only backtracking lock. Final mutation and first-edit automation validate legacy min/max score, signatures, attachments and logo keys. Formats are not aligned; tenant guide explicitly cautions administrators to test guards. |
| First-edit transition | Config at `DueDiligenceConfig.jsx:1249-1280`; toast handling at `ReviewSubmission.jsx:1473-1487` | `save-review.js:238-397` | First saved edit can transition only from initial stage, once; target actions/webhooks run when backend conditions pass. |
| Stage skipping | `ReviewSubmission.jsx:1599-1887, 2680-2723` | `check-stage-actions.js`; target only is executed by `update-status.js` | UI warns if skipped intermediate stages have email/meeting/contract actions. Intermediate actions do not execute. |
| Stage actions | `DueDiligenceConfig.jsx:1781-3190` | `_stageActions.js` entry functions: contract line 252; meeting 672; email 1066; member 1387; field mapping section around 1900-2550; Zoho 2609; orchestrator 3256 | Conditional contract, meeting, email, member creation, field mapping/workflow and Zoho actions. Status webhooks are handled in `update-status.js:98-135`. |
| Owner roles | `DueDiligenceConfig.jsx:1282-1323`; `ReviewSubmission.jsx:1247-1273, 2513-2542` | `update-owner.js:31-84`; `members-by-roles.js` | Picker offered only when roles configured; backend checks selected member's tenant and allowed role. Unassign supported. |
| History and schedule | `ReviewSubmission.jsx:495-1135` | History appenders in `save-review.js`, `update-status.js`, `calculate-score.js`, `_stageActions.js`; `submission-schedule.js` | History presents known events in reverse chronological display. Schedule covers contract reminders/timeouts and meeting request/reminder timing. |
| Documents | `DocumentsCard.jsx`; `DocumentDetailModal.jsx` | `api/due-diligence/documents/{list,create,get-versions,update-status,approve-with-aging,add-comment,ensure-public-url}.js` | Detects native/custom file fields, current/version records, pending/approved/rejected display, preview/download, comments, replacement versions and approved public URL. New versions cannot supersede an approved version until unapproved. The modal wires a reject handler but renders no Reject button. |
| Signatories | `SignatoriesCard.jsx`; `SignatoryDetailModal.jsx`; `ManualContractOverrideForm.jsx` | `api/contracts/{by-submission,send-original,resend,add-signer,manual-override,demote-winner,download-pdf}.js` | Not sent/pending/signed/expired contract states; send/resend, alternatives, first-signer-wins, manual completion, demotion and signed PDF. |
| Form swap | Dashboard swap dialogs around `DueDiligenceDashboard.jsx:1390-1540` | `swap-eligible-forms.js`, `swap-preview.js`, `swap-execute.js` | Eligible configured target forms; preview copy/empty/ignored; execute maps labels, preserves org, creates target, archives source, handles active contracts and initial actions. |
| Delete | Dashboard action and two dialogs at `DueDiligenceDashboard.jsx:891-916, 1303-1383`; `FormSubmissions.jsx:2419, 2528` | `delete-submission/[id].js` | Permanent two-step UI. Handler deletes document rows, reminder logs, contracts, DD row and underlying form submission. Individual child-delete failures are logged and processing continues; see caveat. |
| Bulk actions | No row checkbox/select-all/action bar in dashboard | No DD bulk endpoint found in `api/due-diligence` | Absent. |
| Report form population | `DueDiligenceReports.jsx` global filters | `api/reports/dd-forms.js` | Only forms with active DD configuration are offered. |
| Period semantics | `DueDiligenceReports.jsx` period selector/defaults | `api/reports/_ddReportHelpers.js` | Rolling 7 days, 1/3 months, 1 year, all time or custom. Custom date-only end bound is end-of-day inclusive. Labels must not be described as calendar periods. |
| Funnel metrics | Funnel card in `DueDiligenceReports.jsx` | `application-funnel-stats.js:103-240`; helper history functions | Card period population is DD-row `created_at`, not underlying form creation. Current-stage count, ever-reached conversion, drop-off and stage timing use that cohort. |
| Verification metrics | Verification card in `DueDiligenceReports.jsx` | `verification-stats.js:58-238`; helpers | Current Verified rows require a history-derived verification timestamp in range. Current New/In Review rows use current-stage entry; helper receives underlying form creation fallback. Turnaround/reviewer derive only from timed verified rows. Document metrics are a separate document population. |
| Meeting metrics | Meeting card in `DueDiligenceReports.jsx` | `due-diligence-stats.js:62-223, 271-374, 389-515`; helpers | Headline “scheduled” and “completed” are workflow-stage cohorts, not booking counts. Scheduled uses current stage + verification transition (submission-creation fallback); completed requires current outcome/later stage + outcome transition. Separate `meetingMetrics` queries request creation and linked booking state. |
| Decision metrics | Decisions card in `DueDiligenceReports.jsx` | `decisions-stats.js:57-248`; helpers | Headline current approved/declined/decision-held cohort uses decision timestamp, with underlying form creation only for in-range cohort fallback. Missing decision history yields no timing and is excluded from period comparisons/trends, which require events. |
| Report layout/settings | Report screen preference hooks and card controls in `DueDiligenceReports.jsx` | Browser preference persistence utility | Hide/show/reorder, no resize. Default all forms + rolling month. SLA defaults 5/10/14 and non-negative input. |
| CSV | Buttons in each report card | `api/reports/export.js:33-260`; `_ddReportHelpers.js` CSV escaping/date bounds | Four types, fixed fields, no row selection/field chooser/SLA, archived excluded. Source queries are unpaged. Zero active configs emits `no_data`; active configs plus zero cohort rows emits normal headers only. |
| Export columns | Report screen actions | `export.js:91-260` | Funnel: submission ID, UID, form ID, stored status, underlying creation, current-stage entry, age. Verification: IDs/status/state/reviewer, creation, verified/current-stage dates, turnaround/age; no docs. DD meetings: IDs/status/score/risk, creation, verified/outcome dates and duration; no request/booking fields. Decisions: IDs/status/decision/score/risk/reviewer, creation/decision dates and duration. |
| Export/card cohort divergence | Not disclosed by UI | Funnel `application-funnel-stats.js:129-131` vs `export.js:91-102`; verification `verification-stats.js:90-103` vs `export.js:115-152`; meetings `due-diligence-stats.js:107-176, 362-495` vs `export.js:169-199` | Funnel card dates DD creation, export dates underlying creation. Verification export retains current Verified rows lacking `verifiedAt` regardless range while card excludes them. Meeting export uses outcome→verified→creation event fallback for all enriched rows and is neither the workflow headline nor actual request cohort. |
| General Form Submissions CSV | `FormSubmissions.jsx:1170-1213, 1533-1700, 2114-2133, 2898-3033` | Client-side generation from loaded entity results | Same underlying DD-enabled form submissions remain exportable when general Form Submissions access exists. CSV requires one selected form, exports all general filtered rows (ignores row selection), and has selectable metadata/answer fields. It exports underlying submission data, not reviewed DD values/state. |
| General Form Submissions Word / no PDF | `FormSubmissions.jsx:1350-1504, 2114-2133, 2498-2517, 2898-3033`; no export controls in `FormSubmissionView.jsx` | `api/admin/form-submission-export-jobs/{index,process,[id]}.js`; `form-submissions-word-export.js`; `client/src/lib/formSubmissionWordExport.js` | Word supports filtered or selected rows and a single-row download with selected metadata/answers. More than 100 uses a background job, whose accepted request cap is 5,000. No PDF control/path is wired in either reviewed general submission screen. |
| Demo/Preview mode | `DueDiligenceReports.jsx:128-304, 454-510, 516-534, 624-676, 938-1000, 1237-1305, 1626-1698, 1921-2002, 2082-2163` | Export endpoint is unchanged and receives normal filters | Static in-client sample objects replace live stats and live stats/form queries are disabled; refresh hidden. Toggling demo does not reset `filters.formId` (default remains `all`). Export/dashboard links remain and use retained normal filters, not sample rows. Thus All Forms can export/open live tenant cohorts while samples are displayed; selecting `demo-form-1` ordinarily yields no live match. |
| Access | Page-level redirect checks in dashboard, config, review and reports; menu registration in `pageRegistry.js`, `index.jsx`, `PortalMenuManagement.jsx` | `useMemberAccess.js`, `roleAccessMap.ts`, generated hierarchy; handlers call session and tenant-context helpers | User-facing pages can be excluded by role/menu. Operations reviewed require a signed-in member and tenant context; no live-role verification. |

## Lifecycle trace

1. A configured form submission is received through public, manual or existing-submission initialisation.
2. A DD row captures original values, generated UID, initial configured stage and organisation linkage through the form submission.
3. Initial actions run for public/explicit creation, but deliberately do not run for manual administration.
4. Queue retrieval enriches record with form configuration, organisation, owner and reviewer information; archive exclusion applies by default.
5. Reviewer saves amended/approved fields, question responses and notes. Save validates form relationships/dependencies, records reviewer/date/history and recalculates score/risk.
6. Optional first-edit transition or explicit stage selection changes current stage. The destination can trigger notifications and stage actions.
7. Documents, contracts/signatures and meeting requests are managed through linked form-submission records and contribute to review display/reporting.
8. Default or custom decision stages remain ordinary workflow stages; history transition dates drive reporting where present.
9. A record may be permanently deleted, or a form swap creates a replacement and archives the source.

## Negative-claim checks

| Expected capability checked | Search scope | Result |
|---|---|---|
| DD-record expiry / renewal fields | `shared/schema.ts`; all DD pages; `api/due-diligence`; reports; repository search for expiry/renewal adjacent to DD identifiers | No core DD expiry, renewal date, renewal action, queue filter or report. Matches concern contract timeout/reminders and meeting-request expiry. |
| Separate approval/rejection entity/action | Review/config/dashboard/status handlers/reports | No separate approval object. Approval/rejection are configurable workflow-stage semantics; defaults exist. Document approval/rejection and contract completion are separate subordinate processes. |
| Standalone DD create | Dashboard and DD APIs | No blank DD create UI/API. Creation requires a form submission via public/manual/init/swap paths. |
| Organisation filter/direct navigation | Dashboard filter controls and ReviewSubmission controls | No visible organisation filter and no direct linked-organisation button on review. Organisation may supply display reference and underlying association. |
| Custom-field queue search/filter | Dashboard local matcher and request construction | No general answer/custom-field search or filter. |
| Sorting/saved views | Full dashboard controls and filtering state | No sorting or named saved queue views. Width persistence only. |
| DD queue export | Full dashboard controls and DD APIs | No queue export button/path. Separate report, aggregate widget and general form-submission exports exist and have different populations/fields. |
| Bulk support | Dashboard rows/actions and API file inventory | No select-all, row selection or DD bulk mutation/export. |
| Ordinary archive | Dashboard action inventory and APIs | No general archive endpoint/control. Swap-only archive. |
| Document rejection control | `DocumentDetailModal.jsx:142-300, 338-403, 754-794` | `documents/update-status.js` accepts rejected | Status and mutation code exist, but `VersionItem` renders Approve/Unapprove and Download only; no user-triggered Reject action is present. |
| Archived discovery | Dashboard request construction, listing endpoint, swap dialog | Backend supports `includeArchived=true`; dashboard does not expose or send it. Dialog claim is therefore not achievable through the visible queue reviewed. |
| Excel / chosen fields / selected rows | Reports UI and `export.js` | CSV only; fixed columns; no selected-row model. Export serialises the unpaged query result, which is not guaranteed to contain the entire logical cohort. |
| Report/export completeness | All four stats handlers and `export.js` source queries | Principal DD/form/document/request queries have no explicit `.range()` pagination. Results may stop at the data service's per-request limit; no complete-cohort guarantee is supportable. |

## Reporting date and population evidence

- `_ddReportHelpers.js` is the shared authority for period boundaries, history event extraction, workflow label matching, held-stage classification and CSV escaping.
- Funnel card uses DD-row creation for its period cohort; Funnel export instead uses underlying form-submission creation.
- Verification card requires a verification transition for currently Verified rows. Outstanding rows use the most recent transition into their current stage, with underlying form creation as fallback. Export differs by retaining a current Verified row with no verification event without applying the selected range to it.
- Meeting headline scheduled/completed values are workflow milestone cohorts, not actual bookings. Actual request/booking metrics are queried separately by request creation date. Meeting export is a third population using outcome, then verification, then underlying creation as its event fallback.
- Decision headline cohort uses transition to the current semantic outcome, or underlying form creation only for cohort inclusion when that transition is absent. Missing event rows have no timing and do not enter event-based trends. Decision export follows the same legacy inclusion pattern.
- Archived DD records are filtered out of statistics and exports.
- Report CSVs re-query their own populations. They do not export selected visual rows, do not receive the user-entered SLA value and are not guaranteed to reproduce card populations.
- `toCsv([], columns)` emits the supplied normal header row. The one-column `no_data` response occurs earlier only when the active-configuration form list is empty.

## Schema and migration cross-check

- `shared/schema.ts` defines `form_due_diligence_config`, `form_submission_due_diligence`, document/version/comment structures, contract-related state and meeting-related entities used by this module.
- Material config fields include scoring rules/mode, static questions, custom risk levels, default review state, workflow stages, reference display, owner roles/default owner, stage sequence, first-edit transition and webhook configuration.
- Material DD record fields include original/reviewed values, per-field status/notes, question responses/notes/N-A, score, risk, stage, general notes, signature/attachment status snapshots, webhook/reminder data, history, reviewed by/date, owner, first-edit flag and swap/archive links.
- Relevant history includes `scripts/migrations/add-due-diligence-tables.sql`, `scripts/migrations/add-form-due-diligence-required.sql`, `scripts/add-static-question-not-applicable.sql`, `scripts/add-form-id-to-stage-actions.sql` and dated Due Diligence/stage-action migrations under `supabase/migrations`. Current behaviour was cross-checked against current schema and consumers rather than inferred solely from migration chronology.

## Permissions evidence and wording decision

- Page capability keys map queue/config/review/report access through member access and portal-menu registration.
- API handlers reviewed consistently require session member and tenant context and tenant-scope their principal DD lookups.
- Dedicated operation-level permission checks were not consistently evident on save/status/owner/delete/report handlers beyond signed-in tenant scope. The tenant report therefore says “appropriately authorised” and explains page/module configuration, without claiming a specific role matrix or exposing this implementation detail.
- Effective access for a named tenant/role remains unverified because live calls were prohibited.

## Unresolved or unverified issues

1. **Condition model mismatch:** configuration/review UI uses `score_condition`, `signatories_received` and `documents_approved` (`DueDiligenceConfig.jsx:1675-1776`; `ReviewSubmission.jsx:2076-2147`), while `update-status.js:153-215` checks older keys (`require_all_signatures`, `require_all_attachments_approved`, logo and min/max score). Unless data is translated elsewhere, server enforcement does not mirror the visible lock model. Tenant prose states intended/current UI restrictions but avoids asserting a security boundary.
2. **Archived-record message mismatch:** swap UI says the source remains viewable by including archived records, while the dashboard lacks that control. This is included as a current limitation.
3. **Delete atomicity:** child deletion failures are logged and deletion continues. The UI describes broad related-data deletion, but the implementation is not a transaction and may partially clean up. The guide uses “attempts to remove” for children.
4. **Demo/preview export:** static sample values are displayed, but export and dashboard links use the retained operational filters. Demo toggle does not force the sample form into filter state. With All Forms retained, export/navigation can target live tenant cohorts; with the sample form selected, they ordinarily return no match. They never represent the displayed sample. Source-confirmed but not runtime-tested.
5. **Status-webhook reminders:** configuration exposes interval/max reminders, and state fields exist, but scheduled reminder dispatch was not traced end-to-end during this assignment. Initial status-trigger delivery is evidenced.
6. **External actions:** email, booking, contract and Zoho results depend on service configuration and external availability. Code paths were traced, not executed.
7. **Manual contract override and signed-PDF generation:** UI and backend paths exist, but generated document fidelity and external signing callbacks were not runtime-verified.
8. **Report semantic stage matching:** outcomes depend on configurable labels and helper synonyms/ordering. Unusual custom labels may not classify as expected; no tenant configuration was inspected.
9. **20,000 queue ceiling:** confirmed from 200 rows × 100 iterations. When more records match server filters, local search/owner/drill-through operates only over that fetched prefix; ordering from the endpoint governs which records are included.
10. **Report/export truncation:** report and export source reads are unpaged. The data service's per-request row limit can silently constrain the source set, so large-population cards and CSVs cannot be described as complete.

## Files reviewed

Principal files:

- `client/src/pages/DueDiligenceDashboard.jsx`
- `client/src/pages/DueDiligenceConfig.jsx`
- `client/src/pages/DueDiligenceReports.jsx`
- `client/src/pages/ReviewSubmission.jsx`
- `client/src/pages/FormSubmissions.jsx`
- `client/src/pages/FormSubmissionView.jsx`
- `client/src/pages/FormManagement.jsx`
- `client/src/components/dashboard/WidgetBuilderModal.jsx`
- `client/src/components/dashboard/WidgetCard.jsx`
- `client/src/lib/formSubmissionWordExport.js`
- `client/src/components/ManualSubmissionDialog.jsx`
- `client/src/components/due-diligence/DocumentsCard.jsx`
- `client/src/components/due-diligence/DocumentDetailModal.jsx`
- `client/src/components/due-diligence/SignatoriesCard.jsx`
- `client/src/components/due-diligence/SignatoryDetailModal.jsx`
- `api/public/form-submission.js`
- `api/admin/manual-form-submission.js`
- `api/due-diligence/init-submission.js`
- `api/due-diligence/list-submissions.js`
- `api/due-diligence/get-submission.js`
- `api/due-diligence/save-review.js`
- `api/due-diligence/update-status.js`
- `api/due-diligence/update-owner.js`
- `api/due-diligence/calculate-score.js`
- `api/due-diligence/check-stage-actions.js`
- `api/due-diligence/_stageActions.js`
- `api/due-diligence/_scoring.js`
- `api/due-diligence/submission-schedule.js`
- `api/due-diligence/swap-eligible-forms.js`
- `api/due-diligence/swap-preview.js`
- `api/due-diligence/swap-execute.js`
- `api/due-diligence/delete-submission/[id].js`
- `api/due-diligence/documents/*.js`
- `api/contracts/by-submission.js`, `add-signer.js`, `resend.js`, `send-original.js`, `manual-override.js`, `demote-winner.js`, `download-pdf.js`
- `api/reports/dd-forms.js`
- `api/reports/_ddReportHelpers.js`
- `api/reports/application-funnel-stats.js`
- `api/reports/verification-stats.js`
- `api/reports/due-diligence-stats.js`
- `api/reports/decisions-stats.js`
- `api/reports/export.js`
- `api/dashboard/_lib/sources.js`
- `api/dashboard/_lib/aggregation.js`
- `api/admin/form-submissions-word-export.js`
- `api/admin/form-submission-export-jobs/index.js`
- `api/admin/form-submission-export-jobs/process.js`
- `shared/schema.ts`
- `client/src/hooks/useMemberAccess.js`
- `client/src/lib/roleAccessMap.ts`
- `api/_lib/roleAccessHierarchy.generated.js`
- `client/src/pages/pageRegistry.js`
- `client/src/pages/index.jsx`
- `client/src/pages/PortalMenuManagement.jsx`