# Regional Leads spacing verification

## Confirmed cause

Read-only inspection on 2026-09-19 confirmed that
`https://bnms.dev.iconn.app/regional-leads` already served the Professional
Groups Section-relay fix. Its entry asset was `/assets/index-DWP1F35k.js`,
containing both `shrinkOwningSectionRelay` and the Member Group Cards opt-in.
The remaining desktop gap was therefore not explained by deployment lag.

Regional Leads has a different saved structure: the desktop cards begin at
y=1248 with stored height 2296, while their Section begins at y=1008 with
height 2248. The cards' authored bottom extends 288px beyond the Section.
Following “Working together” content begins at y=3624.

The signed row's synthetic reflow source discarded its members'
`allowSectionBottomOverflow` eligibility. The Section opt-in recognized the
cards, but the effective shrink calculation excluded them. The Section
remained full height and its collision relay prevented following content
from moving up.

The correction carries that eligibility into signed row sources. It changes
neither card content nor authorization, and does not alter saved geometry,
ordinary block shrink rules, or the grow-only policy for decorative Boxes.
Static child bounds continue to constrain Section shrink.

Browser verification then exposed a second part of the same defect: the raw
card shrink could still move external following content farther than the
Section's effective shrink. Opted-in content now delegates that downstream
signed displacement to its owning Section, rather than applying both paths.

## Live guest baseline

These are **pre-correction deployed measurements**, not post-deployment results.
Coordinates include the site's header.

| Viewport | Card top | Card height | Section height | Following top | Card-to-following gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1440 | 1384 | 1457.98 | 2248 | 3760 | 918.02 |
| 768 | 1404 | 2292 | 2578 | 3756 | 60 |
| 390 | 2025 | 4311.81 | 4710 | 6365 | 28.19 |

All three show 15 cards. Measurements and sanitized saved layout are recorded
in `reports/regional-leads-live.json`; screenshots are in
`screenshots/regional-leads-live-{1440,768,390}.png`.

For the rounded desktop measurement of 1458px, the unit regression expects the
Section to shrink by 550px, not by the cards' entire 838px reduction. The
Section must still contain the visible cards. Following content moves up by
the same 550px, retaining the authored 368px Section-to-following gap rather
than pulling content through the Section. Expected following top with the live
136px header is 3210px. This is a source-level expectation, not a live after
measurement. Tablet/mobile authored geometry and spacing remain distinct.

## Verification and boundaries

Final results: **46/46 focused layout tests and 9/9 browser scenarios passed**
(4 Regional Leads, 5 retained Professional Groups).

The Regional suite uses synthetic content and identities with the page's saved
card, owning-Section, following-heading and terminal geometry. It checks 15
cards in 3/2/1 columns, loading-to-content, late images/fonts, guest/member
footprints, same-page guest → member → guest transitions, and exact downstream
and stage displacement. The terminal Section must move only once; tests reject
applying both the raw card delta and the effective Section delta.

Local controlled after-values (not comparable pixel-for-pixel to live copy):

| Audience | Width | Card height | Section height | Following top | Stage height |
| --- | ---: | ---: | ---: | ---: | ---: |
| Guest | 1440 | 1589.98 | 1830 | 3295 | 4881 |
| Member | 1440 | 1769.98 | 2010 | 3475 | 5061 |
| Guest | 768 | 2520 | 2806 | 3984 | 5657 |
| Member | 768 | 2772 | 3058 | 4236 | 5909 |
| Guest | 375 | 4763.81 | 5162 | 6817 | 9187 |
| Member | 375 | 5195.81 | 5594 | 7249 | 9619 |

Guest/member card-to-following gaps are 368px desktop, 60px tablet, and
approximately 28px mobile, preserving the page-specific authored constraints.
Member content remains taller; logout restores the guest footprint.

Commands:

```sh
npx tsx --test client/src/components/canvas/AccordionReflowContext.test.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
  npx playwright test --config=playwright.regional-leads-spacing.config.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
  npx playwright test --config=playwright.professional-groups-spacing.config.mjs
```

Numerical guest/member JSON and six settled screenshots are generated under
`test-results/regional-leads-spacing/`, named
`regional-{guest,member}-settled-bounds.json` and
`regional-{guest,member}-{desktop,tablet,mobile}-settled.png`.

- The focused reflow suite includes the actual Regional Leads desktop
  overflow structure alongside the retained Professional Groups and
  static-child/decorative-container regressions.
- The application workflow was restarted after the runtime change and came
  up cleanly on port 5000.
- No authorized live BNMS member session was available. Authenticated
  verification uses controlled browser fixtures, not a real member account.
- No deployment was performed. The inspected public bundle contains the
  earlier relay fix but still exhibits the defect corrected here.
- No database migrations were needed, applied to any database, or left
  outstanding. No live data or page geometry was edited.