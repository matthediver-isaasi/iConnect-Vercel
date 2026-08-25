---
name: Stable Lucide icon identities
description: Why saved icon choices must not use the runtime component name
---

Persist icon choices with an explicit string key paired to the Lucide component. Do not derive the key from `component.name`, and do not mutate imported icon components to add one.

**Why:** `lucide-react` exports forward-ref component objects whose runtime `name` can be undefined even when `displayName` is present. Using it as persisted identity can silently clear or mismatch a user's selected icon.

**How to apply:** For any saved icon picker, define metadata such as `{ key, Icon }`; store and compare `key`, and render `Icon`.