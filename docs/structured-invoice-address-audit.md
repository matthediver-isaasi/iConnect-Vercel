# Structured invoicing address foundation audit

## Scope and rollout decision

This release adds independent virtual core fields for `member`, `organization`
and `organization_group`: `invoicing_address_line1`, `invoicing_address_line2`,
`invoicing_city`, `invoicing_region`, `invoicing_postal_code`,
`invoicing_country`. Country is a country **name**. Existing
`organization.invoicing_address` remains untouched. The six new fields are stored
only in service-accessible `public.invoicing_address_private`, NOT on owner tables.
The migration is additive, idempotent and has no backfill, browser grants,
provider actions or transaction updates.
Applied with owner approval on 2026-10-22 to verified live DEST
(`lvmzliemqnieeoruhkik`):
`supabase/migrations/202612310025_structured_invoicing_addresses.sql`.
SHA256: `0d62fcc29286bf52ae13b7b324c3ae9aebc01afb65e2f95f6257dd2d7edf1695`.
Verified enabled/forced RLS, denied SELECT/INSERT/UPDATE/DELETE and patch RPC
execution for anon/authenticated, and service-role access. Actual read-only
queries under both browser roles failed with 42501; service-role read succeeded.
Existing owner-table grants and RLS flags were unchanged. The new table is empty.
No address data or invoices were changed; SOURCE was untouched. No migration
remains pending for this foundation. Matching application code needs deployment.

Verification on 2026-10-22: 55 isolated backend, disposable PostgreSQL, layout,
editor-state and mounted-hook tests passed. The application starts and the new
endpoint rejects unauthenticated requests with HTTP 401. Signed-in screens were
not visually verified in this workspace; its local tenant/auth configuration
does not provide an authenticated DEST member session.

### Protected storage decision (supersedes owner-column migration)

Read-only inspection of verified DEST on 2026-10-22 found table-wide SELECT for
both browser roles on all three tables. Member and organisation-group RLS is
disabled; organisation has a public SELECT policy with a true predicate.
Adding columns under those permissions would expose private billing addresses
through direct database access. Application API redaction is insufficient.
The user approved protected separate storage instead. The UNAPPLIED migration
was rewritten to create a private sidecar: RLS enabled and forced, no policies,
all PUBLIC/anon/authenticated privileges revoked, explicit service_role DML and
atomic patch RPC execution only. Existing owner grants remain unchanged.
Owner type/id/tenant are validated by a database trigger. Deleting an owner,
changing its tenant, or anonymizing a member clears the corresponding private
address. The approved live schema change creates this private storage only;
existing owner permissions, address data and invoices were not changed.

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

Private address access uses a dedicated authenticated endpoint:

- `GET /api/invoicing-address?ownerType=member|organization|organization_group&ownerId=uuid`
- `PATCH /api/invoicing-address` with JSON
  `{ownerType,ownerId,address:{...changed invoicing_* fields...}}`.
- Both return `{address:{...all six nullable fields...}}`; absent row returns all
  nulls. Null or blank clears a field. PATCH is atomic and preserves omitted fields.
- Ordinary members can read/edit only their own member address; tenant admins
  can read/edit all three owner types in their authenticated tenant. Owner
  existence and exact tenant membership are checked before accessing storage.
  `X-Tenant-Id`, if supplied, must match the authenticated tenant. No caller
  supplied tenant is used for storage writes.
- Missing sidecar/RPC migration is explicit HTTP 503
  `INVOICING_ADDRESS_STORAGE_UNAVAILABLE`, never empty-success fallback.

Generic entity and alternate admin owner create/update routes reject virtual
fields with endpoint guidance, even for administrators. They never write
nonexistent owner columns, silently discard a mixed owner/address save, or
hydrate the sidecar. UI saves a new owner first, then PATCHes its address, and
must report address failure distinctly. Ordinary nonaddress edits never query
the private table and continue working before its migration.

Generic responses redact any older-schema billing values recursively as defense
in depth, including joins from other entities. Generic aliases/filters/sorts
naming virtual fields are rejected. There is no own-member or admin hydration
exception: dedicated endpoint only.
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

Member anonymization clears its personal sidecar row through a database trigger,
without touching saved financial snapshots or shared organizations/groups.

### Isolated verification

`api/invoicing-address.test.mjs` exercises authenticated own/admin CRUD and
clearing, tenant/owner isolation, input validation and explicit missing-storage
errors. `api/_lib/invoicingAddressBoundary.test.mjs` checks rejection of virtual
fields in generic/alternate owner writes and ordinary-edit independence.
`supabase/migrations/structuredInvoicingAddresses.test.mjs` starts disposable
PostgreSQL, applies the migration twice with existing browser-readable owner
tables, verifies no owner columns/backfill, private table grants/RLS/RPC
permissions, independent atomic partial updates, wrong-tenant/missing-owner
rejection, cleanup, and unchanged legacy/saved financial evidence.


## Member Xero event Stripe policy (implementation; migration NOT applied)

New authenticated member ticket payments only use a pre-Stripe server policy.
`POST /api/event-invoice-address` accepts `{eventId,source:"simple"|"complex"}`.
The private, no-store response contains `applicable`, `required`,
`personalAddress`, `organizationAddress`, and `organizationLabel`. Resolved
addresses are `{source:"structured",address:{invoicing_*}}`, or the linked
organization's own `{source:"legacy",address:string}`. No provider IDs or
private policy tokens are returned by discovery.

Both PI creation paths independently reevaluate the selected Xero company and
verified member. Existing customers skip private address reads/collection and
freeze their ContactID. For absent customers the PI request must include
`invoiceAddressSelection:{mode:"personal",address:{invoicing_*}}` or
`{mode:"organization"}`. Organization details are loaded using the member's
current tenant-scoped organization link, never browser address/owner authority.
The member remains the customer. Selection does not save any profile address.
Optional legacy member `xero_contact_id` is not ignored: any stored company
binding must match, then that exact contact is read inside the selected company
and purchaser email verified. Invalid/archived/missing/wrong-company mappings
stop checkout rather than falling through to absence. Existing immutable
`bnms_dd_beta_invoice_link` / `bnms_dd_alpha_invoice_link` records are also
checked with exact tenant/member/Xero-company scope and internally consistent
invoice/contact evidence. A unique trusted mapping survives a changed email;
conflicting/malformed mappings fail closed. Missing optional pilot tables are
unsupported provenance, not a failed live contact lookup. Organization-only
sales mappings are never used to identify the individual member.

`202612310026_event_invoice_address_policy.sql` is **unapplied**. It adds
service-only immutable snapshot storage with forced RLS, browser grants
revoked, validated tenant/member/event/source bindings, and no backfill. Apply
only with separate approval before enabling this checkout release. PI creation
fails explicitly if policy storage or lookup is unavailable; a private snapshot
ID and authenticated member ID are stamped into server-created PI metadata.
`purchase_request_id` is mandatory for scoped member payments. The same key
replays the immutable policy; changed selection or charge details is HTTP 409.
Additional service-only immutable tables freeze the exact Stripe creation
parameters and bind the returned actual PI ID to policy ownership. Identical
retries use a deterministic Stripe idempotency key; a bound PI is retrieved,
not recreated. Interrupted unbound requests cannot initiate another payment
after a conservative 23-hour idempotency window. Accounting loads policy by this
durable PI binding, not metadata alone. New PI metadata carries policy version
1; pre-rollout PIs with neither binding nor marker retain original charge
address evidence and the guarded legacy Xero writer. Missing authority on a
new marked PI still fails closed.
Required/invalid invoice selection has stable HTTP 400 code
`EVENT_INVOICE_ADDRESS_REQUIRED` in both payment-intent HTTP contracts.
Booking verification checks this ownership before using the payment. Invoice
producers copy frozen policy evidence, not charge billing details or today's
private address. Missing/inconsistent authority becomes durable review.

The dedicated Xero writer also protects queued legacy member Stripe invoices:
before a new invoice write it performs a company-bound, exhaustive bounded
customer lookup, failing closed for ambiguous identities, archived contacts,
incomplete results, and lookup errors. Existing customers receive ContactID
only (no address or other contact fields). This also protects customers created
after checkout. Absent member customers use Xero's create-only `PUT Contacts`,
never contact upsert; the invoice then receives only ContactID. A concurrent
same-name creation rejects instead of updating its address. Contact creation is
inside the existing ambiguous-write fence. Existing issued invoices are never updated. Old absent-customer
work retains its original frozen evidence rather than inventing a selection.
Contact reads precede the ambiguous-write journal; existing retry/lease/payment
ownership authority remains intact. Generic membership contact behavior,
QuickBooks, guest, non-card and on-account paths remain unchanged.

Isolated coverage: `api/_lib/eventInvoiceAddressPolicy.test.mjs`, updated
producer tests, and disposable PostgreSQL
`supabase/migrations/eventInvoiceAddressPolicy.test.mjs`.
No live provider calls, migrations, repairs or address writes were performed.
The create-vs-upsert contract was checked against Xero's official OpenAPI
specification: https://github.com/XeroAPI/Xero-OpenAPI/blob/master/xero_accounting.yaml
defines `PUT /Contacts` as `createContacts` (Creates multiple contacts), versus
`POST /Contacts` as `updateOrCreateContacts` (Updates or creates one or more
contacts). Only the public documentation was fetched, not a provider tenant.

## Member Xero event Stripe policy (migration applied; application deployment separate)

New authenticated member ticket payments only use a pre-Stripe server policy.
`POST /api/event-invoice-address` accepts `{eventId,source:"simple"|"complex"}`.
The private, no-store response contains `applicable`, `required`,
`personalAddress`, `organizationAddress`, and `organizationLabel`. Resolved
addresses are `{source:"structured",address:{invoicing_*}}`, or the linked
organization's own `{source:"legacy",address:string}`. No provider IDs or
private policy tokens are returned by discovery.

Both PI creation paths independently reevaluate the selected Xero company and
verified member. Existing customers skip private address reads/collection and
freeze their ContactID. For absent customers the PI request must include
`invoiceAddressSelection:{mode:"personal",address:{invoicing_*}}` or
`{mode:"organization"}`. Organization details are loaded using the member's
current tenant-scoped organization link, never browser address/owner authority.
The member remains the customer. Selection does not save any profile address.
Optional legacy member `xero_contact_id` is not ignored: any stored company
binding must match, then that exact contact is read inside the selected company
and purchaser email verified. Invalid/archived/missing/wrong-company mappings
stop checkout rather than falling through to absence. Existing immutable
`bnms_dd_beta_invoice_link` / `bnms_dd_alpha_invoice_link` records are also
checked with exact tenant/member/Xero-company scope and internally consistent
invoice/contact evidence. A unique trusted mapping survives a changed email;
conflicting/malformed mappings fail closed. Missing optional pilot tables are
unsupported provenance, not a failed live contact lookup. Organization-only
sales mappings are never used to identify the individual member.

`202612310026_event_invoice_address_policy.sql` was applied with owner approval
on 2026-10-22 to live DEST (`lvmzliemqnieeoruhkik`).
SHA256: `05af5603a85c728cc00335f481c4ee5f329af3d958ec2b6f8f6840f498a60cc6`.
It adds
service-only immutable snapshot storage with forced RLS, browser grants
revoked, validated tenant/member/event/source bindings, and no backfill. Apply
only with separate approval before enabling this checkout release. PI creation
fails explicitly if policy storage or lookup is unavailable; a private snapshot
ID and authenticated member ID are stamped into server-created PI metadata.
`purchase_request_id` is mandatory for scoped member payments. The same key
replays the immutable policy; changed selection or charge details is HTTP 409.
Additional service-only immutable tables freeze the exact Stripe creation
parameters and bind the returned actual PI ID to policy ownership. Identical
retries use a deterministic Stripe idempotency key; a bound PI is retrieved,
not recreated. Interrupted unbound requests cannot initiate another payment
after a conservative 23-hour idempotency window. Accounting loads policy by this
durable PI binding, not metadata alone. New PI metadata carries policy version
1; pre-rollout PIs with neither binding nor marker retain original charge
address evidence and the guarded legacy Xero writer. Missing authority on a
new marked PI still fails closed.
Required/invalid invoice selection has stable HTTP 400 code
`EVENT_INVOICE_ADDRESS_REQUIRED` in both payment-intent HTTP contracts.
Booking verification checks this ownership before using the payment. Invoice
producers copy frozen policy evidence, not charge billing details or today's
private address. Missing/inconsistent authority becomes durable review.

The dedicated Xero writer also protects queued legacy member Stripe invoices:
before a new invoice write it performs a company-bound, exhaustive bounded
customer lookup, failing closed for ambiguous identities, archived contacts,
incomplete results, and lookup errors. Existing customers receive ContactID
only (no address or other contact fields). This also protects customers created
after checkout. Absent member customers use Xero's create-only `PUT Contacts`,
never contact upsert; the invoice then receives only ContactID. A concurrent
same-name creation rejects instead of updating its address. Contact creation is
inside the existing ambiguous-write fence. Existing issued invoices are never updated. Old absent-customer
work retains its original frozen evidence rather than inventing a selection.
Contact reads precede the ambiguous-write journal; existing retry/lease/payment
ownership authority remains intact. Generic membership contact behavior,
QuickBooks, guest, non-card and on-account paths remain unchanged.

Isolated coverage: `api/_lib/eventInvoiceAddressPolicy.test.mjs`, updated
producer tests, and disposable PostgreSQL
`supabase/migrations/eventInvoiceAddressPolicy.test.mjs`.
Live migration verification confirmed forced RLS on all three new tables,
no browser-role read/write grants, service-role SELECT/INSERT only, and enabled
immutability triggers. Actual read-only queries under anon and authenticated
were denied with 42501 for each table; service-role reads succeeded.
Existing member, organisation, group and event permissions were unchanged.
All three new tables were empty. No live provider calls, repairs, payments or
address writes were performed; SOURCE was untouched. No migration remains
pending for this feature. Matching application deployment remains separate.
Combined verification: 211 isolated tests passed, including mounted selector
tests, both intent handlers, payment retry/binding checks, recovery, QuickBooks
and disposable PostgreSQL protections. The application starts and unauthenticated
POST to the new discovery route returns 401. Signed-in checkout was not visually
verified: local preview still reports the existing SOURCE tenant-not-found error.
The create-vs-upsert contract was checked against Xero's official OpenAPI
specification: https://github.com/XeroAPI/Xero-OpenAPI/blob/master/xero_accounting.yaml
defines `PUT /Contacts` as `createContacts` (Creates multiple contacts), versus
`POST /Contacts` as `updateOrCreateContacts` (Updates or creates one or more
contacts). Only the public documentation was fetched, not a provider tenant.

## Future integration prerequisites

1. Explicit checkout payer/address selection and authorization, separate from
   attendee/booker identity and organization/group membership.
2. Apply the Xero event-ticket exception above rather than Stripe billing-address
   precedence. Other payment paths retain their existing behaviour until separately
   reviewed.
3. Freeze the selected address and its provenance before accounting preparation;
   replay only frozen evidence, never today's entity values.
4. Review every tabled path before opting it into the shared resolver; test
   legacy text, configured custom fields, missing/partial structured fields,
   countries, and provider-specific limits without unapproved contact updates.
5. Separate approval for two-way provider synchronization and historical repairs.
