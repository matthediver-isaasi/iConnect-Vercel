---
name: Dynamic email slots (text/image/button) + campaign hide
description: How dynamic block slots flow from template builder through campaign editing to send, and the marker-based hide mechanism.
---

# Dynamic email slots & hide-able regions

Email templates can contain dynamic blocks (DYNAMIC_TEXT, DYNAMIC_IMAGE, DYNAMIC_BUTTON). Each carries a `token` (`dynamic_N`); buttons additionally carry a `linkToken` (`dynamic_N_link`) for the href. The primary `token` (never the linkToken) is the hideable/marker key.

**Token scheme:** image `src={{dynamic_N}}`; button text `{{dynamic_N}}`, href `{{dynamic_N_link}}`.

**Dual-mode previews:** the dynamic block preview components in `BlockRenderer.jsx` switch behaviour on `useContext(SlotEditContext)`:
- No context (builder / plain preview) → render a labelled placeholder or design-time default.
- Context present (campaign edit) → render the filled-in value with click-to-edit popover + a hide toggle.
`ReadOnlyBlockPreview` renders blocks via the `contentBlockPreviewComponents` registry, so any new dynamic block must be registered there to appear in the interactive campaign preview. To make a campaign editor interactive, wrap `ReadOnlyBlockPreview` in `<SlotEditContext.Provider value={{ slotValues, hiddenSlots, onChangeSlot, onToggleHidden }}>`.

**Hide mechanism (region markers):** `mjmlConverter.js` wraps every dynamic block's MJML in `<!-- DYN_BLOCK:START:token -->...<!-- DYN_BLOCK:END -->` markers (top-level, childBlockToMjml, and COLUMNS nested dispatch). At send/test-send time, `stripHiddenDynamicRegions` (in `api/_lib/campaignService.js`) removes the whole marked region for any token in `design_json.hiddenSlots` BEFORE `applyDynamicSlotValues` runs, and also strips leftover markers. This means a hidden element is fully removed from the email, not just blanked.

**Why:** hiding must drop the entire block (image/button/text + its container spacing), which value-substitution alone cannot do — hence region markers rather than empty-string injection.

**How to apply:** any new dynamic block type needs: BLOCK_TYPES + factory + extractDynamicSlots entry (types.js); drop-token assignment (EmailBuilder.jsx); palette entry (BlockPalette.jsx); preview registration in contentBlockPreviewComponents + blockPreviewComponents (BlockRenderer.jsx); editor (BlockEditor.jsx); MJML converter + marker wrap (mjmlConverter.js); token extraction in extractDynamicSlotTokens + extractHideableSlotTokens (campaignService.js). Persist hiddenSlots alongside slotValues in design_json when saving a campaign draft.
