---
name: tenant-branding secondaryBar PATCH sanitization
description: Why new header_config.secondaryBar subfields silently vanish unless whitelisted in the branding API
---

The branding PATCH endpoint (`api/admin/tenant-branding.js`) does NOT pass `secondaryBar` through unchanged. It rebuilds a fresh `sanitizedSecondaryBar = { enabled }` and copies only explicitly-validated keys (height, gradientStops, textColor, fontSize, ...) onto it, then assigns it back over `updates.header_config.secondaryBar`.

**Why:** the rebuild strips unknown/invalid input rather than trusting the client blob.

**How to apply:** when you add any new field under `header_config.secondaryBar`, you MUST add a validation+copy line for it inside that sanitization block, or it will be dropped on save even though the admin UI sends it and the public reader expects it. Top-level `header_config.*` fields (e.g. topNavTextColor, topNavFontSize) merge through fine and only need their own validate/clamp block. A new per-bar branding setting touches 5 spots: AdminBranding formData init + load mapping + card UI, the API validation, and the PublicHeader read+render.
