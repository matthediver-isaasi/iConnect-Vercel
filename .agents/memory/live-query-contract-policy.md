---
name: Live query contract decisions
description: Avoid schema additions for resource routes and parent event capability probes.
---
Resource slug-shaped routes are not authority to invent saved slugs or derive
them from titles. Return not found when no persisted slug contract exists.

**Why:** Live-error repair must preserve existing ID links rather than invent
route identities that can collide or change with titles.

**How to apply:** Compare callers with the production catalog and migration
contract before introducing new routing columns.

Teams meeting fields on event/session/agenda records do not prove that the
Teams binding migration is installed.

**Why:** Production may have editor meeting fields without attendance binding
and provider-identity storage. The parent complex event owns policy, not a meeting.

**How to apply:** Keep capability checks fail-closed on binding readiness and
check meeting-owning tables, never add parent meeting columns to silence a probe.
