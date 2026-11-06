---
name: CPD signature retention
description: Why small signature assets use transactional private blobs and why published images are retained.
---

Keep signature publication transactional and retain previously published image
identity for pending/retained snapshots, not merely current template fields.

**Why:** Small signature blobs fit inside the private database transaction,
avoiding a storage-upload/reference commit gap. Replacement or template deletion
does not authorize changing issued certificates or disposing of pending snapshot
dependencies. Template copies must retain independent access to shared immutable
bytes.

**How to apply:** Do not replace this with public URLs, browser-readable table
grants, or current-layout-only garbage collection. Any future retention policy
must account for snapshots and copies before removing published bytes.

Pass owned, zero-offset Uint8Arrays to pdf-lib when embedding JPEGs.

**Why:** Its JPEG parser uses a DataView over the backing ArrayBuffer without
honoring pooled Node Buffer offsets; valid small JPEGs can fail with “SOI not
found” depending on allocation.

**How to apply:** Copy Buffer bytes into a new Uint8Array at the embedding
boundary and retain a regression using a small JPEG.
