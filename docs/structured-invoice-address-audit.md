# Structured invoicing address foundation audit

## Scope and rollout decision

This release adds independent nullable text fields to `member`, `organization`
and `organization_group`: `invoicing_address_line1`, `invoicing_address_line2`,
`invoicing_city`, `invoicing_region`, `invoicing_postal_code`,
`invoicing_country`. Country is a country **name**. Existing
`organization.invoicing_address` remains untouched. The migration is additive,
idempotent and has no backfill, grants, provider actions or transaction updates.
Apply the migration through the normal reviewed deployment process before using
the new editor fields. It has not been applied by this implementation.

### Live privacy blocker — do not deploy this foundation yet

Read-only inspection of verified DEST on 2026-10-22 found table-wide SELECT for
both browser roles on all three tables. Member and organisation-group RLS is
disabled; organisation has a public SELECT policy with a true predicate.
Adding columns under those permissions would expose private billing addresses
through direct database access. Application API redaction is insufficient.
The migration now refuses to run with these grants. No live schema, permissions,
address data or invoices were changed. Protected separate storage or a reviewed
compatibility-safe permissions change is required before rollout.

The admin UI fields and isolated tests are implemented but not live-ready.
Existing saved layouts are preserved; the fields are available under Customize
Layout, and new/default layouts include a billing address card. Signed-in UI
verification was blocked by the workspace's existing SOURCE tenant-not-found
configuration; compile and isolated editor-state/layout tests passed.

**Deliberately deferred:** accounting pipeline integration, checkout owner/address
selection, contact updates and two-way accounting sync. Saving a core address
does not change what an existing invoice path sends to Xero or QuickBooks.
Existing financial paths retain their current legacy/custom/Stripe resolution.
In particular, this change must not make a retry read today's new address and
replace a frozen checkout or renewal address.

`shared/invoicingAddress.js` exports immutable frontend metadata and keys,
validation, a pure opt-in resolver and pure provider mappings. The resolver uses
the explicitly supplied entity's structured values only if address line 1 is
nonblank. A postcode/city/country alone is not a usable structured address:
it falls back to organization legacy text, or returns null without a legacy
address. No guessed or spliced legacy components are used. Only an organization
can fall back to its own unchanged legacy text. It never searches a member's
organization or a group's descendants. Country is limited to 50 characters
for compatibility with Xero as well as QuickBooks.
Invalid field types/lengths fail explicitly. No financial production path calls
this resolver or these new mappings in this release.

## Existing creation, renewal, retry and update paths inspected

| Paths | Existing address authority / compatibility decision |
| --- | --- |
| `api/_lib/invoiceAddressResolver.js` | Configured core field, then configured preference field, otherwise organization legacy `invoicing_address`; current behavior including config requirements unchanged. |
| `api/membership/org-membership-invoicing.js`, `member-membership-invoicing.js`, `member-fees.js`, `api/_lib/membershipSimulationCore.js` | Existing legacy organization selections and configured address resolver feed membership creation/update/simulation. New fields are not substituted. |
| `api/forms/membership-payment.js`, `api/_lib/formMembershipFinalize.js` | Payment-time Stripe billing evidence is used for Stripe purchases; non-Stripe finalization retains the existing configured resolver. No stored record gets rewritten from Stripe. |
| `api/public/membership-fees/[token].js`, `api/_lib/memberStart.js`, `reminderFeeAccounting.js` | Public fee payment and start/reminder continuations retain saved quote/accounting evidence where available and their existing legacy/configured resolution otherwise. Never replace saved accounting addresses with current core fields. |
| `api/cron/process-membership-renewals.js`, `api/_lib/annualOwnerRenewalPipeline.js` | Annual/member/org renewal address preparation remains unchanged. No new-field lookup added. |
| `api/_lib/membershipInstalmentInvoicing.js`, `accountingQueueGoCardless.js` | Instalment and queued GoCardless work retain agreement/Stripe metadata and existing configured address fallback. Existing prepared work stays immutable. |
| `api/admin/membership-invoice-retry.js` | Reads organization legacy text and can recover original agreement/Stripe payment-time evidence. Do not switch retry to mutable new core fields. |
| `api/_lib/workflows.js` | Member/organization membership invoice workflow actions call the existing resolver. Left unchanged. |
| `api/_lib/accountingSourcePreparation.js` | `invoicingAddress` is included in prepared accounting source arguments. No changes to saved prepared envelopes. |
| `api/_lib/xero.js`, `quickbooks.js` | Existing membership adapters receive `invoicingAddress` as their address argument. Existing parsing/contact handling unchanged. New pure mappings do not invoke adapters or update provider contacts. |
| `api/_lib/eventInvoiceProducer.js` | Event purchaser identity/address is separate: individual Stripe uses verified payment-time billing evidence, while organization/on-account billing remains distinct. Existing event `address` handling is not automatically equivalent to organization `invoicing_address`. No change. |
| `api/_lib/eventInvoiceRecovery*.js`, `api/booking-invoice/[bookingGroupRef].js` | Recovery uses durable checkout snapshots/provider identity and existing-operation authority. No replay, reconstruction, retry policy or historical snapshot changes. |
| `api/membership-invoice/[recordId].js`, `api/public/membership-invoice-pdf/[token].js` | Saved/provider invoice retrieval, not permission to regenerate invoices from today's member/group address. Left unchanged. |
| `api/_lib/trainingFundAccountingContinuation.js`, `api/functions/[functionName].js` | Existing paths explicitly supply no invoicing address in applicable calls. No new implicit owner inference. |

Invoice updates must preserve live provider financial values, payment IDs and
contact/invoice IDs. This foundation does not repair historical issued invoices,
rename contacts, merge accounting customers or alter duplicate-prevention
authority. These restrictions follow the structured-invoice-address-compatibility
and event-invoice-recovery-authority memories.

## Other legacy consumers and write/privacy boundaries

Legacy address consumers include organization admin filtering/export,
`api/opportunities/[id].js`, authenticated directory rendering, form prefill and
form/structured-action/stage/workflow/Zoho mapping allowlists. Their existing
legacy field behavior is preserved. New billing fields are not automatically
added to public form mappings, directory schemas, Zoho synchronization or
user-configured invoice-field selectors.

The generic entity create/update routes validate the new fields and require
administrator authority for organization/group changes. Ordinary members may
update only their own member record's new address; membership of an organization
or group grants no address-edit permission. Admin member/organization PATCH
allowlists include all six new fields. `api/my-organization.js` explicitly rejects
new billing fields rather than extending its existing self-service rights.

Generic member/organization/group responses redact the new fields for
non-admins, except the member's own root member record. Joined organizations and
groups never inherit that self-read exception. This covers single/list/counted
and write-response shapes with wildcard selections.
This also projects wildcard joins from other generic entity endpoints. Non-admin
aliases/filters/sorts naming a new billing field are rejected, so renaming a
column cannot bypass key-based redaction. A member relation aliased `data` does
not receive the counted-list envelope's own-member exception.
`api/public/organisation/[id].js` redacts all six fields from its wildcard
projection. Public member prefill, organization/group options, member search,
member-by-ID lookup and public group member cards already use explicit output
allowlists/selections which exclude the new fields. No new public access or
database policy grants are introduced.

Alternate routes reviewed: authenticated `/auth/me`, login and password-set
responses concern the authenticated member's own record; member search/by-IDs,
public member/group prefill/options and `validateMember` use explicit output
fields. `refreshMemberBalance` selects joined organization data but returns only
balance/name. The legacy magic-link function now redacts the new fields from its
wildcard member response. Direct admin member GET is tenant-scoped when context
is available and redacts new fields when it is absent. Admin read/edit capability
remains required on that route.

Member anonymization clears the six new personal-address fields on the member
record, without touching saved financial snapshots or shared organizations/groups.

## Future integration prerequisites

1. Explicit checkout payer/address selection and authorization, separate from
   attendee/booker identity and organization/group membership.
2. Payment-time Stripe billing address precedence for individual Stripe payments.
3. Freeze the selected address and its provenance before accounting preparation;
   replay only frozen evidence, never today's entity values.
4. Review every tabled path before opting it into the shared resolver; test
   legacy text, configured custom fields, missing/partial structured fields,
   countries, and provider-specific limits without unapproved contact updates.
5. Separate approval for two-way provider synchronization and historical repairs.
