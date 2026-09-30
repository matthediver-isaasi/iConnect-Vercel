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

For campaigns, branding/footer structure and preference-link availability are
separate facts. A recognized embedded footer can prevent a second branding
footer, but it must never suppress the recipient-specific preference fallback.
After composing the final message, independently guarantee a working preference
destination in both HTML and plain-text alternatives; stale design metadata is
not evidence that either rendered alternative contains one.

Late resolution also means earlier link-rewriting passes must recognize reserved
preference aliases. When an alias is the complete anchor destination, preserve
it through click tracking and resolve it only during final-envelope composition;
encoding the literal alias into a tracking redirect makes the visible link
unusable. This exception is narrow: ordinary campaign links still follow the
normal tracking path.

Campaign test sends deliberately differ from production at the credential
boundary. Tenant and group test-send recipients are synthetic and have no
persisted campaign-recipient identity, so preference aliases render as
non-actionable `#` destinations and the transport omits `List-Unsubscribe` and
`List-Unsubscribe-Post`. Test sends must not create recipient rows merely to
mint credentials. Immediate and scheduled production sends use persisted
recipient identities, direct recipient-specific preference URLs, and matching
one-click unsubscribe headers. Footer structure, branding, and ordinary message
content should otherwise retain test/live parity.
