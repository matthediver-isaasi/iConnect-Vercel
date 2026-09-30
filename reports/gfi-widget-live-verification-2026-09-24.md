# GFI widget live verification — 24 September 2026

## Follow-on: user-supplied authenticated waterfall

The user subsequently supplied Network screenshots from the confirmed host.
They show HTTP/2, repeated `widgets?embed=canvas` list requests and repeated
definition IDs. The filtered capture contains 100 matching requests (not
necessarily all from one initial navigation). Some list requests exceed a
minute, while visible `/data?embed=canvas` rows take approximately 2.5–3.6
seconds. The earlier individual definition timing showed 14.28 seconds
stalled and 2.42 seconds waiting for response. These observations demonstrate
expensive discovery traffic, not a minute of proven cache recomputation.

Source inspection found that every mounted Canvas block independently fetched
the entire shared list and its definition, using instance-specific query keys.
Both requests were enabled even before session resolution. The card waited
for both before mounting its data query.

The correction shares concurrent metadata discovery under the existing
tenant/member/role/auth-state scope, with one detail key per saved widget,
and gates it on resolved, validated authentication. Metadata remains immediately
stale and is garbage-collected when unused; requests consume cancellation signals.
Shared-list membership and successful-detail checks remain mandatory.
Result/refresh queries remain instance-specific. No server permission or
database cache/publication behavior changed.

Regression checks model 20 simultaneous cards referencing six widgets: discovery
now performs seven metadata requests (one list, six definitions), rather than
40 for an unpaginated list. Additional checks cover readiness, changed auth
scope, shared observer lifetime, cancellation, pagination, palette and denial.
The targeted test run passed 33 of 34 checks. The unrelated existing permissions
test expects no Cache-Control header for non-Canvas requests, whereas the
unchanged implementation applies private/no-store to all dashboard requests.

This correction is local source, not verified rollout. Deployment revision,
live post-change waterfall, invocation logs and production warm aggregation
count remain blocked as described below. The initial investigation sections
below describe the evidence collected before this correction.

No new migration is needed, applied or pending. The prior refresh-receipts
migration remains already applied to DEST `lvmzliemqnieeoruhkik`.

## Outcome: blocked, not a performance-resolution claim

The user confirmed the affected URL as
`https://gfi.dev.iconn.app/board-report`.
Its unauthenticated document returned HTTP 200 in 3.256 seconds and referenced
`/assets/index-C3ybYuN6.js`. The external browser rendered “Page not found”.
No authorized browser session was available. This does not establish that the
page is missing for an authorized user.

The tenant's configured public domain, `graduatefutures.org`, redirects to
`www.graduatefutures.org`. That host served a different entry bundle,
`index-Csr7kx8-.js`. Its `/boardreport` returned 404; `/board-report` returned
200 but likewise rendered “Page not found” to an unauthenticated browser.
Those observations are not evidence about the affected host's authenticated
performance. Neither bundle name establishes the deployed commit.

## Page-specific destination evidence

Read-only queries targeted Supabase DEST `lvmzliemqnieeoruhkik`, never SOURCE.
The GFI tenant is `fd82da65-aab7-4a5c-85b8-b2febeb2003d`.
Its published Canvas page is `9b66b18a-df77-4b3a-9c5f-fddc366446af`,
slug `board-report`, published at 2026-09-21 13:08:06.090 UTC.

Recursive saved-design widget references resolve to six distinct shared
widgets. Repeated references were deduplicated; this is not a count of visible
cards. No private result payloads or chart values were fetched or reproduced.

Observations A and B were at **05:40:18.823 UTC** and **05:55:46.852 UTC**.
All six had non-null results, zero failures and no recorded error in both.

| Saved widget ID | Last success A (UTC) | Last success B (UTC) | B status |
|---|---|---|---|
| 1344607e-e7c3-49ca-91b2-7fef42e04e2e | 05:39:42.769 | 05:55:42.553 | Current; new publication |
| 185db8ea-45b7-4789-a182-4ac0bb4d31c1 | 05:39:44.198 | 05:55:44.002 | Current; new publication |
| 903d9f61-6f3f-4f49-b48d-ffb63b85c113 | 05:32:41.858 | 05:47:42.947 | Current; new publication |
| a44e5d4e-9e79-45cb-b78e-4f9a2804b259 | 05:39:47.789 | 05:39:47.789 | Stale; 59.063 seconds overdue |
| cf6348c2-6a42-4f24-98c9-61b01f12eb5b | 05:32:41.755 | 05:47:42.255 | Current; new publication |
| e15e9368-8347-4fce-b307-ee7a77d1fb91 | 05:25:47.929 | 05:41:47.951 | Current; new publication |

All last-viewed timestamps remained unchanged between A and B (between
05:34:44 and 05:35:32 UTC). At A, none had an outstanding request or active
lease; four had never had an explicit refresh and the remaining two last had
one on September 23. The investigator called no touch, claim, refresh,
scheduler or stats RPC.

Five observed publication intervals were approximately 15:59.784, 15:59.804,
15:01.089, 15:00.499 and 16:00.021. Thus background publication progressed
without recorded intervening views, but the strict 15-minute target was
exceeded by approximately 0.5–60 seconds. The snapshots do not establish
whether cadence, capacity or another factor caused this overshoot.
No successful-publication history beyond these snapshots was inferred.

The identity helper was permission-denied through the read-only MCP connection.
Identity hashes were readable, but semantic identity equality was not verified.
Visible-card mapping and response-to-result correlation remain unverified.

## Live API boundary and deployment access

Two independent unauthenticated POST requests to the saved-widget data endpoint
for widget `1344607e-e7c3-49ca-91b2-7fef42e04e2e`, with `embed=canvas`,
returned 401 `Authentication required` and `Cache-Control: private, no-store`.

| Attempt | HTTP elapsed | Server-Timing |
|---|---|---|
| 1 | 1.333 seconds | access=133 ms; total=133 ms |
| 2 | 0.372 seconds | access=1 ms; total=1 ms |

These denied requests do not measure widget lookup, cache access, aggregation,
authorized initial/repeat loads or card rendering. No zero-aggregation claim
is made for live warm cards.

The connected Vercel API returned HTTP 403 with `invalidToken: true` and
“Not authorized” for both project listing and a deployment lookup using the
affected hostname. Connection metadata classifies it as API-key authorization,
not OAuth. No deployment configuration or credentials were changed.
Deployed revision, deployed cron configuration and actual invocation logs
remain unavailable. Source cron configuration alone is not rollout evidence.

## Required next access

1. Repair the existing Vercel connection's token/access through the secure
   integration settings, then resolve the affected hostname's deployment and logs.
2. Provide an approved authenticated testing route/session mechanism for this
   host; do not share passwords, session cookies or bearer tokens in chat.
3. Capture authorized initial and independent repeat waterfalls and correlate
   saved-widget response timestamps with DEST rows. Fix only a measured cause,
   then repeat the same live flow and scheduler observation.

## Changes and migrations

No application changes, deployment writes, refresh requests or database writes
were performed. No regression test was added because no defect was reproduced.
This report is the only deliverable; the reported minute-long delay is unresolved.

No new migration is indicated or pending from this investigation.
`dashboard_widget_refresh_receipts.sql` was already applied to DEST
`lvmzliemqnieeoruhkik` before this task. This investigation independently
confirmed all four receipt columns exist there; it did not rerun the migration
or revalidate every function body/grant. Nothing was applied to SOURCE.