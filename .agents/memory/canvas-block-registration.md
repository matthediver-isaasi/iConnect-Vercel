---
name: Adding a Canvas Builder block
description: The places you must touch to register a new /canvasbuilder block so it shows in the palette and renders.
---

A new Canvas Builder ("/canvasbuilder") block needs registering in two files:

1. `client/src/lib/canvasDesign.js`
   - add a key to `BLOCK_TYPES` (string id, e.g. `EVENT_SESSIONS: 'event-sessions'`)
   - add a `BLOCK_DEFAULTS[BLOCK_TYPES.X]` entry (name, geom, style, content defaults)
   - add a `validateBlock` case (validateBlock only sees `block.content`, NOT fetched data — so it can't validate things like server-side counts)

2. `client/src/components/canvas/blocks/dynamicBlocks.jsx`
   - write a `<X>Render({ block, asEditor })` component and a `<X>Inspector({ block, update })`
   - add an entry to the exported `DYNAMIC_BLOCK_DEFINITIONS` map: `{ label, icon, category: 'data', Editor: (p)=><Render {...p} asEditor/>, Renderer, Inspector }`

`DYNAMIC_BLOCK_DEFINITIONS` is spread into the REGISTRY in `registry.jsx` and the palette auto-shows non-hidden blocks — no separate allowlist to update.

**Why:** these are the only wiring points; missing the registry merge or BLOCK_TYPES id silently keeps the block out of the palette or breaks validation.

Reusable data helpers (EmptyState, ErrorState, ListSkeleton, Field, TextField, ToggleField, EventPickerField pattern) already live in dynamicBlocks.jsx — reuse them.
