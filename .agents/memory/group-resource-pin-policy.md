---
name: Group resource pin policy
description: Independent editorial ordering for group resources versus the main library.
---

Group resource pins are shared editorial choices for the owning group, never
personal bookmarks. Linked tenant resources are read-only on group pages.
Group-owned resources receive no pin priority in the main library, even if
tenant-wide pin metadata is present.

**Why:** The owner explicitly required independent group and tenant editorial
choices; legacy metadata or a resource appearing on both surfaces must not
leak group priorities into the tenant library.

**How to apply:** Apply ownership-aware pin ordering to complete eligible matches
before pagination, preserving the chosen normal sort within each partition.
Ordinary content edits must preserve both independent editorial decisions.
