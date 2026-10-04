# BNMS portal renewal action

## Verified scope and rollback

Destination project: `lvmzliemqnieeoruhkik` (DEST only; SOURCE untouched).
Published page: `40c78458-ac7a-497e-a26e-af914cf1cdfd`, slug `portal`.
Payment Details block: `block-mu6xe2ef-9pdrst`.

Original targeted settings, read from the published row:

```json
{
  "manageLink": "/FormView?slug=membership-renewal",
  "manageLinkText": "Renew subscription",
  "manageLinkNewTab": false,
  "renewalLink": "",
  "renewalLinkNewTab": false
}
```

The repair moves only `manageLink` to `renewalLink`, leaving `manageLink` empty.
The dedicated renewal action has the existing fixed label “Renew your subscription”;
it does not support an authored label. The original management label remains stored.
All other content, style, destinations and publication fields remain unchanged.

The runner defaults to read-only inspection:

```
node scripts/correct-bnms-portal-renewal-link.mjs
node scripts/correct-bnms-portal-renewal-link.mjs --apply
```

It pins DEST, verifies TLS, locks the published row, checks exact original link
settings and patches the freshly read design rather than overwriting a prior
snapshot. It does not publish drafts. Replays are no-ops.

If rollback is authorized, lock this exact published page, find exactly this
block, verify its two destinations still equal the repaired values, and restore
only `manageLink` and `renewalLink` to the values above. Do not restore the whole
page or overwrite subsequent edits. Rollback reintroduces the ungated CTA.

## Evidence boundaries

The pictured member's saved agreement was read from verified DEST and evaluated
with `resolveSavedCollectionPolicy(metadata.dd)`. It returned explicit version-1
`continue` / `dynamic` authority with `needs_review: false`. No member identifiers,
consent records, mandates, schedules or financial records are changed or copied
into this report.

The separate Membership Form Renewal Choices task owns payment choices and
successor-term rules. This repair does not change the server eligibility resolver:
finite and unknown-consent DD retain their existing eligibility behavior.

Local regression evidence uses isolated fixtures, not authenticated production
sessions. A signed-in live portal visual check requires an authorized session;
the screenshot supplied by the user is not such a session.

No database migration is required. The configuration repair is a targeted data
update on DEST, not a schema change. Editor guidance requires normal application
deployment; no production application deployment is authorized by this task.

## Execution result (2026-10-04)

- Applied the two-destination correction to verified DEST. Immediate read-back
  returned `changed: false`; the published row already contained the repaired
  values. No migrations were needed or applied to any database.
- Confirmed the existing `membership-renewal` form exists in DEST and is active.
  No checkout was initiated.
- 79 isolated repair/API/eligibility tests and 27 component tests passed:
  `node scripts/run-isolated-tests.mjs node --test scripts/correct-bnms-portal-renewal-link.test.mjs api/_lib/canvasRenewalEligibility.test.mjs api/membership/canvas-summary.test.mjs`
  and
  `node scripts/run-isolated-tests.mjs node --import tsx --test client/src/components/canvas/blocks/MembershipDataBlocks.test.jsx`.
- The current BNMS portal HTML returned HTTP 200 and its main served JavaScript
  bundle contains the dedicated `membership-renewal-cta` implementation. This
  establishes deployed feature presence, not the signed-in rendering result.
- Anonymous public-page API requests returned 404, so they do not verify the
  member page's saved payload. No authorized member session was available.
- The local workflow starts, but its `/portal` screenshot shows “Tenant not
  found”; logs confirm the legacy SOURCE lacks the tenant table. This existing
  environment limitation was not “fixed” by repointing the application's database.
- Outstanding: deploy the editor-guidance wording through the normal approved
  release process, and verify the live card with an authorized member session.
  No additional page publication or migration is needed for the saved correction.