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