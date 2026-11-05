---
name: Profile affiliation editing policy
description: Owner-authorized scope and non-obvious binding authority for member profile affiliation editing.
---

Legacy member profile affiliation editing is a separately enabled, existing-record-only
capability. It must not inherit renewal-form Not-listed requests, Due Diligence,
shared-record creation, or respondent-grant authority.

**Why:** The owner explicitly excludes those actions from self-service profile
changes while requiring existing renewal and administrative flows to remain intact.

**How to apply:** Keep profile writes independent of submission identity and
preserve protected and grandfathered links. Resolve configured relationship
endpoints, never infer ownership from a relationship's display/key name.

The requested opt-in form-based replacement retains normal submissions but
must not require manual approval of affiliation changes. Unknown organisations
or Organisation Groups must affiliate the member to the existing tenant
"Zombie Organisation", following the join-form policy.

**Why:** The owner explicitly rejected the proposed all-changes Due Diligence
gate: "We don't want to be manually approving these changes". They specified
the join-form unknown-organisation/group fallback instead.

**How to apply:** Keep the new mode default-off, retain legacy settings, and
do not infer permission to publish forms, cut over tenants, or create shared
organisations/departments. Preserve normal submission evidence and existing
renewal behavior. Resolve fallback identity within the tenant; a display name
alone is not authority to choose between duplicate records.

Several unknown sites may represent different requested organisations but share
one canonical fallback affiliation, including when the primary site is unknown.

**Why:** The join-style fallback is a holding organisation, not a claim that the
member entered the same real-world site twice. Ordinary duplicate-site rejection
must not prevent automatic handling of these valid unknown answers.

**How to apply:** Retain every requested name and row identity as evidence while
consolidating fallback links. Do not relax duplicate rules for ordinary listed
organisations or change renewal review behaviour.

For BNMS, the owner chose the earlier (September 2026) "Zombie Organisation"
as the canonical unknown-affiliation fallback and authorized moving members
from the later duplicate to it.

**Why:** Both records had members; choosing a fallback by name would be
ambiguous. The owner explicitly said to retain the earlier one and link
members from both to it.

**How to apply:** Pin the earlier record for the new form's fallback. This
approval covers member affiliation consolidation, not deletion or rewriting
of historical bookings/submissions referencing the duplicate.

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
