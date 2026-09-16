---
name: Due Diligence applicant identity
description: Select member or organisation labels by application type, not whichever linked entity exists.
---

The form's application level determines the applicant identity. A linked member does not by itself make an application member-based.

**Why:** Organisation applications commonly also create a contact member. Unconditional member-first labels replace the actual applicant organisation with its contact. When records are deleted, saved answers for the correct applicant type must still precede the opposite entity's name.

**How to apply:** Resolve tenant-scoped typed references and retain application level in dashboard/detail projections. Prefer names or safe saved values of the authoritative applicant type. Never display an unresolved relationship UUID or Due Diligence row ID as an organisation name.