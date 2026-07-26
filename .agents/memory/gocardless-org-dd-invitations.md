---
name: GoCardless org DD billing-contact invitations
description: Org membership Direct Debit payer-choice + secure invite-link design decisions
---
- Org DD offers carry `scope:'organization'` from the membership-payment fee endpoint; the payment form branches to `/api/membership/org-direct-debit` only on that scope.
- **Billing-contact route defers GoCardless billing-request/flow creation to invite-accept time** (`/dd-setup/:token`), so the GC flow can't go stale before the contact acts. The agreement row exists without a BR until then.
- Invite tokens: 64-hex crypto-random, single-use (marked completed on BR fulfilled webhook), superseded on resend/change-payer, expiry from system_settings `dd_invite_expiry_days` clamped 1-90 (default 7).
- **Why:** links travel by email to someone with no account; expiry + supersede + single-use is the whole security model — never loosen one without the others.
- Org lifecycle emails go to billing contact AND primary contact, deduped by lowercased email.
