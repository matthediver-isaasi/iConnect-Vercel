---
name: Website first-content measurements
description: Public metadata remount caching and matched-build timing boundaries.
---

Distinguish public route metadata from cookie-bearing page payloads when removing
website request waterfalls. Preserve safe metadata reuse across layout remounts;
do not automatically give all discovery queries mount-unique keys.

**Why:** A mount-unique homepage-slug query repeated discovery when layout policy
remounted the homepage and made browser Back slower, despite earlier dispatch.
The slug is routing metadata, not membership authority. Raw member-capable page
responses still need their existing session/audience isolation.

**How to apply:** Measure cold entry and Back separately. Keep consumption behind
branding/session/route policy and retain host/tenant/audience metadata partitions.
Verify that changing branding from unresolved to an id does not restart discovery.

Use matched built assets for first-content comparisons and report the request
interval separately from document/JavaScript bootstrap.

**Why:** Development module transformation dominated initial samples and produced
timeouts. Earlier microsite branding dispatch did not by itself make real content
appear sooner when another request/render dependency dominated.

**How to apply:** Do not turn earlier request starts or isolated handler timing
into a production-speed claim. Separate touch, warm no-intent clicks, history,
and direct entry; label intercepted APIs and live-tenant limitations explicitly.

For JavaScript splitting, count the complete static import closure and all
chunks fetched through visible real content, not only the entry filename.
Run matched timing phases after compilation finishes, without parallel builds.

**Why:** Deferred renderers shift downloads past provider startup; entry-size
savings alone can overstate first-content savings. Concurrent compilation also
contaminates cold-browser CPU timings.

**How to apply:** Retain raw samples (including outliers), report file gzip
separately from actual transfer encoding, and measure bootstrap plus content.

Early discovery can populate dependent-query keys even when another prerequisite
has failed. Count a dependent query as pending only while it is eligible to run.

**Why:** React Query marks a disabled, never-fetched query as pending. A discovered
homepage slug combined with failed branding otherwise hid the explicit error
behind an indefinite blank loading state.

**How to apply:** Test discovery success together with independent prerequisite
failure, not just failure of the discovery request itself.
