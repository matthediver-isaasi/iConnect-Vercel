---
name: PDF browser verification
description: Distinguish certificate layout evidence from PDF.js browser compatibility evidence.
---

Treat certificate browser-fixture checks as layout evidence, not proof that every supported browser can load the installed PDF.js version.

**Why:** The workspace system Chromium lacked newer standard JavaScript APIs required by PDF.js. Test-only compatibility shims allowed real PDF rendering and geometry checks, but do not establish unshimmed production compatibility.

**How to apply:** When investigating blank certificate backgrounds or changing PDF.js, test an unmodified supported browser separately. Do not attribute a renderer compatibility failure to fit geometry, or ship fixture shims as an incidental layout fix.