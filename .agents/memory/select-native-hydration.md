---
name: Select native hydration
description: Radix's hidden native select can emit empty changes while asynchronously supplied options mount.
---

For a controlled Radix Select that uses an explicit sentinel option to clear a value, ignore raw empty-string change notifications; preserve clearing through the sentinel.

**Why:** When a saved value arrives before its settings options, Radix's hidden native select can set a value that is not yet present in its native options and dispatch an empty change. Treating this as user input erases the hydrated selection even though both the database and authorized response contain it. A later unrelated save can then persist the unintended clear.

**How to apply:** Test the real dropdown with delayed settings and a saved value absent from the initial options. Assert the native empty change actually occurs and does not change the selection, then test explicit clear and save/reopen. Immediate fixtures with the stored option already present miss this boundary. Do not globally suppress empty values in controls that intentionally use them.