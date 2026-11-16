---
name: Zoom background email recovery
description: Delivery uncertainty and intentional separation of registration from confirmation emails.
---
Background Zoom registration must reconcile provider registrations before replaying a failed attempt. Confirmation emails require a separate explicit choice; do not infer it from registration.

**Why:** a worker can stop after an external provider accepted a request but before the local checkpoint was saved. Registration can be reconciled against Zoom; the confirmation-email helper has no equivalent idempotent send guarantee.

**How to apply:** persist an email claim before delivery and flag an interrupted claimed send as uncertain rather than automatically resending. Do not describe this as guaranteed exactly-once email delivery: avoiding duplicates can leave an email unsent and requiring review.
