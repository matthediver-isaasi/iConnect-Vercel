---
name: Storage object absence
description: Supabase SDK info errors can omit the REST object-not-found code.
---

An authenticated Storage `info()` request can return HTTP 400 with embedded `statusCode: "404"` and `message: "Object not found"` while the SDK drops the REST `NoSuchKey` code.

**Why:** Production deletion succeeded, but code-only absence verification initially failed because the installed SDK omitted that field. Public REST responses retained the code.

**How to apply:** Confirm object-specific absence using the embedded status and exact message together, or the explicit `NoSuchKey` code. Never treat arbitrary 400/404 responses, bucket errors, or permission failures as proof of absence. Check the original public URL separately from authenticated origin metadata.