# BNMS member invoice address audit

This is a one-off, explicitly authorised operational audit and empty-only
backfill, not a synchronisation feature. It uses the existing pinned DEST SQL
connection with verified TLS. It must never run against SOURCE or through an
application invoice/contact-creation workflow.

## Private evidence

All live snapshots, full contact responses, pins, manifests, before-images,
receipts and the Excel workbook belong under
`generated-artifacts/bnms-member-invoice-audit-<run>/`. Both Git and deployment
ignore this directory. Directories use mode 0700 and files 0600. No member data,
OAuth values or signed URLs belong in source, logs, documentation or public
assets. Deliver the workbook using the private project attachment mechanism;
do not expose it through an unauthenticated application route.

## Safety contract

- Pin the BNMS tenant, DEST project, selected token connection and Xero company.
  Verify `/connections` and the live Xero Organisation response.
- Include every member status. Resolve direct tenancy first and count inherited
  tenancy separately. Inherited tenancy alone never authorises an address write.
- Resolve the tenant's unique CPD Guest role. Exclude primary and any installed
  `member_role` secondary assignments. Retain catalog evidence of role schema;
  reject unrecognised secondary-role schemas rather than silently omitting them.
- Read members using keyset pages with an exact independent count and terminal
  empty page in a repeatable-read snapshot.
- Contacts discovery is sequential GET-only, including archived contacts, with
  page size 100, terminal empty page, duplicate-ID checks, a 200-page bound and
  1.6-second pacing. Use existing shared quota reserve/finish controls with the
  same hashed client identity as application callers. Quota bookkeeping is the
  only non-address database mutation. Provider errors or pagination failure are
  incomplete coverage, not absent contacts.
- OAuth tokens remain in memory. No refresh or reconnect is performed by this
  runner. Expired credentials stop it, without writing addresses.
- Identity authority is a verified tenant/member/company binding (with
  contact/invoice ownership evidence) or a unique exact trimmed,
  case-insensitive email. Never use names, organisation addresses or card
  information as authority. Hold inconsistent links, duplicate matches, shared
  member identities, missing bound contacts and archived contacts.
- Only POBOX is an invoice-address source. Preserve original source components
  and raw addresses. Map the six canonical components verbatim. `AddressID` is
  retained provider metadata, not an address component to copy. Hold attention,
  third/fourth lines, unknown nonempty address components, invalid types,
  control characters, overlong fields and missing first lines. Never substitute
  STREET, concatenate extra source text or truncate it.
- Comparison only trims, collapses whitespace and lowercases. It never rewrites
  country names, punctuation or postcode conventions.
- Any nonblank canonical target component protects the entire target.
  Partial addresses are never completed automatically.

## Execution

1. Run `node scripts/audit-bnms-member-invoice-addresses.mjs --discover <dir>`.
   This writes the member snapshot and initial complete/incomplete discovery.
2. Run the same script with `--plan <dir>`. Inspect the aggregate counts,
   classification and manifest SHA256. The manifest is immutable and pinned.
3. Only within the specific user-authorised request, run
   `--apply <dir> <manifest-sha256>`. A second full GET-only company contact scan
   supplies fresh source evidence. Source changes, changed identity/eligibility
   or nonblank targets cause skips, not automatic reinterpretation.
4. The transaction locks cohort member/role rows, the selected connection and
   integration, and the secondary-role relation if installed. It rechecks all
   targets and owners. A guarded UPSERT into `invoicing_address_private` checks
   all six fields for emptiness atomically and returns every committed value.
   A concurrent target edit either wins the guard or aborts the serializable
   transaction. No write is silently accepted.
5. Verify copied values and all untouched tenant address rows before commit;
   verify member records, roles and historical mapping evidence unchanged.
   Verify copied values again after commit, retain receipts, and recompute the
   plan to prove zero-write replay. If any new candidate remains, disclose it
   rather than claim global idempotence.
6. Run `node scripts/export-bnms-member-invoice-addresses.mjs <dir>`.
   The workbook has Summary, All member audit, Differences, Copied addresses,
   Review and errors, and Contact match evidence sheets. Before, source and after values are separate.
   Conflicting candidates retain their separate names, identifiers, matching
   evidence and complete raw addresses; no arbitrary contact is selected.
   Literal text cells cannot become spreadsheet formulas. Reopen and reconcile
   the workbook before private delivery.

Evidence files are create-only. A repeated apply with the same run directory
stops before writes; a new plan against committed values yields no candidates
for already-copied addresses. Never delete existing evidence to force a retry.
After a failed transaction, distinguish rollback from a post-commit
verification failure using the durable receipt journal.

## Isolated checks

```
node --test scripts/bnms-member-invoice-addresses.test.mjs \
  scripts/bnms-member-invoice-addresses.postgres.test.mjs \
  scripts/bnms-member-invoice-workbook.test.mjs
```

These use synthetic members/provider responses and disposable local PostgreSQL,
not live tenant mutations. They cover exclusion, duplicate/name-only identity,
failed lookup, full pagination, archived contacts, null/partial/empty targets,
extra source components, field limits, concurrent edits, replay and formula-like
workbook data.

## Completed live run — 2026-11-18

- Reconciled 4,091 tenant members across all statuses: 2,685 CPD Guest
  exclusions and 1,406 eligible audit rows.
- Both complete Xero scans returned 3,769 contacts, including archived
  contacts, using 41 GET requests each (connection, organisation, 39 contact
  pages including the terminal empty page).
- Copied and verified 251 addresses; zero skipped writes or lookup failures.
- Left 431 members with no verified contact and 24 without a usable invoice
  first line unchanged. Held 700 review rows: 606 with extra source address
  components, 88 conflicting identities, and six archived contacts.
- The initial private member-address store had no BNMS member addresses.
  All non-member address rows were preserved, and member records, role
  assignments and immutable historical mapping evidence were unchanged.
- Post-commit read-only replay proposed zero further address writes. The
  cohort and CPD Guest exclusion counts remained unchanged.

Live evidence and per-member details are private and intentionally not
committed. No Xero contacts, invoices or source address data were modified.
