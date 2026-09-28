# Delivery finalization must match runtime column grants

Claim-time delivery provenance and fingerprints are immutable. When transport
finalization adds new audit content, do not update initial provenance or widen
table UPDATE privileges. Add a dedicated final-output column with a narrow
service_role column grant (or use a narrowly scoped finalization RPC).

Task 4813's handler initially included provenance in its post-provider UPDATE,
but the applied audit migration only granted status/provider_message_id/error/
updated_at updates. The email could be accepted while finalization failed and
left a durable pending fence. A permissive REST mock missed the defect.

For delivery changes, test the complete successful finalization UPDATE under
SET ROLE service_role against disposable PostgreSQL, including new columns,
WHERE guards and RETURNING fields. Superuser migration tests and RLS bypass
alone do not establish column permissions. Also assert initial provenance and
fingerprints cannot be changed and keep mocks aligned with the real ACLs.