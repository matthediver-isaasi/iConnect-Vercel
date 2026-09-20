---
name: Browser fixture route contracts
description: Avoid browser fixtures that hide use of the wrong persistence or processing endpoint.
---

For modal-close assertions, scope the dialog by its accessible name rather than counting every dialog on the page.

**Why:** The cookie-consent dialog can become visible to accessibility queries after an application modal closes, making a successful close look like a persistent application modal.

**How to apply:** Keep consent UI intact; assert disappearance of the named application dialog rather than changing animation behavior to fix an unrelated locator failure.

Browser fixtures must enforce the exact submission route, not merely fabricate the expected success payload for any write.

**Why:** A generic entity-create route can save a submission without running its specialized domain transaction. Returning a fabricated commit marker from that route made a real UI test pass despite no domain update occurring.

**How to apply:** Fail unexpected mutation routes, assert the actual URL and payload, and test missing commit evidence separately from HTTP success. Keep real handler and transaction tests alongside transport-fixture browser tests.