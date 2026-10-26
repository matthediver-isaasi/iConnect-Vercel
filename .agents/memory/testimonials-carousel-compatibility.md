---
name: Testimonials carousel compatibility
description: Legacy sizing and fixed-frame compatibility policy for Testimonials.
---

Existing Testimonials carousels must retain their scroll-row sizing until an editor explicitly configures pagination. Loading or saving an unrelated setting is not permission to enable pagination or autoplay.

**Why:** The requested enhancement explicitly preserves existing designs and excludes unrelated Canvas layout-engine changes.

**How to apply:** Keep pagination opt-in for legacy content. Preserve authored fixed-height frames; make long quotes readable within the frame and reserve navigation space rather than changing other testimonial layouts or introducing general layout-engine reflow.
