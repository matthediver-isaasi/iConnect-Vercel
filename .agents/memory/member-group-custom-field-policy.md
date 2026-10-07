---
name: Member Group custom-field policy
description: Ownership and compatibility boundaries for Member Group custom fields.
---

Member Group custom fields are tenant-managed group metadata, separate from member and organisation PreferenceField scopes. They do not grant additional group-admin editing rights or new access to restricted groups.

**Why:** The requested product scope explicitly excludes preference-scope expansion, form/report/import support, and changes to existing group access policies.

**How to apply:** Keep future integrations opt-in work rather than treating these definitions as another PreferenceField owner. Any future type-conversion feature needs an explicit value migration instead of silently reinterpreting saved values.
