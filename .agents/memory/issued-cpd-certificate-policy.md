---
name: Issued CPD certificate preservation
description: Preserve completed certificates independently of template lifecycle; separate previews, capture and historical delivery evidence.
---

The owner approved retaining completed event and historical CPD PDFs rather than regenerating issued documents from mutable templates.

**Why:** Archiving, deleting or changing a template must not invalidate or silently rewrite a certificate already issued to a member.

**How to apply:** Keep private immutable first-capture PDFs; previews and test emails must not publish them. Preserve authorization and reversal checks. Record capture time separately from original award/delivery time: generating an older award today is not recovery of its originally emailed PDF. Do not claim untouched historical awards are protected before a scoped backfill. Changes to award evidence require review, not silent replacement. Email selection and recipient consent remain current even when the attachment is retained.

A verified conversion of the same guest attendee to a member is not, by itself, a change to the historical certificate's points.

**Why:** A legitimate guest certificate can predate both the member association and the member's points ledger. Treating the new member ID as a changed award incorrectly denies access; treating the guest PDF as a member award would instead fabricate ledger evidence.

**How to apply:** Verify the original guest identity and current attendee association before retaining access. Preserve the original PDF and issuance signature. Preview/resend must not create points; normal eligibility and one-time award processing remain independent. An equal initial event award can coexist with the original certificate, but adjustments, reversals or a different recipient require review.

Owner-authorised corrections may replace the served PDF only while retaining the original private PDF and complete prior issuance evidence. Silent correction must not send email or change CPD awards.

**Why:** The owner requested corrected member-area downloads, not a second delivery or a new points award. A correction timestamp must not be confused with the original capture or delivery date.

**How to apply:** Scope explicitly to the approved event and existing certificates, compare-and-swap publication, preserve original dates/signatures/values, and store separate correction provenance. Active templates are deliberately non-editable: use a corrected copy for future event issuance rather than bypassing the editing guard. Verify both corrected and retained PDFs and the normal member download resolver.

Automatic attendance certificate emails run once, inside the CPD points outbox item. If the certificate is not eligible at that moment (for example, the CPD certificate configuration is incomplete), the email is skipped silently and the outbox item still completes; saving the configuration later never re-triggers it.

**Why:** A BNMS event awarded points to 55 attendees with no certificate delivery rows; its CPD configuration was saved after processing, and the owner then sent certificates manually from the event registration report.

**How to apply:** When investigating a missing CPD email, compare award and outbox timestamps with `event_cpd_certificate_config.updated_at`, and run the read-only eligibility resolver. Do not resend automatically; admins can send through the registration report.
