---
name: Canvas dynamic-list link "open in new tab"
description: How new-tab control is wired for data-driven Canvas list outbound links vs editor-set link fields.
---
Canvas Builder's uniform new-tab control is `resolveNewTab(obj, defaultNewTab=false)` (registry.jsx) plus a `LinkField` Switch. That works for editor-set links (an editable href field). For DATA-DRIVEN dynamic list links (sponsor `website_url`, article "Read more", resource cards) the href is not author-set, so there is no LinkField — instead the new-tab choice is a **block-level `ToggleField`** ("Open in new tab") storing `content.newTab` (sponsor blocks use `content.websiteNewTab`), read via `resolveNewTab`.

**Why:** these links come from live records, so a per-link field is impossible; one block-level toggle governs all items the block renders. Publish + editor share the same renderers, so `target`/`rel` must be emitted from the resolved boolean (guard with `!asEditor` where the editor suppresses navigation).

**How to apply:**
- Default per backward-compat: surfaces that were always-new-tab keep default TRUE (`resolveNewTab(c, true)`) — sponsor website links, resource list. Article "Read more" was same-tab, so default FALSE.
- Sponsor: thread a `websiteNewTab` prop into `SponsorCard`/`SponsorDetail` (default true) and emit `target={websiteNewTab ? '_blank' : undefined}` + matching `rel`.
- Resource list reuses the SHARED `client/src/components/resources/ResourceCard.jsx` (its outbound `handleResourceClick` uses `window.open(url,'_blank')`). Added an optional `openInNewTab` prop **defaulting to true** so the public `/resources` page is unchanged; same-tab path uses `window.location.href`. Don't fork the card — extend it with a defaulted prop.
- Card-deck outbound links are the remaining always-new-tab dynamic list surface (not in the task's named list; tracked separately).
