# Initial public Canvas layout — verification

## Diagnosis and scope

On 2026-10-06 the public navigation API at graduatefutures.org identified Book
as `/leadership-conference-2027/book`. The public page API confirms Canvas V1,
not the flow renderer. Its microsite typography endpoint identifies Plus Jakarta
Sans, description 26px/1.2 at weight 600 with 24px bottom margin. The desktop
description is x21/y120/w480/h149; date/location labels are y269, icons y264,
and both CTA frames y334.

A normal live Chromium visit at 1440×900 settled correctly. The live screenshot
also showed correct alignment. Neither proves that the intermittent failure is
gone: the custom domain still serves `index-mxS59MZe.js` and
`index-CH82jXng.css`, not this candidate. No deployment was made.

The browser fixture preserves those desktop positions but controls typography,
font weight and font-face size-adjust so Linux reliably crosses a line-wrap
boundary. It uses a locally served Plus Jakarta Sans font (SIL OFL license beside
the fixture). APIs are intercepted; no fixture requests write to a database.
It is deliberately not a full live-page reproduction.

Two races fail against the pre-change production-style build:

* With typography seeded before mount, document.fonts.ready resolves before
  discovery/CSS registration. Discovery, CSS and font download each wait 1700ms.
  Description height changes from 117.140625 to 148.1875px. The old baseline
  keeps icons at y295 and CTA at y365; labels remain y269. The candidate restores
  icons to y264 and CTA to y334 without refresh/resize.
* With asynchronously discovered typography as well, the initial short
  measurement produces a 100px persistent offset (icons y364, CTA y434).
  The candidate also repairs this case.

This establishes the lifecycle defect independently of stale deployment assets.
It does not claim to reproduce the exact timing of the supplied screenshots.

## Correction

Measurements identify each block's current font styles, relevant registered
FontFace statuses and width. Only a changed metric identity replaces that block's
minimum baseline. A shared, cleaned-up subscription observes stylesheet completion
and font success/error and remeasures after two frames. ResizeObserver continues
to handle actual size changes. There is no global loading gate, polling loop or
four-second cutoff: even much later assets can repair a fallback baseline.

Accordion answer panels report their contribution separately so their collapsed
footprint remains measurable during user expansion, including before font arrival.
Unrelated font events do not reset card growth. Once a card has grown from live
content, even relevant font changes retain its resting reference conservatively:
the expanded content is not evidence of the original baseline. Subtree style
observation catches margin-only changes that ResizeObserver cannot see.
Stored geometry, spacing rules,
lazy renderer boundaries and editor imports were not rewritten.

## Verification

Built both trees with the same installed dependencies:

```sh
npx vite build --outDir /tmp/layout-baseline --manifest
npx vite build --outDir /tmp/layout-candidate --manifest
npx vite preview --outDir /tmp/layout-candidate --port 5002
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5002 npx playwright test --config=tests/layout-fonts.config.mjs
node --import tsx --test client/src/components/canvas/autoHeightBake.test.mjs client/src/components/canvas/AccordionReflowContext.test.mjs
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5002 npx playwright test --config=client/src/components/navigation/publicPageNavigation.browser.config.mjs
node scripts/check-website-entry-budget.mjs /tmp/layout-candidate
```

* All nine focused browser scenarios pass on the final production-style build,
  covering the isolated font-only failure and combined
  typography/font failure. Both delayed-layout regressions fail on baseline.
* Cold entry, ordinary reload, cache-disabled reload, client navigation and
  desktop→mobile→desktop return preserve settled hero geometry.
* Failed discovery, stylesheet and font download remain usable; success beyond
  four seconds recovers; early accordion expansion remains reversible.
* Dynamic card growth, equalized row heights and unrelated font completion pass.
  Additional regressions cover relevant font arrival after growth and margin-only
  style changes with no border-box resize.
* 97 existing auto-height/reflow unit tests pass. These require the tsx loader;
  plain Node cannot resolve an existing extensionless import.
* All 19 existing public-navigation browser tests pass.
* Workflow restart succeeded on port 5000. The workspace host still returns
  “Tenant not found”; tenant rendering evidence above uses live reads and isolated
  fixtures rather than claiming that workspace hostname is a configured tenant.

## Performance

Static entry graph bytes: baseline 6,473,773, final candidate 6,474,268.
Gzip: baseline 1,615,867, candidate 1,615,942. The budget check confirms CanvasPageRenderer and selected
heavy editor/admin routes remain outside the static entry closure.

Same timing harness, built assets, three fresh contexts per entry, API metadata
300ms and page 500ms delays; baseline and candidate ran sequentially after builds.
Cold real-content samples in milliseconds:

| Entry | Baseline | Candidate |
| --- | --- | --- |
| `/` | 1531,1459,1514 | 1496,1447,1491 |
| `/nav-a` | 1148,1136,1141 | 1152,1160,1142 |
| `/branch` | 1471,1480,1543 | 1474,1455,1490 |
| `/branch/nav-a` | 1145,1186,1173 | 1147,1160,1141 |

Median changes: -23, +11, -6, -26ms respectively. Warm no-intent medians remain
540–550ms. These local fixture timings are not production speed guarantees.

## Release boundary

No migrations needed, applied or pending on any database. No saved-content
changes, production writes or deployment. After a separately approved release,
verify the actual custom-domain bundle and repeat cold/reload/navigation checks;
source completion alone is not evidence of public rollout.
