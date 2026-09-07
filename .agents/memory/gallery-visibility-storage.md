---
name: Gallery visibility and storage
description: Security ordering for gallery audience policies and public/private object storage.
---

Gallery visibility transitions must be owned by the server endpoint that also moves the gallery's objects. Generic entity updates must not independently flip public/private visibility.

**Why:** A public-to-private row update without a completed bucket migration leaves permanent public object URLs that bypass the gallery audience policy. Partial private-to-public moves can create the inverse mismatch.

**How to apply:** For public-to-private, finish moving every object into protected storage before making the gallery private. For private-to-public, changing the gallery to public before moving objects may temporarily withhold intended-public images but does not expose restricted content. Keep transitions resumable and fail explicitly.

Directory/list authorization must treat `is_public` as a separate outer boundary from `access_policy`. A null policy means unrestricted only for an already authenticated viewer of a private gallery; it must never make `is_public = false` rows visible to guests.

**Why:** The shared policy evaluator correctly treats a null policy as unrestricted, but using that result without the private-gallery authentication gate exposed private gallery metadata to anonymous directory requests.

**How to apply:** Public rows may be listed for guests. For every non-public row, require authenticated context first, then apply its audience policy or manager bypass. Keep this gate at each listing endpoint even when policy evaluation is shared or batched.