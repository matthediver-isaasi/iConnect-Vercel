---
name: PostgREST large IN filters
description: Why verification reads with hundreds of UUIDs must be batched.
---

Batch PostgREST `.in()` filters when the value set contains hundreds of UUIDs, including post-write verification and relationship reloads.

**Why:** A large UUID list can exceed practical request or proxy limits and surface only as `TypeError: fetch failed`, even while smaller reads and the database itself remain healthy.

**How to apply:** Split IDs into small deterministic batches, paginate each batch with a stable unique order, and combine the results before comparison. Do not interpret this fetch failure as a database outage or blindly replay writes.