---
name: Positioned table overflow
description: Browser geometry checks for tables containing positioned controls
---

For wide tables with positioned controls, checking the table viewport's width is not enough: also check the document's scrollable width.

**Why:** A relationship table had a correctly sized horizontal scroller and body, yet its content increased the document root's scrollable width on mobile. Making the scroller a positioned containing block eliminated the overflow.

**How to apply:** Keep positioned descendants contained by their scroll viewport, and use browser geometry assertions for both the local scroll area and document root rather than relying only on overflow utility classes.