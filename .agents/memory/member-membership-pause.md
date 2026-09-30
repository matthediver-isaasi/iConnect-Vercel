---
name: Member membership pause
description: Durable invariants for the member-level pause (access + payments suspended together)
---

Pause state lives in `membership_pause*` columns on `member` (migration in supabase/migrations; every read path is 42703-tolerant so pre-migration environments treat everyone as not paused). State changes only via the shared pause helper module; the generic entity API strips pause fields on member create and update.

Invariants:
- **login_enabled is never rewritten.** Enforcement checks the pause flag separately at session resolution and every login path, so resume can never un-disable a member who was manually disabled.
- **Ordering is a safety property:** pause persists local state BEFORE pausing GoCardless (a DB failure must not leave payments paused unrecorded); resume clears local state BEFORE resuming GoCardless (a DB failure must not restart payments while access stays blocked). GC failures surface as warnings + in the member note, never silently.
- Resume uses the recorded paused-subscription ids, falling back to the member's active plans (resume of a not-paused subscription is a tolerated no-op).
- Renewal cron excludes paused members from invoicing, DD renewals and reminders; the auto-restart sweep runs hourly outside the per-tenant cron-hour gate so restart happens on the date, not at the tenant's billing hour.

**Why:** pause must suspend access + payments together without fighting the manual login toggle, and must stay consistent across DB/remote failures.
**How to apply:** any new login path or member billing path must add the paused check; never write pause columns outside the shared helper; keep the persist-before-remote ordering.
