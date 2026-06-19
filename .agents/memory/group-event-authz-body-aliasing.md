---
name: Group-event authz body aliasing in entity PATCH
description: Why tenant-admin event saves 404'd — authorizeGroupAdminEventWrite returns the same body object it was given.
---
The generic entity PATCH handler runs event-family writes through
`authorizeGroupAdminEventWrite`. For TENANT ADMINS that function returns the
**same object reference** it was handed (`return { ok: true, body }`), whereas
for non-admin group admins it returns a fresh copy (`out = { ...body }`).

The PATCH handler then did `for (k of keys) delete sanitizedBody[k];
Object.assign(sanitizedBody, authz.body)`. When `authz.body === sanitizedBody`
(admin path), the delete loop empties BOTH, so the reassign copies nothing and
the update payload becomes `{}`. An empty Supabase `.update({})` matches zero
rows, returns PGRST116, which the handler maps to a clean 404 with no
`console.error` — invisible in Vercel logs.

The CREATE handler does `Object.assign(sanitizedBody, authz.body)` WITHOUT the
delete loop, so admin self-assign is a harmless no-op — that's why creating an
event always worked but editing one 404'd.

**Why:** authz helpers that mutate-or-passthrough must be alias-safe at the call
site. Don't clear-then-merge unless you know the source is a distinct object.
**How to apply:** the fix guards `if (guardedBody !== sanitizedBody)` before
clearing. Any similar guardrail helper that returns the input body on the
pass-through path needs the same guard. Also: every early/silent 404 in the
generic entity API should log entity+id+resolved tenant context or it's
untraceable in production.
