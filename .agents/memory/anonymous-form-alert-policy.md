---
name: Anonymous form alert policy
description: Owner-approved anonymous alerts are distinct from identity-dependent survey emails.
---

Anonymous surveys may have administrator submission alerts, but that approval does not permit identity-dependent template emails or any join between named completion records and answers.

**Why:** The user explicitly approved anonymous survey alerts with identifying details excluded, while requiring existing published-version policy, persistence and cohort thresholds to remain intact.

**How to apply:** Keep this alert feature separate from the Emails tab. Resolve privacy against the published response snapshot; withhold answers below the cohort threshold and withhold identifying attachments and exact-time metadata where policy requires it. Explain that voluntarily identifying free text cannot be guaranteed anonymous. Links default to seven days.

Submission alert setup belongs to FormBuilder access, not a separate administrator entitlement.

**Why:** The user explicitly requires anyone allowed to access FormBuilder through RBAC to have complete alert setup access.

**How to apply:** Use FormBuilder's permission for settings reads, saves and link revocation; preserve tenant isolation, individual exclusions and anonymous-response privacy.

Explicit submission forwarding uses Form Submissions management authority, not
FormBuilder setup authority. Sharing a response must retain the same published
anonymous-survey protections as automatic alerts.

**Why:** The owner requested forwarding individual submissions to members of the tenant's default organisation only
without login. That grants read-only sharing, not permission to disclose protected
identity, bypass cohort thresholds or expose internal submission metadata.

**How to apply:** Keep forward history separate from automatic-alert settings;
default bearer links to seven days and support individual revocation. Treat
unknown email acceptance as unresolved, never permission to resend automatically.

Forwarding recipients must belong to the tenant's default organisation, not just
the tenant. Enforce this in both discovery and send/retry validation.
**Why:** The owner explicitly corrected the broader tenant-member scope.
