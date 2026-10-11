---
name: Sales panel test isolation
description: Avoid accidental browser-client initialization in isolated server-rendered Sales component tests.
---

Isolated Sales panel tests should stub unrelated page-level authentication and project-board dependencies, not supply real tenant credentials to make imports work.

**Why:** Importing a small panel through its page module can initialize unrelated Supabase browser clients and load board CSS before the panel runs. Those failures are fixture-environment failures, not evidence that the panel is broken.

**How to apply:** Keep the panel, its loader and UI dependencies real; stub unrelated page dependencies with their actual export contracts. Keep React Query providers in the same module format as the tested component to avoid separate context instances.
