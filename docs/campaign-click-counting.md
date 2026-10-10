# Campaign click metrics

## Counting contract

- **Total tracked clicks:** retained iConnect GET requests, including repeat
  requests, with a verified recipient/campaign relationship.
- **Unique recipients clicked:** campaign-recipient records with at least one
  counted request, not distinct people across campaigns.
- Mailgun `clicked` events remain provider evidence, never an additional click.
  The database deduplicates new provider-click replays from webhook and sync by
  event ID, message ID and recipient email. With no event ID, identical payloads
  are retained once. Historical duplicate evidence is not deleted.
- Scanners, previews, forwarded links and automation may generate requests.
  Neither metric is an exact count of human interactions.

The link-evidence insert and recipient/campaign increment commit or roll back
together. Concurrent requests serialize on the recipient row. Stale direct
recipient updates cannot replace the authoritative click count or timestamp.
Terminal unsubscribe, complaint and bounce states are not cleared by a click.
The redirect still works if tracking fails; failures are logged, so recorded
requests are not a guarantee of complete traffic capture.

## Historical reconciliation and rollout

`supabase/migrations/20261211_campaign_click_authority.sql` preserves the original
mixed counters and first-click timestamps in recipient legacy fields. It rebuilds
the active counters from retained iConnect evidence, not estimates or division
of the old total. Missing evidence cannot be reconstructed. Provider-only
historical observations remain in `email_event` and legacy fields but are not
included in the iConnect metric. Mismatched historical token relationships stay
in the raw link table but are excluded from the counted-link view.

The migration was applied to verified external DEST (`lvmzliemqnieeoruhkik`),
using `scripts/apply-campaign-click-authority.mjs`. SOURCE was untouched.
Verification confirmed recipient/campaign counts, private view/write grants,
and preservation of all 247,613 raw link rows and 189,249 provider-click rows.
The initial timed-out attempt rolled back; the applied version uses grouped
reconciliation. No feature migration remains pending. Deploy the matching
application code; this change does not itself publish that code.

Offline review: `node scripts/apply-campaign-click-authority.mjs`.
Read-only inspection: append `--inspect`. Applying requires `--apply` and the
exact `--review-sha256=...` printed by the offline review.

## Verification

`node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/track/click.test.mjs scripts/campaign-click-authority.postgres.test.mjs`

Tests use disposable PostgreSQL and stubbed API dependencies, not live sends.
They cover concurrent initial/repeat clicks, webhook/sync evidence replay,
missing event IDs, preservation of historical rows, mismatched campaigns,
rollback, stale writes, terminal status and failed evidence persistence.
Relative links rewritten by the campaign composer are tested through the actual
redirect handler, including preservation of already-encoded query values.
The component bundle is checked separately. The signed-in campaign UI has not
been verified in a live tenant session.
