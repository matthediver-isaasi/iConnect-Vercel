---
name: Role member group limit policy
description: Product scope and automatic membership treatment for tenant role group limits.
---
Role member-group limits govern the target member, never the administrator performing an assignment. Automatic reconciliation remains uncapped; lowering a limit never removes memberships. A manual conversion of an excluded automatic assignment uses capacity.

**Why:** The user explicitly separated role group limits from role member capacity and group-held roles, with no administrator override.

**How to apply:** Preserve these boundaries across new assignment paths. Explicit member merges adopt moved memberships as manual assignments rather than treating the source member's automatic eligibility as evidence for the target.
