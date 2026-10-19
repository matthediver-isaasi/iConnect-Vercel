# Campaign bulk-send rollout

Native Mailgun batch submission is automatic for compatible live and test
campaigns at first send. There is no campaign opt-in setting. Audience resolution
is unchanged. The old `CAMPAIGN_MAILGUN_BATCH_ENABLED` and
`CAMPAIGN_MAILGUN_BATCH_LIVE_ENABLED` flags are no longer consulted.

## Deployment

### Investigation and application evidence — 19 October 2026

Vercel project environment metadata contained the general batch flag for
production but no live batch flag. Under the previous policy this enabled test
batching without opting live campaigns in. This is current configuration
evidence, not a historical environment snapshot at campaign creation.
The 19 October Fast Track campaign was stored as individual; its current
content passes the batch compatibility predicate.

The first-send migration below was applied to DEST on 19 October with the
active campaign's before/after record verified unchanged. SOURCE was untouched.
The code still requires deployment; changing the database alone does not enable
the new selection path. No messages were submitted during this change.
Validation: 195 focused campaign tests and two isolated PostgreSQL integration
tests passed, including concurrent first-send claims and immutable active sends.

1. Apply `migrations/20261012_campaign_delivery_transport.sql` to the external
   destination Supabase database used by Vercel. Do not apply to the stale local
   source database. Then apply the additive
   `migrations/20261017_campaign_transport_first_send.sql` (requires the existing
   campaign preparation migration). It replaces the immutable-at-creation trigger
   with a guarded one-time first-preparation pin and adds a service-role-only RPC
   overload. It does not rewrite any campaigns or recipients.
2. Deploy code to preview, then production after verification. Deploy the migration
   first; new code fails explicitly rather than falling back if the RPC is absent.
3. Existing untouched drafts and scheduled campaigns select their compatible
   transport atomically with the first preparation claim, even if their old
   transport was individual. New and copied campaigns also select at first send,
   not creation. Transport and pin fields cannot be supplied through campaign CRUD.
4. Create a **new no-delivery test-mode campaign** from the same content and
   audience. Do not reset or change the transport of an in-progress campaign.
   Confirm `is_test_mode=true`, then after first send confirm
   `delivery_transport=mailgun_batch_v1`, `delivery_transport_pinned_at`, and the
   provider envelope's `o:testmode=yes`.

Preparing, sending, paused, completed and previously prepared campaigns never
reselect transport. Any residual recipient rows, including pending, processing,
uncertain or sent, block a fresh selection and require reconciliation. Competing
claims are serialized under the campaign row lock; transport, preparation generation
and its snapshot commit together or all roll back. Older seven-argument claims
remain compatible and pin their existing transport.

## What is batched

Ordinary newsletters: at most 100 individually prepared recipients per provider
request, with recipient variables for subject, HTML, text and unsubscribe header.
Domain, sender, tracking and test-mode options must match. Payloads are bounded
to 8 MB. More than one chunk may run within a worker invocation's existing time
budget; 100 is not a per-minute throughput limit.

Group, event, survey, booking and attachment campaigns retain individual
sending. Incompatible prepared envelopes also use freshly gated individual
sending, **only when no bulk provider request has been made**.
Tokenised survey links (in subject, HTML or design JSON), event survey contexts,
booking/event authority tokens, password-setup tokens and event QR blocks remain
excluded. Plain prose mentioning surveys is not a token and does not opt out.
These exclusions preserve recipient-specific entitlement, credential and booking
authority; this change does not attempt to batch those paths.

## Safety and validation

Consent and bounce eligibility are checked again after preparation. A fresh
campaign gate runs before submission. Every recipient is conditionally owned
before any provider call. Timeouts, server errors, and accepted-but-unpersisted
batches remain processing for reconciliation, never automatically retried.
429 responses are recorded as failures and stop invocation-wide sending.

Bulk preparation does not repeat per-recipient consent/bounce queries. The
final check uses bounded set queries for the whole chunk, including case-insensitive
unsubscribe matching and preparation provenance. For 100 category-subscribed
members this takes at most nine parallel reads, rather than hundreds of serial
per-recipient reads. Missing/failed/incomplete evidence still prevents submission.
The final campaign pause/cancel gate remains in place. Individual-message and
incompatible-envelope fallback paths retain their existing checks.

Worker aggregate logs include `bulkEligibilityMs` and
`bulkEligibilityRecipients` so the deployed overhead can be measured separately.
Realistic-latency tests must prove forward progress within the final time budget.

Before submission, the worker selects the largest recipient prefix whose
**actual encoded envelope** fits the 8 MB application limit. This includes
UTF-8 bytes, JSON escaping, recipient variables and shared message fields.
Overflow recipients return to pending before any provider request, retaining
the prepared audience; the next drain checks them afresh. Oversized multi-recipient
envelopes no longer cause individual-send fallback.

The final pause/cancel/deadline gate runs after sizing and releasing overflow.
Only the submitted subset remains processing on an ambiguous provider result
or an accepted-but-unpersisted response. A single message exceeding the bulk
limit, or a genuinely incompatible envelope, retains the individual fallback.
Logs include `bulkSizingMs`, `bulkSelectedRecipients` and `bulkDeferredRecipients`.

Bulk provider events carry `iconn_campaign_id`; the signed webhook resolves
campaign plus recipient email, not a shared batch message ID alone. Historical
event sync separates shared IDs by recipient and ignores another campaign's tag.

Local tests prove payload construction and worker state handling, not Mailgun's
actual rendering or delivery. Before live use, controlled-recipient delivery
must verify isolated To headers, rendered HTML/subject, personalised tracking
and preference links, one-click unsubscribe header expansion, provider event
correlation, and the final inbox rendering. No-delivery mode measures acceptance
speed but cannot establish those received-message properties.

Compare submissions per minute **after preparation completes**, using fresh
counter deltas. No particular speed target is guaranteed until measured.

## Back out

Pause affected campaigns before backing out. Legacy environment flags do not
disable this policy. Do not change pinned transports, reset processing rows or
use individual fallback for uncertain batches. Keep the additive migrations.
Do not resume bulk campaigns on an older worker which does not understand the
pin; older flag-gated workers require their original flags to drain bulk sends.
