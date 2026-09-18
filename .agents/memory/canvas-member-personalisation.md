---
name: Canvas member personalisation boundary
description: Why Canvas member text must use a separately validated viewer snapshot and display-only text-node resolution.
---

Keep member text personalisation at the TipTap display boundary, not in a design-wide string substitution or a save-time transform. Authoring stages remain templates; anonymous extraction remains neutral.

**Why:** Canvas designs also contain links, attributes, Custom HTML and plain-text fields that are deliberately outside the placeholder contract. A general replacement would change those meanings and could persist one viewer's information into shared symbols, footers or search output.

**How to apply:** New rich-text picker surfaces need a matching display resolver and anonymous extraction rule. Do not add the picker to other field types without extending the contract deliberately.

Use a fresh server-authenticated viewer snapshot, never the legacy storage-backed member or organisation objects, as personalisation authority.

**Why:** Layout can display cached identity and load organisation information independently. Those are useful UI hints but do not prove the current viewer, tenant, or linked organisation during account transitions.

**How to apply:** Clear personalisation as authentication closes or identity changes, and fence late authentication results. Keep organisation-name lookup failure isolated from the existing login result.