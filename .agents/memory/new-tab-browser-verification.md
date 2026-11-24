---
name: New-tab browser verification
description: Verify native protected links, including modified and middle-click background tabs.
---

Observe new tabs at the browser-context level, then wait for the expected URL before checking document readiness.

**Why:** Native protected background tabs did not consistently emit the original page's popup event. The context's page event arrived earlier, while the new tab still showed `about:blank`; its initial `domcontentloaded` state was not evidence that the destination had committed.

**How to apply:** Register the context page-event wait before activation, await the expected destination URL, then check readiness, null `window.opener`, tab count, and unchanged original listing state. Retain native browser navigation rather than replacing it with scripted tab creation to satisfy a test harness.
