---
name: useQuery destructure-default render loop
description: Inline `= []` defaults on disabled useQuery data can drive an infinite re-render loop that silently freezes SPA navigation.
---

`const { data: x = [] } = useQuery({ enabled: cond, ... })` creates a NEW array identity every render whenever the query is disabled/unloaded (data stays undefined). If a `useEffect` depends on `x` and calls setState with a fresh object inside, the component loops forever (~hundreds of commits/sec) while looking "idle" — no errors, no network.

**Why it matters:** react-router v7 navigations run in a transition; the loop starves the transition so the URL changes but the page never repaints. Symptom is condition-specific (here: only org-less/Alumni members, because only then was the org-pref-values query disabled).

**How to apply:** use a module-level `const EMPTY = []` fallback (or guard effects to no-op when data is unchanged) for any query data feeding effect deps. Debugging trick: count commits via a `__REACT_DEVTOOLS_GLOBAL_HOOK__` stub and read `root.memoizedUpdaters` per commit to name the components scheduling updates, then diff the component's hook states (hooks with `.queue`) across commits to find the looping hook index.
