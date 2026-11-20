---
name: Organisation Xero contact identity
description: User-approved organisation identity rule applies beyond form checkout; individual email matching remains separate.
---

For an invoice owned by a verified organisation, use its verified Xero contact binding or a unique exact organisation-name match, ignoring case and normalizing whitespace. A different billing email alone is not grounds to reject that organisation contact.

**Why:** The user explicitly approved this matching policy and reiterated it when organisation membership renewal still used email-dependent matching despite the earlier form-checkout change. Invoice recipient email is not the organisation's identity.

**How to apply:** Carry trusted tenant-scoped organisation identity through each invoicing route and queued preparation, not only form checkout. Preserve ambiguity, inactive-contact and provider/company checks. Do not extend organisation name matching to personal invoices or arbitrary submitted text, silently overwrite Xero contact details, or reinterpret frozen requests without reviewed reconciliation.
