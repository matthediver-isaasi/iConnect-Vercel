---
name: Canvas audit resource readiness
description: Resource settling must not become an unbounded prerequisite for auditing.
---
Audit resource readiness is best-effort and distinct from page identity and editor authorization.

**Why:** An offscreen lazy image may never fire load/error until scrolled into view. Waiting for every image can therefore block the preview handshake indefinitely, even when the DOM is mounted.

**How to apply:** Bound image/font settling together, exclude lazy images from blocking readiness, and clean up listeners on cancellation. Never bypass nonce, document, page, view or authorization checks to compensate for resource delays.
