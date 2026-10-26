---
name: Canvas audit realms
description: Browser-realm authority and readiness requirements for rendered Canvas audits.
---
Create and invoke axe in the preview realm, never pass a foreign document to the editor's axe instance.

**Why:** Axe can discard a foreign-realm node context and silently audit its own document, producing plausible editor violations labelled as public/member findings.

**How to apply:** Bind results to the authorized preview's document and readiness runner identity before and after scanning. Missing block mappings do not establish document-wide scope. Keep browser regression tests with conflicting parent/iframe selectors.
