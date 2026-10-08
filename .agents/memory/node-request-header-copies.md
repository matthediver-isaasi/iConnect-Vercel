---
name: Node request header copies
description: Production request getters differ from plain-object endpoint test fixtures.
---

Preserve headers explicitly when making a restricted request for tenant resolution; do not rely on object spread.

**Why:** Node IncomingMessage exposes headers through an inherited getter. Plain-object tests preserved them, but production request copying dropped them and valid confidential form links returned a generic unavailable response.

**How to apply:** Use a minimal object with explicit headers and cleared query/body overrides. Include a real IncomingMessage fixture for security-sensitive request adaptation tests.
