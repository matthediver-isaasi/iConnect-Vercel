---
name: Directory Data Studio file access
description: Why directory-sourced Custom Object files need their own download authorization boundary.
---

Directory opt-in makes individual Data Studio fields available for placement, not public publication or a new role grant. Keep Data Studio permissions authoritative and My Organisation permissions independent.

**Why:** The requested design deliberately interleaves individual object fields with existing card-back items rather than creating separate object sections or a second permission matrix.

**How to apply:** Preserve that separation when extending directory sources or their settings.

Files shown through a protected directory source must download through the same source authorization boundary. Do not disclose reusable storage paths or delegate to a tenant-membership-only URL signer.

**Why:** A generic tenant-scoped file signer lets a copied path remain usable after object, field, relationship, or directory access is revoked. Authorizing only the initial value projection does not secure subsequent file reads.

**How to apply:** Revalidate the source, organisation, active link and record, and object/field permissions for every download; serve the bytes without exposing storage paths.

Stored JSON is not proof of file ownership. The download path must be bound to the authorized object and field by the upload service.

**Why:** Otherwise an editor can place an unrelated tenant-private path in a record and make the directory proxy bypass that asset's stronger policy. Historical generic upload paths cannot establish field ownership.

**How to apply:** Fail closed with an actionable re-upload explanation for legacy unbound references; never silently grandfather arbitrary same-tenant paths into protected directory downloads.

The ownership boundary is object plus field, not a one-use record receipt.

**Why:** Data Studio currently grants record access at object level, so an authorized editor may deliberately reuse a same-field file on another record. Directory reads still require an active link to the requested organisation.

**How to apply:** Revisit this decision if record-specific Data Studio permissions are introduced; do not assume object/field binding alone will still be sufficient.