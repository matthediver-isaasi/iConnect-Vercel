---
name: Directory export membership boundary
description: Privacy and authorization decisions for related-record directory CSV exports.
---

Directory CSV membership data is count-only even when directory cards are allowed to show names. Do not reuse the card's member-name role filter for those counts.

**Why:** The user explicitly prohibited individual member data in exports while requiring counts to use the normal directory eligibility boundary. Additive related-record rows must not inherit an organisation total.

**How to apply:** Keep member identities server-side for distinct aggregation only. Recheck the viewer's organisation as well as tenant, role and admin status before delivery: the own-organisation eligibility exception makes reassignment authorization-relevant.