---
name: Catalogue tax-code authority
description: Product tax choices must match Sales invoice mappings without changing tenant-wide mappings.
---
Use the synced accounting provider's tax codes directly for new Sales transactions. Preserve code identity, not merely the percentage.

**Why:** The user explicitly requested removal of the duplicate Sales percentage-mapping setup. Zero-rated and exempt codes can share a percentage but must remain distinct on invoices.

**How to apply:** Validate selections against tenant/provider-synced revenue codes, derive rates server-side, freeze identity and rate in quote snapshots, and invoice using that exact code. Preserve existing draft line tax on unrelated edits. Keep legacy mappings only for historical lines without saved identity; never infer a code from percentage or erase old mappings while configuring new transactions.

Accounting configuration access follows the independent Manage Accounting RBAC permission, not a dashboard-only account type.

**Why:** Portal administrators manage Sales through their assigned roles; excluding every portal member after granting the capability contradicts that access model.

**How to apply:** Retain the Sales baseline, accounting capability, individual exclusions and tenant checks for both reading and saving mappings. Do not replace them with either unrestricted Sales-page access or a tenant-user-only gate.
