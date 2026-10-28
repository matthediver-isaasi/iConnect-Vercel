---
name: Editor post-save freshness
description: Prevent stale query caches from clearing newly saved fields.
---
After saving an editor, keep its form loaded until the authoritative refresh completes. Do not reset its loaded identity while the old query result remains available.

**Why:** Resetting the identity re-hydrated a quote from the old cached draft before the network response arrived, blanking manually entered billing addresses and then ignoring the fresh response.

**How to apply:** Await a successful refresh before adopting server values. Preserve the submitted form on refresh failure and preserve newer edits made during the request. Distinguish a successful save followed by a failed reload from a failed save.

On return visits, cached query data is not authoritative initial-load evidence.
Draft protection must not freeze a cached snapshot before the mount's fetch
finishes. Keep subsequent server-read baselines separate from preserved drafts.

**Why:** Otherwise a local equality check can report “saved” without writing,
even after a refetch shows that the persisted value differs. Initial-load locking
and dirty-draft preservation are separate requirements.

**How to apply:** Require a successful fetch after mount before enabling edits;
update the persistence baseline on authoritative refetches without replacing
drafts, and fence reads started before a write acknowledgement.

Legacy editors need a raw persisted snapshot separate from a hydrated,
save-normalized baseline. Compare user edits against the latter, then omit
unchanged authority/configuration keys from PATCH requests.

**Why:** Editor defaults, generated IDs and shape migrations can falsely look
like security-sensitive edits; round-tripping raw unchanged keys can also invoke
server normalizers or overwrite newer authority from another tab.

**How to apply:** Use identical normalization at capture and save, retain one
baseline per editor identity, and advance it using the submitted snapshot and
server acknowledgement rather than whatever edits are currently on screen.
