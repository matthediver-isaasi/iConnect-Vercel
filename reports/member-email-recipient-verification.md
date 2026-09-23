# Member Email Recipients — verification report

Date: 2026-09-23

## Result and scope

The member Communications composer uses Outlook, not campaign delivery. Source inspection found one Graph send operation, no BCC/default copy/audience expansion, and no secondary application send in this path. The original endpoint trusted client To (including arrays) and used memberId only for logging. Those were missing safeguards, **not evidence of historical misdelivery**.

The endpoint now authorizes the selected member in the active tenant and constructs exactly one To from the stored member mailbox, plus only the validated CC mailboxes explicitly supplied in this operation. CC remains intentional and supported.

## Delivery trace and safeguards

| Boundary | Source and behavior |
| --- | --- |
| Member Communications | `client/src/pages/MemberDetail.jsx` mounts `MemberEmails`. The same component also serves `AdminMemberEdit.jsx` and `MemberDetailView.jsx`. |
| Composer | `client/src/components/ComposeEmailModal.jsx`: disabled To snapshot, optional CC, exact recipient summary and visible validation. CC accepts plain mailboxes separated by commas or semicolons; no display names, address arrays, empty list entries or control/header characters. |
| Draft context | `MemberEmails.jsx` subscribes to active tenant changes and scopes history keys by tenant/member. The composer clears/closes drafts including CC on member/tenant/email changes and suppresses late results after context changes or unmount. In-flight guards prevent repeated clicks. |
| Authorization | `api/outlook/send.js` and `api/outlook/emails/[memberId].js` use canonical `getTenantContext` + `hasAdminAccess` from `api/_lib/tenantContext.js`. Send requires matching submitted, resolved and session tenant IDs; history requires the matching explicit tenant header. Member lookup is tenant-scoped. Missing/anonymized members fail closed. Login-disabled contacts are not considered deleted merely because login is disabled. |
| Recipient validation | `shared/memberEmailRecipients.mjs` is shared with the UI. Client To must be one plain mailbox matching the server mailbox (case-insensitive); a stale address returns 409 requiring review/refresh. Invalid stored addresses, lookup errors and unauthorized/wrong-tenant targets stop before token access or provider sending. Unknown request fields, including BCC and alternative recipient containers, are rejected. |
| Outlook identity | Connection selection remains scoped to session tenant and caller identity. `api/_lib/microsoftGraph.js` only obtains/refreshes the access token on this path; it does not add recipients or send a second message. |
| Provider envelope | `api/outlook/send.js` constructs a fresh Graph JSON payload: subject, body, exactly one `toRecipients` entry, optional explicit `ccRecipients`, and `saveToSentItems`. There is one POST to `/v1.0/me/sendMail`, with no retry or campaign helper. Sent Items is a stored mailbox copy, not another recipient. |
| After acceptance | One `member_email` history insertion records the validated target and actual To/CC envelope. Returned errors and thrown logging failures after acceptance produce success with a warning, not a retryable send failure. Graph transport ambiguity returns `deliveryUnknown`; the UI blocks retry of that draft and directs the sender to check Sent Items/history. Provider acceptance is not a delivery receipt. |
| Other tab operations | `api/outlook/sync.js` calls `api/_lib/outlookSync.js` to read Graph messages and store them; pin/flag updates change history metadata. Compose success refetches history. None of these operations sends another message. |

History reads remain admin-only and tenant/member-scoped, retaining the existing agent-only/intra-organisation visibility filters. The separate sync and pin/flag authorization policies were not redesigned as part of the send boundary.

## Isolated regression evidence

Commands:

```sh
node scripts/run-isolated-tests.mjs node --test shared/memberEmailRecipients.test.mjs api/outlook/send.test.mjs api/outlook/emails/memberId.test.mjs
node scripts/run-isolated-tests.mjs node --import tsx --test client/src/components/ComposeEmailModal.test.jsx
node scripts/run-isolated-tests.mjs node --test api/_lib/outlookOAuthRedirect.test.mjs api/auth/outlook/callback.test.mjs
git diff --check
```

Results: **15 backend/parser/history tests, 8 rendered composer tests, and 12 focused OAuth tests passed; diff checks passed.** Tests use synthetic example-domain addresses and mocked dependencies, not live members, databases or Microsoft mailboxes.

- Full final Graph payload and exact logged envelope; one total provider request for member-only, omitted/blank CC, one CC and multiple explicit CC.
- Zero sends and zero token access for authorization/tenant failures, missing/deleted/wrong-tenant targets, invalid stored mailboxes, forged/stale/multiple To, unsupported BCC fields, malformed CC/header injection, and lookup errors/throws.
- Provider rejection, ambiguous network outcome and both returned/thrown post-acceptance history errors.
- History authorization and tenant predicates, including legitimate login-disabled contacts.
- Disabled To and explicit CC summary; malformed CC blocked before sending; member/tenant switching clears drafts; late responses after switching or unmount do not update another context; unknown delivery prevents retry.
- Unexpected global network access is blocked; the send route has no campaign dependency.
- Dismissing via the built-in close button during an unresolved send cannot clear the duplicate-send fence; Escape and outside dismissal are also prevented while sending.

Completion review additionally identified a redirect mismatch in concurrently merged Outlook OAuth work. A narrow correction shares validated redirect construction between `api/auth/outlook.js` and `api/auth/outlook/callback.js`, carries the exact URI in signed state, and tests the exchange parameter and hostile redirect rejection. Production's canonical callback is unchanged. This is a small scope extension, not live OAuth verification or a broad connection redesign.

An initial combined command used `npx` inside the isolation boundary and was rejected for spawning a child process. Running the frontend suite directly through `node --import tsx` passed without weakening isolation.

## Earlier report and verification limits

The earlier [campaign safety audit](../docs/campaign-safety-audit-report.md) concerns campaign audience targeting, emergency stop and test mode. It is a different delivery pipeline and is not evidence for this Outlook composer. No dedicated earlier Outlook recipient report was found.

This is source and local fixture verification, **not deployed verification**. No live emails were sent and no historical delivery investigation was performed. Microsoft-side forwarding, distribution-list expansion, mailbox rules and transport rules are outside application control. The member address is resolved at request time; the app does not lock member edits across the external provider operation.

The development server started on port 5000. A root-page screenshot showed “Tenant not found”; logs showed the configured development database lacked the tenant table in its schema cache. Consequently this check does not establish a working authenticated live Member Detail page. Composer behavior was verified in isolated rendered tests instead. No database target or credentials were changed to work around this environment limitation.

## Database migrations

**None needed, none applied to any database, none pending for this change.** Existing Outlook schema readiness and OAuth configuration are separate concerns.