---
name: Supabase public Storage missing-object responses
description: How to distinguish an absent public Storage object from other HTTP 400 failures.
---

Supabase public Storage may return HTTP 400 for a missing object while the JSON
body reports `statusCode: "404"`, `error: "not_found"`, and `code:
"NoSuchKey"`. Do not assume only an HTTP 404 means the object is absent.

**Why:** An idempotent immutable-upload workflow stopped before upload because
its existence probe treated this documented-in-body miss as a generic bad
request. Broadly accepting every HTTP 400 as missing would hide real request
errors, so the body fields matter.

**How to apply:** For public-object existence probes, accept HTTP 404 directly
or HTTP 400 only when the parsed response body explicitly identifies the
404/not_found/NoSuchKey combination. Fail closed for every other 400 response.