---
name: Group campaign claim authority
description: Bind member delivery validation and scheduled-worker selections to the exact campaign generation.
---

Group-campaign delivery authorization must bind the validated campaign snapshot through the final atomic send or schedule claim, not merely check draft status.

**Why:** a second group admin can edit targeting or content between endpoint validation and the service reload. A worker can also retain a scheduled selection after another admin returns it to draft and reschedules it for the same time.

**How to apply:** carry the validated generation into the claim, fence scheduled selections by both schedule and generation, and use the claimed row for preparation. Preserve original authorship on shared edits; reject invalid saved role filters rather than converting them into whole-group audiences.