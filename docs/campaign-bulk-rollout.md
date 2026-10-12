# Campaign bulk-send rollout

Native Mailgun batch submission is default-off. Audience resolution is unchanged.

## Before enabling

1. Apply `migrations/20261012_campaign_delivery_transport.sql` to the external
   destination Supabase database used by Vercel. Do not apply to the stale local
   source database. It adds a creation-time transport pin and does not change any
   existing campaign's mode.
2. Deploy code to preview, then production after verification.
3. Set `CAMPAIGN_MAILGUN_BATCH_ENABLED=true` and redeploy the worker environment.
   This initially affects only campaigns created/copied with `is_test_mode=true`,
   not already-existing campaigns or new live campaigns.
   Preview and production share campaign data, so keep their worker settings
   consistent; a disabled worker refuses to drain a bulk-pinned campaign.
4. Create a **new no-delivery test-mode campaign** from the same content and
   audience. Do not reset or change the transport of an in-progress campaign.
   Confirm `is_test_mode=true`, `delivery_transport=mailgun_batch_v1`, and the
   provider envelope's `o:testmode=yes`.

Leave `CAMPAIGN_MAILGUN_BATCH_LIVE_ENABLED` unset/false for the benchmark.
Only after controlled-recipient validation, set that second flag to `true`
and redeploy to opt newly created live campaigns into bulk as well. Both flags
are required for live bulk. A test campaign already pinned to bulk cannot send
live merely by clearing its test flag while live bulk is disabled.
Test mode must be selected at creation for the initial benchmark: changing an
existing individual campaign to test mode does not change its transport.

## What is batched

Ordinary newsletters: at most 100 individually prepared recipients per provider
request, with recipient variables for subject, HTML, text and unsubscribe header.
Domain, sender, tracking and test-mode options must match. Payloads are bounded
to 8 MB. More than one chunk may run within a worker invocation's existing time
budget; 100 is not a per-minute throughput limit.

Group, event, survey, booking and attachment campaigns retain individual
sending. Incompatible prepared envelopes also use freshly gated individual
sending, **only when no bulk provider request has been made**.

## Safety and validation

Consent and bounce eligibility are checked again after preparation. A fresh
campaign gate runs before submission. Every recipient is conditionally owned
before any provider call. Timeouts, server errors, and accepted-but-unpersisted
batches remain processing for reconciliation, never automatically retried.
429 responses are recorded as failures and stop invocation-wide sending.

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

Pause any bulk test/campaign first. Set the flag false (or remove it) and redeploy.
Bulk-pinned campaigns then remain blocked rather than silently changing modes;
ordinary existing campaigns continue individually. Do not reset processing rows
or use individual fallback for uncertain batches. Keep the additive migration;
it is safe with the flag off. Do not resume bulk campaigns on an older worker
which does not understand this pin.
