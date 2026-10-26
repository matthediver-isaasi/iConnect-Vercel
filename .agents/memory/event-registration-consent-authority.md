---
name: Event registration consent authority
description: Keep optional purchaser consent separate from booking authority and global opt-out changes.
---

Post-registration marketing consent is booker-only, never attendee consent.
Guests whose address matches a member need authenticated member identity;
return the same empty choices as other ineligible identities rather than
disclosing account existence.

**Why:** A successful purchase proves the booker's registration action, not
permission to alter another attendee's preferences or a member account found
through a typed email.

**How to apply:** Issue offers only at fresh successful purchase boundaries;
allocation invitation claims and historical booking lookups are not issuers.
Recover only previously issued offers with their purpose-scoped recovery proof.

Optional consent recovery must not participate in financial idempotency.

**Why:** Adding a new browser nonce to an existing booking-credit fingerprint
would reject payment retries started before the consent feature was released.

**How to apply:** Keep consent-only request data out of booking/payment identity,
and reuse the existing recipient lock and subscribe-only category operation.
The form subscription operation is not interchangeable: it can clear global
opt-outs, which this feature must preserve.
