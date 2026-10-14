---
name: Radix test DOM import order
description: Mounted dialog tests must initialise the DOM before importing Radix components.
---

Set up JSDOM globals before dynamically importing components which use Radix
dialogs when combining server-render and mounted interaction tests.

**Why:** Radix selects browser layout-effect behaviour at module evaluation.
Importing before a DOM exists can leave the dialog portal absent after a click,
even though React state changed; this is a fixture problem, not a UI failure.

**How to apply:** Establish the DOM before component imports, supply the browser
constructors used by focus management, then run the mounted confirmation test.
Clean up the React root and query/mutation caches afterwards.
