---
name: AI V2 prompt-led editing
description: Durable rules for proposing/accepting edits to V2 native-code compositions
---
- Accept re-applies the STORED proposal against the CURRENT document — never trust a client-sent document; patch base drift is a 409, not a silent overwrite.
- **Action carry-over on revisions:** the model never re-resolves links. Carry the FULL resolution payload (resolved flag + navigable href + record metadata) from the stored manifest onto revised actions. **Why:** copying only the resolved flag leaves resolved:true with no href — CTAs go inert and the publish gate flags them; replacing actions wholesale with stored (post-pipeline) rows fails the raw package validator, which requires the raw schema shape.
- **How to apply:** whenever a revised package's manifest is reconciled with a stored one, merge resolution fields onto the model's schema-valid objects; never swap objects wholesale in either direction.
- Stable-ID survival is two-tier: element patches hard-reject dropped descendant data-ai-ids (removals are never a patch); full revisions surface removed ids as confirmable warnings — deliberate removal = user confirmation, same path as protected values.
- Version rows don't retain raw (unscoped) CSS, so a revision built from a stored doc feeds the model scoped CSS — the prompt must tell it to strip the scope prefix.
- Accessibility gate on accept blocks only NEW criticals (before/after diff); contrast needs rendered styles so it stays in the browser validation loop, not the deterministic accept gate.
