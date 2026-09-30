---
name: React Query test process cleanup
description: Why mounted mutation tests can pass but keep Node alive for several minutes.
---

Mounted tests that execute React Query mutations need short garbage-collection times for mutations as well as queries.

**Why:** Both create/edit assertions passed immediately, but the test process remained alive on the default mutation-cache garbage-collection timer. Query-only cleanup settings did not prevent the delay, making successful verification look hung.

**How to apply:** Set `gcTime: 0` for both query and mutation defaults in isolated test clients, unmount the React root, and clear the client. Check clean process exit, not just passing assertions. Do not change production cache settings or force-exit the test runner to hide open handles.