---
name: Editor post-save freshness
description: Prevent stale query caches from clearing newly saved fields.
---
After saving an editor, keep its form loaded until the authoritative refresh completes. Do not reset its loaded identity while the old query result remains available.

**Why:** Resetting the identity re-hydrated a quote from the old cached draft before the network response arrived, blanking manually entered billing addresses and then ignoring the fresh response.

**How to apply:** Await a successful refresh before adopting server values. Preserve the submitted form on refresh failure and preserve newer edits made during the request. Distinguish a successful save followed by a failed reload from a failed save.
