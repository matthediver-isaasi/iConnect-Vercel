---
name: Microsite branding overrides
description: How per-microsite branding overrides flow and what a new overridable key must touch
---

Microsites override tenant chrome via three per-microsite JSON columns: `header_config` / `footer_config` (merged shallow-by-key over tenant configs) and `branding_config` (flat whitelisted string keys, sanitized server-side — only non-empty trimmed strings survive).

**Rule:** a new microsite-overridable branding key must be wired in ALL of:
1. the `MICROSITE_BRANDING_KEYS` whitelist + sanitizer in the shared microsites lib (otherwise PATCH silently drops it),
2. the public tenant-branding endpoint's microsite merge (otherwise the client chrome never sees it),
3. SSR meta resolution in renderHtml if it affects link previews (SSR resolves the microsite itself for `/{prefix}/{slug}` paths — it does NOT read the tenant-branding endpoint),
4. the microsite chrome editor card on /MicrositeManagement.

**Why:** SSR and the public branding endpoint are two independent resolution paths; wiring only one makes previews and client chrome disagree (caught in review — description/social image were SSR-only at first).

**Inherit semantics:** empty/missing = inherit tenant value everywhere. The editor's per-card Override toggles implement this by stripping managed keys on save; unmanaged `header_config`/`footer_config` keys from the legacy raw-JSON era must be preserved by spreading the stored object and only touching managed keys.
