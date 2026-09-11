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