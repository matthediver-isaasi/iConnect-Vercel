# Gmail sponsor-column MIME evidence

## Local decode

The attached message was decoded locally only. No message was sent and no network
or database operation was used.

- The input is a `multipart/alternative` MIME message with plain-text and HTML
  parts.
- Both alternatives use quoted-printable transfer encoding.
- The encoded HTML body is 176,432 bytes.
- The decoded HTML body is **165,878 bytes**.
- The plain-text alternative decodes to 38,126 bytes.

## Confirmed observations

The decoded HTML is MJML-style, table-based email output. In the received HTML:

- Sponsor logo rows contain three adjacent
  `mj-column-per-33 mj-outlook-group-fix` `div` elements.
- Each column has inline `display:inline-block`, `vertical-align:top`, and
  `width:100%`.
- A `min-width:480px` media query changes `mj-column-per-33` to `width:33%` and
  `max-width:33%`.
- The parent content width is 700px. Outlook/IE conditional markup supplies
  three 231px table cells.
- The left, middle, and right logo cells retain the received asymmetric
  horizontal padding. Their image containers are respectively 186px, 181px,
  and 186px.
- The decoded document contains 24 uses of `mj-column-per-33`, not just a single
  sponsor row, and extensive Outlook conditional table markup.
- Structural inspection finds 11 sections with multiple actual column elements:
  30 columns total (including all 24 sponsor columns). Full-width standalone
  columns are intentionally excluded.

The HTML fixture is a representative three-sponsor row. It preserves the
received row's table hierarchy, column classes, inline styles, responsive CSS,
and Outlook comments. Message text, original image references, remote font
reference, and unrelated sections were intentionally omitted. Empty image
sources and generic alt text ensure that the fixture contains no live URL or
source identifier.

## Diagnosis and uncertainty

The source establishes that stacking below 480px is intentional: the inline
100% column width remains in force until the media query applies. It also
establishes that desktop-width layout depends on the client retaining and
applying the head media query; the inline styles alone describe full-width
columns. Outlook has a separate fixed-width conditional-table path.

The MIME source alone does **not** establish which viewport width Gmail used,
whether a particular Gmail client retained/applied the head CSS, or whether a
later rendering/sanitization stage changed the document. Therefore a claim that
Gmail definitely stripped the media query, or that the sender generated
incorrect markup, would be speculation. A captured client DOM or screenshot
with client and viewport details would be needed to distinguish those causes.

## Sanitized received-email artifacts

`full-length-generate.mjs` performs local-only extraction and sanitization of the
approved attached MIME source. The generator was run with the discovered
received-MIME file in `attached_assets` supplied explicitly as its argument; the
private MIME source is not copied into the fixture tree. It generically replaces
visible non-whitespace characters while retaining each text node's length and
whitespace, and sanitizes links, resources, form targets, class identifiers, and
non-Outlook comments. Scripts, `data-*`, `id`, meta `content`, and `on*`
attributes are removed. Structural elements, inline CSS, responsive CSS, and
Outlook conditional markup are retained.

The generator writes independently sanitized baseline and hybrid candidate HTML,
send-ready multipart/related EML copies, and `generated/full-length/manifest.json`.
The manifest records byte sizes, table, media-query, column-class, Outlook
conditional, and CID-reference counts. Assertions reject remote resources,
scripts, non-fixture email addresses, common tracking parameters, transport
headers, private metadata attributes, and lost structural evidence. Safe
balanced-`div` detection marks every section containing more than one MJML
column, rather than stopping after the first sponsor row. The generated
candidate asserts that all 30 expected elements have hybrid bounds and that the
Outlook conditional comments are unchanged by correction.

All send-ready fixtures map `fixture-image@example.invalid` to the benign local
PNG at `generated/assets/fixture-image.png`; they make no remote image request.
Serialization and resource replacement still change decoded size, so the
full-length sanitized copy need not match the original byte length despite the
length-preserving visible-text replacement. Structural detection relies on the
balanced MJML `div` hierarchy and identifies multi-column sections by column
count; it does not infer visual intent beyond that structure. These static
fixtures do not emulate Gmail or Word-based Outlook and cannot prove the cause
of clipping or column stacking. No network, send, or database operation was
performed.