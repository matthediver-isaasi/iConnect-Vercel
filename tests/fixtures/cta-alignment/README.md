# CTA alignment fixture

`alignment-matrix.html` is a local, sanitized visual-builder fixture covering
left, centre, right, missing and invalid alignment for static and dynamic CTAs
at top level, inside sections and inside unequal 37/63 columns. Links use only
`example.invalid`; the fixture contains no recipient, tenant or campaign data.

Regenerate locally with:

```sh
./node_modules/.bin/tsx tests/fixtures/cta-alignment/generate.mjs
```

## Received-client checks

**PENDING — no Gmail or Outlook test inboxes or sending identity have been
authorized. No fixture was sent.** This HTML is not evidence of received-client
rendering. Once explicitly authorized, check left/centre/right positioning in
Gmail desktop/mobile and **classic Outlook for Windows (Word rendering engine)**,
recording the exact Outlook version, client versions, viewport/message-pane
dimensions and screenshots. Do not use a campaign test-send route or real
audience.

## Rollout boundary

The renderer correction applies when HTML is newly generated. It does not
rewrite stored campaign HTML or previously delivered messages. For an affected
unsent draft, first validate its existing `design_json` is valid and that the
stored visual design is fully supported
(all content/order, images, CTA labels/destinations, dynamic tokens, footer and
canvas settings), then use the normal campaign editor save flow
(`EmailCampaignEdit.jsx`) to regenerate and review the HTML. Preserve the
existing stored HTML if complete rendering cannot be validated. No database
migration is required.

## Automated verification (2026-09-23)

- CTA delivery suite: 7 tests passed, including 30 placement/type/alignment
  combinations through generation, dynamic-slot substitution, marker removal
  and tracking-link rewriting. Colours, typography, padding, radius and links
  are checked independently of alignment.
- Existing hybrid-column, column-background and dynamic-token suites: 20 tests
  passed with no skips, including Chromium desktop/mobile and CSS-off checks.
- No campaigns, recipients or database rows were changed. No migrations were
  needed or applied to any database; none remain to apply.
- The app server starts, but the general workspace preview cannot resolve its
  configured tenant (`public.tenant` missing from the configured schema cache).
  This is not CTA or received-client verification.