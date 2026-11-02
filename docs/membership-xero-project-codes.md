# Membership Xero Projects tracking

Pricing structures have an optional `xero_project_code`, shared by flat and
tiered pricing. The Pricing control is visible only for the active Xero provider.
Blank clears the setting; hiding the control does not clear saved data.
The code names an existing option under Xero's **Projects tracking category**,
not the separate Xero Projects product. It never replaces the invoice PO/TBC.

The primary fee line alone receives tracking. Add-ons retain their own accounting.
QuickBooks strips the argument before queue preparation and provider dispatch.
New simulations, quotes, histories and monthly agreements retain their applicable
code. Legacy frozen obligations without a saved code remain untagged; retries
must not infer this setting from today's pricing. Queued provider payloads are
not rewritten.

## Destination rollout, 2026-11-02

Applied `202611020001_membership_xero_project_code.sql` to pinned destination
`lvmzliemqnieeoruhkik`, SHA256
`55303b352c7ee493e9228dfe3848487d42cc20a115108e65664a1e4fdc5bf17b`.
The destination-only runner is `scripts/configure-bnms-membership-projects.mjs`.
It requires explicit `--apply --review-sha256=<hash>`, verified TLS, pinned BNMS
and Xero identities, and an active Projects/MEMBERSHIPS tracking option.

Verified BNMS tenant `ff2df806-b321-4254-b651-3af11fccf1db`.
All 17 schedules previously had a null code; all now have MEMBERSHIPS:
2 historical, 15 current, 0 future. A second execution changed zero rows.
The transaction compared every pricing row before/after, excluding only the new
field, and verified other tenants' codes unchanged. No issued invoices, financial
transactions or frozen snapshots were updated. SOURCE was not modified.
No automatic MEMBERSHIPS default was installed for new schedules.

Application changes still require merge/release. The workspace preview uses
legacy SOURCE; a preview screenshot is not signed-in destination verification.
Provider tests use mocked requests/preparation only, not live invoice creation.

Verification includes API save/reload/change/clear for flat and tiered structures,
tenant isolation and historical edit rejection; actual Xero payload preparation
for PO/TBC, trimmed/blank codes and add-on exclusion; queue replay after edits;
DD consent capture; and existing membership regression suites. The Vite
production build passed. The unauthenticated screenshot showed loading rather
than the protected editor; signed-in UI was not verified.
