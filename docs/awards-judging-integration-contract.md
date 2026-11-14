# Awards & Judging — proposed integration contract

Status: owner approved the proposed policy contract on 2026-11-13, without amendments. This is an implementation contract, not a completed feature or release record.

## Evidence and architecture

The full uploaded brief (sections 1–30 and scenarios A–F) governs the initial release. Existing engagement/manual awards remain unchanged.

Read-only destination catalog inspection on 2026-11-13 confirmed:
- `member` has identity, email, direct tenant and organisation references.
- `organization_contact` is owned through `organization_id`; it has no direct tenant column.
- `audience_list_external_contact` is tenant- and audience-list-owned, not a universal contact directory.
- `opportunity_contact_role` references existing members.

The Supabase MCP catalog request was denied. The existing destination-pinned, certificate-verified SQL connection successfully performed the catalog read inside a read-only transaction. No customer rows, migrations or provider sends were changed. The legacy workspace database is not deployed-schema evidence.

Use member identities where a same-tenant member exists, including organisation-derived tenancy. Resolve established organisation contacts through their owning organisation. Audience-list contacts must remain list-scoped; do not promote them into a global directory. Before migration, inspect contact uniqueness/deletion constraints and the corresponding lookup permissions. Ambiguous email matches require explicit selection, never automatic merging. External email/name data belongs to an appointment/invitation, not a new contact directory; matching an email alone is not authentication.

Reusable assessment services own rounds, criteria versions, appointments, assignments, conflicts, assessment revisions, moderation and decisions. Awards own programmes, form bindings, applications, outcomes, event links and certificate associations. Use relational ownership and composite tenant-safe references; JSON is reserved for versioned definitions/answer snapshots, not mutable authority.

Reuse canonical FormBuilder intake and submissions, tenant session/RBAC resolution, private upload validation, tenant email delivery/tracking, existing event records and PDF rendering. Current form-forwarding links read mutable answers; ordinary storage signatures do not prove assignment authority. Neither is sufficient for judging. Add immutable review versions, restricted sessions, assignment-bound downloads and append-only domain audit records.

## Approved policy contract

1. **Scoring:** normalise scored numeric/mapped criteria with `(value-min)/(max-min)`, then apply weights totalling 100%. Equal judge weighting; retain calculation precision, display two decimals. Binary questions are informational or qualification/review flags, not numeric contributions. Required unanswered questions block submission.
2. **Optional scored answers:** configure policy explicitly before opening judging. Recommended policy: an unanswered optional scored criterion leaves the assessment without a final ranking score, even if qualitative responses can be submitted. Alternative: exclude its weight and renormalise answered scored criteria; no answered scored criteria means no score. Never treat absence as zero. Policy is versioned and cannot change existing assessments.
3. **Completeness and ties:** final averages require the configured minimum, with an optional all-assigned-complete requirement. Exclude drafts, recused, invalidated and superseded assessments. Unresolved cutoff/winner ties block confirmation until a reasoned authorised decision; no ID/order-based tiebreak.
4. **Visibility:** blind means other judges' scores/comments are hidden, not automatic anonymisation of applicant answers. Applicant identity masking is a separate explicit field/file projection. Reveal-after-submit and open modes expose only completed permitted assessments. Moderation access is separately appointed and audited. Exports and downloads use identical restrictions.
5. **Conflicts and approval:** proposed default blocks scoring for unresolved potential and confirmed conflicts. Confirmed conflicts require reassignment; any permitted override requires a configured authority and reason. Chairs propose; a separate approver approves by default. Self-approval is permitted only through explicit award configuration and appropriate independent RBAC authority.
6. **Time:** persist UTC instants and an IANA award timezone. Show the timezone with every deadline; reject ambiguous/nonexistent local times until explicitly resolved. Windows are opening-inclusive and closing-exclusive. Event rescheduling never silently changes award deadlines.
7. **Revisions:** before-deadline applicant amendments create new immutable versions. Once review starts, adopting a new version requires an explicit audited action identifying affected assignments; never mix versions into one final aggregate. Criteria lock at judging start. Reopening creates a successor revision and invalidates dependent finality until reconfirmed, without erasing earlier evidence.
8. **State transitions:** draft → applications open → applications closed → judging → moderation/shortlisting → results approved → completed → archived. Opening requires a valid bound form and dates; judging requires valid locked criteria and eligible assignments. Configured moderation must finish before downstream confirmation. Overrides require permission, confirmation, reason and version checks; they never implicitly publish or send.
9. **Release:** recommendations, approvals, publication and recipient delivery are separate authorities. Publication is explicitly scoped by audience, event and outcome category. Messages/certificate retrieval require an explicit recipient release; approval alone releases nothing. Published corrections create new publication revisions and require fresh authorised delivery decisions.
10. **Retention:** archive retains historical evidence. No automatic destruction or anonymisation period is inferred. Before real intake, require the tenant to specify its retention period, legal-hold rules and permitted disposal authority. Controlled disposal must preserve the permitted audit record while removing expired personal content; ordinary form/entity deletion must not bypass it.
11. **External access:** propose invitations expiring after seven days and restricted sessions after twelve hours, capped by appointment expiry. Resend/revoke invalidates earlier credentials immediately, not saved work. Existing members use normal login; no external appointment creates a member account. Hashed single-use redemption, secure cookies, CSRF/origin checks and rate limits are mandatory.
12. **Delivery:** durable deduplication and claim leases through existing mail transport. Recheck current authority at send time. Ambiguous provider acknowledgement requires reconciliation rather than blind automatic resend. No real customer test mail.

## Requirement-to-stage and verification map

Stages refer to the assigned 15-stage plan. Every row is required; none represents deferred MVP scope.

| Brief sections | Stages | Verification obligation |
| --- | --- | --- |
| 1–2, 27, 30 architecture/reuse | 1–2, 15 | Destination catalog, integration boundaries, additive migration rehearsal |
| 3 navigation and UI permissions | 3, 5, 7 | `/awards`, `/judging`, direct API denial; A/B/F |
| 4–5 programmes/configuration | 2–3 | Independent awards, safe duplication, validation and transition races; A |
| 6 forms/applicants | 4 | Shared-form award context, immutable versions/files, status/amend/withdraw and legacy edits; A/B/F |
| 7–8 identities/permissions | 3, 5 | Canonical identity lookup, redemption replay/expiry/resend/revoke and role/appointment separation; B/F |
| 9–10 criteria/assessment UI | 7 | Every criterion type, ranges/weights/optional policy, durable drafts, atomic locking and reopen history; A/B |
| 11–12 aggregation/visibility | 7–8 | Precision, completeness, exclusions and blind/reveal/open projections including exports; A/F |
| 13–14 conflicts/allocation | 6 | Preview/confirm, fair capacity, concurrent duplicates, replacement and explicit inclusion decisions; A/F |
| 15 shortlisting | 8 | All four modes, ties, incomplete entries, overrides and no automatic release; A |
| 16–18 moderation/chairs/rounds | 9 | Discussion access, criterion/overall proposals, approval/reopening, fresh panels and preserved prior rounds; C/E/F |
| 19 results | 10 | Three selection methods, categories, approval/publication separation and published corrections; A/F |
| 20 events | 11 | Supported event types, admin progress, independently gated projections, cancellation/reschedule preservation; D/F |
| 21 certificates | 13 | Existing renderer, placeholders, preview/approval, immutable private PDFs and recipient authority; D/F |
| 22 communications | 12 | Every message category, send-time release checks, leases/retry/replay and delivery history; B/D/F |
| 23 reports | 14 | Counts/matrix/drilldown/discrepancies, round filters, complete paged CSV/Excel and PDF, identity rules |
| 24–25 audit/security | 2, 5, 15 | Immutable reconstructable audit; DB grants/RLS; generic CRUD/storage bypass; cross-tenant/award denial; F |
| 26 edge cases | 4–15 | Each listed edge case as regression fixture plus integration tests for lifecycle races |
| 28 UX | 3–14 | Existing styling, responsive split-view, empty/error states and confirmations |
| 29 acceptance | 15 | A–F end to end; isolated checks and deployed evidence recorded separately |

## Release gates

Policy approval precedes dependent implementation. Before release, verify destination identity and deployed constraints again; build and test additive migrations on an isolated PostgreSQL database, then use the existing reviewed migration safeguards. Test actual API, database policy, concurrency and browser paths, not only helper calculations. Provider fixtures demonstrate integration logic, not provider delivery. Do not declare the task complete until every stage and all six scenarios pass. No deployment is authorised from this task fork.
