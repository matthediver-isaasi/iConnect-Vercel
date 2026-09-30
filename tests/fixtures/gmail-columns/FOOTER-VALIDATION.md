# Automatically appended footer validation

## Status

Implementation and isolated automated checks pass. **The user confirmed all three
widths pass in Gmail mobile, Gmail desktop and classic Outlook.** On 2026-09-22, Mailgun accepted all
three synthetic 500/600/700px messages for the chat-approved inbox and From
address. Tracking was disabled. No audience was accessed or stored HTML rewritten.

Earlier attempts inferred the Mailgun sending domain from the From address and
were rejected with HTTP 401. Read-only domain discovery established the actual
verified sending domain; explicitly using it with the dedicated test key resolved
the send failure without changing the approved From address or application
credentials. Transport acceptance alone does not establish inbox receipt or
correct Gmail/Outlook rendering.

The automatic send-time wrapper is now 100% wide up to the configured desktop
width (600px by default). Classic Outlook receives a conditional fixed-width
table. Existing tenant-footer processing is unchanged, and the new wrapper
preserves the processed inner HTML byte-for-byte. This is not a general repair
of arbitrary fixed-width or non-wrapping content within tenant HTML.

## Automated checks

```sh
node scripts/run-isolated-tests.mjs node --test api/_lib/gmailColumnsDelivery.test.mjs
node --test api/_lib/emailFooterLayout.test.mjs
```

- Mocked transport: four tests pass, including 500/600/700px appended footers and
  the existing builder-footer exclusion path.
- Layout: three tests pass with no skips, including Chromium at
  320/375/479/480/481/1000px viewport widths, with and without stylesheets.
- Verified desktop bounds and centering, no horizontal overflow, image sizing,
  text, colors, links, default/invalid widths, and MSO conditional dimensions.
- Application workflow starts successfully. The general preview still reports
  `Tenant not found`, as previously documented in ROLLOUT.md; the isolated footer
  checks do not depend on that tenant.

These checks are not proof of received Gmail or Word-based Outlook rendering.

## Required received checks

The three approved examples have been submitted; do not resend without need.
For any additional approved checks, use isolated transport, not a campaign test-send route;
do not create recipients, access audiences, use live tracking/unsubscribe tokens,
or mutate stored campaign/template HTML. Mailgun test mode does not deliver and
cannot satisfy this requirement.

`scripts/send-footer-layout-check.mjs --send TO FROM WIDTH [eu|us] [SENDING_DOMAIN]` sends exactly one
synthetic test through Mailgun, with tracking explicitly disabled and an inline
PNG (no third-party image requests). It uses the same wrapper helper as sendEmail,
has no database or campaign imports, and does not retry or fall back to a different
sender. It requires the dedicated `MAILGUN_LAYOUT_TEST_API_KEY`, not the normal
application sending credential. Recipient and sender approval is supplied at
invocation, not stored here.

The following results are user-reported from the approved inbox. No screenshots,
received source, client versions, exact viewport sizes or orientation breakdown
were supplied; these are not independent agent-observed client results.

| Client | Required result | Status |
| --- | --- | --- |
| Gmail desktop | Configured desktop width, centered footer, intact content/colors/images | User confirmed pass for 500/600/700px |
| Gmail mobile | Footer fits message pane without horizontal scrolling or missing content | User confirmed pass for 500/600/700px; orientations unspecified |
| Classic Outlook for Windows | Configured width and preserved padding/content/colors/images | User confirmed pass for 500/600/700px |

No database migration is needed, created, or applied to any database. None remains
to apply.