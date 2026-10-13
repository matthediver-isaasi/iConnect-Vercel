---
name: Event display timezone policy
description: Additional audience timezones are display preferences, never scheduling authority.
---
Additional tenant event timezones are display-only. Keep the event's own timezone first, and never use a display label to infer an offset.

**Why:** The owner explicitly confirmed that audience display preferences must not change event setup timezone, stored dates, agenda grouping, deadlines, provider schedules or calendar exports.

**How to apply:** Convert existing instants only; preserve date-only agenda values and the existing DST ambiguity policy. Emails, tickets and standalone embeds are separate scope.

Public host routing is not authenticated workspace authority.

**Why:** On the shared admin host, login and workspace selection can change the active tenant without changing the public client's captured slug. Public-only discovery can therefore show no preferences or another tenant's preferences.

**How to apply:** Scope authenticated discovery to active workspace/member identity and react to switches; reserve public slug discovery for guest views.
