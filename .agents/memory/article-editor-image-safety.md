---
name: Article editor image preservation
description: Exact-record loading and explicit image-change authority for draft editing and autosave.
---

An article edit must load the exact authorized record, and unrelated text updates must not claim ownership of its saved image.

**Why:** Opening draft previews for editing exposed a path where an empty editor image value was autosaved over the persisted image. Complete editor hydration and explicit image-change intent are independent safeguards.

**How to apply:** Fetch by ID, fail visibly on missing image metadata, wait for hydration before writing, and omit image fields from updates unless upload, removal or focal-point editing explicitly changed them. Keep the Preview Mode banner edit control without duplicating it in the preview header.
