---
name: Communication consent boundaries
description: Entry points for category lifecycle, consent serialization, and member eligibility rules.
---

- [Category deletion](category-deletion-consent-boundary.md): prevent globalizing opt-outs or removing campaign suppression.
- [Consent serialization](email-preference-consent-serialization.md): global and category writes share recipient locks.
- [Member category eligibility](communication-category-member-rbac.md): role checks govern every opt-in path, not unsubscribe.