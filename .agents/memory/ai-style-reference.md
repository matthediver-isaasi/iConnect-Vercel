---
name: AI generation style reference
description: Style Reference & Design DNA for AI generation — SSRF two-stage check, byte-identity rule, guardrails
---

Admins can attach a style reference (own published page, external URL, or uploaded screenshots) to AI generation. Durable rules:

- **No-reference byte-identity:** when no valid reference is supplied, generation options and prompts must be exactly what they were before the feature existed — the reference key is only added when validated, and prompt builders emit nothing without one. Any future change to the reference path must preserve this (regression-tested).
- **Screenshots are only trusted under the tenant's own public-assets prefix** — anything else is silently dropped; a reference with no surviving screenshots is treated as no reference. This is the boundary that stops arbitrary URLs being fed to the vision LLM.
- **SSRF needs two stages:** string/pattern checks on the URL are bypassable via decimal/hex/octal IP literals and DNS pointing at private space. Always follow with a DNS-resolution check that rejects any resolved address in private/loopback/link-local/CGNAT/NAT64/mapped ranges.
- **Anonymous capture ⇒ public pages only:** server-side screenshotting sees pages as a guest, so only published, publicly-routable, non-microsite pages qualify; everything else falls back to manual screenshot upload.
- **Uploads for LLM vision input are raster-only (no SVG) and must be allowlisted server-side** — client-side file filtering alone is bypassable.
- **Prompt guardrails:** tenant branding/content/accessibility always beat the reference; never copy the reference's text or images; influence levels only change emphasis, never the guardrails.
- **v2 structured Design DNA:** analysis is a staged serverless flow (start → per-viewport capture → analyze) so each stage fits an invocation budget; results are cached per tenant+normalised URL+capture/analyser versions with a TTL, and a refresh flag bypasses the cache. The structured DNA is handed to the generator whole (JSON block + priority order), never flattened to prose; a quality gate (evidence-count/measurement/generic-language checks) fails weak analyses with a fixed user message rather than passing vague guidance downstream.
- **Redirects re-validate:** the post-redirect final URL from the headless capture must pass the same SSRF/public-target checks as the requested URL, or a public URL redirecting into private space defeats the start-time check.

**Why:** reference images and URLs are user-influenced input to server-side fetching, storage and a vision LLM; without these rules the feature becomes an SSRF proxy, an injection vector, or a silent regression of existing generation.
