---
name: Transactional preference identity
description: Why preference aliases must wait for the final recipient envelope.
---

Transactional preference aliases authorize the actual recipient, not the entity used to personalize a template. Preserve campaign substitution as a separate contract.

**Why:** Workflow entities, form submitters and template-test sample members can differ from the delivery address. Signing during personalization can expose another member's consent controls, especially after CC/BCC is added. Visual Unsub blocks are also used outside campaigns.

**How to apply:** Keep aliases reserved through mapping passes and resolve only after footer insertion and the final envelope is known. Verify a unique tenant-owned recipient; use nonclickable fallback for unsafe contexts without blocking essential delivery. Test final transport payloads across every independent sender, not just template helpers.

Treat the substitution location as an authorization boundary too.

**Why:** Unescaped form values can introduce aliases inside CSS fetch URLs or attacker-prefixed text. A correct recipient signature still leaks a bearer credential if inserted into those contexts.

**How to apply:** Permit signed output only in explicitly safe standalone text or anchor contexts; raw-text, foreign markup and URL concatenations get fallback. Exercise both URL and link aliases through real form interpolation and final HTML/plain-text transport payloads.