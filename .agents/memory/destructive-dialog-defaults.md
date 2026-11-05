---
name: Destructive dialog defaults
description: Preserve explicit safety decisions across background preview refreshes.
---

Initialize disposal defaults only when the operation's member pair or direction changes, never merely because its preview becomes ready again.

**Why:** React Query reconnect refreshes can transition readiness from true to false to true while a confirmation screen is open. Reapplying defaults at that point can silently replace “Leave untouched” with deletion or anonymisation.

**How to apply:** Keep initialization identity separate from request readiness. Test a same-direction refetch on the final review and assert both the visible preservation choice and the execute payload, for same-organisation and different-organisation pairs.
