# GoCardless heartbeat incident: read-only diagnosis

## Conclusion

**The job is executing, but retained reconciliation runs have been partial since
18 September 2026. This is not merely an absent heartbeat.** The latest sampled
runs repeatedly fail subscription-status reads for four BNMS plans labelled
`sandbox`. BNMS's enabled GoCardless connection is currently configured `live`,
and the reconciliation code selects historical rows without checking environment
but resolves the client using the tenant's current connection.

This is strong evidence of a sandbox/live routing mismatch. A provider 404 alone
does not establish resource ownership or prove that a stored environment label
is correct. Wrong account/rotated credentials remain alternatives until
provider-origin evidence is checked. No provider request was made during this
investigation.

Older runs also failed while attempting housekeeping updates on held BNMS beta
plans. Those are real application errors around a correctly enforced hold—not
permission to release the plans or weaken the database guard.

The six-hour Better Stack setting reported in the user's screenshot is a
**separate, now-stale cadence setting**. It matches the earlier observed run
cadence, but not the five-minute execution pattern observed from 30 September.
It does not explain the recorded reconciliation errors.

## Evidence boundary and safety

- Database: verified **DEST `lvmzliemqnieeoruhkik`**, not the workspace's legacy
  SOURCE. Reads used the documented destination pooler, independent REST/SQL
  project pins, verified TLS with the public Supabase CA, read-only transactions,
  and a 20-second statement timeout. No business function/RPC was invoked.
- Observations were taken on 1 October, approximately 15:59–16:03 UTC. The fixed
  incident analysis cutoff is **15:55:58.749 UTC** to avoid mixing counts while
  naturally scheduled runs continue. A later metadata-only count saw another
  partial at 16:01:29.546.
- The Supabase integration's documented SQL callback was unavailable in this
  session; the existing, authorized destination connection successfully supplied
  the reads. There was no provider-side access denial for those database reads.
- The attached Vercel connection returned HTTP 403, `invalidToken: true`, both
  for project discovery and for the exact documented project/team. Its
  authorization type is API key. No new connection was attached and no
  credentials were printed or changed.
- Consequently, **the active Vercel deployment ID/commit, deployed source bytes,
  cron metadata and production heartbeat-variable presence/value mapping were
  not verified**. Local source/history is not deployment proof. Audit timestamps
  show the observed cadence, but do not independently identify the invoker.
- No authenticated Better Stack incident/delivery history was available. The
  screenshot's approximately thirteen-day incident, recent heartbeat and
  six-hour interval are user-supplied evidence, not a retrieved delivery ledger.
- No reconciliation invocation, heartbeat request (including HEAD), deployment,
  provider retry, billing operation, email, monitor change, or incident dismissal
  was performed. Pre-existing invoice implementation changes were not edited.
  The initial completion checkpoint inadvertently bundled them with the report;
  user-authorized separation preserves their exact changes on local branch
  `preserve/event-invoice-recovery-unreviewed`, outside this diagnosis. That
  preservation is not approval to merge, deploy or apply its migration.
- The uploaded monitoring screenshot contains a bearer heartbeat reporting URL.
  It is excluded from the diagnosis and preserved locally under an ignore rule.
  **The endpoint should be rotated through separately authorized configuration
  work.** Exclusion from the current commit does not revoke the URL or guarantee
  removal from older checkpoints, history or cached copies. No token is copied
  into this report, and no rotation was performed.

## Job execution and retained history

At the fixed cutoff, 566 GoCardless audit rows were retained, spanning
31 July 12:16:07.443 through 1 October 15:55:58.749 UTC: 196 success, 370 partial.
This establishes the retained range, not a guarantee of complete invocation
history or a retention policy. A timeout or audit-insert failure can leave no row.

All retained `details` values were JSONB **strings containing JSON objects**.
They were decoded before aggregation; directly reading
`details::jsonb->>'errors'` would return null and incorrectly hide the evidence.

- **Last recorded success:** 18 September **06:15:50.522 UTC**.
- **First recorded partial:** 18 September **12:15:50.418 UTC**.
- **Every recorded run thereafter through the cutoff:** partial, 370 runs.
- The first partial contains one subscription GET 404. This establishes the
  application's failure onset to the six-hour interval between these two runs;
  the exact Better Stack incident-open timestamp is unavailable.
- From 18 September through the cutoff: **372 runs, 2 success, 370 partial**,
  with 1,482 counted error occurrences. These are repeated attempts, not
  1,482 distinct failed payments.

| UTC date/window | Runs | Success | Partial | Counted errors |
|---|---:|---:|---:|---:|
| 18 September | 4 | 2 | 2 | 2 |
| 19 September | 4 | 0 | 4 | 6 |
| 20–29 September, each day | 4 | 0 | 4 | 4 |
| 30 September | 132 | 0 | 132 | 612 |
| 1 October, through 15:55:58.749 | 192 | 0 | 192 | 822 |

Before the cadence change, rows appear around 00:15, 06:15, 12:15 and 18:15 UTC.
The first observed five-minute sequence begins **30 September 13:15:59.002**,
then 13:20:55.694, 13:25:55.735, etc. On 1 October there is one retained run in
each five-minute slot from 00:00 through 15:55. This is strong evidence that the
job is not simply stopped.

The latest eight sampled runs are all partial, with four or five errors.
The last at 15:55:58.749 records **0 repaired, 0 flagged, 9 skipped, 4 errors**,
duration **16,465 ms**. The 1 October durations range from 12,531 to 163,010 ms;
these completed audit rows do not prove that no unlogged timeout ever occurred.

## Error groups and affected scope

| Operation / signature | Occurrences | First–last observed UTC | Scope |
|---|---:|---|---|
| Subscription GET: 404 Resource not found | 1,291 | 18 Sep 12:15:50.418–1 Oct 15:55:58.749 | Four BNMS sandbox-labelled plans |
| Payment GET: 404 Resource not found | 94 | 30 Sep 13:15:59.002–1 Oct 15:46:01.643 | Four BNMS sandbox-labelled payments linked to those plans |
| Completion outcome write: “Beta collection release requires a separate reviewed release migration” | 3 | 19 Sep 18:15:49.759–20 Sep 06:15:49.755 | BNMS beta guard; individual row not recorded |
| Completion outcome write: “Beta collection requires reviewed release” | 40 | 20 Sep 12:15:49.834–30 Sep 12:15:50.108 | BNMS beta guard; individual row not recorded |
| Dynamic collection error write: “Beta collection requires reviewed release”, no stage | 1 | 25 Sep 18:15:55.748 | Individual row/original collection error not recorded |
| Same collection outcome error, stage `dynamic-collections` | 53 | 30 Sep 13:15:59.002–20:16:01.413 | BNMS beta guard; individual row/original error not recorded |

The subscription and payment stages are inferred from the provider operation and
the code path; these row-level errors do not themselves retain a stage field.
The beta tenant attribution comes from the dedicated guard definition, not a
tenant ID in those historical error entries.

### Subscription/payment routing

Local plan identifiers below are included only to make the bounded repair cohort
reproducible; no member identity or provider credential is included.

| Plan ID | Subscription 404 occurrences | First observed | Linked payment 404 occurrences | Current linked payment accounting |
|---|---:|---|---:|---|
| `8d11925e-4218-435a-bccc-9061bf5b8bdb` | 326 | 18 Sep 12:15 | 1 | failed: Xero invoice-retrieve HTTP 429 |
| `6ea6a50c-7155-4aae-9034-c00a66918e29` | 322 | 19 Sep 12:15 | 1 | failed: Xero invoice-retrieve HTTP 429 |
| `eaa4f068-71fc-43f9-af4c-b1e518a3be16` | 322 | 19 Sep 12:15 | 91 | skipped: no invoice linked on membership history |
| `fad8579a-6a29-44c8-bb42-a6f7cfb29327` | 321 | 30 Sep 13:15 | 1 | failed: Xero invoice-retrieve HTTP 429 |

All four plans are currently active and labelled sandbox; all four related
agreements and payment rows are also labelled sandbox. The payments are locally
`paid_out`; this is not evidence of real-money settlement in the live account.
Three agreements use per-instalment invoicing; the third table row uses annual
invoicing.

BNMS's integration is enabled, has an access-token field (existence only was
queried), and its non-secret environment is `live`. Its last update timestamp
is **18 September 07:53:02.843 UTC**, between the last success and first partial.
This timing supports the mismatch hypothesis but does not prove that this update
changed the environment. Historical settings and successful credential
decryption in the deployed runtime were not independently observed.

Source trace:

- `api/_lib/directDebitReconciliationPipeline.js:15–32`: selectors do not filter
  the row's environment.
- `api/_lib/gocardlessCredentials.js:75–107`: credentials come from the current
  tenant integration, with platform fallback if unavailable/disabled/unusable.
- `api/_lib/gocardless.js:47–62,414–416`: the resolved credential environment
  selects the provider host; token-prefix checks do not compare record
  environment or historical account ownership.
- `api/cron/reconcile-gocardless.js:27–32,61–93`: client cache is tenant-only;
  subscription errors are recorded without refreshing the plan's timestamp,
  so the same plans remain eligible on each run.
- `api/_lib/directDebitReconciliationPipeline.js:150–172`: payment reads use the
  same tenant routing. Payment failures receive a fairness timestamp update;
  that is not successful status reconciliation.

### Held beta work and historical phase abortion

The installed DEST `bnms_dd_beta_hold_guard()` contains both the reviewed-release
rule and the processing-not-before gate. Its plan and reservation triggers are
enabled. This is **not evidence of a missing hold/release schema migration**.

The guard intentionally forbids changes to held plan fields except permitted
metadata/timestamp changes. Polling/error fields fall outside those exceptions.
Historical completion code tried to update its next-check/error outcome on held
plans. That housekeeping write itself was rejected. Historical collection error
bookkeeping could similarly throw and mask the initial collection outcome.

Local git history shows that the older cron wrapped all phases in one outer
catch. A completion outcome-write exception therefore stopped subsequent
collections, status reconciliation and accounting phases for that invocation.
The 43 completion-error runs and the one unscoped collection-outcome run are
consistent with that version's envelope; they record zero repaired/skipped work.
This explains why disappearance of subscription errors during that interval is
not evidence that the subscriptions became healthy. Exact deployed code for
each historical run remains unverified.

Current source isolates phases and row outcome errors and excludes held plans:
`api/cron/reconcile-gocardless.js:102–140`,
`api/_lib/directDebitDynamicPipeline.js:117–140,295–327`,
`api/_lib/gocardlessDynamicCollections.js:180–233`, and
`api/_lib/gocardlessDynamicCompletion.js:126–165`.
The exact guard contracts are in
`supabase/migrations/20261112_bnms_dd_beta_held.sql:66–86` and
`supabase/migrations/20261115_bnms_dd_beta_scheduled_release.sql:53–110`.
Migration filename dates are not application dates.

No beta guard error was recorded after **30 September 20:16:01.413** through the
fixed cutoff. Current DEST has ten beta adoptions with ten reviewed release
records; none remain stopped/release-required, and none has a current collection
or completion error. This does not establish whether release, code rollout, or
both ended the historical error. Do not release any cohort merely to clear a
monitor.

## Business impact—not all Direct Debit payments failed

- **Status reconciliation:** confirmed repeated inability to inspect the four
  affected subscriptions; recurring inability to inspect one linked payment,
  with single earlier errors for the other three.
- **Historical dynamic work:** held-plan bookkeeping errors could prevent later
  phases from running in the older envelope. Holds were enforced, not bypassed.
  The historical logs cannot identify the exact held row or recover the masked
  original collection exception.
- **Collection creation continues:** current BNMS scope contains 355 live
  dynamic plans and 355 reservations created within the incident window,
  locally marked submitted with provider payment IDs attached. Of the plans,
  354 are `first_payment_pending`, one `mandate_pending`; none currently has a
  collection/completion error. These are local submission records, not proof
  of confirmation, payout, or successful membership activation.
- **Term completion:** these dynamic plans have no completed terms and no
  completion outbox rows. There is no evidence here of a currently due, fully
  settled term failing to complete; pending first payments are not completed
  annual terms.
- **Accounting is a separate issue:** three of the affected sandbox-labelled
  payments currently retain Xero HTTP 429 errors. The annual agreement's payment
  is skipped for no linked invoice. In current source,
  `gocardlessAccounting.js` returns `{status:'failed'}` for caught errors, while
  `reconcileAccounting` treats every non-posted result as skipped. Consequently,
  these returned failures are not represented by the heartbeat error count.
  No invoice/payment retry or accounting provider request was made here.
- Incident-window audit counters include **495 repaired outcomes**. These are
  operations across repeated runs, not unique payments, members or collections.

## Heartbeat delivery versus monitor configuration

The source mapping is:

`GoCardless reconciliation` → `/api/cron/reconcile-gocardless` →
`BETTERSTACK_HEARTBEAT_GOCARDLESS_RECONCILIATION_URL`.

Current source logs `partial` and reports a failure heartbeat whenever aggregate
errors are nonzero. Its response may be HTTP 200 with `ok:false`; older source
could return `ok:true` despite partial audit status. HTTP 200 alone is therefore
not a useful health verdict.

`api/_lib/heartbeat.js:58–97` sends the configured normal URL on success and
appends `/fail` on failure. Delivery is best effort, times out after two seconds,
and delivery errors are swallowed with a safe warning. The audit entry is
written **before** heartbeat delivery and contains no delivery acknowledgement.
Thus:

1. Production audit rows prove completed logged invocations and partial outcomes.
2. Their errors explain why the documented handler would send `/fail`.
3. The screenshot's recent heartbeat is consistent with failure delivery, not
   proof of job success.
4. Neither the audit rows nor screenshot prove every heartbeat was delivered,
   that the variable maps to exactly this monitor, or that no delivery failure
   also occurred. Vercel warnings and Better Stack event history are still needed.

**Exact monitor correction after separately approved access/configuration work:**
expected interval **300 seconds (5 minutes)**, grace **900 seconds (15 minutes)**,
matching `*/5 * * * *` in `vercel.json` and
`guides/better-stack-cron-heartbeats.md`. Preserve the existing distinct monitor
and failure predicate. Store the normal heartbeat URL, not an already suffixed
failure URL. Do not send any manual success ping or dismiss the incident.
Confirm the active deployment's cron metadata before changing settings; the
observed five-minute audit pattern supports, but does not replace, that check.

## Narrow remediation and prerequisites

1. **Fix environment/account isolation for reconciliation.** First establish the
   four records' original provider environment/account using retained
   provider-origin evidence or separately authorized read-only provider checks.
   Then ensure reconciliation never routes sandbox records through a live
   client, including its accounting/lifecycle follow-ons. Either isolate
   positively identified sandbox records from the live worker with explicit
   diagnostics, or use a separately configured correctly scoped sandbox client.
   Ambiguous identities must remain actionable errors, not silently skipped
   “success”. Do not relabel rows live, delete financial history, cancel plans,
   or change BNMS's working live connection to sandbox.
2. **Confirm existing held-plan fixes in the deployed artifact.** Current source
   already filters held work and isolates independent phases. Confirm those
   exact fixes rather than designing a broader guard relaxation. Test
   held-to-released races and outcome-write failures without real billing.
3. **Handle accounting failures truthfully and safely.** Address the three
   retained 429 outcomes after environment ownership is established. Preserve
   idempotency, apply appropriate retry backoff, and distinguish failed posting
   from expected skips in aggregate health. Do not manually retry the sandbox
   cohort through live accounting to remove an error.
4. **Restore read-only deployment/monitor evidence and align cadence.** An
   administrator needs to repair the existing Vercel integration's API access
   or supply sanitized deployment/cron/environment-name evidence, plus Better
   Stack's timestamped receipt/failure history. Do not share token-bearing URLs.
   Verify the production heartbeat variable is present, uniquely associated
   with this monitor, and in the active deployment. Configuration changes are
   separate approval work; any app changes need an approved Vercel deployment.

After an approved correction, verify **naturally scheduled runs**: advancing
five-minute audit entries, no recurring provider identity errors, correct
accounting failure classification, continued eligible collection progress, and
matching Better Stack success receipts/automatic recovery. Allow the existing
per-row backoffs before declaring all due work verified. No synthetic health
request is needed.

**Migration/data-change statement:** No database migrations, schema changes or
data changes were applied to DEST, SOURCE, or any other database. No outstanding
migration requirement is established by this evidence. Environment isolation
uses existing columns, and the relevant beta guards/release tables are installed
on DEST. Any later evidence-authorized data repair or genuinely necessary schema
change must be separately reviewed and target verified DEST
`lvmzliemqnieeoruhkik` only; it is not authorized by this diagnosis.

## Minimal read-only reproduction

Run only through the verified DEST connection in a read-only transaction. Do
not call a cron route or business RPC. The query below normalizes the observed
JSONB string storage as well as ordinary object storage:

```sql
WITH runs AS (
  SELECT executed_at, status,
    CASE WHEN jsonb_typeof(details::jsonb) = 'string'
      THEN (details::jsonb #>> '{}')::jsonb
      ELSE details::jsonb END AS result
  FROM public.scheduled_task_log
  WHERE task_name = 'gocardless_reconciliation'
    AND executed_at >= '2026-09-18T00:00:00Z'
    AND executed_at <= '2026-10-01T15:55:58.749Z'
)
SELECT (executed_at AT TIME ZONE 'UTC')::date AS utc_day,
       count(*) AS runs,
       count(*) FILTER (WHERE status = 'success') AS successes,
       count(*) FILTER (WHERE status = 'partial') AS partials,
       sum((result->>'errors')::integer) AS errors
FROM runs
GROUP BY 1
ORDER BY 1;
```

The investigation decoded every inspected entry successfully. Missing or
unparseable details in future runs must be reported as evidence gaps, not zeros.