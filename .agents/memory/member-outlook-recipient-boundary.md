---
name: Direct member correspondence policy
description: Intentional CC and login-disabled contact semantics for direct member correspondence.
---

Keep intentional CC supported on direct member correspondence; do not reuse campaign audience rules or treat disabling a contact's login as deletion. CRM composition must use tenant-aware Mailgun, not the administrator's Outlook mailbox; the separate Outlook synchronization integration remains independent.

**Why:** The user explicitly requires Mailgun for CRM composition. Direct correspondence is an admin-selected member plus sender-entered copies, not a campaign. Login permission does not determine whether an administrator may contact a legitimate record or inspect its correspondence. Anonymized deletion is a separate boundary.

**How to apply:** Preserve the member-pinned To and explicit CC contract when changing this flow. Keep provider acceptance distinct from delivery and from successful local history logging; a history failure must not invite a duplicate send.

Rendered email content must be opt-in, not added to shared delivery return values by default.

**Why:** Existing callers may serialize complete delivery results to logs; expanding that contract can expose personalized content and bearer links without changing those callers.

**How to apply:** Keep general delivery results metadata-only, request rendered content only where correspondence persistence needs it, and allowlist fields at logging boundaries.