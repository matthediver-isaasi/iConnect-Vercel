# CRM search and export functionality

**Source review date:** 10 September 2026

## Overview

The CRM provides separate workspaces for Organisations and Members. Each has its own search, filters, list or card presentation, saved views, record details, selection, deletion and CSV export. There is no single joined search across both record types.

Organisation Groups, configurable Custom Object Records, Sales Opportunities and Sales Quotes are associated workspaces rather than additional modes of the main Organisation or Member lists. The member-facing directories are also separate: they present configured information for discovery by users and are not the administrator CRM.

This guide describes the current checked-out iConnect codebase, not a verified deployment or the configuration of a named tenant. Availability depends on enabled areas, configuration, permissions and data.

## Available functionality

| Area | What is available |
|---|---|
| Organisations | List and card views; search; core, group and configured custom-field filters; sorting; configurable columns; personal saved views; record creation and detail navigation; selected or filtered CSV export; selected-record deletion |
| Members | List and card views; search; login, organisation, department, role, contact and configured custom-field filters; sorting; configurable columns; personal saved views; record creation and detail navigation; selected or filtered CSV export; selected-record deletion |
| Organisation Groups | Separate 20-per-page list and card workspace with search, filters, sorting, configurable columns, create/edit/delete and a whole-hierarchy CSV export |
| Custom Object Records | Separate configured record-type lists with search, typed filters, archive visibility, sorting, configurable columns, personal saved views, CSV export and archive rather than hard delete |
| Sales Opportunities | Separate table or pipeline board with name search, stage filter, a “My opportunities” option, personal browser-saved views and opportunity details |
| Sales Quotes | Separate paginated list with search and status filter; individual non-draft quotes can be previewed or downloaded as PDF |

The main Organisation list shows 20 records per page. The main Member list shows 50. Custom Object lists allow 10, 25, 50 or 100 records per page.

### Columns and saved views

Organisation and Member columns can be shown, hidden and reordered. The record-name column remains required. The available custom-field columns depend on administrator configuration.

| List | Core columns available |
|---|---|
| Organisations | Organisation, Group, Members, Contact, Email, Phone, Website, Address, Description and Created. Organisation, Group, Members and Contact are initially visible. |
| Members / Contacts | Member, Email, Organisation, Department, Job Title, Mobile, Status and Roles. Member, Email, Organisation, Job Title and Status are initially visible. |

Named Organisation and Member views are personal to the user and list. A view can retain:

- search text;
- active filters and operators;
- sorting;
- filter order and hidden filters; and
- column order and visibility.

Views can be created, updated, renamed, deleted and made the default. Column preferences stored separately from a named view are not the same as a saved view.

Custom Object lists have equivalent personal views scoped to the configured record type. These also retain whether archived records are included and the selected page size.

Organisation Groups do not provide named saved views. Their column preferences are browser-local.

## Searching and filtering

### Search behaviour

| Workspace | Search scope and matching |
|---|---|
| Organisations | Case-insensitive partial matching across organisation name, invoicing email, phone and website |
| Members | Search text is split on whitespace. Every word must match at least one of first name, last name, email, mobile or job title. Matches are case-insensitive and partial |
| Organisation Groups | Case-insensitive partial matching across group name and description |
| Custom Object Records | Case-insensitive partial matching across readable active text, long-text, email, web-address, dropdown and single-country fields |
| Sales Opportunities | Case-insensitive partial matching on opportunity name only |
| Sales Quotes | Case-insensitive matching across quote number, customer reference and the snapshotted organisation name |

Member search does not search organisation name, department, role, biography, landline or custom fields. Use the corresponding filters where they exist.

The public-site search results page concerns published site content, not a generic joined CRM search.

### Organisation filters

| Filter | Options |
|---|---|
| Organisation Group | A specific group or organisations with no group |
| Phone, invoicing email, website, invoicing address | Contains, does not contain, equals, is empty, is not empty |
| Text custom fields | Contains, does not contain, equals, is empty, is not empty |
| Choice and country custom fields | Any of, none of, is empty, is not empty |
| Boolean custom fields | Is Yes, is No, is empty, is not empty |

The Organisation list accepts up to 20 active custom-field filters in one request.

### Member filters

| Filter | Options |
|---|---|
| Login status | Active or Disabled |
| Organisation and role | Is, is not, is empty, is not empty |
| Department | Any selected department |
| Phone (the Member mobile number) and job title | Contains, does not contain, equals, is empty, is not empty |
| Member custom fields with configured choices | Any of, none of, is empty, is not empty |
| Member custom fields without configured choices | Contains, does not contain, equals, is empty, is not empty |
| Member boolean custom fields | Is Yes, is No, is empty, is not empty |
| Related organisation fields with configured choices | Any of, none of, is empty, is not empty |
| Related organisation country fields | Any of, none of, is empty, is not empty |
| Related organisation fields without configured choices | Contains, does not contain, equals, is empty, is not empty |
| Related organisation boolean fields | Is Yes, is No, is empty, is not empty |

Multiple active filters narrow the result together. In other words, records must satisfy every active filter. Where a choice filter contains several selected values, matching any selected value satisfies that one filter. Negative choice filters also include records where the field has no value.

A Member request accepts up to 100 selected identifiers in each Organisation, Department or Role filter, plus up to 20 Member custom-field filters, 20 related-Organisation custom-field filters and 10 direct-field filters.

The main Organisation and Member lists do not provide a dedicated created-date or other date-range filter. A date-type custom field exposed on these lists is handled as a text-style filter rather than as a calendar range.

### Sorting

Organisations can be sorted by name, member count, contact or invoicing email, email, phone, website, description and created date. Organisation Group, address and custom-field columns are not sortable.

Members can be sorted by name, email, organisation name, job title, mobile and login status. Departments, roles and custom fields are not sortable.

Organisation Groups provide:

- case-insensitive partial search across group name and description;
- a Description filter with contains, does not contain, equals, is empty and is not empty;
- configured text, long-text, email, web-address, number, decimal and date fields with the same five text operators;
- configured choice and country fields with any of, none of, is empty and is not empty;
- configured booleans with Is Yes, Is No, is empty and is not empty; and
- ascending or descending sorting by name, description, organisation count or created date.

All active Organisation Group filters combine together. Multiple values within one choice or country filter match any selected value. Configured custom fields can be displayed as columns but cannot be sorted. Results are paged at 20 groups, with list and card presentations.

Custom Object Records can sort by created or updated time and by supported readable fields. Supported relationship columns can be sorted by related label or count. Their typed filters include:

- relationships: any of, none of, is empty or is not empty;
- numbers and dates: equals, at least or at most;
- options, countries and lists: any of or none of;
- text: contains, equals, is empty or is not empty; and
- booleans: equals.

## Managing information

Opening an Organisation or Member from a list leads to its full record.

### Organisation records

Organisation records can include Overview, Members and Activity, plus conditional areas for Commercial information, Notes, Forms, Documents, Membership and configured related records. Depending on configuration and access, users may see or manage core and custom information, tags, logo, guest access, team information and a training-fund summary.

The Members area can be filtered by role. Administrators can add or invite members. Notes can be searched, carry attachments and be edited or deleted. The Activity area combines recent booking, form and opportunity activity, but it is a recent-activity summary rather than a guaranteed complete ledger.

### Member records

Member records can include Overview, Activity, Roles, Categories, Opening Balances, Notes, Communications, Membership and configured related records. Available actions can cover core and custom information, role and organisation assignment, login and directory status, guest expiry, communication preferences and other configured data.

Member activity brings together bookings, event and session check-ins, group joins and leaves, and opportunity activity. Notes can be searched, edited and deleted.

### Sales records linked to CRM

Opportunity details connect an opportunity to its Organisation and contacts. They also provide collaborators, notes, documents and tasks, stage changes and stage history, activity, Quotes and allocations. Users with edit access can add and remove notes and tasks; collaborator management requires broader Opportunity management access.

The Quote list can be filtered to Draft, Issued, Sent, Accepted, Converted, Rejected, Declined, Expired or Superseded. Opening a Quote provides its current immutable or editable version as appropriate, delivery and status history, and version comparison.

### Bulk selection and deletion

Both main lists allow selection of rows on the current page and can expand selection to all matching selectable records for export. The primary organisation is excluded from the Organisation all-filtered selection.

Deletion is more restricted:

- it acts only on records explicitly selected in the UI, not the all-filtered population;
- confirmation requires typing `DELETE`;
- deleting an Organisation removes the organisation, clears or removes related organisation data as appropriate, and anonymises and unlinks its members; and
- deleting a Member removes associated personal-data records, disables access and directory display, and anonymises the retained member record so historical financial references can remain intact.

Deleting an Organisation Group has different behaviour: organisations are detached from the group, not deleted.

Custom Object Records use archive instead of hard deletion. Archived records are hidden by default and can be included using the archived-record option.

## Reporting and exporting

### Main CRM CSV exports

Organisation and Member CSV controls are available to signed-in users who can access the respective CRM screen. A user first selects records on a page or expands that selection to all matching records.

Organisation and Member exports support two scopes:

1. **Selected records** — exports the explicitly selected records. Current list filters are not reapplied to that selected set.
2. **All filtered records** — reruns the current list search and filters and exports all matching selectable records.

Before download, the export compares the current matching count with the count recorded by the screen. An empty selected population or a different count blocks the download and asks the user to refresh. This is a count check, not a record snapshot: edits or substitutions that leave the count unchanged are not detected.

These CSVs use fixed core schemas and are not based on the currently visible columns. There is no export field picker in the main lists.

| Export | Field behaviour |
|---|---|
| Organisations | Fixed organisation, contact, address, commercial, grouping and timestamp fields, plus all active Organisation custom fields |
| Members | Fixed identity, contact, organisation/group, department, role, account, directory, membership, engagement and activity fields, plus all active Member custom fields |

Member exports do not add the related Organisation custom fields that may have been used to filter the member population.

Export values are normalised for CSV, but the two exports do not format every custom value identically. Organisation custom choices use their configured labels. Member custom choices export their stored values, including semicolon-separated values where several are stored. Both exports present custom booleans as Yes or No. The main exports process records in batches and do not impose a fixed whole-export row ceiling, although normal browser, network and processing constraints still apply.

### Export matrix

| Screen or report | Format and population | Columns and related/custom information | Availability and practical limits |
|---|---|---|---|
| Organisations | CSV of explicitly selected records, or all records matching the current Organisation search and filters. It is not a current-page-only export unless only current-page rows were selected. Selected mode ignores current filters. | Fixed core organisation, contact, address, commercial, group and timestamp columns, plus all active Organisation custom fields. Visible-column settings do not change it. | Signed-in access to the Organisation CRM screen and a non-empty selection are required. The filtered mode excludes the primary organisation. Processing uses 1,000-row batches; there is no fixed total row ceiling in this workflow. A count mismatch blocks download. |
| Members | CSV of explicitly selected records, or all records matching the current Member search and filters. It is not a current-page-only export unless only current-page rows were selected. Selected mode ignores current filters. | Fixed identity, contact, organisation/group, department, role, account, directory, membership, engagement and activity columns, plus all active Member custom fields. Related Organisation custom fields can filter the population but are not included as export columns. Visible-column settings do not change it. | Signed-in access to the Member CRM screen and a non-empty selection are required. Processing uses 1,000-row batches; there is no fixed total row ceiling in this workflow. A count mismatch blocks download. |
| Organisation Groups | CSV of the whole group → organisation → department hierarchy, regardless of the current page, search, filters or visible columns. | Group, Organisation and Department names and identifiers. Empty groups and grouped organisations without departments remain represented. Group custom fields are not included. | Requires access to Organisation Groups and administrator-level access. Source records are read in 1,000-row batches; there is no fixed total row ceiling in this workflow. |
| Custom Object Records | CSV of all records matching the current record-type search, filters, sort and archived-record setting; not selected rows or the current page only. | The currently visible columns. Readable custom fields can be included. Visible relationship columns show up to three related labels and indicate further values. | Requires permission to view and export that record type and read the included fields. Fetches 1,000 rows per request and continues to the reported total; there is no fixed total row ceiling. The browser assembles the file. |
| Shared Custom Object relationship report | CSV of the configured shared report population and configured column order, not selected CRM rows, a CRM-filtered population or only the 50-row preview page. | The builder can choose a starting record type or connected entity, follow a relationship path of up to six steps without returning to a previous record type, choose/reorder columns, edit headings, include relationship fields and count distinct related records for each row. Member fields include names, email and Organisation identifier; Organisation fields include name and email; Organisation Group includes name; Custom Objects include active readable fields and record identifier. Multi-values are joined with semicolons. | Requires management access to the configured data model, record/export permission and readable related fields; reports involving core CRM entities also require administrator access. Shared named configurations can be created, applied, updated, renamed and deleted. Preview is 50 rows per page. Current exports use resumable 500-row batches with no fixed total row ceiling; a cell may expand to at most 10,000 values and one processed batch to at most 100,000 expanded values. Some older saved definitions use a single-request export instead. |
| AI-assisted report | CSV of all rows returned for the generated report, not just the initial 20-row table display. | Generated report columns, or the returned row fields when columns are not specified. Screen-only sorting is not applied to the CSV. There is no export field picker. | Requires administrator and AI Reports access plus configured AI service. The report request is limited to 2,000 characters and generation reads at most 500 source rows. Summaries, charts, table and CSV therefore operate on that returned subset. No fixed scheduling or saved-report facility is provided. |
| Sales Opportunities | No list export. | Not applicable. | The list remains searchable/filterable but has no CSV, spreadsheet or PDF action. |
| Sales Quotes | PDF preview or download for one non-draft Quote; no whole-list export. | The branded immutable Quote version, rather than CRM-list columns. | Requires Sales access; Quote actions depend on Quote management permissions. |
| Data Export & Backup | No downloadable file is currently produced. | Not applicable. | The screen may be available through Data Export access, but its current action reports failure. Use a supported screen-specific export above. |

Shared relationship reports do not have a standalone keyword, date or status filter panel and do not inherit CRM list filters. Their relationship path and active data define the population. A report can optionally retain starting records that have no related row and can apply a configured label for a missing related record.

## Permissions and configuration considerations

What a user sees and can do depends on their role, enabled areas and configuration.

- Organisation, Member, Organisation Group, Sales and Custom Object access are controlled separately.
- Creating, editing and deleting core CRM records is generally more restricted than viewing them.
- Custom Object permissions separately govern viewing, creating, editing, archiving and exporting records. Field-level settings can make individual fields readable, editable or unavailable.
- Custom Object export includes only information the user can read.
- Organisation and Member custom fields can be independently configured to appear as list columns and as filters.
- Detail tabs and actions appear only when the relevant feature or configuration is available.
- Sales users require Sales access. Non-administrator Opportunity lists are limited to records they own or collaborate on; “My opportunities” applies that same owner/collaborator scope for administrators who choose it. Quote management and sensitive pricing actions have additional restrictions.
- Organisation Group hierarchy export is available only with administrator access to Organisation Groups.
- Member and Organisation directories have their own display, role, field, organisation and filter settings. They are designed for configured user-facing discovery and should not be treated as a substitute for the administrator CRM.

## Current Limitations

- Organisations and Members must be searched separately; there is no joined CRM-wide Organisation/Member search.
- The public-site search is a content search, not a generic CRM search.
- Main CRM lists have no dedicated date-range filter.
- Main Organisation and Member CSVs use fixed schemas rather than visible columns or a user-selected field set.
- Main CRM list exports are CSV only. Individual Sales Quotes are a separate exception with per-quote PDF output.
- There is no selected-row bulk update or archive action on the main Organisation and Member lists. Their bulk action is the deletion workflow for explicitly selected records, with the anonymisation and historical-retention behaviour described above.
- Organisation Groups have no named saved views, and their export always covers the whole hierarchy.
- Opportunity search covers opportunity name only, and the Opportunity list has no CSV export.
- The Quote list has no combined CRM export.
- Custom Object relationship labels in list CSV output are limited to three displayed labels per relationship cell.
- Data Export & Backup does not currently generate a backup file.
- AI-assisted report generation is based on at most 500 source rows.
- Recent activity components are bounded summaries: Organisation activity applies smaller sampling/display bounds, while the unified Member booking, group and check-in timeline shows the latest 50 entries.