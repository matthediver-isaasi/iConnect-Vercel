---
name: Email design validity
description: Why visual-design recovery must validate before regenerating stored HTML.
---

Treat unrenderable persisted email designs as unavailable, preserving their stored HTML until the user explicitly replaces the content.

**Why:** The email converter can return a non-empty HTML document even when unsupported blocks or container nesting were silently omitted. Successful HTML generation alone is not evidence that the campaign content survived.

**How to apply:** Validate supported block structure at the loading boundary before giving a visual snapshot precedence over saved HTML. Do not use a current linked template to reconstruct missing historical design data without explicit replacement consent.