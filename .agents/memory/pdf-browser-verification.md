---
name: PDF browser verification
description: Distinguish certificate layout evidence from PDF.js browser compatibility evidence.
---

Treat certificate browser-fixture checks as layout evidence, not proof that every supported browser can load the installed PDF.js version.

**Why:** The workspace system Chromium lacked newer standard JavaScript APIs required by PDF.js. Test-only compatibility shims allowed real PDF rendering and geometry checks, but do not establish unshimmed production compatibility.

**How to apply:** When investigating blank certificate backgrounds or changing PDF.js, test an unmodified supported browser separately. Do not attribute a renderer compatibility failure to fit geometry, or ship fixture shims as an incidental layout fix.

Native PDF iframes do not reliably provide an in-dialog preview in headless Chromium.

**Why:** A successful PDF response followed by blob-iframe navigation was treated as a download and reset the report; it initially looked like a development hot-reload problem.

**How to apply:** Check browser download/navigation events before blaming reloads. Use in-dialog canvas rendering for predictable previews, and verify real rendering separately from mocked component tests.

Validate actual rendered text widths, not only the PDF writer's wrap calculations.

**Why:** jsPDF's built-in Helvetica wrapping and PDF.js's measured text widths differed enough for a supposedly margin-safe answer to extend about 1.6 mm into the right margin.

**How to apply:** Assert extracted text x + width against page margins and visually inspect rendered output; retain a small wrap-width guard for standard-font exports.

Rasterized HTML exports also require independent inspection of the downloaded PDF, not just a successful download or source screenshot.

**Why:** Browser HTML capture can shift text baselines enough to overlap adjacent image content even though the source layout and PDF structure are valid.

**How to apply:** Render representative first, middle and final PDF pages with an independent reader and check headings, image boundaries and pagination. Poppler can provide this evidence without adding PDF.js compatibility shims to older test browsers.