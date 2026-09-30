---
name: Canvas page external-screenshot artifact
description: External URL screenshots of script-provisioned canvas pages show footer overlapping mid-page; it's a capture-timing artifact, verify against a same-pipeline known-good page.
---

External screenshots (Firecrawl-style capture) of BNMS script-provisioned canvas pages show the site footer overlapping the hero/intro mid-page. This is NOT a page defect: the footer renders before the canvas container grows to its measured height, and the capture fires during that window.

**Why:** Chasing this as a layout bug wastes time — a long-established, user-accepted canvas page (`/the-bnms-student-prize`) shows the identical overlap in the same tool, while genuinely broken geometry would also show bad `bp.desktop` values in the design JSON.

**How to apply:** When verifying a newly provisioned canvas page via external screenshot, ALWAYS screenshot a known-good page built by the same script in the same run and compare artifacts. Trust structural JSON verification (geometry finite, max y+h sane, hrefs exact) over a single mid-load screenshot.
