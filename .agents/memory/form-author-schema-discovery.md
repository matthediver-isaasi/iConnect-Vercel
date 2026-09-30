---
name: Form author schema discovery
description: Why form metadata discovery differs from record access and catalogue fields.
---

Schema-authorized form authors may discover object metadata without record
grants, but explicit member field denials must still constrain form discovery.
Ordinary record-granted members do not thereby become form authors.

**Why:** Catalogue schema visibility and record grants are separate capabilities.
Using only record grants hides valid objects from schema-authorized admins;
using broad admin status instead would ignore explicit schema restrictions.
Form metadata also configures respondent-facing values, so catalogue field
visibility alone is not sufficient justification to ignore field denials.

**How to apply:** Resolve schema capabilities from trusted server context, retain
the form-author gate, and test object, primary-label, filter and relationship
metadata independently of public options and submission policies.

Apply the same trusted author policy when saving configuration, not only when
listing metadata. Keep relationship-topology validation separate from
record-reference eligibility.

**Why:** A distinct-value source uses a relationship but returns a scalar.
Reusing a record-reference-only guard for form saves rejects valid distinct
sources; relaxing that guard instead would let scalars reach record resolvers.

**How to apply:** Exercise discovery, save, and reopen with the full real source
validator, including distinct values and filters. Never trim configurations in
a test harness to make an authoring failure disappear.