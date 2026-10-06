# BNMS invoicing-address mapping audit

This is a read-only proposal, not an approved backfill. No application behavior,
database data or schema was changed. No migration is necessary or applied.

## Reproduction and private evidence

- `node scripts/audit-bnms-address-snapshot.mjs` reads the pinned current DEST and
  pinned BNMS tenant in one `REPEATABLE READ READ ONLY` transaction, then rolls it
  back. It has no apply mode. Verified TLS and independent REST/SQL project pins
  come from the existing destination connection helper.
- `node scripts/report-bnms-address-audit.mjs` reads the local snapshot only.
- `node --test scripts/bnms-address-mapping.test.mjs` uses synthetic data, no DB.
- Snapshot, full JSON evidence and self-contained side-by-side HTML are under
  `private/bnms-address-audit/`, ignored before generation, outside public assets.
  Do not commit them or publish them as website assets. They contain organisation
  identities and original addresses. Files are created with mode 0600.

## Observed scope

Snapshot: 2026-10-06 05:13:45 UTC. Complete cohort: 477 organisations,
338 with nonblank invoicing addresses and 139 without. There were no line-break
addresses in this snapshot; the parser nevertheless supports CR/LF and CRLF.
All seven exact `org_` definitions were active, organisation-scoped and unique.
No legacy aliases were substituted. Six definitions are text fields; country
is a country selector. Source and destination values are stored as text.
Country selector restrictions were read from the live definition. Canonical
country-name output matches `OrganisationDetailView.jsx` and `shared/countries.js`.

Existing nonempty values: address line 1: 8; line 2: 3; line 3: 2;
town/city: 456; county: 5; postcode: 98; country: 460.
No duplicate destination value pairs were found.

Exclusive categories: 215 clear mappings, 122 ambiguous addresses, 1
existing-value conflict, 139 missing sources, 0 unresolved definitions.
The conflicting record is also ambiguous, giving 123 ambiguous records when
counted independently. The proposed clear subset contains 728 blank-only field
fills across 215 organisations. Nothing has been applied.

## Interpretation and approval boundary

“Clear” means a deterministic, source-supported split without existing-value
conflicts, not proof of postal accuracy. Neither a model confidence score nor
geographical enrichment is used. A town boundary is corroborated by an exact
existing town component; explicit UK county labels are classified using a
limited enumerated list. Unrecognised localities remain unresolved. Text before
a corroborated town retains its order across at most three address lines;
dependent locality text may legitimately remain in these lines.

Every nonblank source component is represented once in the assignment ledger or
the unassigned list. Original strings remain verbatim in JSON and HTML.
Trimming, delimiter removal and explicit country canonicalisation are the only
normalisations. No missing country, county or other component is invented.
Null proposals do not mean clearing existing values.

Representative clear UK and Pakistan cases, incomplete street-only addresses,
compound administrative-area overflow, and the existing street-value conflict
were inspected against their existing values and proposals. This is not a
manual geographical verification of every organisation. The side-by-side
report exposes all records for owner review.

Recommend reviewing the 215-record blank-only subset for a later explicitly
approved backfill, conditional on the owner confirming invoicing addresses are
appropriate for these organisation fields. Any later writer must re-read and
compare the original source, exact field IDs, definitions and existing values
against this snapshot; changed records require new review. Do not overwrite
the conflicting record or apply ambiguous proposals.
