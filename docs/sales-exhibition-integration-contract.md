# Exhibition inventory integration contract

## Implementation status

Implemented in the existing catalogue and proposal workflow, with server-resolved
logical slots and database-owned reservations. Standalone quantities are expanded
on save into individually priced lines, preserving exact pennies and existing
invoice/tax arithmetic. Bundle quantities stay grouped at their fixed selling price.
Selected references/prices are frozen into line descriptions for existing proposal,
PDF, agreement and invoice renderers.

Migration `202610260001_sales_exhibition_inventory.sql` was applied to verified
DEST `lvmzliemqnieeoruhkik` using `scripts/apply-sales-exhibition.mjs` after the
user explicitly requested completion and migrations. SHA256:
`a79ca77d4c1a14621d7e6ca00adf2ecbf0b84c7c46fafa2c5b6669f3569388ab`.
Historical totals were unchanged; all five inventory tables have RLS and deny
browser access and direct service-role writes. SOURCE was untouched.

Verification: 59 selected contract, API, mounted UI and disposable PostgreSQL
tests passed, including concurrent claims, transactional rollback, price
preservation and tenant/capability checks. Existing isolated layout fixtures pass
at 375/1280/1440/1920px. The actual signed-in UI was not verified: local runtime
still points to stale SOURCE and reports Tenant not found; authentication was not
bypassed. The broader sales-hardening suite has an unrelated attendee-picker
source-pattern assertion failure. No live sales, notifications or deployment ran.

Soft deletion uses the existing proposal DELETE endpoint with expectedVersion;
it cancels unsold reservations, hides the quote and revokes delivery links while
retaining allocation evidence. The UI exposes cancellation and reopening.
Cancellation maps to the existing `declined` status, not a new status.

## Authority and event context

- The existing proposal Event selector is the only allocation-time event input.
  Do not add an event selector inside a bundle or space picker.
- Preserve the distinction between simple and complex events even where UUIDs
  happen to differ. Event identity is `(tenant_id, event_kind, event_id)`.
- Resolve and validate that event on the server; persist its verified kind with
  the proposal snapshot. Current snapshot construction loads the source event
  row and does not explicitly retain the submitted kind. Do not guess an
  exhibition event kind from a ticket product.
- Ticket-product `eventReference` continues to identify its own event and ticket
  class. It does not choose exhibition inventory or require matching the
  proposal's exhibition event.
- A missing or unverifiable proposal event prevents space selection with the
  instruction to choose the proposal Event and save the draft.

## Requirements versus event groups

Use an event-independent, tenant-owned space requirement, for example “Bronze
stand”. A product references that requirement and a positive integer number of
spaces per product unit. Each event-specific inventory group implements one
requirement. This permits reusing the same product and mixed bundle for different
events without changing ticket-product semantics.

Group fields: tenant, verified event kind/id, requirement, display name, normalized
reference prefix, currency, archive state and generation cursor. Space fields:
group, tenant/event identity, immutable reference and ordinal, current future
price in minor units, and administratively unavailable state.

Reference uniqueness belongs to **the whole event**, not merely one group:
`UNIQUE (tenant_id, event_kind, event_id, normalized_reference)`.
Trim and uppercase reference prefixes before generation. Different events may
reuse references. Group generation must use a locked, monotonic cursor, never
`count(*) + 1`. Collisions with another group's prefix must fail or be explicitly
skipped within the transaction; they must never overwrite a space.

Generation retries need a tenant-scoped idempotency key and a canonical payload
digest. Replaying the same command returns the same result; reusing a key with a
different command fails. Incremental generation adds spaces without repricing or
renumbering existing ones.

Catalogue prices accept zero and are safe integer minor units. Currency must
match the proposal. Available spaces may be blocked or archived. Held or sold
spaces may have their future catalogue price edited, but never their agreed
allocation price, group, reference, event or current availability. Preserve
historical spaces by archiving rather than reusing deleted references.

## Stable allocation identity

Current `save_sales_quote_draft` deletes and recreates physical quote lines.
`amend_sales_quote` creates new version/line/component rows. Consequently a
reservation must not cascade-delete with those child rows.

Persist independent logical line and component UUIDs. Validate their ownership
server-side: an existing identity must belong to this proposal, and incoming
identities must not allow attachment to another tenant, quote or unrelated
catalogue requirement.

Each selection uses:

```
(tenant, proposal, logical_line, logical_component_or_null,
 line_unit, component_unit, requirement_unit)
```

For two bundles, each containing three products requiring two spaces, generate
12 independently selected slots. Preserve the nested ordinals: flattening to one
number would silently change the meaning of existing slots when component
quantity grows. Reordering lines or assigning a different sales agent changes
none of these identities. Replacing a catalogue item is a new requirement
configuration and must reconcile or release the old slots transactionally.

The contract bounds a single proposal to 1,000 exhibition units to prevent
unbounded expansion. Fractional quantities remain valid for unrelated ordinary
products; any exhibition-bearing line/component requires positive whole units.

## Ownership and evidence

Keep mutable current ownership separate from immutable evidence:

1. One current ownership row per reserved/sold space, uniquely constrained by
   tenant and space and by the logical unit tuple.
2. Append-only allocation movements recording reservation, replacement, release,
   version transfer and sale.
3. Version-bound selection snapshots with reference, group, event, currency,
   individual agreed price and containing logical identities.

Use composite tenant foreign keys throughout. Do not grant browser roles direct
mutation privileges. Service-only RPCs must check the caller role with
`IS DISTINCT FROM 'service_role'` and explicitly reject null required arguments.
RLS alone is not sufficient where a service client bypasses it.

## Transaction contract

The database is the final authority. Client validation and preflight reads do not
authorize a reservation.

- Save the proposal before its first reservation. A new-draft retry must not
  create multiple drafts. The UI must not display a successful reservation until
  the database has committed it.
- Reserve/replace accepts proposal ID, expected row version, a complete intended
  selection set and an idempotency key. Resolve required slots from the saved
  proposal, not client-supplied quantities or requirement IDs.
- Lock the parent proposal before reading its current version. Acquire affected
  inventory locks in deterministic space-ID order. Validate the full requested
  set before publishing any ownership changes.
- A replacement releases old ownership and claims new ownership in the same
  transaction. Any conflict rolls back both, preserving the previous selection.
- Draft save reconciles removed slots, retained slots and requirement changes in
  the same transaction as its physical line rewrite. A reload cannot leave
  hidden reservations belonging to removed lines.
- Reject event changes while ownership exists. Require an explicit release of
  unsold selections first; never reinterpret the old reference at another event.
- Partial drafts are allowed, but issue and acceptance require one matching
  reserved selection for every current required unit, with no extras.
- Validate ownership again at acceptance; do not assume an earlier issue-time
  check is sufficient.
- Ordinary price, notes, salesperson or tax-preserving saves retain applicable
  reservations and their price evidence.

Catalogue/event mutations must serialize against the same inventory authority.
Avoid a check-then-write window that allows an administrator to move or block a
space between validation and claim. Prevent deletion or tenant reparenting of
referenced events and requirements. When adding child immutability checks,
validate both old and new parents.

## Pricing and representations

- A standalone space product uses the selected spaces' agreed individual prices.
  Multiple selected prices may differ; do not average into a rounded integer
  unit price and lose pennies. The integration must choose a precise existing
  line representation (such as one priced subline per selected unit) and carry
  it through tax, totals and invoices.
- Bundle spaces are included entitlements. The existing bundle selling price
  remains the financial total; do not add space prices on top or redistribute
  grouped billing from live catalogue prices.
- A zero-price space is a valid selection, not a missing value.
- Preserve agreed prices through draft reload and repricing. A catalogue change
  affects future reservations only. Replacing a space is an explicit new price
  agreement; retaining a space preserves the old one.
- Public proposal DTOs, PDFs, agreements, comparisons and invoice descriptions
  need explicit reference/price display fields. Do not expose broad allocation,
  tenant or customer snapshots to bearer-link readers.
- Accepted document evidence remains immutable. Amending accepted sales cannot
  become a way to release sold inventory or silently change the signed price.

## Lifecycle mapping

Actual proposal statuses are `draft`, `issued`, `sent`, `accepted`, `declined`,
`expired`, `superseded`, `converted`. Several labels displayed by the UI are
delivery events, not proposal statuses.

| Boundary | Unsold ownership | Sold ownership |
| --- | --- | --- |
| Save, reorder, reassignment | Preserve matching logical units | Preserve evidence; existing financial guards apply |
| Issue | Require complete valid reservations | Not a new sale |
| Send, view, download | Preserve | Preserve |
| Delivery token expiry/revocation | Preserve | Preserve |
| Staff/public acceptance | Atomically validate and mark sold with sale | Verify same sale; idempotent retry |
| Confirm sale | Same atomic finalization | Verify existing sale |
| Decline or explicit proposal expiry | Release reserved only | Do not release |
| Opportunity enters a stage whose `is_lost` is true | Release reserved only | Preserve |
| Opportunity enters Won | Preserve; not acceptance | Preserve |
| Explicit cancellation/deletion | Release reserved in same transaction | Block or use existing financial safeguards |
| Unsold amendment/supersession | Transfer authority to new current version atomically | No implicit unselling |
| Reopen Lost/declined/expired | Revalidate and explicitly reserve available selections | No automatic release/reclaim |
| Remove/change selection | Atomic release/replacement | Financial safeguards |

Do not use a blanket “on superseded release” trigger: the old version becomes
superseded during a normal amendment, where the hold must transfer without a
free-inventory window. Keep old version evidence intact.

Do not use elapsed `valid_until` or expired delivery links as automatic hold
expiry; automatic hold expiry is outside scope. Explicit transition to proposal
`expired` releases unsold reservations. Reopening an opportunity itself does not
reclaim previously released inventory.

Staff acceptance currently invokes commercial sale confirmation conditionally
for ticket-bearing or scheduled-billing proposals. Extend that condition to
exhibition-bearing proposals. Public acceptance and agreement signing must reach
the same sale finalization transaction. Ticket capacity failure must roll back
exhibition sale publication too. Existing sold-proposal financial protections
must remain in effect.

## Required verification before rollout

- Disposable PostgreSQL with concurrent competing claims, atomic replacement
  rollback, reserve-vs-block, save-vs-reserve, Lost-vs-accept, and amendment races.
- Service-only table/RPC grants, null-role denial, cross-tenant IDs, wrong
  capability, stale row versions and changed-payload idempotency retries.
- All nine brief cases, including repeated product lines, multiplied bundle
  quantities, heterogeneous individual prices and zero-price included spaces.
- Save-before-first-reserve, failure to load inventory, reservation conflict,
  successful save with failed reload, repeated acceptance and browser refresh.
- Public/staff/agreement acceptance; grouped and percentage billing; mixed
  ticket/exhibition rollback; ordinary non-exhibition proposals.
- Historical PDF/agreement/reference evidence after catalogue repricing and
  amendment. Signed-in browser verification must use isolated fixtures, not
  live customer actions.

## Database and release boundary

Prepare a pinned destination-only migration runner with reviewed SQL checksum,
explicit expected database identity and fail-closed guards against unexpected
existing function definitions. Do not apply to the stale workspace SOURCE.
Production database changes need separate authorization. No live sales,
signatures, emails, invoicing, provider actions or deployment are authorized by
this implementation task.

**Current migration accounting:** the above migration is applied to verified
DEST; none applied to SOURCE and no feature migration remains pending.
Matching application code still needs merging and the usual authorized release.
