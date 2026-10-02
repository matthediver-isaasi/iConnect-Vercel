# Campaign throughput: first improvement pass

## Production baseline

A read-only query against the verified production DEST database sampled the 12
most recent campaigns with at least 100 recipients and a recorded start.
No campaign was triggered, resumed, cancelled or otherwise modified.
No recipient addresses, names, content or campaign identifiers are retained here.

Selected completed campaigns:

| Recipient acceptances | First-to-last acceptance | Approximate acceptances/minute |
| ---: | ---: | ---: |
| 313 | 13.0 minutes | 24 |
| 3,757 | 42.2 minutes | 89 |
| 4,960 | 62.9 minutes | 79 |
| 848 | 7.6 minutes | 111 |

These are historical observations, not benchmarks of the new implementation.
Campaign type, personalization, concurrent activity and code version can differ.
Rate is `(accepted - 1) * 60 / seconds_between_first_and_last_acceptance`.
Recipient `sent_at` was used because campaign `sent_count` sometimes lagged
recipient records. Acceptance means submission accepted by Mailgun, not inbox
delivery. Campaign `sent_at` includes preparation start; it does not isolate
preparation duration. An inconsistent historical completion timestamp and an
unresolved processing recipient were observed and left untouched.

## Implemented changes

- The scheduled worker defaults to two concurrent recipient deliveries per
  campaign. `CAMPAIGN_SEND_CONCURRENCY` can select 1–4; no environment setting
  was changed. Claims/admission are serialized and conditional; only an
  available delivery slot can claim a row.
- The scheduled worker's per-campaign attempt cap is 100 times the concurrency:
  default 200, maximum 400. This avoids finishing the same 100 recipients sooner
  and then waiting for the next cron tick. The cap is shared across slots,
  not applied separately to each slot.
- The shared 38-second invocation deadline, campaign ordering and one-minute
  configured schedule remain unchanged. No self-chaining was introduced.
- Hidden regions and campaign-wide slot values are rendered once per batch.
  Consent, authorization, event/booking/survey context and recipient-specific
  substitutions still resolve per recipient; revocable policy is not cached.
- Organization enrichment is skipped only when rendered subject/body tokens do
  not need it. Supported generic fallback tokens are included in that check.
- Aggregate batch logs report concurrency, attempts, claims, outcomes, elapsed
  time, stop reason, claim/gate time and rendering/pre-provider/provider/
  persistence time. They contain no recipient addresses or message content.
  Stage totals overlap under concurrency and must not be summed as wall time.

## Delivery boundaries

Fresh consent and campaign/group authority checks still precede submission.
Pause/cancel stops further admissions but cannot recall a provider request
already in flight. The drain awaits all started operations, including when a
different slot fails. Accepted-but-unrecorded or otherwise ambiguous sends stay
`processing` for reconciliation; they are never automatically reclaimed.

A confirmed HTTP 429 stops admissions and the remainder of that worker
invocation. The rejected recipient is recorded as failed, not reset to pending.
It needs an explicit retry; there is no new durable Retry-After scheduler.
Later invocations may attempt untouched pending recipients. An ambiguous
outcome, even with a rate-limit signal, stays processing.
Rate limits and ambiguous failures never trigger alternate-domain fallback.
Source-recipient test sends do not alter real recipient delivery state.

## Verification and rollout

218 isolated regression tests passed, covering the real worker/batch wiring,
global caps, overlapping slots/workers, cancellation/pause, deadlines,
all-started-work settlement, rate-limit stop propagation, consent and group
authority, organization tokens, rendering/sponsors, source-recipient tests and
provider acceptance/persistence ambiguity.

No real emails were sent and no production data or environment settings were
changed. No database migration is required. The change needs deployment before
it affects production; there is no additional enablement flag. Setting
concurrency to 1 restores serial scheduling and a cap of 100.

After deployment, compare like-for-like campaigns using recipient acceptance
timestamps and the new batch timings. Do not promise a fixed speedup from the
two-slot configuration. Use stop reasons to distinguish cap-bound, deadline-
bound, rate-limited and reconciliation-held work before further tuning.