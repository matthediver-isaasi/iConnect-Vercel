---
name: Tenant-setting first-save races
description: Why optimistic setting updates must also protect the missing-row case.
---

Do not assume system settings have a unique tenant/key constraint. Compare-and-swap updates protect an existing row, not simultaneous first inserts.

**Why:** The legacy table did not provide that uniqueness guarantee. For a new server-owned singleton setting, a deterministic tenant-and-key UUID uses the existing primary key to serialize first writes without requiring a production migration just for that setting.

**How to apply:** Keep all writes behind the dedicated endpoint, retry only verified primary-key conflicts, reject historical duplicate rows instead of arbitrarily selecting one, and use SQL `IS NULL` rather than equality for null-valued compare-and-swap updates.

Dedicated settings authorization must also close generic entity-write paths, including renaming an existing protected key.

**Why:** An export opt-in is an authorization decision, not merely presentation configuration. A stronger dedicated endpoint is ineffective if ordinary members can enable its setting through generic CRUD.

**How to apply:** Guard both submitted and persisted keys on generic create, update, and delete when introducing server-owned settings.