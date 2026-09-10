# Dashboard and reporting functionality

**Reviewed:** 10 September 2026

**Scope:** This report describes the current checked-out iConnect codebase, not a verified deployment or the configuration of a named tenant. Availability and labels can vary by tenant configuration, role and terminology.

## Overview

iConnect has three distinct dashboard experiences:

1. **Dashboard widgets** appear at the top of the main portal dashboard. They are configurable charts, lists and headline figures built from tenant data. A tenant can provide shared widgets, while permitted users can also build private widgets for themselves.
2. **Reports Dashboard** is a separate page containing seven fixed report cards. Users can choose which cards to show, reorder them and adjust the display controls provided by each card, but cannot define new report-card calculations.
3. **Portal summary cards** are fixed account summaries on the main portal dashboard. They show the signed-in user's organisation, its training fund balance and its total programme-ticket balance. An unread-message prompt also appears when the inbox is available and has unread messages.

Dashboard widgets and the Reports Dashboard are separate. Changes to one do not change the other.

## Available functionality

### Dashboard widget catalogue

| Choice | Available options | Important conditions |
|---|---|---|
| Display | Stat / KPI, bar chart, pie chart, donut chart, line chart, list | A line chart needs a date field. Bar, pie and donut charts need either a category or a date field. A list needs a category. |
| Measure | Count, distinct count, sum, average, minimum, maximum | Sum, average, minimum and maximum are available only for numeric fields. Count and distinct count can use non-numeric fields. |
| Date grouping | Day, week, month, quarter, year | Date grouping and category grouping cannot be combined in one widget. |
| Rolling date range | All time, or the latest 1–120 days, weeks, months, quarters or years | The current, incomplete period counts as one period. Empty periods inside the selected range are shown as zero. |
| Line calculation | Value per period or cumulative running total | Cumulative display is available for date-based line charts. |
| Width | One-fifth, one-third, one-half, full width | Permitted managers can resize a saved widget. |
| Height | Short, Medium, Tall, Extra Tall, Huge | Permitted managers can resize a saved widget. |
| Number display | Compact or full number; 0–4 decimal places | Applies to Stat / KPI widgets. |
| Presentation | Title, one of five tenant-configurable colours, optional helper text | Titles can contain up to 200 characters. Helper text can contain up to 1,000 characters. The builder provides a live preview. |
| Interaction | Optional click-through on supported grouped widgets | See “Opening the records behind a result” below. |

### Data available to dashboard widgets

Tenant-defined organisation and member fields are added to the relevant choices when they are active. Numeric tenant-defined fields can be used for numeric calculations; other supported field types can be counted, grouped or filtered as appropriate.

| Data area | Available information and special behavior |
|---|---|
| Organisations | Name, domain, country, derived region, created and last-synchronised dates, training fund balance, guest-access settings, purchase-order setting and active tenant-defined organisation fields. |
| Members / contacts | Email, role, organisation, derived region, derived organisation type, active or inactive in a chosen period, login and directory settings, created date, last activity and active tenant-defined member fields. The tenant's preferred plural label may replace “Members”. |
| Due Diligence submissions | Current status, organisation, Due Diligence form, organisation type, submitted and created dates, and the first date a submission moved to a selected stage. Reports can instead count all stage transitions or one selected transition. |
| Event bookings | Simple and complex event bookings in one source, including status, event kind, event, organisation, booker, attendee email, ticket type, guest status and booking date. Tenant-defined organisation fields can filter bookings but cannot be used as booking measures or groups. |
| Jobs | Job title, company, posting organisation and member, status, job type, hours, member-post and featured flags, payment status, external source, application method, location, amount paid, posted date, closing date, expiry date and last external-seen date. |
| Form conversion | Compares a source form with up to 20 different target forms. An organisation converts when it submitted both the source and any selected target; alternatively, submissions can be matched by lower-cased submitter email. Date filters apply to target submissions. |

Additional rules apply to some dimensions:

- **Region:** choose the iConnect or World Bank region scheme. Records covering several regions can appear once in a single Multi-region category or once in each applicable region.
- **Active in period:** uses each member's last activity. A start date, end date or both may be supplied; boundary dates are inclusive. A member with no last activity is inactive.
- **Multi-select fields:** a filter matches when any selected item matches. When used as a category, one record contributes to each selected category. Distinct counts flatten the selections before counting.
- **Due Diligence transitions:** a current-status report counts submissions in their current stage. A transition report counts status-change events; repeated forward transitions can therefore be counted more than once. Transition date filters use the time of the transition.
- **Event participation:** compares organisations with and without at least one booking that matches the widget filters. Bookings not linked to an organisation do not contribute to this split.

### Fixed Reports Dashboard catalogue

All seven report cards are shown by default.

| Report card | Headline information | Detail and controls |
|---|---|---|
| Members | Total members and members whose account status is active | New-member comparison with the preceding equivalent rolling period and an acquisition chart. Period choices are latest 7 days, 1 month, 3 months, 1 year or all time. |
| Activity | Members active in the latest 24 hours, 7 days, 1 month and 3 months; members inactive for 3 months or more; monthly engagement percentage | Comparison with the preceding equivalent rolling period and an activity chart based on each member's last activity. |
| Article Views | Distinct article–viewer pairs, number of viewed articles, distinct viewers and today's views | Views in the latest 7 days and month, five most-viewed articles, period comparison and trend chart. Repeated views of the same article by the same viewer count once. |
| Resource Views | Total recorded views, number of viewed resources, distinct viewers and today's views | Views in the latest 7 days and month, breakdown by download/video/link, five most-viewed resources, period comparison and trend chart. Resource views are not de-duplicated. |
| Organisation Types | All organisations split by a selected tenant-defined organisation field | Category totals and creation-date charts. Choose weekly, monthly, quarterly, yearly or all-time display; bar or line chart; and optionally combine two or more categories under a user-entered label. |
| New Organisations | Organisations created in the current calendar year, split by a selected tenant-defined organisation field | Each category also shows the current calendar month. Choose weekly, monthly, quarterly, yearly or all-time display, chart style and optional combined categories. |
| Members by Organisation Type | Members split by a selected tenant-defined field on their organisation | Category totals and member-created-date charts, with the same period, chart-style and category-combination controls. |

For the three organisation-category cards, the weekly view covers the current Monday-to-Sunday week, the monthly and quarterly views show the current calendar year, the yearly view shows all available years, and the all-time view is a single aggregate. A record with no selected field value appears as Unspecified. A multi-select field can place one organisation or member in several categories.

### Specialist reports inventory

Specialist reports are separate screens rather than configurable dashboard widgets.

| Specialist area | Available functionality | Limits and export behavior |
|---|---|---|
| AI Report Generator | A permitted administrator can describe a report in natural language, refine it conversationally, and view a generated title, description, summary figures, chart and sortable result table. Available summaries are count, distinct count, sum, average, minimum and maximum. Charts can be bar, line, pie or area. | Availability requires the relevant feature and a configured AI service. The request can contain up to 2,000 characters and can use only the reportable records, relationships and comparisons supported by this screen. Each generation reads at most 500 raw rows; summaries and charts therefore describe that returned subset. A chart uses at most the first 50 result entries. CSV contains all returned rows and generated columns, not only the first 20 table rows, and does not apply the table's temporary sort. Reports are not saved and cannot be scheduled from this screen. |
| Shared relationship reports for custom objects | A permitted user can build and save a shared, named report across a starting record and connected records. The user chooses the row relationship, fields, relationship fields and distinct counts of related records; can reorder columns and edit headings; and can choose whether to retain starting records that have no related row. Relationship paths can contain up to six steps without repeating a relationship or returning to the same record type. | Preview is paged at 50 rows. Current report definitions export the configured report population and column order as CSV in 500-row batches, with progress that can be resumed by returning in the same browser. There is no fixed overall row-count limit, but expansion beyond 10,000 field values in one cell or 100,000 in a processed batch is rejected. Some older saved definitions use a single-request export instead and may not behave identically. These reports do not inherit list filters and have no separate keyword/date/status filter panel. |
| Data Export & Backup | A role-controlled screen is present and describes a complete ZIP backup. | Its current export action does not generate a downloadable backup. Use a supported screen-specific export instead. This finding does not assess any separate operational backup service outside the product screen. |

### Event, finance and form reports

These screens have their own filters, calculations and export formats. A
widget's settings do not apply to them. Unless stated otherwise, exports
use fixed columns and do not offer an export-field chooser.

| Screen | Information and controls | Export scope and important conditions |
|---|---|---|
| Registration Report | Select simple events, complex events or event groups. Filter by event-start dates, event type, member group, event status, registration status, payment status, organisation and attendee search. Expand booking groups to see attendees. Choose and reorder standard columns and linked event-form answers. | CSV or Excel of the filtered loaded booking groups, with the chosen columns, rather than only a visible page. At least one event/group must be selected. A matching attendee can retain the rest of their booking group; payment figures remain group-level even when attendee filters narrow the display. Large source datasets can be incomplete because not every contributing list is retrieved in successive pages. |
| Event Budget Report | Actual and budgeted income, costs and profit/loss, variances, vouchers, seats, attendees and distinct organisations. Optional event-start From/To dates. Open an event's cost lines, add itemised costs or remove lines where permitted. | CSV of generated report rows; no selectable fields, event/status/organisation filter or on-screen paging. Missing budget amounts are treated as zero in variance calculations, not as a separate “not budgeted” state. |
| Pending Purchase Orders | Invoices awaiting a PO. Search organisation, invoice number, source or email; filter source type; sort by date, organisation or invoice number. Optionally hide paid invoices after a Xero status check. View 20 rows per page. Update a PO, send single or all-filtered reminders and configure reminder timing where permitted. | CSV of all loaded filtered invoices, not just the page, with fixed invoice/customer/source/reminder fields. Hide-paid results depend on the status check. The export's “Invoice Date” is the record's creation date, not necessarily the accounting invoice's date. |
| Monthly Finance Report | Monthly **voucher** position by organisation: opening, allocated, used, expired, adjustments, reinstated, closing, reserved and available balances. Select a month, organisation and positive/zero/negative closing balance. Open months use live figures; closed months use a saved month-end position. Expand an organisation for transactions, filtered by transaction type, voucher status, event, funding source, allocation dates or expiry dates. | Excel workbook with Summary and Transactions sheets. The selected month and organisation apply; the balance filter narrows Summary only. Expanded transaction filters are **not** carried into this export, so the workbook can include transactions not visible in the expanded detail. No field chooser. Future months cannot be selected. This is not an invoice net/VAT reporting screen. |
| Ticket Sales Analytics | Programme-ticket transactions summarised by organisation: purchased tickets after cancellations, used, refunded and net tickets, pre-discount sales value, programmes and transaction count. Search organisations, filter programme and sort by purchased tickets, sales value or organisation name. Open an organisation's transactions. | CSV of the filtered organisation summaries, with fixed columns for those measures. No event selector or date range; this is not event-ticket revenue or promotional-code analytics. |
| Survey Reports | Survey/version and event/group selection; separate event-date and submission-date ranges; identified/anonymous and completion filters; question/category scores, response volume/rate, event comparisons and score distribution. Volume can use event or submission date. Search comments and filter by question. Comments and permitted response details default to 25 rows per page, up to 100. | Multi-section summary CSV or Excel with Summary, Events, Questions and Categories sheets; all-filtered comments CSV; separately permitted response-detail Excel including filtered responses and comments. Exports are not confined to the current page. Anonymous identities remain protected and small anonymous cohorts may suppress comments and detail according to the survey version's settings. |
| Form Conversion Report | Select one source form and up to 20 target forms. Match organisations or submitter email addresses; show All, Converted or Not converted. Summaries include source/target submissions and entities, converted/not-converted entities and conversion rate. Rows show entity, outcome and submission dates, 25 per page. Configurations can be saved as shared named reports. | CSV of all matching rows, not the page: organisation or email, organisation identifier where applicable, outcome and source/target dates. No column chooser. Here, inclusive From/To dates constrain **both source and target submissions**. This differs from the conversion widget, whose date filters constrain target submissions only. A source entity converts when it has any selected target submission in the range; it need not submit every target. Processing stops with an error on reaching 50,000 submissions for a form. |
| Due Diligence Reports | Four configurable-visibility cards: Application Funnel, Verification, Due Diligence Meetings and Decisions. Form and rolling/custom period selection, service-target values, reorder/hide/show, summaries, trends, stage/reviewer breakdowns and links into the application queue. | Each card offers a fixed-column CSV, not selected queue rows or full answers. CSV population/date rules differ from the corresponding card, so downloads are not exact reconciliations of displayed totals. Retrieval is not fully paginated. Meeting stage counts are separate from actual meeting-request statistics. Preview mode shows examples, but export and queue links can still target live records using retained filters. See the standalone Due Diligence functionality report for precise date, cohort and extraction rules. |

### Engagement, group and sales reports

| Screen | Information and controls | Export scope and important conditions |
|---|---|---|
| Group Assignments Report | Current assignments with member/email, group, classification, role, leadership indicator and assignment date; totals for assignments, distinct members, leadership and groups. Search those labels; filter classification, group, role or leadership. Twenty rows per page. | Fixed-column CSV of all loaded filtered assignments, not the page. No assignment-date range; not a historical membership ledger. |
| Member Group Invite Report | Invitee, group/classification, inviter, sent/expiry/accepted dates and status, with status summary counts. Search invitee email, group, classification or inviter; filter status, classification and group. Twenty-five rows per page. Pending invites can be resent, copied or cancelled where permitted. | Fixed-column CSV of the loaded filtered invitations. The initial retrieval is not fully paginated, so the visible pagination and CSV do not guarantee a complete large invitation history. |
| Group Classification Report | Select one classification and an inclusive date range. View current member/organisation counts, leadership and co-convenors, alongside period emails, vacancies, resources and events; draft events are excluded. | On-screen only; no export or paging. Membership and leadership counts are current, whereas activity counts use the selected dates. |
| Member Role Report | Counts by assigned role, including No Role Assigned; expand each role for member name, email and organisation, 25 members per role page. Optionally segment by a configured organisation choice field. | CSV of all members after segmentation, not just expanded pages: role name/count, member name/email and organisation. No keyword, status or date filter on this screen. |
| Team Engagement Report | Members of the signed-in user's organisation, not a tenant-wide list of teams. View event participation, published articles, jobs, achievement and engagement awards, opening balances and total score. Search name/email, sort measures, include inactive members and open supporting detail dialogs. | On-screen only; no download, date range or paging. Opening balances contribute alongside recorded activity. |
| Organisation Engagement Report | Organisation engagement rates and member activity details; week/month/quarter/year or a custom range, period navigation and search. Custom ranges require both dates. | CSV of loaded filtered organisations and their member rows. No tier filter, user-sort or paging controls. Activity is inferred from each member's **latest activity date**, not a full event history; later activity can change earlier-period comparisons. Disabled accounts still contribute to the member-count denominator. |
| Sales Dashboard | Open and weighted pipeline, won value, outstanding quotes, currency breakdowns, recent activity/wins, expected closes and overdue tasks, with relevant record links. | On-screen dashboard, not the report export screen. No dashboard-level date/owner filter, download or paging. |
| Sales Reports | Pipeline, Owners, Products, Bundles, Categories, Organisations, Events, Conversion, Loss reasons, Deal size and Sales cycle. Report-dependent date, currency, status, owner, event, product and organisation filters; browser-local named filter sets; 25 rows per page and relevant record links. | CSV of all matching rows for the active report, not its current page. Fixed report-defined columns. Date ranges are inclusive and may span at most ten years; the measured date depends on the report, for example expected close for pipeline and issue date for quotes. Not every report offers every filter value. |

Access to these specialist screens is controlled separately by the relevant
report/module access. Administrative cost editing, reminders and invitation
actions are not granted simply by the ability to see a chart. Monthly Finance
requires administrator access; survey response detail has its own permission;
Sales dashboard and reporting access are separate capabilities. The
organisation-specific Team Engagement report also depends on the user's
organisation association.

## Searching and filtering

### Filtering a dashboard widget

A widget can contain multiple filters. All filters must match for a record to be included.

| Operator | Typical use |
|---|---|
| Equals / does not equal | Exact values, including configured choices and booleans |
| Contains | Text containing a value |
| Is one of | Match any value in a supplied set |
| Greater than / at least / less than / at most | Numeric or date comparisons |
| Is empty / is not empty | Presence or absence of a value |
| LMIC only / Not LMIC | Country-shaped fields, using the tenant's configured country list |

Filters are defined inside each widget. There is no dashboard-wide filter that automatically changes every widget. The fixed Reports Dashboard does not provide free-text search or arbitrary record filters; it provides only the period, organisation-field, chart and category-combination controls described above.

### Date interpretation

Dashboard-widget dates are calculated against UTC period boundaries. A rolling window starts at the beginning of the earliest included UTC day, week, month, quarter or year, and includes the current partial period.

Most fixed Reports Dashboard comparisons use rolling periods ending at the time the report is loaded: 7 days, 1 month, 3 months or 1 year, compared with the immediately preceding period of the same length. “Today” for article and resource views starts at the current calendar day's midnight, while “Active Today” means activity during the latest 24 hours.

## Managing information

### Shared and personal dashboard widgets

| Area | Visibility | Who can manage it |
|---|---|---|
| Shared widgets | Everyone in the tenant who can view dashboard reporting | Roles granted shared-widget management |
| My widgets | Only the owner | Roles granted personal-widget management |

In an area they can manage, users can:

- create and edit widgets;
- duplicate a widget as a new copy;
- permanently delete a widget after confirmation;
- drag widgets into a new order;
- change width and height.

Changes are saved to the tenant's dashboard. Shared and personal areas keep separate orders. Personal widgets and personal layouts cannot be shared with another user.

Roles with shared-widget management also control the five colour choices and which fields appear as new category choices for the tenant. Hiding a field does not break widgets that already use it. Colour slots can be relabelled with up to 40 characters and assigned a six-digit colour value; an existing widget retains its selected slot when the slot is changed.

### Arranging the fixed Reports Dashboard

Every user of the Reports Dashboard can:

- show or hide any of its seven report cards;
- drag visible cards into a preferred order;
- hide all cards and restore them through Customize;
- refresh each live-data card individually.

Card visibility, order, and the four main period selectors are remembered for that user in the current browser. The selected organisation field and period view for the Organisation Types card are also remembered. Demo mode, bar/line style, combined-category settings, and the corresponding choices on the New Organisations and Members by Organisation Type cards are reset when the page is reopened or used in another browser.

### Demo Data

The Reports Dashboard has a Demo Data switch. When switched on, all seven cards use built-in illustrative example values and live report requests are disabled. These figures are not tenant data. Refresh controls are hidden in demo mode. Switching demo mode off returns the cards to live tenant reporting.

## Reporting and exporting

### Opening the records behind a result

Click-through can be enabled for supported grouped widgets:

- an organisation category opens the organisation list for that category;
- a member/contact category opens the member/contact list;
- a booking or participation category opens the organisations behind that result.

Click-through returns no more than 2,000 record identifiers. When more records match, the result is marked as truncated. Click-through is not available for every source or widget shape.

### CSV export from a dashboard widget

When a widget has loaded successfully, any viewer can download its displayed aggregate result as CSV. Export does not require permission to edit the widget.

| Widget result | CSV content |
|---|---|
| Grouped or date-based result | `Label` and `Value` rows |
| Bar, pie or donut | Grouped rows plus a `Total` row |
| Line | Grouped date rows, without an added Total row |
| Stat / KPI | `Metric`, `Value` and `Records` |
| Form conversion | Converted count, conversion rate to one decimal place, source-entity count and not-converted count |

The file name is derived from the widget title. This is an aggregate export of the data already loaded into the widget, not an export of the underlying raw records.

The fixed Reports Dashboard and the portal summary cards do not provide CSV, Excel, PDF, print or dashboard-wide export controls.

## Permissions and configuration considerations

- Access to dashboard reporting is role controlled.
- Viewing dashboard reporting, managing shared widgets and managing personal widgets are separate role capabilities.
- A role may therefore view shared widgets without being able to edit them, or may be permitted to manage only one widget area.
- The Reports Dashboard is governed by the dashboard-view capability. It does not have a separate per-card management permission.
- Shared-widget managers have the tenant-wide field and colour settings described above.
- Available organisation and member fields depend on the tenant's active field configuration. Available Due Diligence forms, organisation-type values and LMIC country list also depend on tenant setup.
- A dashboard-widget section is omitted when the user cannot manage it and it contains nothing to display. The normal portal welcome content remains available.
- Error and retry states are provided when a widget or fixed report card cannot load. The widget builder validates incompatible choices before saving.

## Current Limitations

- A configurable widget can group by a category or by time, but not both.
- Grouped charts are limited to 30 categories, lists to 500 categories and time series to 50 date buckets.
- Widget scans have a 50,000-row ceiling; several sources reject on reaching that count and ask for narrower filters.
- Click-through returns at most 2,000 record identifiers and can therefore open a truncated result.
- Widget CSV contains aggregate displayed values, not raw contributing records. There is no whole-dashboard, fixed-report-card, Excel, PDF or print export.
- There are no saved named filter sets, cross-widget filters, scheduled refreshes or scheduled report delivery.
- Personal widgets and layouts cannot be shared with other users.
- AI-generated report calculations are limited to the first 500 fetched raw rows, chart display to the first 50 result entries, and the screen has no saved-report or scheduling function.
- Shared relationship reports support no standalone search or date/status filter panel. Very large relationship expansion is rejected, and some older saved definitions use a single-request export rather than resumable batches.
- The Data Export & Backup screen does not currently produce its advertised download.
- Fixed report period labels such as “This Week” and “This Month” mostly represent rolling periods rather than calendar periods. Article and resource “All Time” totals are all-time, but their “All Time” trend charts show only the latest two years.
- Article Views removes repeat article–viewer pairs before calculating every period. The retained viewing date is not guaranteed to be the first or latest, so recent-period counts are not a reliable count of pairs that viewed during that period.
- The fixed Reports Dashboard's preferences are stored only in the current browser, and several display choices are not remembered.
- Member-acquisition, activity-trend and organisation-category cards do not retrieve every contributing detail list in successive pages; large populations can therefore produce incomplete charts or category totals.
- Specialist exports do not all mirror visible filters: Monthly Finance omits expanded transaction filters, and its balance filter affects Summary only. Registration results and payments remain booking-group based.
- Some specialist reports load bounded source lists before local filtering and export. Visible paging is not, by itself, a guarantee that a large source population was fully retrieved.
- Organisation engagement is based on latest activity rather than a historical activity ledger, so previous-period figures can change when members become active again.
- Dashboard results reflect available stored data and tenant configuration; this code review did not validate the completeness, freshness or quality of any individual tenant's data.