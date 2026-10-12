---
name: PostgreSQL extension resolution
description: Production pgcrypto lives in extensions, outside restricted RPC search paths.
---
In the destination database, pgcrypto's digest functions live in the extensions schema. A SECURITY DEFINER function restricted to public, pg_temp cannot resolve an unqualified digest call.

**Why:** The public quote rate limiter failed before quote lookup; a read-only reproduction with the same search path returned undefined-function error 42883.

**How to apply:** Qualify extension functions explicitly, retaining restricted search paths and service-only grants. Test RPC execution with production-equivalent extension placement, not just successful migration installation.
