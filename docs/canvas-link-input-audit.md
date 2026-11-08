# Canvas inspector link layout audit

## Scope and results

Audited the registered inspectors in `blocks/registry.jsx` and
`blocks/dynamicBlocks.jsx`, their delegated membership, advanced-accordion,
AI composition and Featured Job editors, and the rich-text toolbar.
The actual Builder inspector is 288px including its border and 12px padding.
Nested list borders/padding further reduce its available width.

### Shared LinkField: 16 callsites

All retain their existing value, picker events, test IDs and new-tab callbacks.
Only the input/action layout changes: full-width single-line input, followed
by wrapping nonshrinking page/file/optional section buttons.

| Inspector | Link surfaces | Parent layout |
| --- | --- | --- |
| Hero | CTA items | Nested list, full row |
| Image | Optional link | Full row |
| Button | Link target | Full row |
| FAQ / Accordion | Item links | Two nested lists |
| Card | CTA | Full row |
| Logo strip | Logo link | Nested list |
| Mega Menu | Direct, column item, featured links | Up to three nested lists |
| Pricing table | Tier CTA | Nested list |
| Hero Carousel and mobile variant | Slide CTA | Changed half-width CTA text/link grid to vertical stack |
| Speaker carousel | Custom CTA | Full row |
| Sponsor grid | Empty-category CTA | Full row |
| Sponsor carousel | Empty-category CTA | Full row |
| Payment Details | Manage payments, renewal | Full rows |

Membership Summary uses the same inspector but does not expose the payment
destinations. Advanced Accordion delegates its selected child's settings to
the registered inspector; reusable-symbol content uses the same CanvasBuilder
and inspector with no alternate link implementation.

### Additional affected entry surfaces

- RichTextField passes `anchorOptions` (including an empty array) to the shared
  RichTextEditor. In that Canvas mode only, URL entry now takes a full row;
  section picker, new-tab switch and confirmation wrap below. Non-Canvas
  email editors retain their existing layout.
- Featured Job delegates to the iEdit editor. Its CTA text/URL grid is stacked
  only with the new Canvas-only inspector prop; the separate iEdit builder is
  unchanged.
- AI Code Composition's unresolved external URL/anchor/email/tel action entry
  shared a row with its resolve button. Entry now occupies a full row.
  Content-search and composition-ID fields are not URL inputs and are unchanged.

### Already usable / no link-entry change needed

- Hero background video, Video URL and captions URL already have independent
  full rows. Image/background media URLs use ImageField's independent input;
  media selection dialogs are outside this audit's change scope.
- Text, hero/slide copy, accordion answers, testimonials and other rich-copy
  fields use RichTextField; their inline link controls inherit the Canvas fix.
- Custom HTML and Data Table author content rather than exposing a separate
  URL entry. No content schema or renderer is changed.
- Section, Columns, Spacer, horizontal/vertical Divider, Box, Icon, Stat,
  Map, Countdown, testimonial grids, news ticker and card-flip grids have no
  additional structured destination entry; selected content/source controls
  and rich text remain as above.
- Event list/teaser/registration/sessions/carousel, speaker grid, directory
  carousel, article/resource lists, resource showcase, form/campaign embeds,
  member/dynamic directories, member groups/cards, card deck, wall of fame,
  gallery, login, search and dashboard widgets use source selection or
  generated navigation rather than extra free-text destination inputs.
- AI Composition attachment uses composition IDs, not a URL field.

## Verification

`playwright.canvas-link-widths.config.mjs` includes the new real-route geometry
tests and the existing pane-scroll and symbol-content tests. All API traffic
is intercepted by isolated fixtures; no real tenant records are written.
Geometry assertions measure the real inspector, full available input row,
picker bounds and pane overflow at 1440px and 1200px editor viewports, with
and without anchors. Coverage includes nested FAQ and Mega Menu, carousel,
membership, dynamic CTA, selected advanced-accordion child and symbol editing.
Long URL native scrolling, section selection, new-tab and save/reopen are
covered alongside existing real page/file picker tests.

Run:

```sh
npx playwright test --config playwright.canvas-link-widths.config.mjs
node --test client/src/lib/canvasLinks.test.mjs
```
