# Custom Object audience verification

## Read-only BNMS evidence

Destination project `lvmzliemqnieeoruhkik` was inspected in a read-only
transaction on 2026-09-30, 09:41:54–09:42:51 UTC. No lists, campaigns,
assignments, preferences or records were changed.

- Tenant: `ff2df806-b321-4254-b651-3af11fccf1db` (BNMS).
- Object: `cd1ebfd3-3e16-4091-be5a-99992d926f2f`, currently labeled
  **Organisation department**, active.
- Relationship: `0fdede92-efa2-4d84-9b16-df1a88069486`, key `members`,
  label **Members**, active, Custom Object source → Member target.
- Relationship field: `edf1fbf8-76f7-4455-a7e2-f0f45db57b43`,
  key `survey_respondent`, label **Survey respondent**, boolean.
  This is stored in relationship `field_values`, not the similarly named
  member preference and not survey-submission evidence.

Requiring true JSON booleans, active edges and Department records, correct
tenant/object identity, and nondeleted members produced **188 relationships
and 171 unique members**. All 171 had unique nonempty email addresses.
Fourteen members had multiple matching relationships. Neither global
communications opt-outs nor global email unsubscribes removed any of these
171 at the observation time.

Category consent is separate: 171 were subscribed to BNMS Updates and
Newsletter, but only 60 to Society Admin. These are a read-only snapshot,
not a guaranteed future recipient count. The selected campaign category
and existing suppression policies still apply.

## UI recipe after deployment

In Communications Management, open Audience Lists, start a list, and add
a **Field Filter** segment:

1. Scope: **Custom Object**.
2. Object: **Organisation department**.
3. Member relationship: **Members (Object → Member)**.
4. Field: **Relationship: Survey respondent**.
5. Operator: **Yes**.
6. Add/apply the filter and save the list only with separate authorization.
   Preview the saved list before using it in a campaign.

Do not choose the similarly named Member preference. Conditions within an
AND group using the same object/relationship/direction must hold on the
same Department record and relationship edge. OR groups remain alternatives.

## Rollout boundary

The condition uses existing audience JSONB storage; no migration is required
or was applied to either database, and none remains pending.
Application deployment is required. Live metadata/count evidence above is
separate from isolated automated UI and resolver tests: it does not prove
an authenticated deployed UI session or authorize sending a campaign.

## Isolated regression evidence

- Backend resolver, preview, and campaign concurrency checks: 51 passing tests.
  Run `node scripts/run-isolated-tests.mjs --shell "node --test api/_lib/audienceCustomObjects.test.mjs api/audience-lists/preview.test.mjs api/_lib/campaignService.concurrency.test.mjs"`.
- Component/render checks: five passing tests in
  `client/src/components/communications/CustomObjectAudienceCondition.test.jsx`.
- Full Communications Management browser fixture: create, captured JSON save,
  reload/reopen, Yes→No update, metadata failure/retry, stale references,
  unapplied-edit protection, and actionable count errors pass.
  Run `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(command -v chromium) npx playwright test --config=tests/custom-object-audience.config.mjs`.
- Existing audience-list preview browser regression also passes.

Browser API responses and list writes were intercepted fixtures, with
unexpected writes rejected. The unmocked local preview reports “Tenant not
found”; it is not evidence of an authenticated live BNMS flow.