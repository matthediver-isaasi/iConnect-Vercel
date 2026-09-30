---
name: Canvas dashboard embedding
description: Shared dashboard embeds retain dashboard authorization and independent Canvas layout ownership.
---

“Shared” dashboard widgets mean tenant-shared, not publicly published datasets. Canvas must remain a reference to the dashboard definition, never a snapshot of its title, configuration, or data.

**Why:** A Canvas page may be public while its embedded dashboard data is private. Public page caches and prerendering must not acquire dashboard data, and embedding must not create a second visual implementation.

**How to apply:** Reuse the canonical dashboard presentation and authorization. Keep discovery, resolution, data, and drilldown shared-only and tenant-scoped; keep authenticated response caches separate from public page caches.

Viewer resizing stays local within the authored Canvas frame. It can reduce and restore the displayed widget dimensions, but cannot modify the dashboard definition or saved Canvas geometry.

**Why:** The absolute and flow Canvas modes share this boundary without introducing persistent viewer layouts or a general layout redesign.

**How to apply:** Keep author resize separate from the viewer toggle; use actual unscaled container measurements and discard viewer dimensions on reload.