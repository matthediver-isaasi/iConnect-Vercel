---
name: Form checkout query scope
description: Repeated query keys can invalidate a correctly scoped saved purchase.
---

Keep purchase-identity query parameters scalar; do not append scope again when
adding a saved-checkout reference. Reject ambiguous scope rather than choosing
one supplied value.

**Why:** Repeated form/field keys become arrays in the server query contract.
Strict comparisons then report false ownership failures even when the saved
checkout metadata is correct. A later valid database read does not establish
the exact earlier request or prove a provider did not charge.

**How to apply:** Test the serialized URL through query parsing and the mounted
form, not only helpers supplied with hand-built scalar inputs. Inspect the
saved purchase before attributing an incident to missing legacy metadata.
