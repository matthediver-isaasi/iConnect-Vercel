---
name: WordPress option leases
description: Concurrency rules for using wp_options as an expiring cross-request lease.
---

An expiring WordPress option lock must use the option table's unique key for
initial acquisition, an exact-value database compare-and-swap for expiry
takeover and renewal, and an exact-value compare-and-delete for release. Renew
between long phases and immediately before protected writes; stop work if
ownership is lost.

**Why:** A `get_option` → `delete_option` → `add_option` takeover can delete a
new owner's lock between the read and delete. A read-then-unconditional release
has the same race, and a fixed TTL without renewal lets a long-running old owner
write concurrently with its replacement.

**How to apply:** Use a random ownership token in the serialized option value.
Compare the exact raw serialized value in SQL updates/deletes, clear the option
cache after successful CAS operations, heartbeat the lease during work, and
test expiry takeover plus stale-owner release races.