# Year 2 organisation membership preview: read-only DEST diagnosis

## Local verification

The combined isolated core, endpoint, integration, individual commitment, invoicing and rendered component suites passed 113 tests. The final added exact Partner-price regression also passed (32 core tests total). The existing isolated Playwright rollover fixture passed both browser tests. No fixtures contacted live payment, email or database services. The development workflow restarted cleanly, but its root-page screenshot showed the existing legacy-database tenant-not-found setup limitation; it is not evidence of the authenticated production card. No migrations were needed, applied to any database, or left outstanding.

Checked 2026-09-30 UTC against the pinned production DEST Supabase project. The supplied UUID resolves to an **organisation**, not a member. This document intentionally omits names, addresses, contact information, tenant and record identifiers, and credentials. No database writes, approvals, or deployments were made. The simulator was passed a read-only client that rejects mutation methods and RPC.

## Live evidence and exclusion

- The organisation has structure scope **Partner**; its selected membership structure is fixed-date (1 August), annual, flat **GBP 950**, pro-rata enabled, **no free-period incentive and no rollover**. A tenant-level active `go_live` preference field exists, but this organisation has **no value** for it. There are **zero** organisation membership history rows, **zero** overrides, and no organisation invoicing-setting rows.
- Before the fix, the simulator used the missing go-live date as *today* to calculate Year 1 and Year 2 numbers, but its `genuinelyInYearOne` guard additionally required a **non-null saved go-live date**. Thus the Year 2 prospective branch was excluded. It fell through to historical `calculateOriginalIncentiveRollover`, which rejected the absent history/snapshot: `new_member_incentive_review_required`, “New-member incentive requires review: no snapshot or demonstrably unchanged, history-linked joining configuration is available.”
- The updated local core uses the same assumed joining date for the prospective **display-only** guard, verifies the missing preference is genuinely missing, and projects its own Year 1. It does not manufacture a purchased Year 1 or permit approving prospective Year 2.

## Exact source-tab reproduction and amounts

The organisation GET tab's calls are `simulateMembershipForOrg(tenantId, organizationId, { source: 'tab', targetYear: '2026/2027' })` for current Year 1, and `{ source: 'tab', targetYear: '2027/2028', asOfDate: '2027-08-01' }` for next Year 2. These are internal read-only calls, not HTTP writes. The tab's GET path is `/api/membership/org-membership?organizationId=<organisation-id>`; the mapping suppresses a failed quote and sets `previewWarnings.nextYear`.

| Date / result | Year 1 2026/2027 | Year 2 2027/2028 |
| --- | --- | --- |
| Before change, 2026-09-30 | Successful: annual GBP 950; pro-rata GBP 793.82; incentive GBP 0; net GBP 793.82; VAT GBP 158.76; gross GBP 952.58 | **Unavailable**, `new_member_incentive_review_required`; no computed Year 2 amount |
| Updated local core, 2026-09-30 screenshot date (clock 12:00 UTC) | Same: annual GBP 950; pro-rata GBP 793.82; incentive GBP 0; net GBP 793.82; gross GBP 952.58 | Successful **prospective-only**: annual/net GBP 950; incentive/rollover GBP 0; VAT GBP 190; gross GBP 1,140; `previewOnly: true`, `previewAssumedJoinDate: '2026-09-30'`; rollover source `prospective_year1_projection`, original/used/remaining entitlement **0/0/0**, eligible false |
| Updated local core, actual check time 2026-09-30 07:07 UTC | Same as above | Same as above |

The Year 2 GBP 0 incentive is expected because the applicable Partner structure has no free-period entitlement. The absence of a saved go-live date is surfaced as an assumption, **not** historical evidence. The current date and screenshot date are the same UTC calendar day; future dates could change an assumed join-date calculation.

Regression fixture can be fully synthetic: an organisation scoped `Partner`; annual fixed 1 August flat GBP 950, pro-rata true, free-period null, rollover false, VAT 20%; no `go_live` preference value, history, override, or invoicing setting. Clock `2026-09-30T12:00:00Z`; tab current/next options above. Assert Year 1 GBP 793.82, prospective-only Year 2 GBP 950, zero Year 2 rollover, and no permission to approve prospective Year 2. Separately assert a real historical renewal with incomplete evidence still fails closed.

## Deployment/bundle boundary

The Replit deployment metadata service reports **no Replit deployment** for this workspace; this repository uses an external Vercel preview. A read-only public check of documented `https://dev.iconn.app/` returned HTTP 200 and served `/assets/index-DFkXgDa4.js` (HTTP 200). That live bundle contains `OrgMembershipTab` but **does not contain** the updated client strings `previewAssumedJoinDate` or “Joining date is not set. This estimate assumes a joining date”. Unauthenticated GET of the membership endpoint returns **401**. Therefore the verified DEST data plus **local updated code** reproduction does **not** prove the Vercel live API or UI has the fix; the observed preview bundle appears older. No deployment or authenticated live endpoint test was performed.