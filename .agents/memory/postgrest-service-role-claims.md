---
name: PostgREST service role claims
description: SECURITY DEFINER authorization must support modern JSON role claims, not only deprecated individual settings.
---

Use the database's canonical `auth.role()` for API-caller role checks inside SECURITY DEFINER functions, while retaining restrictive execution grants.

**Why:** Modern PostgREST supplies `request.jwt.claims` JSON; checking only `request.jwt.claim.role` rejects valid service calls. Inside SECURITY DEFINER, `current_user` identifies the function owner rather than the API caller.

**How to apply:** Execution-test modern JSON claims, legacy individual claims, and forbidden caller roles. A SQL test that manually sets only the old claim format can pass while every real API request fails. Resolve RETURNS TABLE name collisions explicitly with qualified names or named constraints, not a global variable-conflict setting.
