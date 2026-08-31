---
name: Deactivating referenced workflow states
description: Concurrency rule for safely disabling pipeline or workflow states that live records may enter.
---

When a configurable workflow state can be deactivated while records are assigned
to it, assignment and deactivation must contend on the same database row lock.
A read-then-check for references is not sufficient, even inside a trigger.

**Why:** Under `READ COMMITTED`, assignment can validate an active state while a
concurrent deactivation sees no committed reference. Both transactions can then
commit, leaving a live record assigned to an inactive state.

**How to apply:** Maintain a transactional reference count (or equivalent locked
invariant) on the state row. Assignment increments the active destination row;
movement increments the destination before decrementing the source; deactivation
rejects a locked nonzero count. Test both winning transaction orders.