# Professional Groups spacing verification

## Confirmed cause

The deployed Member Group Cards block already supports signed auto-height.
The grid measurement and visible Section shrink both work. However, the
Section's collision relay retained its authored bottom, cancelling the upward
movement of following content. This creates extra space after the resized
Section, rather than inside the cards.

The fix opts Member Group Cards into shrinking the owning Section's collision
relay along with its rendered bounds. Other block types and decorative Boxes
are not opted in. Static child collision protection remains active. No card
queries, permissions, or saved page geometry were changed.

## Live guest evidence — 2026-09-19

Read-only Chromium inspection of
`https://bnms.dev.iconn.app/professional-groups`, after cards and fonts settled:

| Viewport | Cards | Grid top | Grid height | Owning Section height | Following Section top |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1440px | 9 | 1296 | 1092.39 | 1260 | 3016 |
| 768px | 9 | 1320 | 1722 | 0 (hidden) | 4735 |
| 390px | 9 | 1703 | 3092.69 | 0 (hidden) | 5528 |

Desktop coordinates include the 136px site header. Stored desktop grid height
is 1296px, Section height 1464px. The visible Section already shrinks by 204px.
Its bottom is 2444px, but the following Section remains at 3016px: a 572px gap
instead of the authored 368px. The grid-to-Section-bottom inset is approximately
56px and must remain.

The live entry bundle was `/assets/index-D7uEQ56o.js`; it contains the existing
Member Group Cards signed-auto-height definition. This was not diagnosed as
missing shrink support or simply assumed to be a stale deployment.

## Source verification

The saved desktop geometry is covered by the reflow regression tests: the
following Section moves up 204px, from authored y=2880 to y=2676 (2812 with the
live header), restoring the authored 368px gap without changing the ~56px inset.
These after-values are regression expectations, **not post-deployment live
measurements**.

The browser suite uses the actual published Canvas renderer, data hook, card
view, and reflow provider with controlled API responses. It covers loading and
cached mounts, guest/member/restricted rendering, responsive columns and hidden
Section geometry, padding, and late image/font settlement. A same-page
guest → member → guest → restricted-member test uses the real storage/session
refresh path and asserts removal of audience-specific controls. Its controlled
fixture preserves an exact 104px following-block gap across all four states.

Results: 44 layout tests and all 5 browser scenarios passed after the final
source revision. The layout suite also covers a lower static child in a separate
lane limiting Section shrink: following content retains its authored gap and
cannot move through the still-visible Section. Restricted browser views assert
the exact gap, not merely non-overlap.

Commands:

```sh
npx tsx --test client/src/components/canvas/AccordionReflowContext.test.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
  npx playwright test --config=playwright.professional-groups-spacing.config.mjs
```

Browser screenshots and numerical JSON attachments are test artifacts under
`test-results/professional-groups-spacing/`. The cold-loading reference screenshot
shows the loading state, not a pre-fix deployed page.

## Boundaries

- No authorized live member session was available; member checks use controlled
  fixtures, not a real BNMS account.
- The public site was inspected before the fix. This task does not deploy the
  source change or claim that the custom domain now serves it.
- Intentional authored whitespace remains; this is not a page redesign.
- No database migrations were needed, applied, or left pending.