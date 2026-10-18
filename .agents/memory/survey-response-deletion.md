---
name: Survey response deletion policy
description: Survey responses are deletable and must be removed from survey statistics; invitation completion is separate.
---

Survey responses must be deletable by submission managers and removed from survey statistics.

**Why:** The user explicitly changed the previous blanket survey-response deletion restriction.

**How to apply:** Remove the response and normalized answers atomically, update event survey counters, and refresh cached reports. Do not confuse deletion of a response with deletion of the survey definition or editing its published snapshot.

Retain historical invitation completion when deleting answers.

**Why:** Deleting a response should not silently reopen a completed invitation or undo a certificate workflow. Anonymous completion deliberately has no response-to-person link.

**How to apply:** Treat completion as historical evidence, not a source for survey statistics. A retained private response UUID may refer to a deleted response; do not assume it still resolves.
