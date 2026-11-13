---
name: Member note document privacy
description: Admin-note files must not inherit tenant-wide private-file access.
---

Member-note documents require note-level administrative access, not merely
membership of the same tenant.

**Why:** The shared private-file signing route accepts tenant-wide access;
using that storage area for CRM notes would expose a second, weaker download
path even if the Notes endpoint were protected.

**How to apply:** Keep storage access service-only and downloads behind the
member-note authority. If changing storage or introducing another download
route, check all signing paths and direct Storage policies, not just the UI.
