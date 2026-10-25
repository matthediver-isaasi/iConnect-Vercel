---
name: Communication consent boundaries
description: Entry points for category lifecycle, consent serialization, and member eligibility rules.
---

- [Category deletion](category-deletion-consent-boundary.md): prevent globalizing opt-outs or removing campaign suppression.
- [Consent serialization](email-preference-consent-serialization.md): global and category writes share recipient locks.
- [Member category eligibility](communication-category-member-rbac.md): role checks govern every opt-in path, not unsubscribe.
- [Job posting alerts](job-posting-alert-policy.md): tenant-controlled, all sources, one protected category shared with member preferences and campaigns.