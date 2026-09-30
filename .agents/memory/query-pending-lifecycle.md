---
name: Pending queries on reusable detail views
description: Distinguish request loading from disabled queries and temporary relationship-tab discovery.
---

Gate discovery loading UI on a valid existing-record identity, not only a query's pending status. When discovery temporarily removes a selected tab, use neutral loading/error content until its authorized definition returns.

**Why:** TanStack Query keeps disabled, uncached queries pending. Reusable detail views can change from an existing record to a new/unsaved record without remounting, leaving a permanent spinner if the prior selected tab survives. Rendering a tabpanel while its trigger is absent also creates a broken accessible label reference.

**How to apply:** For reusable detail views, reset relationship selections when identity becomes invalid; distinguish unresolved definitions from confirmed missing definitions; keep temporary discovery status outside tabpanel semantics unless a corresponding trigger remains.