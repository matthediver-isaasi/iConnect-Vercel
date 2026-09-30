# Gmail sponsor columns: controlled release checklist

## Release status

**Approved for normal generation on 2026-09-22, based on user-observed received tests.**
The user confirmed the corrected full-length candidate was “perfect”, then
explicitly confirmed all minimal/generated-three/generated-two/generated-60-40
cases in Gmail desktop, Gmail mobile and classic Outlook. They explicitly waived
Gmail applied-CSS evidence: “not required, tests are good”.

`designToHtml` now defaults to `hybridColumns: true`; existing normal callers
inherit that default. Explicit `hybridColumns: false` remains the rollback path.
This is a code change for newly generated HTML, not a claim of deployment.
No saved campaign, recipient, template, send status or database record was changed.

### Evidence boundary and approved deviation

Received-client visual results were reported by the user, not independently
captured by the agent. No screenshots, exact client versions/pane dimensions,
downloaded received MIME or computed CSS were supplied. Original Gmail stacking
causation remains unproven. The user accepted the visual tests and waived further
CSS evidence; the original forensic evidence checklist was therefore not completed.
The historical pending statuses below describe the investigation before this
release decision, not a claim that those missing artifacts were later collected.

### Historical investigation and transport record
Mailgun accepted 20 isolated test messages on 2026-09-22. The user subsequently
reported successful full-length candidate rendering in Gmail desktop, Gmail
mobile and classic Outlook; the remaining release evidence is incomplete.
The user approved two test inboxes, the BNMS
display name, and both minimal and full-length sanitized baseline/candidate
copies in the task conversation. Classic Outlook for Windows is available to
the user for independent inspection.

### Sending authorization and transport evidence

The approved From domain `mail.bnms.org.uk` returned HTTP 404 from Mailgun's
domain lookup in both EU and US regions using this workspace's existing
credentials. A read-only domain listing found `bnms.iconn.app` active in the EU
region instead. The user subsequently explicitly approved
`BNMS <noreply@bnms.iconn.app>` for both inboxes.

The isolated run `client-check-01` passed preflight for five baseline/candidate
pairs per inbox (20 individual messages planned). Mailgun rejected the first
message request with HTTP 401; the sender stopped immediately. The other 19
messages were not attempted. No delivery or received-client pass is claimed.
The existing credentials could read domain configuration but did not authorize
this send. The user then supplied a separate test-only sending credential;
the application's shared credential was not changed.

Run `client-check-02` was rejected with HTTP 400 on the first message and stopped.
The MIME string was changed to a Buffer so the SDK posts it as a file part.
Run `client-check-03`, starting at 2026-09-22 18:39:14 UTC, was accepted for all
20 messages (10 per inbox). See `generated/send-acceptance.json` for sanitized
per-message status, timestamps, HTML byte sizes and SHA-256 hashes.
Private provider IDs and inbox addresses remain only in the conversation and
local `/tmp/bnms-layout-client-check-*.json` transport journals, not this report.

Subjects begin `[BNMS layout client-check-03]`, followed by `received-minimal`,
`generated-three`, `generated-two`, `generated-60-40`, or `received-full-length`,
then `BASELINE` or `CANDIDATE`. Provider acceptance is not inbox delivery or a
rendering pass. Received HTML byte sizes, screenshots, client versions, pane
widths and applied Gmail CSS are still required before enabling the candidate.

No campaign route, application database query, recipient write, or template
regeneration was performed. The standalone sender uses raw multipart MIME with
base64 HTML and a CID PNG, disables open/click tracking, and journals each
attempt before transport. Do not automatically retry uncertain transport outcomes.

Additional prepared artifacts include CID-image minimal copies, two-column and
60/40 fixtures, and independently sanitized full-length copies under `generated/`.
See `EVIDENCE.md` and `generated/full-length/manifest.json` for structural checks
and limitations. The received-client gate remains open as detailed below.

The full-length candidate bounds all 30 multicolumn elements in 11 sections,
including all 24 three-column sponsor elements. Baseline/candidate retain 303
tables and 185 Outlook conditional comments. Sanitized decoded HTML sizes are
147,611 / 148,852 bytes; these are pre-send sizes, not received MIME evidence.

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
| Wide desktop Gmail, original message | Inspect actual applied width/max-width and surviving CSS; identify why desktop rule did not win | Waived by user; root cause not established |
| Wide desktop Gmail, minimal baseline and candidate | Three sponsor columns, no missing sponsors or buttons | User-reported pass for corrected batch; no screenshots |
| Gmail mobile, portrait and landscape | Readable content, no horizontal scrolling, footer reachable | User reports mobile checks good and all corrected cases correct; no separate orientation captures |
| Classic Outlook for Windows (Word engine) | Three columns and preserved widths, gaps, backgrounds, image sizing and CTAs | User-reported pass, independent of Gmail; no version/screenshots supplied |
| Two-column and unequal-column fixtures | Configured proportions and order on desktop; readable mobile layout | User explicitly confirms all cases correct in all three clients |
| Full-length independently sanitized copy | All sections and footer present; record any clipping separately | Corrected candidate reported “perfect”; earlier clipped candidate retained columns in inbox and expanded view |

### User-observed received results (2026-09-22)

For `[BNMS layout client-check-03] received-full-length CANDIDATE`:

- Gmail desktop: displayed correctly in the inbox view. Gmail clipped the
  message; opening “View entire message” in another window retained three columns.
- Gmail mobile: user reported “best results” with this same candidate, without
  specifying orientation, app version, dimensions, overflow or footer reachability.
- Outlook: user reported that this candidate “worked well in the Outlook client.”
  Classic Outlook for Windows availability had been confirmed before sending.

These are user reports, not independently inspected screenshots or applied-CSS
captures. No screenshot or received-source file was supplied. Baseline results,
minimal and proportion-case comparisons, versions/account types, dimensions,
decoded received sizes, and Gmail computed styles remain outstanding. Do not
infer that clipping caused the original stacking; the reported clipped candidate
retained its columns both before and after expansion. Ordinary generation remains
unchanged until the release gate is satisfied.

Compare both minimal and full-length copies in Gmail. In desktop developer tools,
inspect column element computed width, max-width, display and box-sizing; check
whether the 480px rule survived Gmail sanitization, matched, and won the cascade.
Do not assume browser screenshots or preserved conditional comments demonstrate
real Gmail or Outlook compatibility. Do not forward the original private source
to third-party testing services without separate permission.

## Regeneration after approval

### Image failure and corrected isolated batch

The user subsequently clarified that **all images were missing** in the earlier
reported results, including the full-length candidate. Mobile layouts otherwise
looked good. The earlier results therefore do not pass image sizing/completeness.

Local decoding found the test PNG corrupt (invalid chunk data and failed zlib
checksum), despite a recognizable PNG header. It has been replaced with a locally
generated, visibly blue/green/orange RGB placeholder. Chunk CRCs, dimensions and
full pixel decompression are now tested, including corruption/truncation rejection;
the sender validates the image before transport. Two focused tests passed and the
replacement image was visually inspected locally.

The same approved isolated fixture set was resent as `client-check-04`: all 20
messages were accepted by Mailgun. See `generated/send-acceptance-04.json` for the
image hash and sanitized transport evidence. HTML hashes match the earlier batch;
only the image payload and identifying transport headers changed. No original
campaign was resent. Use this corrected batch for image/rendering evidence.
Received screenshots, sources, applied CSS and remaining comparisons are still
pending. The production converter remains disabled by default.

The user subsequently reported that
`[BNMS layout client-check-04] received-full-length CANDIDATE` is “perfect” in
response to the corrected-image check. This supersedes the missing-image report
for that corrected full-length candidate as a user-observed visual result.
No screenshots or received sources accompanied the confirmation, and it did not
separately report the minimal, generated-three, generated-two or generated-60-40
pairs. Do not extrapolate this result into a complete release-matrix pass.

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

Set the `designToHtml` default back to `hybridColumns: false`, or explicitly
pass false at an individual call site, to return future generation to baseline.
Do not simply remove an explicit true option: the default is now enabled.
Regenerate
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

node --test tests/fixtures/gmail-columns/fixture-image.test.mjs
# 2 passed: full PNG decoding/checksums and corruption/truncation rejection
```

After enabling normal generation, all 22 focused tests above passed with no skips
(18 converter/background/button tests, 2 isolated delivery tests, 2 image tests).
The Chromium layout and mocked delivery checks exercise the enabled default,
and explicit rollback is covered independently.

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