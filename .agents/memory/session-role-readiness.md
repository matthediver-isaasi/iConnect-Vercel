---
name: Session role readiness
description: Safe reuse of verified role data, terminal failures, and observer-driven loading loops.
---

In-place event sign-in must retain its current layout tree while independently
revalidating access. Embedded event routes must have the same session owner even
when they omit page chrome.

**Why:** Switching from public to portal chrome remounts event controls and loses
valid choices. A modal disappearing can mean its whole page crashed or remounted,
not that authentication completed. Storage writes cannot establish readiness.

**How to apply:** Refresh through Layout's session owner, wait for a new verified
identity-matched role epoch, and assert retained controls and rendered event content
after dismissal. Do not substitute the access hook's member-entity refresh.

A session-supplied role can eliminate a second permissions request, but must remain tied to the verified member, tenant, role and session. It must still participate in explicit role-query invalidation.

**Why:** Permanently preferring an authentication snapshot would leave navigation using old permissions after role changes. Missing role data is especially dangerous in an exclusion-based policy: an empty exclusion list means unrestricted access, not a failed lookup.

**How to apply:** Keep trusted snapshots out of persisted member data, clear them on identity/auth changes, distinguish unavailable roles from valid unrestricted roles, and make failures terminal with a retry action. Preserve role invalidation when optimizing the first read.

Keep a successfully loaded role fresh within its validated session rather than automatically refetching whenever another access-hook consumer mounts.

**Why:** If a refetch closes access readiness, it unmounts protected children. A child that refetches stale role data on every mount can then repeatedly close readiness and unmount itself.

**How to apply:** Test a late second observer and explicit invalidation separately. New session generations and deliberate invalidations must still refresh permissions; mounting another consumer must not create a request loop.

Protected route guards must derive readiness and permissions from the same session-role observer, not an effect-published Layout permission callback.

**Why:** Hidden portal children still run redirects. A stale deny callback can redirect an authorized member during loading; a stale allow callback can mount protected workspaces before refreshed permissions resolve.

**How to apply:** Gate workspace mounting and redirects on a ready, identity-matched role. Keep missing/error states recoverable and distinguish them from confirmed exclusion.

Browser fixtures that authenticate a member must also supply a valid tenant-matched role lookup, even when testing public Canvas previews.

**Why:** Older member-only fixtures returned generic empty metadata for role-by-id reads. After role readiness became fail-closed, this caused editor and draft-preview failures unrelated to the feature under test.

**How to apply:** Model the intended member capability explicitly in fixture role responses; do not bypass guards or promote the fixture to an administrator merely to recover an older test.

Route readiness and session lifetime are separate boundaries. A pathname change must not invalidate a trusted session. Explicit identity/auth invalidation remains required.

**Why:** Route-scoped authentication cleared trusted roles on every navigation and repeatedly replaced the entire portal with its loading state. Browser projections never authorize server operations.

**How to apply:** Scope session discovery to the tenant and authentication generation, fence old responses, and test ordinary navigation separately from expiry, explicit invalidation, and account changes. Route decision leases still expire on navigation and must never carry public/blank/microsite chrome into another destination.

Established pages must not poll session authority or hide on an elapsed display-retention deadline.

**Why:** The user explicitly chose display continuity until protected-request rejection or explicit invalidation, replacing the previous five-minute polling and ten-second retention policy.

**How to apply:** Preserve displayed content and unsaved nodes through idle/focus/offline events. Keep server authorization, normal session expiry, independent stale-tenant-tab protection, logout, identity changes and explicit permission invalidation. Infrastructure lookup failures deny work without claiming logout or durable saving. Fence late API responses.

Navigation-loading improvements must cover the tenant main website as well as microsites.

**Why:** The user reports that all pages, including the tenant main site, go blank with a loading spinner during navigation and considers this poor website UX.

**How to apply:** Evaluate website navigation continuity separately from session continuity. Do not restrict investigation to microsite routes; preserve destination-specific chrome and access rules.

Do not substitute a visible “Loading page… / Cancel” notice or generic homepage
skeleton for faster website loading.

**Why:** The user explicitly rejected both presentations as odd website UX and
reported that navigation did not feel quicker.

**How to apply:** Address and measure the time until real page content appears,
not merely the appearance of the waiting state. Keep loading feedback unobtrusive
and appropriate to the actual website.

No skeletons on public-facing presentation pages, on either the tenant main site
or microsites. Portal skeletons are acceptable where the card layout is known.

**Why:** The user explicitly distinguished known portal card layouts from
front-end presentation pages and said skeletons on presentation pages are a “no no.”

**How to apply:** Preserve this distinction when changing loading presentation;
do not introduce a different skeleton as a replacement for the rejected one.

Intent preloading must not become a retained cache of cookie-bearing public-page
responses.

**Why:** A hover is not an authorization event; identity or eligibility can
change before activation. Overlapping an in-flight read can reduce post-click
waiting without treating old completed responses as fresh authority.

**How to apply:** Keep speculative work bounded and abortable, discard completed
unactivated results, fence audience changes, and measure click-to-content
separately from first-visit performance. Do not claim hover gains for touch-only
or direct-entry visits.

Keep the old page associated with its old URL while preparing website navigation;
never carry its chrome decision into an unresolved destination.

**Why:** This preserves website continuity without violating pages deliberately
configured to hide headers/footers. The user also explicitly requires documented
rollback capability for these navigation changes if regressions appear.

**How to apply:** Treat prepared results as a bounded one-navigation handoff, not
long-lived permission evidence. Fence identity changes and late completions.
Document an isolated source revert that preserves unrelated session and form fixes,
and distinguish a source rollback check from a deployed rollback rehearsal.

Successful background checks need retention assertions after completion as well as while pending.

**Why:** Equivalent new projection objects can repaint page-owned Canvas content even when the outer portal shell never closes, losing live controls and input state.

**How to apply:** Keep equivalent authoritative projections stable without suppressing real permission changes, and assert exact input-node identity across repeated successful refreshes.

Equivalent legacy snapshots are not evidence that permissions remain unchanged.

**Why:** A legacy auth response omits the role projection; preserving its session key with an infinitely fresh fallback query can retain revoked permissions indefinitely.

**How to apply:** Resolve legacy permissions afresh on explicit verification. Never use equality of legacy metadata to suppress explicit role invalidation.

Transient failures must preserve established view state, and failed mutations must never be automatically replayed.

**Why:** Making a retained Canvas page observe a guest transition destroys its live controls. Server-side authorization, not a cached browser role, determines whether work is permitted.

**How to apply:** Reject failed work without clearing identity on an infrastructure error. Only confirmed session-specific rejection clears authority; a feature denial does not. Always distinguish fixture verification from a confirmed production cause.

Recovery request gates must not turn confirmed guests into permanently blocked viewers.

**Why:** Public job and booking flows share the functions transport with member
operations. A blanket pause after a cold null session blocks legitimate guest actions.

**How to apply:** Test cold guest public actions separately from signed-in failures. Keep confirmed-guest flows working under server authorization.