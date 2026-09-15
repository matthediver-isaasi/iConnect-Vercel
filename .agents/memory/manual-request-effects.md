---
name: Manual request effects
description: Avoid self-cancelling asynchronous React effects when toggling loading state.
---

Do not include an effect's own loading indicator in the dependency list when its cleanup cancels or ignores the pending response.

**Why:** Setting loading immediately retriggers cleanup, so a successful HTTP response can be ignored forever while the UI stays loading. Pure formatting and static render tests do not catch this.

**How to apply:** Depend on request identity and navigation state, not self-written loading state. Verify an actual expand → request → response → rendered details interaction.