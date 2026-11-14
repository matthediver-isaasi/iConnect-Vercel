---
name: PostgREST domain conflicts
description: Avoid treating optimistic concurrency failures as retryable database serialization failures.
---
Use `PT409` for application-level optimistic version or evidence conflicts in PostgREST-facing RPCs. Reserve `40001` for genuinely retryable database serialization failures.

**Why:** Native PostgREST integration testing showed that a permanently stale outcome revision raised as `40001` was retried continuously, consuming database work instead of returning to the caller. The same request returned promptly as HTTP 409 after changing it to `PT409`.

**How to apply:** New awards/assessment commands must raise `PT409` directly. API adapters should map it to HTTP 409 (and may retain legacy `40001` handling). Test a stale write through actual PostgREST, not just direct PostgreSQL or a mocked client. The migration converting existing awards commands is explicitly allowlisted; it does not protect future functions automatically.
