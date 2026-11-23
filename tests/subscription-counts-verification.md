# Subscription-count reliability verification

## Cause and reproduction

The category card adds explicit eligible member subscriptions to external subscriber
counts. There is no combined-count HTTP endpoint. Previously, missing member and
preference query data defaulted to empty arrays; an external response of 1 therefore
rendered as the complete total even while preferences were pending or had failed.

React Query keeps those inputs independently. Members remain fresh for 60 seconds,
external totals for 30 seconds, and preferences become stale immediately. Remounting
can reuse cached members/external totals; opening a dialog or expanding a card computes
from that cache without making a new combined-count request. Preferences may refresh
on remount. Browser changes without a newly initiated count request do not establish
that stored consent changed.

The fix keeps those timings and existing explicit-subscription/eligibility semantics.
All three successful inputs are required. Initial loading, refreshing cached data,
and unavailable inputs are distinct; failed inputs have retry. Dialog content and
CSV export are gated by the same state. Export validates complete external pagination
and refuses changed inputs or tenant context before downloading. Query prefixes remain
compatible with existing invalidations, while keys and request headers pin the tenant.
Admin category/global preference writes invalidate both aggregate member and preference
inputs, in addition to retaining their existing member-specific invalidations.

## Read-only GFI evidence

On 2026-11-23, approximately 09:05–09:07 UTC, SELECT-only queries against the documented
destination project `iconn-multi-tenant` identified tenant slug `gfi`
(Graduate Futures Institute). No records, consent, recipients or eligibility rules
were changed. Only category-level aggregates were retrieved:

| Category | Explicit true preference rows | Eligible distinct members | External not opted out | Sum |
| --- | ---: | ---: | ---: | ---: |
| Graduate Futures Newsletter | 5355 | 4838 | 123 | 4961 |
| News updates | 5131 | 4782 | 1 | 4783 |
| Event updates | 5166 | 4819 | 1 | 4820 |
| Heads briefing | 2 | 2 | 0 | 2 |
| Job postings | 33 | 33 | 0 | 33 |

The member aggregate joined preferences to members within the tenant, required explicit
true consent, deduplicated member IDs, excluded empty/deleted-placeholder email, disabled
login, global opt-out and archived/minimised/deleted lifecycle states, matching
`filterExplicitCategorySubscribers`. The first SELECT exposed that this database lacks
`member.lifecycle_state`; the successful SELECT used `to_jsonb(m)->>'lifecycle_state'`
so its absence matches the current helper's undefined-field behavior. External counts
required `opted_out = false`, matching the endpoint.

These are a point-in-time database snapshot, not verification of the deployed browser,
campaign-recipient counts, or a claim that every historic reported category was reproduced
live. No additional role/category-availability eligibility was introduced. The exact
external value of 1 for both News and Event updates supports the readiness explanation;
it does not imply their member subscriptions were lost.

## Checks and limitations

- `node --test client/src/lib/subscriptionCountState.test.mjs client/src/lib/jobAlerts.test.mjs`
  covers pending external-one, successful zero, failures with cached data, refreshing,
  real QueryClient cached remount/request reuse, mutation invalidation, tenant-separated
  late responses, pinned paginated requests, malformed pages and incomplete exports.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which chromium) npx playwright test --config=tests/subscription-counts.config.mjs`
  uses intercepted fixture API responses on the real page: external one precedes held
  preferences, card/export remain blocked, dialog displays the complete total without
  another input request, complete CSV downloads, and member/preference failures recover
  using Retry. These are browser fixtures, not GFI sessions.
- The existing subscriberModalSearch suite has an unrelated obsolete source assertion:
  “the first toggle on a missing explicit preference subscribes the member” expects
  `getToggledExplicitSubscriptionValue(existingPref?.[0])` in an API now using atomic
  consent operations. All other tests in that suite passed.
- The application workflow starts cleanly. The unsigned preview screenshot cannot
  resolve its configured default tenant (`Tenant not found`); it does not verify the
  signed-in GFI UI. Authentication and tenant configuration were not bypassed or changed.
- No polling, production deployment, consent mutation or live-provider test was performed.
