# Graduate Futures Institute: form access audit

Read-only production DEST audit, 2026-09-28. Tenant
`fd82da65-aab7-4a5c-85b8-b2febeb2003d`; project `lvmzliemqnieeoruhkik`.

## Scope and method

All 40 saved tenant forms were read in one tenant-scoped SQL query inside a
read-only transaction. Of these, 34 have `is_active=true`, six are inactive.
The current shared mutation-contract classifier was applied to persisted
configuration, with explicit inspection of pipeline destinations, structured
operations, and implicit field bindings. No implicit bindings or structured
actions were present in the returned forms. Aggregate submission/grant/draft
queries read no respondent answers, personal identifiers, or bearer tokens.

This is a configuration-risk audit, not live submission testing or a guarantee
that every unflagged form works. Active means the saved active flag, not verified
availability under schedules or other runtime restrictions. Current deployed
revision remains independently unverified.

## Findings

Ten other active forms have existing-record mutation risk and no explicit
mutation policy. All ten are public with no saved login requirement or access
policy. They can work for genuinely new records yet reject existing-record
matches without verified authority. They may also encounter the form-builder
contract gate when changing mutation-related configuration.

### Organisation updates: closest to the Partner incident

| Form | Slug | Risk | Submissions since Sept 1 | Unexpired drafts |
|---|---|---|---:|---:|
| University Full Application | university-application | Organisation finance, phone and custom updates, plus member updates; highest priority for an existing applicant organisation | 0 | 1 |
| Partner enquiry form | partner-join | Organisation name matching plus nine custom mappings, including static/date writes | 11 | 0 |
| Enquiry form | enquiry | Organisation name matching, website and ten custom mappings | 2 | 0 |

University has one historical continuation grant, but it is revoked, consumed
and detached from its organisation. It is not usable authority. The other two
have no grants. Do not reactivate that historical grant.

Recommendation: review University Full Application for the same explicit
applicant-continuation policy and trusted link issuance as Partner. Existing
drafts need independently verified scope. For the two initial enquiry forms,
first decide how a new applicant should proceed when their organisation already
exists: simply requiring an invitation on every request would obstruct genuine
first-time enquiries. Preserve configured updates; neither respondent email nor
an organisation name match can authorize them.

### Member updates: related ownership risk, not the identical organisation error

| Form | Slug | Submissions since Sept 1 | Unexpired drafts |
|---|---|---:|---:|
| AHECS join | ahecs-join | 0 | 0 |
| Freelance enquiry | freelance-enquiry | 3 | 0 |
| Freelancer membership | freelancer-membership | 6 | 6 |
| HoS Join | hos-join | 0 | 0 |
| Individual | individual-join | 45 | 0 |
| Partner Individual Join | partner-individual-join | 0 | 0 |
| PoC Join | poc-join | 1 | 0 |

These configure member mutation/upsert pipelines. A fresh unauthenticated
attempt whose email resolves to an existing member can reach the member
ownership guard. They are not proven universally broken: new-record submissions
and verified-owner paths differ. Organisation-scoped applicant continuation is
not a valid blanket repair for member-only flows. Preserve new-member signup,
and provide verified-owner access for existing-member updates rather than
granting authority from a supplied email or silently discarding updates.

### Already addressed / no matching configuration risk

- Partner Full Application has the approved applicant-continuation policy.
  The user reports the change works and they could update the form. A September
  28 submission now exists, but no grant was issued by this investigation and
  the successful request's authentication path was not inspected.
- The other 29 forms (23 active, six inactive) have no existing-member or
  organisation mutation target under this audit. They are not flagged for this
  specific issue; this is not a broader health certification.

## Evidence limits and recovery

No retained September submission for the eleven reviewed forms contains the
literal “verified ownership” message in processing notes. This is **not**
evidence that there were no failures: rejected attempts can leave no retained
submission. Submission counts prove persistence, not completion of every side
effect. Do not replay existing records based on these counts.

No tenant forms were changed by this audit. No migrations were required or
applied; none are pending for the audit. No deployments, emails, payments,
capability issuance, submissions, or recovery actions were performed.