---
name: Commercial Event capacity
description: Capacity accounting and lock-order rules when quote allocations become named or reserved Event delegates.
---

Treat a ticket definition's capacity as a fixed maximum. True usage is confirmed booking rows plus the allocation balance that has not been named, reserved, released, or cancelled. Each named/reserved movement must be backed by exactly one matching confirmed booking row so conversion never double-counts or understates occupancy.

**Why:** A booking status change committed separately from its allocation movement creates a brief false-free-place window that can oversell. Locking the ticket before the booking in one path and the booking before the ticket in another can deadlock.

**How to apply:** Any flow that reconciles or cancels an allocated delegate must do both booking and movement changes in one database transaction. Use the canonical order: booking row, allocation row, then the shared ticket advisory lock. Never increment a ticket's fixed capacity during cancellation.