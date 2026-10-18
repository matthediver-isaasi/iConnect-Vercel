---
name: Unified Sales agreement intent
description: Requested replacement for the separate manual commercial proposal and legal contract.
---
The user currently uses two manual documents: a detailed quote and a full legal contract. They want one automatic agreement: quote first, per-proposal rich-text legal content next, and sender/contact details with signatures last. Both parties must be able to type in a script font, draw, or upload a signature; the sender signs when sending.

**Why:** The user described this business process, reviewed the recommendation, and approved implementation.

**How to apply:** Keep signature authority separate from email-sender selection: a colleague must personally sign through an authenticated request. Bind both signatures to an immutable agreement version, never live profile or template content. Preserve ordinary quotes without legal content.

Recipient email verification must produce a separate short-lived secret proof held by the verifying browser, not merely set a verified flag on the shared delivery token.

**Why:** A forwarded-link holder could otherwise sign after the intended recipient verifies their email.

**How to apply:** Bind proof to the delivery token and current code generation, invalidate on resend, keep it out of URLs and logs, and validate it transactionally with acceptance.
