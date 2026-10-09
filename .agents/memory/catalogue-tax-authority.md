---
name: Catalogue tax-code authority
description: Product tax choices must match Sales invoice mappings without changing tenant-wide mappings.
---
Product VAT-code choices must not imply a per-product invoice-code override or silently rewrite tenant-wide Sales tax mappings.

**Why:** Sales invoicing resolves one provider code per percentage. Offering multiple selectable codes at the same percentage would promise a distinction the invoice cannot honor, particularly zero-rated versus exempt. Changing that mapping from a product modal would also affect unrelated sales.

**How to apply:** Offer synced revenue codes consistent with the current Sales mappings, with clear guidance for unmapped choices. Retain existing tax values on unrelated edits. If per-product tax-code identity is introduced later, carry it through immutable quote snapshots and invoice preparation before offering conflicting codes as independently selectable.

Accounting configuration access follows the independent Manage Accounting RBAC permission, not a dashboard-only account type.

**Why:** Portal administrators manage Sales through their assigned roles; excluding every portal member after granting the capability contradicts that access model.

**How to apply:** Retain the Sales baseline, accounting capability, individual exclusions and tenant checks for both reading and saving mappings. Do not replace them with either unrestricted Sales-page access or a tenant-user-only gate.
