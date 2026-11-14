---
name: Member balances display policy
description: Scope of the tenant-controlled Balances tab on member records.
---

The member-record Balances preference is display-only, shared across standalone and embedded record views. It is not permission to hide the portal Balances page or change financial/API authorization, saved balances, or engagement reporting.

**Why:** The owner explicitly limited the request to record-tab visibility and prohibited automatically changing GFI's saved preference.

**How to apply:** Preserve legacy visibility only after a successful settings read confirms the preference is absent; pending and failed reads must not expose the tab.
