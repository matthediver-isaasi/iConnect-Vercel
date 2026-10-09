---
name: Serverless catch-all routing
description: Request URL coverage prevents development-only catch-all assumptions.
---

Test catch-all API handlers with a real request URL and no injected route-query parameters, as well as the local adapter's parameter shape.

**Why:** The local adapter injects catch-all parameters; tests using only that shape missed the Sales settings failure where configuration was treated as an invoice request without a sale ID.

**How to apply:** Resolve the actual endpoint pathname when available, keep query-only compatibility where required, and ensure caller-supplied query strings cannot override the URL's operation. Verify read/write routing and unchanged permission gates.
