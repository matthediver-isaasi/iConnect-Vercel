---
name: Member Outlook recipient policy
description: Intentional CC and login-disabled contact semantics for direct member correspondence.
---

Keep intentional CC supported on direct member Outlook correspondence; do not reuse campaign audience rules or treat disabling a contact's login as deletion.

**Why:** Direct correspondence is an admin-selected member plus sender-entered copies, not a campaign. Login permission does not determine whether an administrator may contact a legitimate record or inspect its correspondence. Anonymized deletion is a separate boundary.

**How to apply:** Preserve the member-pinned To and explicit CC contract when changing this flow. Keep provider acceptance distinct from delivery and from successful local history logging; a history failure must not invite a duplicate send.