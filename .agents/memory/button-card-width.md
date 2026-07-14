---
name: Card-as-button needs explicit w-full
description: Why clickable card components rendered as <button> collapse to content width (iOS "squashed" cards) while div/a cards fill their slot.
---

Any card component rendered as a `<button>` must carry an explicit `w-full` class.

**Why:** Form controls (`<button>`) have shrink-to-fit width (`width:auto` = content width) even when given `display:flex`, unlike `div`/`a` which fill their block container. Inside a carousel slot or plain wrapper div the button collapses to its content width — most visible on narrow phone viewports ("squashed to the left half"), while desktop content is wide enough to mask it. The sponsor carousel's empty-CTA slide (a div) rendered fine in the same slot, which was the diagnostic tell.

**How to apply:** When a card has both link (`<a>`/`<div>`) and clickable (`<button>`) render variants, the button variant needs `w-full` added; the others don't. Also note: a bug reported as "still broken after the fix merged" may just be a stale deployed bundle — fetch the live site's JS and grep for a distinctive literal from the fix before re-debugging (bnms prod vs dev.iconn.app preview build from the pushed branch).
