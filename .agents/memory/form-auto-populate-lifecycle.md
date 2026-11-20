---
name: Automatic form field initialization
description: React initialization ordering and mounted regression test requirements for automatic profile fields.
---

Automatic profile population must recover when a parent initializes or resets the answer map after child effects have run.

**Why:** React child effects run before parent effects. A parent reset can erase an automatic value within the same commit, leaving the observed value undefined both before and after. Watching only profile values and the answer misses this case.

**How to apply:** Test the actual renderer inside a parent that resets answers on mount, for name, email, organisation and job title. Preserve nonempty saved answers. Mounted Node tests should use the existing esbuild CSS-empty harness, with CommonJS React Query imports matching the bundled renderer; Node 24's navigator must be defined rather than assigned.
