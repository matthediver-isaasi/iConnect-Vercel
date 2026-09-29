# Direct Debit Membership Renewals — User Guide

**For:** Membership administrators  
**Updated:** 29 September 2026  
**Scope:** Monthly membership payments through GoCardless

This guide explains the supported renewal journey and what members see. Available screens depend on your permissions and your organisation's settings. It is not confirmation that any particular site's payment service or scheduled processing is ready for live use.

**The essential rule:** an active mandate is permission to use a bank account under the agreed terms. It is not a paid membership, a completed renewal or unlimited permission to collect.

## Contents

1. [Understand the four separate parts](#understand-the-four-separate-parts)
2. [Find the settings and check readiness](#find-the-settings-and-check-readiness)
3. [Choose and understand the collection policy](#choose-and-understand-the-collection-policy)
4. [Follow the renewal journey](#follow-the-renewal-journey)
5. [Read payment and invoice information](#read-payment-and-invoice-information)
6. [Handle problems, pauses and cancellation](#handle-problems-pauses-and-cancellation)
7. [Worked examples and administrator checklist](#worked-examples-and-administrator-checklist)
8. [Make this guide easy to find](#make-this-guide-easy-to-find)

## Understand the four separate parts

| Part | What it means |
| --- | --- |
| **Mandate** | The payer's bank authorisation. An active, suitable mandate can be reused for a later term without entering bank details again. |
| **Collection plan** | The monthly payment arrangement for one term. It has a limited number of collections; it is not an unlimited subscription. |
| **Membership term** | The dated period of membership being purchased. Paying monthly does not mean that the membership itself lasts only one month. |
| **Renewal** | Setting up the next membership term with its own agreement and collection plan. The previous term is not rewritten. |

**Two different “ends”.** The old term's schedule is finite. If the payer agreed to continue, a new term and schedule may follow. This is why a membership end date alone does not tell you whether future Direct Debits will stop.

Use the saved start, end and renewal dates shown for the membership. Terms can follow a shared membership year or an individual start date. Do not substitute the date of the last bank payment or guess a renewal date from a year label.

### Membership access is separate from payment

Depending on **Membership activates**, access can begin when the mandate becomes active, on the first successful payment, or after manual administrator approval. Access being active does not mean that all instalments have been collected.

A term awaiting payment setup or its first payment should not be described as fully paid. Conversely, a successful bank collection may need accounting attention even though the money was collected.

### Individual and organisation memberships

The current renewal service supports eligible individual and organisation agreements. Organisation lifecycle messages go to the saved billing contact when that person is the payer, and to the saved primary contact, without sending duplicate copies to the same address.

Do not assume every old organisation plan is eligible. Missing term information, contact details or consent can require administrator review. Organisation payers should use the organisation's payment/setup journey; do not direct them to an unrelated personal renewal button.

## Find the settings and check readiness

### Where administrators look

- **Membership Tier Management:** open the relevant structure and its **Payment** step. Review **Monthly Direct Debit**, **Instalments**, **Monthly amount**, **First collection**, **Membership activates**, and the collection policies.
- **Current or Scheduled Membership Commitment:** check the purchased dates and saved policy, not just today's tier settings. Direct Debit details distinguish agreed amounts, price previews and actual provider information.
- **Direct Debit Console:** use **Plans**, **Renewals**, **Cancellation requests**, and **Payments & payouts** to investigate the corresponding records. Access and console visibility depend on permissions and configuration.
- **Member payment page:** the **Monthly Direct Debit** card shows available payment information and, where applicable, **Fix payment** and **Request cancellation**.

### Before relying on renewal processing

Check that:

1. GoCardless is connected for your organisation in the intended environment, and the responsible payment administrator has verified its setup.
2. The correct membership structure offers Direct Debit, has applicable dates and prices, and has both collection policies selected.
3. The existing agreement contains saved consent and reliable term dates. Changing a structure today does not supply missing consent for an older agreement.
4. An eligible active mandate is available, or the payer is ready to complete a new authorisation.
5. Contact addresses are correct and the organisation's payment administrator has checked email delivery and scheduled renewal processing.
6. The invoice method and, where used, the Xero or QuickBooks connection and dedicated GoCardless bank account are correct.
7. Any required fee approval, manual membership activation, outstanding payment issue or pause has been reviewed.

**Do not use a live payment, renewal or reconciliation action merely to test readiness.** Such actions can create real collections or accounting entries.

The **Automatically renew monthly card memberships** switch is for card payments. It is not the Direct Debit continuation setting.

## Choose and understand the collection policy

There are two independent choices in the **Payment** step:

- **At the end of the billing period:** stop collections or continue collections.
- **Monthly collection amount:** fixed for the membership term, or use the current active membership structure price.

| Saved choices | During this term | At renewal |
| --- | --- | --- |
| **Stop + fixed** | The agreed monthly amount stays fixed. | A new renewal must be accepted before further term collections. |
| **Stop + dynamic** | Each monthly collection uses the applicable active price. | The schedule ends with the term; a new renewal is required. |
| **Continue + fixed** | The agreed monthly amount stays fixed. | Eligible automatic renewal creates a new term at its applicable price. |
| **Continue + dynamic** | Each monthly collection uses the applicable active price. | Eligible automatic renewal creates a new term; monthly prices can still vary. |

### What “fixed” means

Editing the structure does not change an existing fixed-price term. With continuation consent, the next term's fixed amount is set again from the applicable renewal price. “Fixed” does not promise the same price forever.

### What “dynamic” means

Dynamic pricing requires **per-instalment invoicing**. The opening monthly figure is indicative, not an agreed fixed total for the whole term. Each collection is separately priced under the purchased pricing basis; it cannot change currency.

Dynamic setup authorises the mandate rather than including an immediate first payment in that authorisation. Collections remain subject to the term limits, applicable price, bank submission and notice deadlines. If a safe price or date cannot be established, collection is blocked for investigation rather than guessed.

### Saved consent takes priority

An administrator's later setting change does not grant permission to continue an older agreement or make its price variable. The saved agreement controls those permissions.

Some older agreements display **Based on saved legacy consent**. An explicitly saved older automatic-renewal choice can support continuation or stopping, but only with fixed pricing. **Existing agreement needs review** or **Policy not recorded** means permission is incomplete or unreliable: do not assume continuation or dynamic pricing.

## Follow the renewal journey

### 1. Before renewal: notice, not collection

The normal notice threshold is **30 days before the saved renewal date**. Processing depends on successful scheduled runs; it is not a guarantee that a message arrives at an exact time or that money is taken on that date.

- **Continue:** the renewal notice describes the next plan. Normally the payer need not re-enter bank details or confirm again if the mandate remains usable and all eligibility checks pass. They should contact the organisation before renewal if they do not wish to continue or their details have changed.
- **Stop:** a confirmation-required message asks the payer to renew from their membership payment page once the new term opens. Simply receiving the message or retaining an active mandate does not renew membership.

Notices describe the expected terms. The applicable price is checked again when the new term is prepared; a preview is not proof of a bank charge. For dynamic pricing, the amount is explicitly indicative.

### 2. At or after the renewal boundary

For an eligible **continue** agreement, processing attempts a new membership agreement, term and finite collection schedule. It reuses an eligible active mandate. It does not extend the previous schedule indefinitely.

For **stop**, processing waits for the payer's renewal action. The payer reviews and accepts the offered monthly terms through the appropriate payment/setup journey. If a suitable mandate is available, it can be reused; otherwise new bank authorisation is needed.

Automatic setup can be blocked by a missing plan or mandate, unresolved arrears, a paused member, missing consent or dates, an unavailable renewal offer, or a next term already recorded through another payment method. Only eligible active or completed/expired plans proceed.

**If processing starts late:** the first eligible run without a notice record prepares the notice, not an immediate same-run automatic renewal. Later eligible processing can attempt renewal. Do not promise a fresh full 30-day delay after a late notice: the notice threshold and banking notice requirements are separate.

### 3. After setup: wait for payment evidence

A renewal-confirmed message describes the new arrangement; it is not a receipt for every instalment. GoCardless handles bank processing and advance collection notices. Collection confirmation and payout happen separately.

The member should check payment messages, keep sufficient funds available, and report changed bank details or missing information. Administrators should check the actual plan and payment status rather than treating an email label as evidence that money arrived.

Email delivery is not guaranteed by a renewal status alone. If a payer reports no notice, check the saved recipients and delivery outcome before assuming they received it.

## Read payment and invoice information

### What the collection labels tell you

| Display | Safe interpretation |
| --- | --- |
| **Agreed amount — not a confirmed provider charge** | A fixed amount was accepted; this does not prove a bank collection is scheduled. |
| **Reserved locally — not yet confirmed by provider** | A dynamic amount has been prepared, but GoCardless has not yet confirmed the request. |
| **Accepted by provider — not yet collected** | GoCardless has accepted a payment request; money is not yet confirmed collected. |
| **Last collected amount — not the next collection** | Historical evidence, not a forecast of the next amount. |
| **Collection blocked** or **No confirmed collection evidence available** | Investigate the explanation. Do not read an unavailable amount as zero. |

A **Current price preview — not a confirmed charge** is also not a payment request.

### Two invoice methods

| Question | Annual invoice | Per-instalment invoices |
| --- | --- | --- |
| What is expected? | One invoice for the term, with monthly part-payments. | One invoice for each confirmed monthly collection. |
| What creates it? | The separate membership invoicing process. Direct Debit setup alone does not create it. | Confirmation of the corresponding GoCardless collection. |
| Main check | The annual invoice must exist and be linked before a part-payment can be posted. | Check both the instalment invoice and its matching accounting payment. |
| Dynamic pricing? | Not supported. | Required. |

The method is saved when the agreement starts. Editing the tier does not convert an existing plan. Do not create an annual invoice for a per-instalment term.

**Confirmed** means GoCardless has confirmed collection; accounting updates are attempted then. **Paid out** means the funds have subsequently been included in a payout. Waiting for payout does not fix missing invoicing. Refunds, reversals or chargebacks can still occur after confirmation.

### Dates and delays

**First collection** can be earliest possible, a nominated day, or the membership anniversary. Nominated days are limited to 1–28. These are scheduling rules, not guarantees of bank settlement on that day.

Allow for several working days and potentially longer for a new mandate. Weekends, bank holidays and scheme rules affect dates. A dynamic collection's intended monthly date can differ from the provider's accepted charge date. Use the actual provider information when available; do not invent a date from the membership renewal date.

## Handle problems, pauses and cancellation

### Failed payments and arrears

A failed collection can enter a saved grace period. Automatic retries are subject to payment and mandate eligibility; they are not guaranteed to succeed. Where available, the member can select **Fix payment**. This may schedule a permitted retry or request new mandate authorisation. If it cannot proceed, contact the administrator rather than submitting repeated attempts.

After grace, two separate policies matter:

- **Access policy:** keep access active, restrict the member to a configured role, suspend access, refer for manual review, or flag cancellation at the end of the paid period. The cancellation flag does not itself mean immediate cancellation.
- **Saved post-grace collection policy:** stop automated collection and leave the balance for recovery, or continue with catch-up collection for unpaid periods plus the current instalment when eligible.

Catch-up can be larger than the usual monthly amount. It does not change annual versus per-instalment accounting or give new authority to collect beyond consent. Open monthly arrears block renewal. Check the actual outstanding balance and collection outcome; manually resolving an issue is not proof of a bank payment.

### Pause and cancellation are different

A member-level **membership pause** is an administrator action that blocks access and excludes the member from automatic renewal while paused. Payment pausing/resuming can produce provider warnings; check the result rather than assuming all bank activity stopped.

**Pause subscription** in the Direct Debit Console is a payment-plan action, not a substitute for pausing the membership itself. Resuming does not guarantee immediate collection or erase arrears.

On the member card, **Request cancellation** submits a request for administrator review. **Payments continue until it is approved.** The member may use **Withdraw request** while it remains pending. Administrators review requests in **Cancellation requests**.

Cancelling a mandate, cancelling a collection plan and ending membership are separate decisions. Cancelling the bank mandate does not itself cancel membership or forgive outstanding fees. Neither cancellation nor pause promises a refund or reversal of a payment already submitted. Confirm the outcome and any remaining liability with the payer.

### Quick troubleshooting

- **No renewal shown:** check saved dates and consent, the latest plan, pause and arrears, and whether another payment method already covers the next term. Do not create a duplicate plan as a shortcut.
- **No amount/date, or “needs review”:** ask the payment administrator to verify the saved agreement and GoCardless evidence. Today's structure cannot repair missing consent.
- **Mandate active but nothing paid:** check setup, activation rules, holds and collection status. The bank authorisation alone is not payment.
- **Collected, but no accounting payment:** check invoice mode and the linked annual invoice, or the instalment invoice and accounting connection. Per-instalment reconciliation can retry failures; a missed annual part-payment needs separate investigation.
- **No notice or unavailable renewal page:** verify contact details and delivery, then check the correct personal or organisation journey. Do not ask the payer to switch payment methods until existing commitments are checked.

## Worked examples and administrator checklist

### Example 1 — Continue with a fixed amount

A member agreed to 12 monthly payments of £20 for a term ending 31 March, with renewal on 1 April. The next applicable price is £22.

The current fixed plan stays at £20. A renewal notice is normally prepared from 30 days before 1 April. On or after 1 April, eligible processing can create the next term at £22 using the active mandate. It cannot promise that the first £22 bank debit happens on 1 April. The administrator checks the new plan, invoice method and payment status.

### Example 2 — Stop, even though the mandate is active

A member finishes a fixed-price term with stop consent. Their bank mandate remains active. They receive a confirmation-required notice but take no renewal action.

The old mandate does not authorise a new term's collections. The administrator helps the member review the new offer through the payment page when the term opens. A suitable active mandate can avoid entering bank details again. Unpaid amounts from the old term must still be handled separately.

### Example 3 — Continue with dynamic pricing

An organisation's authorised monthly price begins at £30. A later applicable structure price is £32. With saved dynamic consent and per-instalment invoicing, a later eligible collection can use £32, subject to notice, submission and term limits.

The opening £30 is not a guaranteed annual total, and a £32 preview is not a confirmed payment. The administrator checks the provider-accepted amount/date and the invoice after confirmation. Missing or ambiguous pricing blocks collection for review.

### Example 4 — Renewal is due, but a payment failed

A member has continue consent but an unresolved monthly arrears balance. Renewal is blocked. If the saved post-grace policy allows catch-up, the next eligible recovery collection may include unpaid periods and the current instalment; otherwise recovery needs administrator handling.

The administrator checks the grace period, access policy and payment evidence, resolves the arrears through the appropriate process, and verifies renewal eligibility again. They do not assume “continue” overrides the overdue balance.

### Administrator checklist

**Before the notice window**

- Confirm the payer, contact details, saved dates, stop/continue consent and fixed/dynamic policy.
- Check the applicable renewal offer, mandate, approvals, pause status and outstanding instalments.
- Confirm invoice mode, accounting readiness and responsible staff for exceptions.

**During the notice window**

- Check that the appropriate notice was prepared and investigate delivery problems.
- Explain whether the payer needs to act; record and handle requests not to renew.
- Do not promise a bank date from the notice or renewal date.

**At renewal and afterwards**

- Verify the new term and plan, or identify why processing is waiting or blocked.
- Avoid duplicate card payments, plans or invoices while investigating.
- Check provider confirmation separately from access, invoicing and payout.
- Review arrears, cancellation requests and any manual activation required.

## Make this guide easy to find

### Upload to File Repository

This document has **not** been uploaded to a live File Repository, and no live repository search was performed. Files in the code project's guides folder do not appear there automatically.

1. Download **direct-debit-membership-renewals-user-guide.pdf**.
2. With the appropriate administrator permission, open **File Repository** in the intended site. Confirm the correct organisation and destination folder before uploading.
3. Select the folder, or use **New Folder** / **New Subfolder** if authorised. A name such as “Membership administration guides” is a suggestion, not an existing destination.
4. Click **Upload Files (max …MB each)** and select the PDF. Wait for the completion message and confirm the file appears. The button shows your site's current size limit.
5. Edit the file's **Description** to “Direct Debit membership renewals: consent, pricing, invoices, notices and administrator checklist”. Add **Tags** such as “Direct Debit”, “membership”, “renewals” and “GoCardless”, then **Save Changes**.
6. In that folder, use **Search files...** and the **Documents** filter to find it. Open/download it to confirm the correct version. Search matches the filename, description and tags; do not assume it indexes the PDF's body.

**Sharing caution:** File Repository uploads use public file storage. Do not add bank details or personal payment records to this guide. Folders organise files; they are not a privacy control.

### Further reading

These are related source guides, not proof that the same documents exist in File Repository:

- **GoCardless Monthly Membership Invoicing** — `gocardless-monthly-invoicing.md`: the focused invoice and part-payment journey.
- **Direct Debit collection policies** — `direct-debit-collection-policies.md`: technical detail on saved collection authority and dynamic pricing.
- **GoCardless Membership Lifecycle** — `gocardless-membership-lifecycle.md`: a technical lifecycle audit. Some older annual/member-only renewal descriptions have been superseded; do not use them instead of this guide's current consent and eligibility explanation.
- **Membership Renewal System** — `membership-renewal.md`: broader organisation fee calculation and invoicing, not the authority for recurring Direct Debit consent.
- **Membership Renewals Continuation** — `membership-renewals-continuation.md`: technical explanation of scheduled processing and recovery, not a member instruction sheet.

### Document locations

Readable source: **guides/direct-debit-membership-renewals-user-guide.md**  
Downloadable PDF: **guides/direct-debit-membership-renewals-user-guide.pdf**

This is documentation only. No payment behaviour or tenant settings were changed, and no database migrations were needed or applied.