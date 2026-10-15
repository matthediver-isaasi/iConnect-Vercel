---
name: Serverless payment handler loading
description: Traceable handler imports and safe ordering before renewal reservation fences.
---

Use literal import paths for serverless payment dispatch, and load the selected handler before reserving the renewal or claiming provider work.

**Why:** A variable-path import worked locally but Vercel omitted the Direct Debit handler. The resulting module-not-found error left a provider-work fence despite no provider setup having started.

**How to apply:** Test all dispatch branches and import-failure ordering. Never broadly clear fences on handler errors: once the handler starts, provider outcomes may be uncertain. Existing stranded reservations require specific failure evidence and owner-scoped checks, not age-based resets.
