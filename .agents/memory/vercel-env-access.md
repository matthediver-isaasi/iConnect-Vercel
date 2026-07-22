---
name: Vercel env access from workspace
description: Whether production Vercel env vars can be managed from this Replit workspace
---

The workspace has a `VERCEL_API_TOKEN` secret, but it is **invalid** — every Vercel API call returns 403 `invalidToken` (checked July 2026). Production Vercel env vars therefore cannot be set from here; changes like adding `CRON_SECRET` must be done by the user in the Vercel dashboard (Settings → Environment Variables), followed by a redeploy.

**Why:** As of July 2026, `CRON_SECRET` was NOT set in production, so all `/api/cron/*` endpoints were publicly callable (the guard is `if (cronSecret && ...)` — it fails open when unset).

**How to apply:** If a task needs a prod Vercel env change, verify the token first with `GET /v2/user`; if 403, hand the user dashboard instructions instead of retrying. Vercel sends `Authorization: Bearer <CRON_SECRET>` on scheduled cron runs automatically once set.
