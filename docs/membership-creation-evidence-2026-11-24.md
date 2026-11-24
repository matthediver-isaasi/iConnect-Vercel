# Membership creation evidence

Read-only investigation, 24 November 2026. No application, configuration, accounting or payment records were changed; no processing endpoints, communications or provider operations were invoked.

## Conclusion

**The automatic membership-renewal cron created the membership and invoice, following an enquiry that created the member and an automatically approved invoicing setting.** This is supported by the saved execution log, not merely a possible code path.

The enquiry was not the subsequent full membership application. A retained message asked the member to complete that next step. No second submission or local payment evidence was found within the searches below.

The linked invoice is now locally recorded as **voided**. The owner describes the void as deliberate. The available evidence does **not** establish its exact date, actor or provider-side audit history.

## Target and references

The connected Supabase project listing and project instructions agree on destination project `lvmzliemqnieeoruhkik`, **iconn-multi-tenant**. Queries ran against that explicit project, not the legacy SOURCE or Replit-managed database.

The member lookup established tenant **Graduate Futures Institute**, `fd82da65-aab7-4a5c-85b8-b2febeb2003d`. Subsequent reads were tenant-scoped; tables without tenant columns were filtered by the verified member ID.

| Reference | Record |
|---|---|
| Member | `63ca2730-90cd-421a-bc72-2adc8aeb6e2d` |
| Enquiry submission | `39826897-cebb-4318-afad-9f94d4f84612` |
| Enquiry form | `f38233a3-08fd-4b83-930a-398333f15300` |
| Pipeline binding | `33b7b6ee-8be6-4724-9042-e56040371107` |
| Invoicing setting | `df04d5ea-6e04-46da-8c12-83faafcf2dc7` |
| Membership history | `22bbc19f-a787-4a26-badc-eca25648f38d` |
| Structure | `ed35c64a-2f4a-40d6-909c-8c7288e4d6f1` — 2026/2027 Freelance |
| Xero invoice | **SI-44976**, `89beec72-69e3-445b-81cb-b163358939cb` |
| Creation execution log | `f894d767-3ce6-415e-9998-c891707023f5` |

## Dated evidence timeline

Times are UTC for timestamp-with-time-zone fields. The execution-log timestamp has no timezone suffix; it is reported below as stored, consistent with the surrounding UTC chronology.

| Date/time, 2026 | Persisted evidence |
|---|---|
| 12 Nov 01:31:24.450 | **Freelance enquiry** submission created. It is now `actioned`, with `created_member_id` linking the target member. Its payment status, payment reference and payment metadata are null. |
| 12 Nov 01:31:28.686645 | Member created (`created_on`). |
| 12 Nov 01:31:29.343024 | Member preference `0d56851d-aa19-4722-917a-686d50733dee` records **Freelancer**, matching the membership structure selector. |
| 12 Nov 01:31:29.763492 | Pipeline binding links that enquiry, primary-member pipeline `member_1767041423468`, and this member. Submission entity processing completed at 01:31:30.078. |
| 12 Nov 01:31:30.683475 | Year-specific invoicing setting created: `invoicing_mode=automatic`, `fees_approved=true`, `membership_year=rolling:2026-11-12`, no invoice date or PO. |
| 12 Nov 13:04:41.444 | Retained transactional message `ea8444fa-3fa9-43aa-a6f4-c096730a37fa`: **“Next step: Complete your Graduate Futures freelance partner application”**. |
| 12 Nov 13:04:41.632557 | Workflow log `2f3723b5-ccb8-4ed1-8e08-9a881c848e9a`, workflow `98d42f35-486e-4605-8a52-12151d5e574b`, records a user-confirmed field-change invocation and a successful `send_email` action. It does not record a create-membership action. |
| 12 Nov 17:00:47.360459 | Membership history created. Origin note: **“Automatic renewal via cron job (year 1, member: …)”**. Amount: £120 net + £24 VAT = **£144**. Term: **12 Nov 2026–11 Nov 2027**, renewal date 12 Nov 2027. No previous-term reference. |
| 12 Nov 17:01:03.945, as stored | `scheduled_task_log` records `membership_renewals`, target member, `mode=automatic`, `action=renewed_and_invoiced`, `status=processed`, year 1, fee 120, and `xeroInvoice=SI-44976`. This establishes invoice creation during that run, after history insertion and by this completion log; the precise provider creation timestamp was not retrieved. The whole run was partial/deferred, but this individual result succeeded. |
| 13 Nov 18:05:37.560917 | Member note `1ce233a7-cd00-4566-8b0c-e97ed9d5ae81` records withdrawal of interest in the membership application. Author reference: `ddeb75ae-3fa7-4eac-bc26-867294c3965a`. This is not a void audit event. |
| Exact time unknown; observed 24 Nov | History remains `status=active` but `payment_status=voided`, `paid_at=null`. The member currently has login disabled. The history's `updated_at` still equals its creation timestamp and therefore cannot date invoice linkage or voiding. |

## Why the enquiry led to an invoice

**Confirmed facts:** the enquiry created this member; the Freelancer selector was persisted immediately; an approved automatic invoicing row followed within seconds; the cron later explicitly reported creating the membership and invoice.

**Strongly supported attribution, not separately audited:** application processing auto-approved the fees. Current `api/forms/process-application.js` calls `autoApproveMemberFees` after member processing. `api/_lib/membershipFeeApproval.js` resolves the member structure and, when auto-approval is enabled, inserts a year-specific setting with `fees_approved=true` and `invoicing_mode=automatic`. The timestamps and saved configuration match this sequence. The invoicing row has no actor/source audit, so this particular helper invocation is inferred rather than independently logged.

The current enquiry form's primary-member pipeline sets the Freelancer selector and an initial-application stage, and disables login. Its legacy `auto_create_entity=false` flag does not negate the persisted pipeline binding. The current form is not a historical form snapshot; its mapping configuration alone is not proof of what every field contained then.

The annual cron selects automatic/scheduled invoicing settings, checks fee approval and creates history before requesting the accounting invoice. It can create **year 1**; “renewal” in the internal label does not prove an earlier purchased membership.

Relevant source:

- `api/_lib/annualOwnerRenewalPipeline.js`: settings selection, fee approval check, active history insertion and origin note.
- `api/cron/process-membership-renewals.js`: `annualOwnerEffects`, `processMemberRenewal`, provider invoice creation and `renewed_and_invoiced` result.
- `api/_lib/upfrontRollingRenewal.js`: saved invoice/upfront commitment.
- `api/membership/member-membership-invoicing.js`: manual renewal has a distinct manual origin note. No such evidence was found here.
- `api/_lib/workflows.js`: workflow membership creation is an alternative capability, but the retained workflow for this member sent an email only.
- `api/_lib/formMonthlyCardFinalize.js`: monthly-card finalization expects submission/agreement evidence and a pending monthly-card history, not this annual invoice snapshot.

Repository history predating the event (`97663443999214f2779d8652dde5a2d5c726967c`, 2 Nov 2026) also contains the cron's active insertion and same automatic origin note. This supports historical code consistency but is **not** a deployment attestation. The persisted execution log is the authority for what actually ran.

## Card-only assessment

This is not a conclusion based solely on today's settings. Both configuration snapshots stored on the history record contain:

- `online_card_payment=true`
- `dd_enabled=false`
- `card_monthly_enabled=false`
- `auto_approve_fees=true`
- `start_mode=immediate`, annual billing, flat cost £120
- member-scoped matching on **Freelancer**

The commitment itself records `payment_method=invoice` and `payment_frequency=upfront`. The row's separate payment-method column is null. Its Stripe intent, payment quote and billing agreement references are also null.

The same selected flags remain in the current structure, whose stored update timestamp is 24 August. No matching entry-configuration audit was found. The tenant currently requires fee approval, but the invoicing row already carries approval; the current global setting is not a historical snapshot.

**Card enabled is not the same as requiring a successful card payment before the cron may invoice.** Here, automatic fee approval and automatic invoicing supplied an independent route. No evidence shows a card-only checkout was bypassed during submission: the triggering record was an enquiry. Historical payment options on the later full application form were not established.

The saved configuration's invoice description refers to August–July, whereas the actual saved rolling term is November–November. Treat the persisted term fields as evidence; do not infer dates from that description.

## Searches and limitations

All counts below cover retained records at investigation time, with no status filter unless stated.

- **Submissions:** tenant-scoped searches by `created_member_id`, case-insensitive current email in `submitted_by_email` and answer JSON, and member ID in answers/payment metadata found **one** submission: the enquiry. Pipeline-entity lookup found its one binding; the separate entity-creation table returned none. This does not establish that no submission ever existed under another email/identity or was permanently deleted.
- **Incomplete submissions:** the same search included pending and other statuses. Drafts searched by current email or member ID returned **zero**. Expired/deleted drafts cannot be excluded.
- **Deleted-submission evidence:** schema discovery found no dedicated generic deleted-submission archive/tombstone table. Retained workflow logs, pipeline associations and messages were checked; there was no second submission reference establishing a later application. No backups or deleted data were restored.
- **Payments:** no member-linked billing agreements, payment plans, payment quotes, fee tokens or initial-checkout recovery rows. History has null Stripe intent, quote, agreement and paid-at fields. Tenant payment-webhook payload searches by member ID, current email or invoice ID returned zero. GoCardless searches by member metadata or invoice ID returned zero.
- **Audit/accounting:** no matching membership payment-status history or source-linked accounting queue row. Scheduled-task logs from **12 Nov inclusive through 25 Nov exclusive** were searched for member, history and invoice references. They establish renewal/invoice creation, not the void actor/time. Later renewal entries skip the existing record.
- **Provider/runtime limits:** no connected Xero or Stripe investigation integration was returned. The app's accounting linkage was not treated as a direct provider audit. Better Stack exposed only an onboarding flights source, not application logs. No app provider helper was executed, avoiding token refresh, reconciliation or other writes. Direct Xero invoice history and Stripe charge/customer searches remain unverified.

**Missing local payment references are not proof that no provider charge occurred.** A charge under another identity, outside this application, or without a retained webhook/link remains possible.

The local `voided` state is consistent with `api/_lib/membershipPaymentReconciliation.js`, which can copy provider status without changing the membership's active status or updating its timestamp. That is a possible explanation for the current fields, **not confirmed attribution of this void**. A provider invoice-history export is needed to establish the void's date and actor.

## Focused recommendations — not implemented

1. Separate enquiry/member creation and fee calculation from authority to start a chargeable membership. Require a completed/approved joining event or explicit administrator action before creating year-one automatic invoicing. Preserve legitimate existing-member renewals.
2. Retain actor/source and occurrence timestamps for invoicing approval and provider-status transitions, so future investigations can date voiding without guessing from mutable row timestamps.

Do not restore this deliberately voided invoice or replay processing. No repair, payment, refund, communication or configuration change is authorised by this investigation.
