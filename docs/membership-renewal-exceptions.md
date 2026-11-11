# Renewal journey exceptions

The **Renewal journey exceptions** section of `/admin/settings` adds tenant-scoped
exceptions without replacing the default renewal or post-grace questionnaire.

- Current role rules match the current access role only.
- Purchased-class rules use recorded paid membership evidence and survive a
  change to Former. They do not use editable form answers as authority.
- Direct renewal may select an authenticated payment-only form, or retain the
  original portal renewal link. Questionnaire exceptions require a form.
- “Restrict to purchased class” permits a new yearly schedule in that category,
  not another category. Ambiguous matches fail closed and need administrator review.
- Changes have revision checks and immutable audit history. Other tenants are unchanged.

First joining and mid-term amendments are not new renewal entry paths. Unknown
membership evidence is not invented or repaired by these settings.

## Enforcement and rollout

Apply migrations `202701220003` and `202701220004` before deploying the matching
application. The latter preserves already authorised checkout terms while checking
owner and config identity; existing payment-settlement guards remain in place.
Simulation gives an early explanation; database insert guards cover new quotes,
successor elections, agreements and membership history.

BNMS's default questionnaires remain unchanged. Its purchased Retired-class rule
uses the authenticated **Direct membership renewal** copy, slug
`direct-membership-renewal`. The archived original remains untouched.
No memberships, charges, emails or invoices are created by configuring the route.

The guarded provisioning script records reviewed inputs and a fingerprint in an
ignored directory. Rehearsal rolls back all changes; application requires that
fingerprint. Do not rerun it after provisioning: normal changes use the settings UI.
To back out the BNMS route, remove its exception using the audited settings save;
do not drop guards or change existing payment records.

Verified with focused API/helper and mounted UI tests, portal rendering tests,
isolated PostgreSQL permission/category/revision checks and a rolled-back DEST
rehearsal. The authenticated settings screen was not visually verified: preview
displayed its sign-in page.
