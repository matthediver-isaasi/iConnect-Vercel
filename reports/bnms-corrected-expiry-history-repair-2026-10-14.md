# BNMS corrected-expiry membership history repair

## Authorisation and scope

The owner confirmed paid membership through the retained corrected expiry dates
for the 96 missing-history members identified by the 155-member formatting audit.
This includes 90 upfront members and six members with legacy DD evidence.
No other missing-history member was included.

Contract SHA-256:
`ac63496b148b5047c7ccb8ab28db0fd60919e5e79c898cf8e527393c5044d69c`

## Production result

- Applied to the pinned external DEST Supabase production database.
- Inserted 96 membership histories: 66 active, 30 expired.
- Historical start dates, amounts, currency and invoice links remain unknown.
- Paid status is administrator-confirmed, not provider-verified settlement.
- Six DD-evidence histories have no billing agreement or collection attached.
- Existing histories, CRM/custom fields, billing agreements, payment plans,
  GoCardless payments, renewal-policy assignments and archived invoices were
  fingerprinted and unchanged within the repair transaction.
- Replay inserted zero records and verified all 96 existing repair records.
- No migrations, invoices, provider calls, collections or renewal policies.

Private before/after evidence is retained in ignored generated-artifacts files.
Per-member approval provenance is also recorded in each history's notes.

## Verification

- Real insert dry run followed by rollback passed.
- Production commit and committed-row reread passed.
- Zero-write replay passed.
- 20 focused reporting/attestation tests passed.
- NMC projection includes 78 repaired members; 18 remain excluded because their
  retained expiry is over 90 days old.
- At verification, Full and Full Junior was 321; Online-only was 293. The other
  two sheets were empty.

## Release boundary

The data repair is already applied. The new reporting attestation helper and
NMC integration require application deployment before the live report recognises
these records. No database migration remains to apply. Signed-in UI verification
was not performed; counts were verified using the actual report projection
against production records.
