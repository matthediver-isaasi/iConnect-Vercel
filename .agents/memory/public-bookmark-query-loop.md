---
name: Public bookmark query loops
description: Why public card interactions can disappear when guest bookmark reads trigger session rejection.
---

Treat member-only reads mounted inside public cards as session-gated work,
even if their buttons are normally hidden elsewhere.

**Why:** Guest bookmark 401s triggered session rejection and shared query-cache
clearing repeatedly, replacing an unrelated Event Carousel with its loading
skeleton. The apparent slide-painting failure was a cross-component reload loop.

**How to apply:** When public content disappears on interaction, inspect
unauthorized request repetition and root replacement before changing clipping
or image rendering. Include neighboring public cards and guest auth in fixtures;
authenticated carousel-only fixtures cannot reproduce this failure.
