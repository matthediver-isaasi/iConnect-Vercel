# Gmail sponsor columns: controlled release checklist

## Release status

**Candidate only; production rollout is blocked on received-message checks.**
This delivery is explicitly scoped to investigation, a gated test candidate,
regression coverage and test artifacts under the task's no-inbox-access fallback.
It does not close the user-facing Gmail rendering issue. Received-client validation
and activation are a blocking follow-up, not a claim of completed production rollout.
The converter's `hybridColumns: true` option is an explicit test opt-in. Ordinary
builder generation remains unchanged until those checks pass. No campaign,
recipient, template, send status or database record was changed during this work.
No test messages were sent: no test inbox was approved for this task.

The received source has the desktop percentage rule, so its mere presence does
not explain what Gmail actually applied. Removing stylesheet rules in a browser
reproduces a failure mechanism, not a confirmed Gmail diagnosis. HTML size and
Gmail clipping are a separate risk; shrinking a fixture does not prove that size
caused the original stacking.

## Isolated received-message checks

Use the sanitized before/after fixture artifacts, not the original campaign.
Obtain explicit approval for a single test inbox and sending identity first.
Send the HTML as the actual message body (not an attached HTML file), with distinct
subjects for baseline and candidate. Use an isolated transport without campaign
IDs, tracking tokens, live unsubscribe links, audience lookup or recipient writes.
Do not use the original campaign's `/api/email-campaigns/test-send` endpoint:
it can insert test recipient rows, and campaign reads can refresh stored counts.
Mailgun `testMode` is not a received-message test: it accepts without delivery.

For each result, record client/version, account type, viewport/message-pane width,
date, before/after screenshots, decoded received HTML byte size, and pass/fail:

| Client / case | Required result | Status |
| --- | --- | --- |
| Wide desktop Gmail, original message | Inspect actual applied width/max-width and surviving CSS; identify why desktop rule did not win | Pending; source alone cannot establish this |
| Wide desktop Gmail, minimal baseline and candidate | Three sponsor columns, no missing sponsors or buttons | Pending |
| Gmail mobile, portrait and landscape | Readable content, no horizontal scrolling, footer reachable | Pending |
| Classic Outlook for Windows (Word engine) | Three columns and preserved widths, gaps, backgrounds, image sizing and CTAs | Pending; a new independent check, not inferred from Gmail or new Outlook |
| Two-column and unequal-column fixtures | Configured proportions and order on desktop; readable mobile layout | Pending |
| Full-length independently sanitized copy | All sections and footer present; record any clipping separately | Pending |

Compare both minimal and full-length copies in Gmail. In desktop developer tools,
inspect column element computed width, max-width, display and box-sizing; check
whether the 480px rule survived Gmail sanitization, matched, and won the cascade.
Do not assume browser screenshots or preserved conditional comments demonstrate
real Gmail or Outlook compatibility. Do not forward the original private source
to third-party testing services without separate permission.

## Regeneration after approval

1. Pass the received-client gate above before enabling the converter option for
   ordinary builder calls. The option is not a tenant setting or a database flag.
2. Converter changes affect newly generated HTML only. They cannot change messages
   already delivered and do not automatically regenerate saved campaigns/templates.
3. For any later explicitly approved regeneration, retain an immutable original
   HTML snapshot and original design snapshot in access-controlled storage.
   Do not commit private campaign content or recipient data.
4. Validate the entire design is supported before rendering. Compare every visible
   block's content and order, image source/alt text, button text/destination,
   dynamic tokens, unsubscribe block, footer configuration and canvas width.
   A non-empty generated HTML string is not proof of completeness.
5. Review before/after HTML and decoded size, then deliver an isolated test copy.
   Replace stored HTML only after explicit approval for that specific record.
   Do not bulk regenerate templates or reopen/resend the original campaign.

## Rollback

Keep ordinary generation on its existing default while the gate is pending.
For test callers, remove `hybridColumns: true` to return to baseline output.
If later released, disable the option at converter call sites and regenerate
only separately approved drafts, or restore their exact saved HTML/design
snapshots. Reverting code does not restore HTML already saved; restoring HTML does
not retract delivered messages. Never reset recipient state or resend to undo a
rendering change.

## Delivery-path limitation

The builder-rendered tenant footer is inside the responsive MJML wrapper.
The separate `sendEmail` fallback footer now uses a fluid, desktop-bounded outer
table with an MSO-only fixed-width wrapper. Its independent browser checks and
user-confirmed received-message checks are recorded in [FOOTER-VALIDATION.md](FOOTER-VALIDATION.md).
This does not enable the hybrid-columns candidate or rewrite historical HTML.

## Automated results and artifacts

The following passed locally:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(command -v chromium)" \
  ./node_modules/.bin/tsx --test client/src/components/email-builder/hybridColumns.test.mjs
# 7 passed, no skips (including Chromium checks)

./node_modules/.bin/tsx --test \
  client/src/components/email-builder/columnBackground.test.mjs \
  client/src/components/email-builder/buttonDeliveryMarkup.test.mjs
# 11 passed

node scripts/run-isolated-tests.mjs node --test \
  api/_lib/gmailColumnsDelivery.test.mjs
# 2 passed, mocked transport and database

./node_modules/.bin/tsx tests/fixtures/gmail-columns/generated/generate.mjs
```

The Chromium checks cover 500/600/700px canvases, equal three/two and unequal
60/40 columns, viewports 320/375/479/480/481px and desktop, stylesheets present
and removed, overflow bounds, and a received-markup stacking reproduction.
They do not emulate Gmail or Word-based Outlook.

The delivery test also passes and exits normally under plain Node, as required
by the configured `ai-assistant-tests` glob. Its browser converter is imported
through a scoped tsx loader with teardown. The full configured suite was attempted
but did not pass: it reported failures in unchanged CPD, Custom Object and form
tests, then stalled after 2,267 reported tests and was stopped. No full-suite pass
is claimed. Those failures were not changed as part of this email rendering task.

`generated/` includes baseline/candidate HTML and recipient-free EML files for
both the representative received markup and a generated design with sponsors,
CTA and builder footer. The generated design embeds data-URL images for offline
viewing; Gmail may block them. Image loading in a received test must separately
use an approved benign hosted image or CID attachment, without changing layout.

| Decoded HTML | Bytes |
| --- | ---: |
| Original received HTML | 165,878 |
| Sanitized received baseline | 8,266 |
| Sanitized received candidate | 8,535 |
| Generated baseline | 15,233 |
| Generated candidate | 15,517 |

The original is above Gmail's commonly encountered approximate 102KB clipping
threshold. That is a clipping risk, not proof of the stacking cause. The candidate
does not reduce original content size. Re-measure final decoded received HTML
after personalization, link tracking and footer insertion.

The application workflow started successfully, but its general home-page preview
reported “Tenant not found”; logs show the configured database's tenant table
missing from the schema cache. No database configuration was changed to address
that separate environment issue. The email fixture browser checks are independent
of this unavailable application tenant.

## Database migration status

No migration is needed. None was created or applied to development, source,
destination or production databases. No migrations remain to apply for this work.