---
name: Dynamic Text slot injection contract
description: How visual-email-builder "Dynamic Text" slots flow from template design through campaign send/test.
---

The visual email builder has a `DYNAMIC_TEXT` block: an editable label plus a stable unique token (`dynamic_N`). The builder emits the token as `{{token}}` literal text inside the rendered HTML (template `body`/`html_content`).

**Contract for filling slots at send time:**
- Per-send slot values are stored at `design_json.slotValues` (an object `{ token: value }`), NOT in a separate column.
- The rendered HTML keeps the `{{token}}` placeholders unfilled when persisted. Filling happens server-side at send/test time.
- `applyDynamicSlotValues(html, slotValues)` (in `api/_lib/campaignService.js`) does the `{{token}}` → value substitution. It must be applied to BOTH the html body AND the subject.
- Two send paths must each apply it independently: the batch send path (via `parseCampaignDesign` reading `design_json.slotValues`, then `sendToRecipient`) and `api/member-campaigns/test-send.js`.

**Why:** the same template can be reused for many sends with different slot values; storing values inside `design_json` keeps them with the campaign row and lets the server inject them without a schema change. If you add a third send path, remember it will silently leak raw `{{dynamic_N}}` tokens unless it also calls `applyDynamicSlotValues`.

**How to apply:** any new code that renders a campaign/template for delivery must run `applyDynamicSlotValues` on html + subject before per-recipient placeholder substitution. The client mirrors this with a local `fillDynamicSlots` helper purely for preview.
