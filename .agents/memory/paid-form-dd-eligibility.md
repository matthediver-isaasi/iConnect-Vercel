---
name: Paid form Due Diligence eligibility
description: Prospective-only DD rollout and safe handling of interrupted initial-stage effects.
---

Paid-form Due Diligence must remain prospective: historical submissions must not become eligible merely because a browser return, webhook, or reconciliation job revisits them.

**Why:** This rollout intentionally excludes all historical submissions. Enqueuing at finalizer entry would silently backfill old rows on provider retries.

**How to apply:** Keep eligibility tied to new checkout submissions rather than absence of a DD record. Monthly setup completion alone is too early: membership binding and checkout finalization must finish before independent DD recovery can run.

One-off readiness is also a durable prerequisite, not equivalent to `payment_status='paid'` or an overall finalized stamp.

**Why:** Entity pipelines and membership binding can finish after payment finalization. Starting DD first can permanently skip organization-dependent initial-stage actions.

**How to apply:** Mark readiness only after prerequisites fully succeed. Recover finalized-but-unready prospective rows after a quiet period under a lease; expired leases require attention rather than automatic external-effect replay.

An interrupted external action whose outcome is unknown must not be automatically replayed as if it definitely failed.

**Why:** Emails and other external effects cannot be rolled back with the database. Retrying after an uncertain acknowledgement can duplicate a completed effect.

**How to apply:** Retry confirmed query/action failures using completed-action checkpoints; keep ambiguous interrupted effects in an attention state unless provider-side evidence proves replay is safe.

Do not treat a provider SDK's HTTP-like status as proof that a send was rejected.

**Why:** Mailgun's Axios wrapper can replace a transport failure with a synthetic 400 and move the original error code into message/details. A lost response can therefore resemble an ordinary rejection even after acceptance.

**How to apply:** Preserve transport uncertainty through SDK normalization; distinguish confirmed preconnection failures from interrupted sends before deciding whether automatic replay is safe.