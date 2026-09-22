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