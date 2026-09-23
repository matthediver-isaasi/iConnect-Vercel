# BNMS final member workbook: read-only validation

Validation snapshot: **2026-09-23 08:03 UTC**. This is a proposal, not an import.

## Source and destination

- Workbook SHA-256: `560923bb2986a69245d192c35724e4a0f513f690cab5b39e591ce16bee008fc6`.
- Sheet: `Replacement Import`; 79 populated rows, 21 columns. Original worksheet row numbers are retained.
- Destination: Supabase project `lvmzliemqnieeoruhkik`, BNMS tenant `ff2df806-b321-4254-b651-3af11fccf1db`.
- Exact exclusions: Excel row 75 / YM ID 82906861 and row 79 / YM ID 82907468.
- Excel row 71 / YM ID 82907369 retained: ready-new in this snapshot.
- Source assignments: 28 Group, 28 Organisation, 23 none. Eligible assignments: 26 Group, 28 Organisation, 23 none.

## Mutually exclusive outcomes

| Outcome | Rows |
|---|---:|
| User-excluded | 2 |
| Ready-new | 47 |
| Existing-unchanged | 0 |
| Proposed-update | 0 |
| Blocked | 30 |
| Total | 79 |

All 23 unassigned rows are accepted without Group/Organisation requirements or placeholders. Other metadata conflicts still apply.

All 21 live mapping contracts were verified. No unsupported options, missing supplied hierarchy references, or unexpected schema blockers were found. Both assignment columns support NULL.

Expiry: 3 true Excel serials, 30 British text dates, 46 blanks. Student End Date: 1 true Excel serial and 78 blanks. Expiry is proposed as `dd/mm/yyyy` in the established **legacy text preference**, not as a purchased term. Student End Date maps to the live **Student course end date** date preference; Student Course maps to **Student course title**. Phone maps to `member.mobile`, as in the established contract. Affiliate `True`/`False` maps to text `true`/`false`. No Member Since is supplied or inferred.

The shared normalized source email is accounted for across rows 71, 75 and 79; only 71 remains eligible. No remaining eligible source duplicates.

## Decisions needed before a separate import

1. **Excel rows 40–65:** 26 Active statuses conflict with Former/Resigned classifications. Confirm the intended legacy metadata or supply corrections. This does not authorize enabling access or financial commitments.
2. **Excel rows 2 and 80:** existing-member membership-type conflicts.
3. **Excel rows 76 and 77:** emails match existing members whose legacy IDs, membership types and classes differ. Row 77 also conflicts with existing hierarchy. Resolve identity explicitly; no overwrite or prior-import overlap exception is assumed.
4. Review the complete mappings and field-level proposals, including legacy expiry formatting. Approve a separate import only after review and fresh identity checks.

## Reports and rerun

`node scripts/validate-bnms-final-members.mjs`

The runner has **no apply mode** and rejects all CLI arguments. Credentials are read from existing DEST secrets, never printed. It verifies the REST project pin and SQL pooler project identity, uses verified TLS and a single `REPEATABLE READ READ ONLY` transaction, and finishes with `ROLLBACK`.

Reports are git-ignored under `exports/bnms-final-validation/`:

- `summary.html`: non-personal summary, complete 21-column mapping table including destination field IDs/types, transformations, blank handling and live verification.
- `restricted-report.html`: human-readable expandable evidence for all 79 rows, identities, reasons, current/source values, field-level changes and hierarchy evidence.
- `report.json`: full machine-readable evidence, including live options, source duplicates, read coverage and safety boundary.

Directory permissions are `0700`; report files are `0600`. The workbook is ignored and removed from the current Git index, while remaining locally available. **Historical caveat:** it was already committed in the shared main-branch checkpoint inherited by this task, before these changes. This task does not claim to purge that shared history or external caches. A separately authorized repository-history cleanup is needed if historical removal is required; rewriting the shared base could disrupt other tasks. Do not publish the restricted reports or source workbook. The supplied workbook must remain available locally to rerun the pinned validation.

Complete snapshot coverage: 3,866 BNMS members, 28,888 preference values, 3,730 legacy-field values (including checks for dangling/foreign identity ownership), 149 groups, 476 organisations, 6 categories and 638 active member-target relationship edges. SQL reads are not subject to PostgREST paging caps. No billing/account/provider tables are involved.

## Verification and migration status

`node scripts/run-isolated-tests.mjs node --test scripts/bnms-final-source.test.mjs scripts/validate-bnms-final-members.test.mjs scripts/bnms-final-readonly.test.mjs`

17 isolated checks passed: pinned exclusions, mixed dates, booleans, source duplicates, continuation after row errors, all outcome classes, preference-only changes, blank preservation, options, cross-tenant identities, hierarchy conflicts, read-only guards, rollback and HTML escaping.

**No migrations expected, needed or applied to any database. No outstanding schema blocker. No live import, production record change, access change, notification, consent, entitlement, provider operation or billing change was performed.** Previous pinned importers were not changed.