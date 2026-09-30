# Task 4596: bounded route splitting

## Method

Ran `npx vite build --manifest` before route edits and again afterwards with the
same Vite configuration. Traversed each entry's recursive static `imports` in
`dist/public/.vite/manifest.json`, summed emitted JavaScript file bytes, and
gzip-compressed each file with Node's `zlib.gzipSync`. Dynamic imports, CSS,
fonts, and images are excluded from these initial-JavaScript totals.

| Measurement | Before | After |
| --- | ---: | ---: |
| Initial static JS bytes | 15,602,540 | 14,615,121 |
| Initial static JS gzip bytes | 3,869,388 | 3,637,042 |
| Static entry closure chunks | 1 | 1 |
| Build duration | 41.61 s | 46.18 s |

This is a reduction of 987,419 emitted bytes (6.3%) and 232,346 gzip bytes
(6.0%). Build duration is not a page-loading performance measurement.
The after-build includes concurrent task changes to portal loading/session
readiness; this is a task-working-tree comparison, not an isolated causal
benchmark of only the routing patch. No production network/CPU timings are claimed.

## Scope and safety

Sixteen editor/report routes now use module-scope React lazy components:
IEditPageEditor, CanvasPageEditor, CanvasFooterEditor, FormBuilder, NewsEditor,
ImportManager, EmailCampaignEdit, AIReports, AccessibilityAudits,
CanvasLinksManager, EventRegistrationReport, EventBudgetReport,
FormConversionReport, SurveyReports, OrganisationEngagementReport, and
AiDesignStudio. All sixteen appear as dynamic entries in the after manifest.

Routes still use their original element identities; DynamicPage, ViewPage,
HomePageRedirect and SmartLoginRoute ownership classification is unchanged.
The portal's Suspense/error boundary is inside Layout, keeping shell ownership
outside chunk loading. Standalone/admin routes have an outer boundary.
Both provide loading status and an actionable refresh error state.
Caught chunk failures call the existing loop-guarded stale-chunk recovery.
Navigation clears a previous error without key-remounting healthy pages.

`npx tsx --test client/src/components/routing/RouteLoadingBoundary.test.jsx`
passes three tests covering pending imports, shell/state preservation,
failed imports, navigation recovery, identity classification, and stale-chunk
handler wiring. Both production builds passed.

The initial chunk remains large. This bounded change deliberately does not
rewrite all routes or shared renderer/editor imports. Further splitting needs
its own dependency analysis and route-ownership regression coverage.