---
name: Sales panel test isolation
description: Avoid accidental browser-client initialization in isolated server-rendered Sales component tests.
---

Isolated Sales panel tests should stub unrelated page-level authentication and project-board dependencies, not supply real tenant credentials to make imports work.

**Why:** Importing a small panel through its page module can initialize unrelated Supabase browser clients and load board CSS before the panel runs. Those failures are fixture-environment failures, not evidence that the panel is broken.

**How to apply:** Keep the panel, its loader and UI dependencies real; stub unrelated page dependencies with their actual export contracts. Keep React Query providers in the same module format as the tested component to avoid separate context instances.

For mounted input tests, establish JSDOM globals before evaluating the component bundle (which may transitively import React DOM).

**Why:** React DOM detects browser support at import time. Importing it before a DOM exists can make synthetic text-input events fail to update state even though select events work.

**How to apply:** Initialize the DOM before compiling/loading the bundle, then assert the submit button is enabled before clicking it; do not interpret an unchanged form as an application regression until fixture initialization is correct.
