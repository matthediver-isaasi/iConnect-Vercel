# Member-content reindex operation authority

Reindex ownership is a security boundary: keep operation state in a dedicated
service-role-only table and make its SECURITY DEFINER claim/renew/complete
RPCs service-role-only. Never use browser-writable shared settings as worker
authority; missing worker authorization must fail closed.

Knowledge publication changes must preserve the deployed generation repair
protocol rather than replay foundational index migrations.

**Why:** The repaired writer and protected-knowledge publisher have different
content contracts. Replaying older index setup can undo the repaired schema,
while substituting the authored-only adapter drops protected content.

**How to apply:** Make additive changes against the current destination contract.
Verify publication through the real REST client as well as SQL: PostgREST
safe-update behavior has failed where direct SQL probes passed. Use isolated,
cleaned-up fixtures with no provider calls for that compatibility check.

Large-page indexing must checkpoint embeddings privately and publish only a
complete freshly validated source. A per-slice allowance is not a page-size cap.

**Why:** A 284-chunk page could never fit the 100-chunk maximum and blocked the
People/Board page behind it. Retrying an unchanged allowance made no progress.

**How to apply:** Reuse only exact input-hash/model matches under fresh generation
claims. Manual per-slice continuation requires durable progress; scheduled chains
retain their total allowance. Renew active checkpoint expiry so multi-day cron
progress is not discarded before it can finish.

Verify large-source completion against the real database publisher, not only
the batching adapter and its mocks.

**Why:** Batching tests passed while the deployed atomic publisher still rejected
more than 100 rows. That independent guard prevented any large page publication.

**How to apply:** Retain explicit row/byte bounds and verify full publication,
stale rejection and rollback using isolated transactional fixtures before rollout.

Dependency invalidation must distinguish operational updates from source or
access changes. Narrow by renderer presence, not only previously indexed
dependencies; unknown fields and renderer types must remain fail-closed.

**Why:** Broad dependency updates repeatedly invalidated every GFI iEdit page,
including successfully rebuilt Board content. Saved dependencies alone miss
newly eligible automatic-list entries.

**How to apply:** Audit changed fields against extraction and visibility inputs.
Keep both old/new identities and insert/delete coverage. Recover unchanged
content through the normal fresh-claim publisher with a zero-embedding budget,
never by reactivating old generations directly. Stale claims are deferred work,
not permission to replenish a scheduled embedding allowance.