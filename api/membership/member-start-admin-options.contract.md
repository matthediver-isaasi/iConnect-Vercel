# Admin Start / Renew payment options

## Authority and rollout

Invoice and No charge are tenant-admin finance actions, not member payment
choices. Both use the existing `create_member_start` transaction, member lock,
immutable request, confirmation fingerprint and purchase/period guards.

Apply `202612310025_member_start_admin_waiver.sql` after the existing Start,
payment-authority and member-choice migrations. It is additive and does not
rewrite historical periods. New No charge creation fails closed until the
capability is present. Existing saved requests can still be resumed.

Invoice additionally requires:

- `ACCOUNTING_REQUEST_QUEUE_ENABLED=true`;
- `member_membership_history` in `ACCOUNTING_REQUEST_QUEUE_SOURCES`;
- the durable accounting queue schema and worker;
- an explicitly selected Xero or QuickBooks provider with a valid stored
  connection/company binding;
- the existing membership invoice reconciliation cron.

No deployment, production migration, live financial write or test email was
performed for this change.

## Financial result

No charge preserves the ordinary calculated amount and original structure in
the immutable quote. The request records the authenticated actor and reason;
the waiver applies only to the purchased period. Net, VAT and gross due for
that period are zero. The existing zero-due paid workflow owns activation.
No payment token, provider plan, invoice or collection is created. Later
pricing still uses the unchanged configuration, not a new free structure.

Invoice history is persisted before provider work. Queue identity is the
tenant, history source type and purchase record ID. Retries resume it; linked
invoices are reused. Incomplete queue work still owns notification recovery.
Linking does not mark the purchase paid. The existing sweep selects unpaid or
partial records with a linked accounting invoice and applies settlement.

History labels No charge only from explicit immutable Start evidence, never
from a null method alone. Admin invoice history distinguishes queued, retry,
uncertain, review, unavailable and not-yet-queued work. Linked invoice viewing
and downloading remain independent of paid status.

## Verification evidence and limits (2026-11-03)

- Isolated PostgreSQL tests cover positive-price and zero-price Starts,
  concurrent same-key submissions, invalid waiver rollback, immutable records,
  tenant/role boundaries, and rejection of invoice/free member-choice selection.
- Mock-provider queue tests cover concurrent leases, write-intent persistence,
  uncertain outcome recovery, provider lookup before retry and scoped linking.
- Reconciliation tests cover unpaid-to-paid transitions with preserved period
  dates and one paid workflow.
- Mounted React tests cover No charge confirmation, retained retry keys,
  immediate history invalidation, invoice unavailable reasons, explicit free
  evidence, historical Unknown and unpaid invoice actions.
- Vercel's connected project reported a READY production target. Its domain
  metadata verified `www.bnms.org.uk`. Read-only requests fetched the public
  entry bundle `index-CcdIktKL.js` and member route
  `MemberDetail-5f4VQVl_.js`; neither contained the current admin Start / Renew
  heading, Invoice option text or member-start API path. This is evidence of
  source/live frontend differences, not proof of tenant finance configuration.
- The live member-start API returned 401 without authentication. Authenticated
  BNMS discovery/availability and the signed-in deployed UI were not verified.
- The local application starts, but its default public preview returns Tenant
  not found against the workspace's legacy database. The screenshot therefore
  does not verify the authenticated membership screen; mounted fixtures do.

Merge/rollout must preserve the project's destination-only migration policy.
Do not infer that merging these files updates an already-served custom-domain
bundle or enables the production queue.
