# Event audience preparation: investigation and release evidence

## Evidence collected 2026-10-15

All incident reads targeted verified Supabase DEST `lvmzliemqnieeoruhkik`.
No recipient names, addresses or answer data are retained here.

Two campaigns named “ASNC/BNMS Joint Webinar part 1 - survey” were found,
both failed. Their current generations ended at 14:56:15 and 15:29:15 UTC:
segment 1, cursor 0, total 0, last error “No recipients found for this
campaign”. Both had **null communication_category_id**, in both campaign
and frozen preparation snapshot. Neither used campaign/list opt-out bypass.
Neither had delivery rows, staged eligible recipients, retained candidates,
or recipient-seen facts. The saved list selected the webinar's **attended**
confirmed bookings. There were 189 confirmed ordinary bookings, zero
check-ins and zero complex bookings.

74 confirmed bookings had published, tenant-valid recorded attendance outcomes
with tracking enabled. Their latest update was 13:04:48 UTC on October 15;
all 74 existed before both failures. Running only the current read-only
recipient resolver against DEST, with the actual saved list and null category,
returned 74 matching contacts, zero global/category exclusions, zero
duplicates and 74 eligible recipients. No preparation/send endpoint was called.

Vercel's production deployment listing for the project's pinned project
`prj_iPFlb9rOOVNVtbobMRR1vyV934lf` identified READY deployment
`dpl_HU2t68gnRYgt8eu96t1xPeEAoe69`, commit
`b5fb99384b3b94ec2eaa603c8668fe993ca68fd9`. Inspection of that exact commit's
preparation stream shows **check-in-only attendance selection**, without
`recordedAudienceAttendance`. Its ordinary preview also lacks recorded
attendance. Current source includes the recorded-outcome path in both.
The deployed SQL preparation function matched the original repository migration
byte-for-byte (function body) before the diagnostics migration.

## Conclusion and limits

The production source contract excludes all 189 bookings at attendance
selection, explaining the empty preparation without any category exclusion.
The current saved-list resolution includes the 74 recorded outcomes because
it runs newer attendance-aware source. Deploying only the SQL repair does
not update the JavaScript worker. The category-preview discrepancy is real
for categorized campaigns, but **is not the cause of these two failures**.

This is deployment/source plus durable database evidence, not a retained
per-invocation trace. The old generations did not retain exclusion counters,
so we do not infer historical consent counts from their empty candidate table
alone. Duplicate identity selection was nondeterministic in preview; it is
now aligned with preparation, but was not demonstrated to cause this incident.

## Changes and verification

- Event-attendee preview uses the same bounded, deterministic member-identity
  RPC as preparation; lookup failures propagate instead of turning members
  into guests. Fallback member reads propagate errors and use stable ordering.
- Saved-list counts explicitly exclude campaign category context; campaign
  previews show matching contacts, global/category exclusions and final count.
- New preparations retain aggregate candidate/global-exclusion counts and
  explain whether nothing matched or consent/category eligibility excluded all.
  Existing generations have unknown historical counts, never invented zeros.
- Consent rules, bypass semantics, tenant scope and attendance predicates remain
  unchanged. Failed preparations remain terminal.
- Disposable PostgreSQL tests execute real SQL candidate/consent finalization
  for nested event lists, subscribed/unsubscribed members, guests, duplicate
  identities/bookings, ticket and attendance exclusion, empty audiences and
  committed-transition response loss. A 189-booking/74-recorded-attendee fixture
  with no category prepares 74 recipients. Tests never invoke email transport.
- JavaScript resolver and list endpoint regressions pass. Changed JSX compiles.
  The local app starts, but its unmodified SOURCE configuration shows
  “Tenant not found”; authenticated campaign UI was not visually verified.

## Database and release requirements

Applied `20261016_campaign_preparation_eligibility_feedback.sql` to **DEST only**
using the SHA-pinned destination runner. SHA-256:
`7a45378441bbd1fc9454812acaccdb99baa8807e3ad8b06ff0b792f0978aa6be`.
The migration runner verified all 141 existing campaign rows and row versions
unchanged. No campaign state or preference was changed. SOURCE was untouched.
No migration remains pending for this task.

The matching source (including recorded attendance in the worker) still needs
the normal merge/release process. This task did not publish. Verify the release
commit and the signed-in campaign-context preview on the tenant's real domain
before any operator authorizes a send.

## Safe recovery

The originals cannot resume: SQL rejects resume for a terminal failed
preparation. Preserve them as evidence. After release verification, use the
existing **Duplicate** control to create one new draft, review audience,
attendance, content and campaign category, and use its recipient preview.
Counts may change with legitimate source/consent updates. Do not change the
attendance filter or override opt-outs merely to obtain recipients. Only the
user should authorize sending that reviewed draft. No retry, duplicate, state
reset, preference update, test email or real email was performed here.
