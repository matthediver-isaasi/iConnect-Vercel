---
name: Gallery visibility and storage
description: Security ordering for gallery audience policies and public/private object storage.
---

Gallery visibility transitions must be owned by the server endpoint that also moves the gallery's objects. Generic entity updates must not independently flip public/private visibility.

**Why:** A public-to-private row update without a completed bucket migration leaves permanent public object URLs that bypass the gallery audience policy. Partial private-to-public moves can create the inverse mismatch.

**How to apply:** For public-to-private, finish moving every object into protected storage before making the gallery private. For private-to-public, changing the gallery to public before moving objects may temporarily withhold intended-public images but does not expose restricted content. Keep transitions resumable and fail explicitly.