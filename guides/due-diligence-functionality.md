# Due Diligence Functionality

**Reviewed:** 10 September 2026

**Scope:** Current functionality evidenced in the checked-out iConnect codebase. This document does not assert verification against a live deployment or any named tenant.

## Overview

The Due Diligence module provides a form-led review process. A Due Diligence record represents one submitted form that has been selected for Due Diligence processing. It retains the submitted answers, reviewer decisions and amendments, score and risk result, current workflow stage, ownership, notes, documents, signature activity, meeting activity and history.

A record can be linked to an organisation when the underlying form submission has an organisation association. The organisation name may also be used as the record's display reference. There is no separate organisation filter on the current queue, and the review screen does not provide a direct organisation-navigation control.

The module is configurable per Due Diligence-enabled form. Consequently, the stages, labels, scoring questions or rules, risk levels, assignable owner roles, transition controls and automated actions can differ between forms. “Approved” and “Rejected” are default stage labels rather than separate, immutable decision fields.

## Available functionality

### Record creation

| Entry path | Current behaviour | Initial-stage actions |
|---|---|---|
| Identified public form submission | A Due Diligence record is created automatically when the form has Due Diligence enabled. | Run when an initial stage is configured with actions. |
| Anonymous survey response | No Due Diligence record is created. | Not applicable. |
| Authorised manual form entry from Form Management | Creates the form submission and, where enabled, its Due Diligence record. The record is then managed from the Due Diligence queue. | Deliberately not run. |
| Initialising an existing form submission | Creates the Due Diligence record if one does not already exist; repeated initialisation returns the existing record rather than duplicating it. | Run for a newly initialised record. |
| Form swap | Creates a replacement record against another configured Due Diligence form and archives the source record. | Initial-stage actions may run for the replacement. |

There is no standalone blank Due Diligence record: creation is anchored to a form submission. Manual entry is opened for a selected form from Form Management rather than from the Due Diligence queue itself.

### Information held and displayed

| Area | Information and controls |
|---|---|
| Queue | Display reference, current stage, source form, risk level, created date, last-updated date, owner, form-swap control and record actions. |
| Review | Original and reviewed answers shown side by side, per-field approved/amended state, reviewer-only fields, field notes, overall notes, review author/date and current stage. |
| Scoring | Percentage score and risk level. Scoring is recalculated when relevant reviewed answers or assessment responses are saved. |
| Documents | Current document status, version number, preview where supported, download/open actions, version history, comments and replacement versions. |
| Signatures | Signer identity, contract, not-sent/pending/signed/expired state, sending and resending, alternative signers, signed-document viewing, manual completion and winner demotion. |
| Meetings and schedule | Meeting requests and scheduled contract or meeting events, with status and dates where available. |
| History | Submission receipt/update, stage change, score, email, contract, meeting, member-creation and form-swap events, depending on what occurred. |

### Workflow, decisions and actions

Administrators can configure and reorder stages, select the initial stage, change stage names and colours, and allow or disallow form swapping at each stage. The default configuration provides New, In Review, Verified, Approved and Rejected, but a tenant's forms may use different stages.

The review screen can mark a stage unavailable based on:

- a score above or below a configured percentage;
- receipt of all configured signatures;
- approval of all documents; and
- optional forward-only stage sequencing.

There is an important configuration caveat. The current configuration screen and review picker use the score, signatures and documents rules listed above, while the final stage-change check also recognises an older set of requirements covering minimum/maximum score, all signatures, all attachments and a designated organisation logo. These formats are not fully aligned. Forward-only sequencing is applied by the review picker. Administrators should test each configured transition, including first-review automation, before treating a displayed rule as a reliably enforced workflow guard.

Moving directly over intermediate stages is possible unless configuration prevents it. If skipped stages contain actions, the reviewer receives a warning that those skipped actions will not run.

Entering a stage can conditionally:

- send contracts for signature;
- send meeting invitations;
- send templated emails, optionally asking the reviewer for a custom message;
- create member records with configured role, login and field mappings;
- update mapped member or organisation information and trigger associated processing;
- send configured external status notifications; and
- create or update records in a configured external customer-management connection.

These actions depend on the relevant templates, mappings, recipient fields and integrations being configured. A form can also move a record automatically to a selected non-initial stage on the first saved review, including that stage's configured actions.

### Configuration matrix

| Configurable area | Options currently available |
|---|---|
| Review defaults | Fields begin approved or amended; locked fields and the linked organisation field remain approved and cannot be amended. |
| Display | Reference field, linked organisation name, or fallback reference; optional display of instruction/description fields. |
| Ownership | Roles whose members can be selected as owners; an optional default owner name for communications. Records can remain unassigned. |
| Scoring | Rules based on form-field values, or reviewer assessment questions with configurable coloured answers and points. |
| Risk | Any number of named, coloured levels with percentage thresholds from 0 to 100. |
| Workflow | Stage names, colours, order, initial stage, swap permission, forward-only sequencing, first-edit transition, entry conditions and actions. |
| External notifications | Status trigger, destination, and optional reminder settings. |
| Configuration reuse | A form's Due Diligence configuration and stage actions can be copied to another form; mappings that do not resolve on the target require correction. |

## Searching and filtering

### Queue controls

| Control | Matching behaviour | Availability |
|---|---|---|
| Keyword | Case-insensitive partial match against the generated application reference and the configured/displayed reference. It does not search every submitted answer. | Always visible. |
| Form | Exact form match. | Always visible. |
| Workflow status | Exact current-stage match, using the selected form's configured stages. | Enabled only when one form is selected. |
| Risk level | Exact current risk match, using the selected form's risk configuration. | Enabled only when one form is selected. |
| Owner | Exact assigned owner, or Unassigned. | Enabled only when one form is selected. |
| Submitted from | Created on or after the entered date. | Optional and independently applicable. |
| Submitted until | Created on or before the entered date, inclusive through the end of that date. | Optional and independently applicable. |

All applied filters are combined: a record must satisfy every active filter. Keyword and owner filtering are applied after the matching records have been retrieved; therefore they do not change the queue summary cards. The report drill-through links can also open the queue restricted to a reviewer or to records that have spent at least a specified number of days in their current stage, although those are not normal visible queue controls.

The queue retrieves records in batches of 200, for at most 100 batches, so search and local filters operate on no more than 20,000 retrieved matching records. Results are then displayed 25 per page with Previous and Next controls.

### Display behaviour

The display reference follows the configured reference choice where possible. If that does not produce a value, the system can fall back to the linked organisation name, common submitted organisation, company, name or email values, and finally the generated application reference.

The queue's columns can be resized to a minimum width of 60 pixels, with widths retained in the current browser. There is no user-selectable sorting, column chooser or saved queue view.

### Configurable dashboard widgets

The general dashboard widget builder offers Due Diligence Submissions as a data source. It counts non-archived Due Diligence records belonging to forms with an active Due Diligence configuration.

| Widget dimension or mode | Meaning |
|---|---|
| Status | The record's current Due Diligence stage, normalised into the recognised status group where possible. An unfamiliar custom status is shown under its stored value rather than discarded. |
| Organisation | The organisation linked to the underlying form submission. Records without that link have no organisation value. |
| Organisation type | The current organisation-type value for the linked organisation. |
| Form | The underlying form. The form picker contains actively configured Due Diligence forms. |
| Submitted at | When the underlying form submission was created. |
| Created at | When the Due Diligence record was created. This can differ from Submitted at when an existing form submission is initialised later. |
| Date moved to stage | The first recorded history event in which the record entered the selected stage. It is blank if no matching transition was recorded, including where older or initial-stage history is absent. |
| Stage transitions | Counts recorded moves from one stage to another instead of counting current records. It can show every from/to pair or one selected pair. Each recorded move counts, so moving back and later re-entering a stage counts again. |

Widgets support record count or distinct count, filters, and either a grouping or a date time-bucket. The Due Diligence source does not expose submitted form answers as widget custom fields and does not support numeric sum or average measures. In ordinary record mode, a date filter applies to the selected date dimension. In stage-transition mode, date filters apply to each transition event's own timestamp; grouping and time-bucketing are not used.

The widget engine refuses a Due Diligence widget that would scan 50,000 or more source records and asks for narrower filters. A stage-transition breakdown is limited to 30 distinct from/to pairs. Each loaded widget can export its aggregate result to CSV: a statistic exports its metric/value/record count, while a grouped chart exports label/value rows and, where shown by the chart, a total. This is an aggregate export, not an export of the underlying submissions or their answers.

## Managing information

### Review and edit

Reviewers can compare original answers with reviewed answers, approve a submitted value as-is or amend it using the relevant field control, and add a note to each field. Reviewer-only fields are editable without an original-value comparison. Multi-page forms retain page navigation in the review.

Locked form fields and the organisation field that represents the linked organisation cannot be amended in this view. Form visibility, repeatable-row and relationship-selection rules are validated when amendments are saved. General Due Diligence notes are also available.

Where traffic-light assessment is configured, reviewers answer configurable questions, can mark questions not applicable, attach question notes and hide completed questions. Not-applicable questions are excluded from that calculation. Field-rule scoring instead evaluates the reviewed form values.

### Ownership and dates

An owner can be assigned, changed or cleared when owner roles are configured. Only members in the configured owner roles are offered. Created and last-updated dates are shown, and the latest reviewer and review date are recorded when a review is saved. Relevant stage, communication, signature and meeting dates appear in history, schedules and reports.

The core Due Diligence record has no review-expiry date, renewal date or renewal workflow. Contract-signing requests and meeting requests can expire, but that does not expire or renew the Due Diligence record itself.

### Documents

Uploaded file fields appear in the Documents card, including empty placeholders where no file was supplied. A reviewer can:

- preview images and PDF files in the application;
- open or download other supported files;
- approve a version or return an approved version to pending;
- upload a new version while the current version is not approved;
- review all versions and their dates;
- add comments to individual versions; and
- access or generate a shareable URL for an approved stored version where supported.

Only one approved version is presented as the active approved document. Approving a replacement ages the previously approved version. An approved version must first be returned to pending before it can be superseded.

Document records can display a Rejected state, but the current document detail interface does not present a control to place a version into that state.

### Signatures and contracts

Contact fields associated with contracts appear in a separate Signatories card. The original signer can be sent or resent a contract. Alternative signers may be added until one signer completes the contract; the first completed signer becomes the winner and other signers are then locked out. Authorised reviewers can view/download the signed PDF, record a manual contract completion with a chosen date and entered answers, or demote the winner to return the contract to an unsigned state.

Contract expiry and reminders are shown in the submission schedule when configured. They are contract controls, not Due Diligence-record renewal controls.

### Form swap, archive and deletion

A permitted stage can offer a swap to another active, configured Due Diligence form. The preview separates values that will copy, target fields that will be empty and values that will be ignored. Matching is based on form-field labels. Active contracts can be relinked when a compatible target contract field exists; incompatible contract material remains associated with the archived source.

Execution creates a new form submission and Due Diligence record in the target form's initial stage, preserves the organisation association, links the old and new records in their histories, and archives the source record.

Deletion is permanent and requires two confirmations. It removes the Due Diligence record and underlying form submission and attempts to remove associated document records, contract records and contract reminder logs. Due Diligence submissions cannot instead be deleted from the general form-submissions screen.

There is no ordinary archive action for reviewers; archive is currently a consequence of form swapping.

## Reporting and exporting

### Queue summary

The queue displays total records, records in the selected form's initial stage, approved-stage records, high-or-critical risk records, a risk breakdown, average score and an ordinal average-risk indicator. These cards use the form/status/risk/date-filtered retrieved set before keyword, owner, reviewer drill-through and age drill-through filters are applied.

Because stage and risk names can be customised, the specifically named “approved”, “high” and “critical” summary values rely on those conventional configured values. Archived records are excluded.

### Due Diligence reports

| Report | Principal current measures |
|---|---|
| Application Funnel | Total applications, current stage counts and shares, stages ever reached, conversion and drop-off, average time by stage, visual funnel/bar view and prior-period comparison. |
| Verification | Verified and outstanding counts, turnaround, configurable service target indicators, outstanding age bands of 0–2, 3–5, 6–10 and 11+ days, six-month submitted/verified trend, current-document status and turnaround, document fields and reviewer breakdown. The interface shows up to five document fields and eight reviewers. |
| Due Diligence Meetings | Workflow-stage “scheduled” and “completed” counts, completion rate, stage-to-outcome timing, service-target breaches, actual meeting-request and booking statuses, meeting outcomes, score bands of 0–25, 26–50, 51–75 and 76–100, risk distribution, six-month workflow throughput and timing bands of 0–5, 6–10, 11–15 and 16+ days. |
| Decisions | Approved, declined and on-hold decisions and percentages, comparisons, six-month trend, decision timing by outcome, score by outcome, reviewer breakdown and service-target breaches. The interface shows up to eight reviewers. |

“Held” is interpreted as a meeting outcome when it occurs before final-decision stages in that form's workflow; otherwise it is treated as an on-hold decision.

The Meetings card uses two distinct populations. Its headline “Scheduled” figure is not a count of booking records: it counts Due Diligence records that are currently at Verified or a later recognised stage and whose first verification-stage event falls in the selected period, using underlying submission creation only when that event is absent. “Completed” counts records currently at a recognised meeting outcome or later stage and requires an outcome-stage event in the period. The scheduling duration is the time from verification to that outcome. Separately, the meeting-request section counts actual requests created in the period and reports request and linked-booking measures including booked, pending, expired, cancelled, no-show, resent/rescheduled and completed. A workflow milestone must not be read as proof that a meeting booking exists.

Users can choose all configured forms or one form and can select rolling 7-day, 1-month, 3-month or 1-year periods, all time, or a custom range. Despite some short labels, these are rolling periods rather than calendar week, month, quarter or year. A custom end date includes that entire date.

Date meaning differs by report:

| Report population | Date event used |
|---|---|
| Funnel period totals | Due Diligence record creation. |
| Verification | A currently Verified record is included only when it has a recorded verification-stage event in the period. A currently New/In Review record uses entry into its current stage, with underlying form-submission creation as the fallback when that history is absent. |
| Meetings | The workflow “scheduled” population uses first verification-stage entry, with underlying form-submission creation as a fallback; “completed” and individual outcome populations require a recorded outcome-stage event. Actual meeting-request metrics instead use request creation and linked booking dates. |
| Decisions | Current approved, declined or decision-hold records use their decision-stage event. If that event is missing, underlying form-submission creation is used only to decide whether the record belongs in the selected headline cohort; decision date and time-to-decision remain blank and such a record is excluded from event-based trends. |

The default report view is all configured forms over a rolling one-month period. Service-target values default to 5 days for verification, 10 days for meeting scheduling and 14 days for decisions; a user may enter any non-negative number of days. Report visibility, order, filters, service targets and preview-mode preference are retained for that browser/user/tenant context. Reports can be hidden, shown and reordered, but not resized. Many figures link to a pre-filtered queue.

### CSV exports

Each of the four reports has a CSV download. Exports:

- re-read a report-specific population rather than exporting selected visual rows;
- use the selected rolling/custom period according to each export's population rules, with a custom end date included through the end of that date;
- exclude archived records;
- do not apply the on-screen service-target number;
- do not offer field selection;
- do not include full form answers, custom form fields, organisation details or document contents; and
- provide CSV only, not an Excel workbook.

The downloads do **not** reproduce the report cards exactly:

- Funnel cards apply the period to Due Diligence record creation, while Funnel CSV applies it to underlying form-submission creation.
- Verification cards exclude a currently Verified record that has no recorded verification event. Verification CSV retains such a record regardless of the selected period because it has no verification date to test; its date and turnaround remain blank. The outstanding population uses current-stage entry with form-submission creation as fallback in both.
- Meetings CSV is not an export of either the workflow headline cohort or the actual meeting-request/booking cohort. It includes records by the first available meeting-outcome event, verification event or, if neither exists, underlying form-submission creation. It contains no meeting-request status or booking fields.
- Decisions CSV and the headline decision cohort both use decision event where available and form-submission creation to place legacy records with no decision event in the period; those legacy rows have blank decision timing.

The report and export reads do not explicitly page through their source data. The available result can therefore be constrained by the data service's per-request row limit; neither the cards nor their CSVs should be treated as guaranteed complete for a population larger than that limit.

| Export | Fields included |
|---|---|
| Funnel | Underlying submission identifier, application reference, form identifier, stored workflow status, underlying form-submission creation date, current-stage entry date (with form-submission creation as fallback) and age in days since form-submission creation. |
| Verification | Underlying submission identifier, application reference, form identifier, stored workflow status, verified/outstanding state, reviewer, underlying form-submission creation date, verification date, current-stage entry date (with creation fallback), turnaround days and outstanding age days. It does not include document counts. |
| Meetings | Underlying submission identifier, application reference, form identifier, stored workflow status, score, risk, underlying form-submission creation date, verification-stage date, meeting-outcome stage date and duration from verification—or creation when verification is absent—to outcome. It does not include meeting-request or booking fields. |
| Decisions | Underlying submission identifier, application reference, form identifier, stored workflow status, decision, score, risk, reviewer, underlying form-submission creation date, decision date and time to decision. |

When active Due Diligence configurations exist but the export cohort is empty, the CSV contains the normal report headers with no data rows. The one-column no-data marker is used only when no active configuration matches the selected form scope.

### General form-submission view and exports

Every Due Diligence record is anchored to an underlying form submission. Where a user's access includes Form Submissions, the same underlying submission can also appear there. That area is separate from the Due Diligence queue:

- View Full displays the submitted form answers, submitter, submission date and linked organisation, and allows individual submitted fields and the general form-submission status to be edited. The general status values such as New, Actioned and Junk are not the Due Diligence workflow stage.
- CSV export is available only after choosing one form. It exports all submissions in the currently filtered general form-submission result, not the selected rows. Users choose from form name, submitter name/email, general status, submission date and that form's answer fields.
- Word export can use all currently filtered submissions or only selected submissions, and users can choose the included metadata and answer fields. A single submission also has a Word download.
- Large Word exports use background processing and accept at most 5,000 submissions.
- No PDF export is presented in the reviewed Form Submissions or individual submission view.

These general exports use the current underlying submitted answers and readable representations of supported choices, relationships, repeatable rows and file links. If an answer is edited in the general submission view, that changed underlying answer is what a later general export uses; this remains separate from the reviewed/amended answer set held by Due Diligence. These are not Due Diligence case exports: they do not add field approval state, review notes, Due Diligence score/risk/stage/history, document-review state or signature activity. Accordingly, the four report CSVs remain the only exports directly on the Due Diligence reporting screen, but they are not the only way to export data from the associated form submission.

### Demo Data / Preview mode

Turning on Demo Data replaces the report cards and headline figures with a fixed sample dataset and a single sample form. Live report-statistic requests and manual refresh controls are disabled while this mode is on. It is a presentation preview; changing the displayed period or service target can change which prepared sample figures the cards select or how they flag performance, but it does not query tenant records.

Export and dashboard links remain visible in Demo Data mode. They are not generated from the sample dataset: CSV export still performs a normal live report export using the retained filters, and dashboard links open the normal live queue with those filters. If the form filter remains All Forms, these actions can therefore return actual tenant records even though the cards show samples; selecting the sample form will ordinarily return no corresponding live records. They must not be interpreted as an export or drill-through of the figures displayed in Preview. Switch Demo Data off and confirm the filters before exporting or following dashboard links for operational use.

## Permissions and configuration considerations

Due Diligence queue, review, configuration and reporting pages are subject to each member's assigned page/module access and to portal-menu configuration. A user who cannot access a relevant page is redirected rather than shown its controls. Access to Form Submissions, its exports and the general dashboard widget builder is configured separately. Administrative setup also depends on the form being enabled for Due Diligence and having an active Due Diligence configuration.

The exact experience varies by form and tenant configuration:

- stages, “approval” and “rejection” labels are configurable;
- status and risk filters are available only after selecting one form;
- owners appear only when assignable roles have been configured;
- signature controls require contract-enabled contact fields;
- meeting actions require meeting types, templates and booking agents;
- email, member, mapping and external actions require valid templates, mappings and connections;
- reporting lists forms with active Due Diligence configuration; and
- historical records with incomplete event history may use the documented report fallbacks.

The effective permissions of a live role or tenant were not reviewed. Destructive and management controls should therefore be treated as available to appropriately authorised users, not as universally available to every member.

## Current Limitations

- There is no Due Diligence-record expiry date, renewal date, renewal process, expiry/renewal filter or expiry report. Expiry shown for contracts or meeting requests is separate.
- There is no standalone blank-record creation control in the Due Diligence queue; records originate from form submissions.
- Keyword search is limited to generated and displayed references. It does not search all answers, notes, organisation fields, owners or custom fields.
- There is no separate organisation filter, reviewer control, type/category control or custom-field filter in the visible queue. Reviewer and stage-age restrictions are available only through report drill-through links.
- Status, risk and owner filters cannot be used while viewing all forms.
- Queue search/filter retrieval is capped at 20,000 matching records before local filtering, and queue pages contain 25 rows.
- Queue columns cannot be selected or reordered, and records cannot be user-sorted.
- Queue filters/views cannot be named and saved.
- Keyword and owner filters do not update the summary cards.
- There is no Due Diligence queue export. The four Due Diligence report cards provide fixed operational CSVs; aggregate dashboard widgets and the separate Form Submissions area provide different exports as described above.
- Due Diligence report CSVs have no selected-row export, field chooser or Excel option, and do not contain full submitted/custom-field data or document content.
- General Form Submissions can export selected answer fields to CSV or Word, but those exports do not include Due Diligence review decisions, notes, score, risk, workflow history or subordinate review activity.
- Although a document can display a Rejected state, the current document detail interface has no Reject action.
- There is no bulk selection, bulk assignment, bulk stage change, bulk archive, bulk delete or other bulk Due Diligence action.
- There is no ordinary archive control. Form swapping archives the source, but the visible queue has no control to include archived records even though the swap message says archived records can be found by including them.
- The queue's specifically named approved/high/critical summary cards depend on conventional configured values and may not reflect semantically equivalent custom labels.
- Report cards can be hidden, shown and reordered, but not resized.
- Demo Data CSV and dashboard links do not represent the displayed sample figures; operational export/drill-through requires Demo Data to be switched off.
- Report cards and CSV exports use unpaged data reads, so large populations can be incomplete at the data service's response limit.
- Report CSV populations are not exact row-level reproductions of the cards, particularly for Funnel, Verification and Meetings; the differences are documented in the export section.
- The source audit did not verify behaviour against a running deployment, live external integration, actual scheduled processing or a named tenant.