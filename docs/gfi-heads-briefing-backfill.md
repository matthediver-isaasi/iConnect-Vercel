# GFI Heads briefing: one-time correction

Applied and independently replay-checked on 2026-11-23 against the documented
live Supabase destination `lvmzliemqnieeoruhkik`.

## Exact scope

- Tenant: Graduate Futures Institute (`fd82da65-aab7-4a5c-85b8-b2febeb2003d`).
- Category: Heads briefing (`b5a43d92-04f3-4e83-a0e5-fce00c678552`), active,
  member-enabled, with exactly one applicable role.
- Role: Head of Service (`561682bb-57f2-4a61-89aa-c3c201692923`).
- The separate Head of Service with AI role was excluded (one member).

## Reconciled totals

| Measure | Before | After |
| --- | ---: | ---: |
| Head of Service population | 245 | 245 |
| Login-enabled, active role holders | 193 | 193 |
| Positive Heads briefing preferences in role | 3 | 192 |
| Missing preferences in role | 241 | 52 |
| Explicit negative Heads briefing preferences | 1 | 1 |
| Global member opt-outs in role | 0 | 0 |
| Applicable category ledger suppression | 1 | 1 |
| Applicable global ledger suppression | 0 | 0 |
| Disabled members excluded | 52 | 52 |
| Other inactive/paused/cancelled exclusions | 0 | 0 |
| Invalid email exclusions | 0 | 0 |
| Historical-address ledger rows linked to cohort | 0 | 0 |
| Displayed category member count | 3 | 192 |

**189 missing positive preferences were inserted.** The one category ledger
suppression belongs to the same member as the explicit negative preference:
these are overlapping evidence, not two excluded members. Other-category
unsubscribe records were also preserved.

## Verification and safeguards

1. Read-only live project, tenant, role, category, preference and ledger preflight.
2. Full transaction rehearsal inserted 189 rows and verified preservation, then
   rolled back. No durable subscriptions were changed by the rehearsal.
3. The identical transaction was committed explicitly, returning exactly 189
   inserted preference IDs and member IDs for the private audit.
4. A separate post-commit rollback rehearsal returned **zero additions**, with
   the displayed count remaining 192.
5. Existing tenant preference rows and the entire tenant unsubscribe ledger
   were compared exactly before/after. All tenant member records were compared
   by ordered full-row fingerprint. They remained unchanged.
6. The displayed total uses the existing explicit-positive, active-member,
   global-opt-out count semantics, not a newly introduced role-based count.

The transaction takes the existing tenant/normalized-email consent advisory locks,
then brief NOWAIT write fences covering membership, consent and configuration.
It rechecks role, status, category eligibility, normalized address identity,
global flag and applicable ledger suppression under those fences. Inserts use
`ON CONFLICT DO NOTHING`; no resubscribe RPC or suppression deletion is used.
All persistent writes target only the pinned tenant/category/role.

The retained SQL is **rollback-only by default**, is not registered with startup,
merge setup, migration application or any schedule, and additionally pins the
exact reviewed member-set digest. Never run the broad
`scripts/migrations/backfill-communication-preferences.mjs` for this correction.

The configured destination SQL password was rejected before any query executed.
The existing connected Supabase SQL interface successfully supported the protected
transaction and was used instead; no credentials or connection settings changed.

Exact rehearsal and committed IDs and replay evidence are retained in
`private/gfi-heads-briefing/`, excluded from Git and deployment, with restricted
directory/file permissions. These local private audit files are not committed.

No application behavior, category/role configuration, count semantics, existing
subscription, disabled member, other tenant, campaign or sending process changed.
No emails were sent. Future member/role changes retain their existing behavior.
The signed-in UI was not exercised; the total was reconciled from live database
evidence using its existing count predicate.
