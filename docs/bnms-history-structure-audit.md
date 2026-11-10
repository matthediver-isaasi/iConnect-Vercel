# BNMS historical structure presentation

## Read-only destination findings — 10 November 2026

The destination-only SQL connection verified project `lvmzliemqnieeoruhkik`
and BNMS tenant identity. The MCP SQL connector denied permission; the existing
destination-pinned TLS connection succeeded using read-only transactions.
No database or provider writes were performed.

`node scripts/audit-bnms-history-structures.mjs` uses a repeatable-read,
read-only transaction, UUID keyset pages of 200, tenant scoping, a statement
timeout and an independent aggregate count to detect incomplete reads.

| Evidence category | Histories | Distinct members |
| --- | ---: | ---: |
| Classification only, no structure ID or saved name | 145 | 144 |
| Structure ID but no saved name or approved reconstruction | 47 | 47 |
| Saved named snapshot, matching non-retired configuration | 662 | 660 |
| Saved named snapshot, matching retired configuration | 21 | 21 |
| Approved reconstruction, explicitly not original purchase evidence | 11 | 11 |
| **Total** | **886** | **874** |

Combined missing structure-name evidence: **192 histories / 191 distinct
members**. Named snapshots: **683 histories / 681 distinct members**.
Distinct-member totals across categories must not be summed: a member can
have multiple histories.

There are 17 tenant-scoped configuration records, including retired versions.
None is named exactly “LMIC Membership”. There are zero BNMS organisation
history records. No named snapshot had unresolved configuration identity/name
in this audit, and none used the unsupported five-member proposal source.
Matching configuration names corroborate saved identity; this audit does not
re-certify original consent, price, or collection authority.

## Reported record

The reported member's destination history has classification “LMIC Membership”,
null `config_id`, and null `commitment_snapshot`. Saved provenance identifies
original workbook row 1932 and the five-member reconstruction source.
The £61 paid amount, invoice number 300004834, and term
14 January 2026–12 January 2027 remain unchanged.

The offline preparation script put the classification into `structure_name`.
That is **not** evidence it was persisted: the verified-paid runner explicitly
clears the snapshot, and the live read confirms it is null. The unverified
runner also omits that proposal snapshot. Source provenance was checked against
the saved notes and pinned script definitions, not by reopening the original
workbook or re-verifying provider payments.

## Presentation and correction boundary

Both history views now use “Structure unknown” as the primary badge when no
saved name exists. A retained label appears separately as
“Recorded tier / classification: …”. An ID alone is identified as a recorded
ID with no recorded name; it is not resolved against today's configuration.
Genuine saved names, retired names and existing approved reconstruction
overlays remain visible. A snapshot explicitly tagged with the offline
five-member proposal source is treated as classification-only, not purchase
evidence. No such persisted snapshot was found.

The 192 missing-name histories are evidence gaps, not permission to repair
data. No incorrect persisted snapshot requiring correction was identified.
Recovering any missing name would require separately reviewed historical
evidence and approval; current matching structures must not be substituted.
The 11 approved reconstructions remain distinct from purchase snapshots in
the audit, with existing reconstruction authority unchanged.

## Verification boundary

Rendered isolated tests exercise both complete tabs, personal and
organisation-sourced member rows, classification-only/absent/blank labels,
saved and retired names, config-ID-only rows, proposal-only snapshots and
approved reconstruction overlays. They assert retained prices, payment
statuses, invoice controls, dates/year labels and no data mutation or write
requests. Existing renewal-policy and organisation preview tests also pass.

The local workflow starts, but the unauthenticated preview shows “Tenant not
found”: its legacy SOURCE database lacks the tenant table. This is not a
verification of the signed-in BNMS page. Destination SQL findings are live
read-only evidence; rendered regression results are isolated fixtures.
No deployed BNMS UI was checked or changed and nothing was published.
