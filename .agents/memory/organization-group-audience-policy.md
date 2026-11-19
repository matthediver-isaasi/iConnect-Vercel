---
name: Organisation Group audience semantics
description: Effective-group authority and empty/negative audience rules.
---

For Communications audience filters, use an Organisation's group whenever the
member has an Organisation. Direct group assignment applies only without an
Organisation; do not fall back when the Organisation has no group.

Members without an existing tenant-owned effective group never match a group
predicate, even a negative or empty one. An existing group's missing value is
empty; negative comparison follows existing preference-value semantics, which
requires a stored non-null value.

**Why:** These are the approved targeting boundaries, not permission to include
unaffiliated members or target secondary organisations. Member Group JSON fields
are a separate system.

**How to apply:** Preserve these semantics across preview, counts and resumable
preparation. Live BNMS configuration verification is read-only; never alter
fields, assignments, lists or consent to test this feature.
