---
name: Canvas widget discovery sharing
description: Separate shared metadata discovery from instance-specific card result state.
---

Canvas metadata discovery should deduplicate concurrent requests within an
authenticated tenant/member/role context, while card result and explicit-refresh
state remain instance-specific. Wait for resolved, validated authentication.

**Why:** A live board-report capture showed repeated full-list and definition
requests taking over a minute before cached-result requests could start.
Instance isolation for interactive card state must not force every copy of a
saved widget to rediscover the entire catalogue.

**How to apply:** Preserve auth-scoped keys, server authorization, list/detail
eligibility checks, cancellation and unused metadata eviction. Do not cancel
a shared request just because one of several observing blocks unmounts.
Do not equate fewer local requests with verified production latency.