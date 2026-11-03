---
name: Profile affiliation editing policy
description: Owner-authorized scope and non-obvious binding authority for member profile affiliation editing.
---

Member profile affiliation editing is a separately enabled, existing-record-only
capability. It must not inherit renewal-form Not-listed requests, Due Diligence,
shared-record creation, or respondent-grant authority.

**Why:** The owner explicitly excludes those actions from self-service profile
changes while requiring existing renewal and administrative flows to remain intact.

**How to apply:** Keep profile writes independent of submission identity and
preserve protected and grandfathered links. Resolve configured relationship
endpoints, never infer ownership from a relationship's display/key name.

Historical BNMS relationship names are not sufficient evidence of endpoint kind.

**Why:** Read-only destination inspection on 2026-11-03 found a relationship
named `assignment_organisation` whose endpoint was a member, not an organisation.
The actual secondary ownership path was identified from the picker graph.

**How to apply:** Use live endpoint metadata and graph path IDs when configuring
bindings; fail closed when configuration and current schema disagree.

Administrator setup should suggest compatible choices for explicit confirmation,
never silently select, enable, or save them.

**Why:** The owner requested a non-technical setup after raw relationship IDs
and unrelated options made the affiliation configuration difficult to use.

**How to apply:** Present human-readable choices and dependent guidance while
retaining unavailable saved selections for review. Keep identifiers in optional
technical details and require an explicit save.
