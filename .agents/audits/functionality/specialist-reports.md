# Specialist reporting — internal evidence checklist

Reviewed 10 September 2026. Checked-out source only. No live requests,
tenant data, deployment checks, downloads or mutations were performed.
This working paper is excluded from the tenant handover; it is not a
filesystem privacy boundary.

## Accuracy reconciliation

The initial delegated matrix was rejected after independent verification:
it described unrelated/older implementations of Monthly Finance, Ticket
Sales, Member Role, Team Engagement and Organisation Engagement. Its Form
Conversion description was also incorrect. The evidence below supersedes
that draft; none of those initial descriptions is suitable for publication.

## Verified screen-to-output inventory

| Screen | Current behaviour | Evidence and boundary checks |
|---|---|---|
| Registration Report | Selected simple/complex events or event groups; event-start date, type, member group, event/registration/payment status, organisation and attendee filters. Grouped registrations with configurable/reorderable standard and event-form-answer columns. CSV and XLSX of filtered loaded groups/selected columns. | `client/src/pages/EventRegistrationReport.jsx:696-705,759-777,862-901,979-1099,1203-1431,1632-1647`; `api/reports/event-registration-report.js:322-327,625-632,751-758`. Not page-only. Attendee match retains booking group and its payment figures. Unpaged source reads can constrain completeness at scale; no live scale test. |
| Event Budget | Per-event budget/actual income, costs, profit/loss, variances, vouchers/seats/attendees/distinct organisations. Optional event-start from/to controls. CSV; cost-line view/add/delete. | `client/src/pages/EventBudgetReport.jsx:210-245,252-300,316-348,357-435`; `api/reports/event-budget-report.js:328-351` and paged fact reads. No other visible filter or pagination. Missing budgets enter variance arithmetic as zero. Backend checks admin/report feature. |
| Pending Purchase Orders | Search organisation/invoice/source/email, source type, date/name/invoice sort, hide paid after Xero status lookup; 20/page. All-filtered CSV. Edit PO, single/bulk reminders, reminder timing settings. | `client/src/pages/PendingPurchaseOrdersReport.jsx:39,189-249,315-330,764-1007`. CSV “Invoice Date” uses local created date. UI paid hiding depends on status lookup; no generic accounting-provider parity asserted. |
| Monthly Finance | Voucher monthly balances per organisation: opening, allocated, used, expired, positive/negative adjustments, reinstated, closing, reserved and available. Live open month / closed snapshot. Month, organisation, closing-balance filters; expandable supporting transactions. | `client/src/pages/MonthlyFinanceReport.jsx:17-71,92-170,185-254,347-490`; `api/admin/voucher-monthly-report/index.js:1-15,40-47,92-199`. Not invoice/VAT analytics. Month cannot be future. Detail type/status/event/funding/allocation/expiry filters. |
| Monthly Finance export | XLSX Summary and Transactions tabs, selected month/org/balance parameters. UI does not pass expanded-detail filters. Balance filter affects Summary, not Transactions. Fixed columns; no CSV or field chooser. | `client/src/pages/MonthlyFinanceReport.jsx:165-170`; `api/admin/voucher-monthly-report/export.js:79-150`. Organisation/snapshot lookups are unpaged; no whole-dataset or performance certification. Administrator access required. |
| Ticket Sales Analytics | Programme-ticket transactions aggregated by organisation. Purchased net of cancellations, used, refunded, net tickets, pre-discount purchase value, programmes and transaction count. Search organisation, filter programme, sort purchased/value/name; organisation transaction dialog. | `client/src/pages/TicketSalesAnalytics.jsx:34-46,50-117,119-180,252-413`. CSV fixed Organisation/Purchased/Used/Refunded/Net/Sales Value/Programs/Transactions from filtered aggregate. No event selector, date range, AOV or promotion analytics. |
| Survey Reports | Survey/version/event/group/event-date/delivery/completion filters, summary/question/category scores, response volumes, comparisons/distributions, comment question/search, separately permitted response detail. Comments/responses default 25, max 100/page. | `client/src/pages/SurveyReports.jsx:61-91,200-251,364-526,682-686,817-821`; `api/reports/survey-report.js:490-539,623-865`. Summary CSV/XLSX, comments CSV, permission-gated response XLSX. Anonymous threshold/identity suppression applies independently of page size. |
| Group Assignments | Current member/email/group/classification/role/leadership/assignment date rows. Search those labels; classification/group/role/leadership filters; 20/page. All-filtered CSV. | `client/src/pages/MemberGroupAssignmentReport.jsx:92-204,226-445`. No assignment-date range control. Current assignments, not complete historical membership. |
| Member Group Invites | Invitation identity/group/classification/inviter/status and sent/expiry/accepted dates; summary counts. Search + status/classification/group filters; 25/page; all-loaded-filtered CSV. Pending resend/copy/cancel. | `client/src/pages/MemberGroupInviteReport.jsx:138-168,210-331,351-463`; `api/admin/member-group-invites/index.js:115-119`. Initial unpaged read can limit dataset before local paging. No claim that list pagination retrieves all invitations. |
| Group Classification | One classification + inclusive required from/to. Current member/organisation/leadership/co-convenor counts; period emails/vacancies/resources/events, excluding draft events. | `client/src/pages/MemberGroupClassificationReport.jsx:137-297`; `api/admin/member-group-classification-report/index.js:102-169,174-335`. Admin/feature gate; on-screen only, no export or paging. |
| Member Role | Role counts and expandable member/name/email/organisation lists, including No Role Assigned. Optional configured Organisation picklist segmentation. Expanded roles page 25 members. Fixed CSV from all loaded members after segmentation. | `client/src/pages/MemberRoleReport.jsx:14-15,37-90,92-150,169-211,223-263,337-475`. Members and organisations use paginated-all loading. No 500-row report cap, keyword search, role/status/date filters or assignment-history columns in this screen. |
| Team Engagement | Signed-in member's organisation; member-level confirmed-event participation, published articles, jobs, achievement/engagement awards, opening balances and total score. Name/email search, sortable columns, include inactive toggle, metric detail dialogs. | `client/src/pages/TeamEngagementReport.jsx:31-95,103-172,174-228,409-665`. Not per-team activity, resource/discussion reporting or low-engagement filter. No period/export/pagination controls. |
| Organisation Engagement | Organisation/member activity and engagement rate; week/month/quarter/year/custom, previous/next period navigation and search. CSV of filtered organisations and members. | `client/src/pages/OrganisationEngagementReport.jsx:26-123,136-228,252-540`; `api/reports/engagement-report.js:73,128-165`. Initial period week; custom needs both dates. No tier/activity-only/sort/page controls. Last-activity timestamp only: historical period membership is overwritten by later activity; denominator includes disabled accounts. Do not describe this as a historical activity ledger. |
| Sales Dashboard | Open/weighted pipeline, won/outstanding quotes, currency breakdown, recent activity/wins/expected closes/overdue tasks/outstanding quotes and links. | `client/src/components/sales/SalesReportingWorkspace.jsx:76-98`; `api/sales/reports/index.js:573-659`. No dashboard filter/download/pagination. |
| Sales Reports | Pipeline, Owners, Products, Bundles, Categories, Organisations, Events, Conversion, Loss reasons, Deal size, Sales cycle; date/currency/status/owner/event/product/org filters; browser-local saved filters; 25/page; report CSV/drill-through. | `client/src/components/sales/SalesReportingWorkspace.jsx:17-24,115-178`; `api/sales/reports/index.js:96-490,535-571`. Report-specific facets/definitions; no universal widget calculation or export-column chooser implied. |

## Form Conversion

Source-to-target conversion is the actual current screen, not the
submission-completion report described in the rejected draft.

- UI: `client/src/pages/FormConversionReport.jsx:21,68-109,125-175`.
  Source form, target forms, organisation/email matching, comparison,
  optional source-and-target submission date bounds, 25/page and CSV with
  the same configuration.
- UI uses shared named report configurations via `useSavedExportReports`
  and `ExportReportSwitcher`; catalogue search is for selecting forms,
  not arbitrary answer search.
- The widget's equivalent conversion configuration is separately evidenced
  in `dashboard.md`; do not conflate widget aggregate CSV with this report's
  record-level CSV.
- Final handler verification: `api/reports/form-conversion-report.js:10-15,
  29-66,108-147,165-207,209-330`. Inclusive date range applies to BOTH
  source and target `created_date` (UTC start, exclusive next-day end).
  Max 20 targets, reject when a per-form scan reaches 50,000. Summaries
  contain source/target submission/entity counts and converted/not/rate.
  Rows sort by display name; 25/page UI, max 200 backend. CSV is all matching
  comparison rows with entity, organisation ID if relevant, status and
  source/target date lists. No export-column chooser.
- Survey exact filter correction: `api/reports/survey-report.js:158-222,
  605-645,670-865` supports separate event and submission dates,
  identified/anonymous and completion filtering, assignment/version
  selection and category aggregation. Do not infer delivery-status
  filtering from earlier draft labels. Comments CSV and response XLSX
  export all permitted filtered rows, not current page. Anonymous
  suppression is based on per-version snapshots.
- Sales date/export verification: `api/_lib/salesReports.js:26-63,83-104,
  559-577`; inclusive UTC dates, reject reversed or >10-year range;
  metric-specific date (pipeline expected close, quotes issue time/date).
  Export returns all filtered report rows, not page; normal UI 25/page.

## Source verification boundaries

- All access claims distinguish visible page/feature availability from
  independently enforced backend guards. Security discrepancies remain in
  internal notes, never in the tenant reports.
- “All filtered” client exports mean the loaded filtered population where
  the source loader is not fully paginated. They are not proof of a complete
  tenant export.
- No operation was executed. No fixes, migrations, settings changes,
  notifications, sample data or development proposals form part of this audit.