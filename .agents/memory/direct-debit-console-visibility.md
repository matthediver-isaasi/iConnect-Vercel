---
name: Direct Debit console visibility
description: Keep console identity eligibility separate from historical billing and collection authority.
---

Console hiding must never be reused as a background payment-processing eligibility rule.

**Why:** Deleted identities can retain legitimate historical financial records. Imported mandate discovery also does not prove canonical adoption or authorize collections; visibility repairs must not release held plans or reconstruct missing adoption links.

**How to apply:** Apply the exact anonymised-email convention at console reads/actions only. Diagnose import absence against adoption and canonical links before proposing repair, and preserve each plan's existing collection holds independently of its displayed mandate status.

Historic members must not be presented as new joiners awaiting their first payment merely because this system has not collected yet.

**Why:** The user explicitly distinguishes current membership from local collection progress. Historical payments alone do not prove current entitlement, and import provenance does not authorize collections.

**How to apply:** Show Current only from authoritative dated entitlement or approved recognition, with collection holds separate. Canonical imports lacking current evidence need an unverified-membership label, not a new-joiner label. Keep summary, filters and detail consistent without rewriting financial statuses.

Membership-display totals partition eligible plans, not people; operational exceptions are not a partition.

**Why:** One member may own several plans, activation flags can overlap other display statuses, and accounting/cancellation counts represent different entities. Combining these counts misleadingly suggests missing plans.

**How to apply:** Keep exact display-status drill-downs distinct from legacy financial/activation filters, and clear search and pagination when selecting a global count.

Planned membership due dates and provider-scheduled bank debit dates are separate facts.

**Why:** Releasing a dynamic plan permits later submission; it does not schedule a bank debit. Showing a planned date as confirmed misrepresents the provider's notice and submission requirements.

**How to apply:** Label planned cadence dates explicitly in list, details and exports. Require matching provider-payment evidence for bank dates; a reservation or active mandate alone is insufficient.