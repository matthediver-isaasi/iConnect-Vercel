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

Private form uploads follow the same boundary: permission to upload an answer
does not imply permission to read the private file back without a session.
Form rendering must not probe that access automatically. Explicit file access
can use the protected endpoint in a separate tab, leaving the draft intact.

**Why:** A private-file 401 during repeated-row rendering can activate global
session rejection even though a guest's upload was permitted. Making the file
public or suppressing genuine session invalidation is not a safe fix.

Typography rendering follows the same rule: a public renderer must not use an
editor-only entity lookup or its cached private results.

**Why:** A typography 401 caused repeated page resets on a live page, making an
unrelated directory carousel repeatedly restart its requests.

**How to apply:** Keep public, tenant/microsite-scoped style reads separate from
authoring selectors. Test public renderers alongside the carousel, not only in
an isolated carousel fixture.
