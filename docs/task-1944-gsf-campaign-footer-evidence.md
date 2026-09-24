# Task 1944: GSF campaign footer evidence

Investigation date: 2026-09-24 UTC.

## Scope and method

This was a read-only inspection of production Supabase project
`lvmzliemqnieeoruhkik` through the authorized Supabase MCP SQL tool. Queries
were limited to exact columns and bounded rows for GSF tenant
`21296ad6-1350-483a-a90c-1b06ece70501`. No email was sent and no database,
provider, or tenant configuration was changed.

The stored HTML itself is not included here. Only structural counts and hashes
needed to reproduce the diagnosis were retained.

## Production evidence

The two affected GSF rows are structurally identical:

| Campaign | ID | Sent at (UTC) | Stored HTML |
| --- | --- | --- | --- |
| Snapshot 23 September 2026 | `4bf9a266-11f2-4366-a266-7572fe32d7e7` | 2026-09-24 09:10:32.112 | 100,018 bytes; MD5 `ec0522e2d22cf7ff1f6282b6c24bbf0d` |
| Snapshot 24 September 2026 | `b1229b59-3d77-4af6-94a8-a162785168b7` | 2026-09-24 09:37:37.079 | 100,018 bytes; MD5 `ec0522e2d22cf7ff1f6282b6c24bbf0d` |

For each row:

- `design_json` exists, has 26 top-level blocks, and specifies a 600px content
  width.
- Recursive block inspection found no block with `type = 'unsubscribe'`.
- `html_content` contains the tenant's configured `email_footer_html` value
  exactly once (`strpos` match and exact-string occurrence count = 1).
- The stored HTML has one GSF copyright line and the generated
  `tenant-email-footer` / `tenant-email-footer-outlook` wrapper markers.
- The configured footer is 1,655 bytes, MD5
  `408f7640e48e454dc9c69bbe3d1cf250`, and contains neither an unsubscribe
  placeholder nor “manage email/communication preferences” text.

This identifies the first footer source exactly: the configured tenant footer
was already embedded in each campaign's persisted `html_content`.

## Code-path correlation at investigation start

The committed production path in `api/_lib/campaignService.js` treated a visual
campaign as `skipFooter = true` only when `design_json` contained an
`unsubscribe` block. These rows have no such block, so their persisted embedded
footer did **not** suppress footer insertion. `sendEmail()` in
`api/_lib/emailService.js` therefore loaded and appended the same tenant
`email_footer_html` configuration again. That is the second footer source.

The committed test-send paths differed:

- `api/email-campaigns/test-send.js`
- `api/member-campaigns/test-send.js`

Both set `campaignSkipFooter = true` whenever `design_json` existed. For these
same rows, a test send therefore kept the one embedded footer and skipped the
second append, while the production send appended it. This is the concrete
test-send/live-send parity gap.

Both production and test paths could also add the separate “Manage email
preferences” fallback when there was no unsubscribe placeholder/block. That
fallback is a preference link, not the configured GSF branding footer, but its
selection should still be shared to preserve parity.

## Evidence limitation

Production stores campaign source HTML and Mailgun message identifiers, not the
recipient's final received MIME/HTML source. No mailbox or provider message
body was inspected in this task. The duplicate is therefore established from
the exact persisted input plus deterministic send-path behavior, not from a
captured received email. Final payload regression tests should be the
implementation proof that only one configured footer reaches Mailgun in both
live and test sends.

## Verification and test-send safety

Isolated transport tests reproduce the embedded-footer structure through both
test handlers and the immediate/scheduled delivery entry points. They assert
one branding footer and the required preferences section in HTML and plain text.
Additional tests cover builder unsubscribe aliases before click rewriting and
unsafe alias locations introduced by recipient interpolation.

Test sends intentionally use non-actionable `#` preference destinations and
omit one-click unsubscribe headers. They do not create recipient records or
mint subscription credentials. This is a deliberate exception to test/live
parity: synthetic test identities cannot resolve at the production preference
endpoints, and tests must not alter real subscriptions. Actual immediate and
scheduled deliveries retain recipient-specific links and one-click headers.