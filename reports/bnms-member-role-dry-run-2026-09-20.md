# BNMS Member-role dry run

Audited **2026-09-20 12:36 UTC**, against **production DEST `lvmzliemqnieeoruhkik`, database `postgres`**. All database queries used explicitly read-only repeatable-read transactions, ended with rollback. SOURCE was not accessed.

## Result

- 3,865 total retained BNMS member records.
- 2,927 records have primary role **Member**.
- 10 of these are anonymised deleted-member placeholders, identified by the application's deletion-email convention, not by login status.
- **2,917 eligible non-deleted members**, matching the expected population exactly.
- **0 would change; 2,915 would remain Member; 2 blocked.**
- Both blocked members have **no preference-value row** for the active member-scoped `member_class` field. One has login enabled; one does not. Neither is inferred to be deleted or assigned a class.
- No unknown nonempty class values or duplicate class values were found.
- One active member-scoped `member_class` field resolved.
- All 20 mappings resolve to exactly one existing tenant-owned role each. All 10 distinct target roles have both administrator flags false, exclude the admin module, require no effective-from date, and have no member-capacity limit.
- The catalog confirms **`public.member_role` does not exist**. All cohort assignments are primary `member.role_id`; there are no secondary associations or target-role deduplication operations.

## Every supplied mapping

Counts below apply only to the 2,917 eligible members currently holding Member.

| member_class | Resolved target role | Source count | Would change | Would remain Member |
|---|---|---:|---:|---:|
| Associate | Associate | 0 | 0 | 0 |
| Full | Full member | 0 | 0 | 0 |
| Full junior | Full member junior | 0 | 0 | 0 |
| Trainee | Trainee | 0 | 0 | 0 |
| Student | Student | 0 | 0 | 0 |
| Full with NMC | Full member | 0 | 0 | 0 |
| Full junior with NMC | Full member junior | 0 | 0 | 0 |
| Overseas Full | Full member | 0 | 0 | 0 |
| Overseas Full junior | Full member junior | 0 | 0 | 0 |
| Overseas Full with NMC | Full member | 0 | 0 | 0 |
| Overseas Full junior with NMC | Full member junior | 0 | 0 | 0 |
| Honorary | Member | 21 | 0 | 21 |
| Retired | Retired | 0 | 0 | 0 |
| Former | Member | 413 | 0 | 413 |
| Department contact | Member | 168 | 0 | 168 |
| Patient representative | Patient Representative | 0 | 0 | 0 |
| LMIC Full | LMIC Full | 0 | 0 | 0 |
| LMIC Full junior | LMIC Full junior | 0 | 0 | 0 |
| Overseas associate | Associate | 0 | 0 | 0 |
| CPD Guest | Member | 2,313 | 0 | 2,313 |
| **Missing value (blocked)** | **Unresolved** | **2** | **0** | **0** |
| **Total** | | **2,917** | **0** | **2,915** |

Per-target totals: Member 2,915; Associate, Full member, Full member junior, Trainee, Student, Retired, Patient Representative, LMIC Full and LMIC Full junior each 0; unresolved 2.

This establishes current state only. It does not prove when or why other members obtained their current roles, and does not expand the correction to members holding unrelated roles.

## Private review evidence

The deterministic, ID-ordered plan, original role state, class rows, exact target-role IDs/definitions, excluded deletion placeholders and database trigger definitions are retained outside the repository:

`/home/runner/.private-recovery/bnms-role-audit/2026-09-20T12-36-07.915Z/`

Directory mode is 0700; `snapshot.json` and `summary.json` are 0600, exclusively created. No names, emails, sessions, or credentials were included. Member UUIDs remain private; do not publish this snapshot or attach it to a public asset. Retention is local to this workspace, not an external backup.

- Plan SHA-256: `45cd877d752867c211fcc972b338c1bdbb712cafee65ece3145cd8004fc40b37`
- Evidence SHA-256: `65738d5bc600ce886df5ba3a820039a4d53e01f4c5b85da358c06c6c53359a3c`
- Hashes cover compact `JSON.stringify` representations, not pretty-printed file bytes.

## Requirements before any future execution

Separate approval is required. The audit script has **no apply mode**. The current proposed write set is empty; the two missing classes need authoritative review, not guessed mappings.

Any future plan must re-read the live cohort and compare original role/class state against the approved snapshot. Only replace the Member primary role, never overwrite unrelated roles or broaden eligibility. Preserve member-level exclusions, login flags, organisation, effective dates and all other data.

Live member triggers enforce same-tenant role/capacity rules and authorisation locking. Updates also change `updated_at` and can queue automatic-group recalculation; a future executor must explicitly account for these side effects rather than disabling triggers. Organisation reassignment session revocation is not a role-only update trigger. Server authorization reads the primary role, while the client uses a validated session-role snapshot; any future change needs a deliberate refresh strategy without assuming secondary roles drive authorization. No sessions were read or changed in this audit.

## Verification and boundaries

`node scripts/run-isolated-tests.mjs node --test scripts/audit-bnms-member-class-roles.test.mjs`: 5 tests passed, covering exact mappings, replacement/no-op plans, unresolved values/roles, privilege and constraint blockers, and rejection of apply arguments.

Full SQL result sets were read without REST pagination caps. Unique-ID and partition accounting checks passed: **0 + 2,915 + 2 = 2,917**.

**Dry run only. No database records, roles, schema, sessions, or external service data were changed. No emails were sent. No migrations were needed or applied, and none remain to apply for this audit.**