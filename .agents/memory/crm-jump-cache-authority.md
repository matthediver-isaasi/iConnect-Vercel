---
name: CRM jump cache authority
description: Why an exact-ID jump still needs to revalidate a cached target page
---

Revalidate a previously visited target page before focusing a record, even if
the query cache considers it fresh. Do not invalidate alphabet metadata simply
because a user jumps or changes pages.

**Why:** Browser testing with reversed responses showed that an earlier request
can populate a page cache after its jump intent is cancelled. A later jump
then focuses a stale record without observing a concurrent deletion. An exact
record ID prevents substitution, but does not prove the cached record remains
in the authorized filtered result.

**How to apply:** Refresh only the exact target-page query, fence completion
with the latest intent, and focus only after the matching response renders.
Keep metadata invalidation tied to record/filter authority, not pagination.
