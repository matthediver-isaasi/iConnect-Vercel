# BNMS 2027-expiry membership correction

## Scope and outcome
On 19 October 2026 the owner authorised correcting missing current memberships
like the reported BNMS member and identifying other members with the same condition.

18 records were inserted into the live DEST member membership history. The
transactional dry run succeeded; an exact replay made zero writes. No schema
migration was required. SOURCE was untouched.

Eligibility required active imported membership, a current 2027 expiry within one
year of the review date, unique member-class structure resolution, imported paid
membership invoice evidence, and no existing history, organisation membership,
billing agreement, payment plan or known Direct Debit evidence. Student/former
members were excluded. Two otherwise eligible cases had historical DD invoices
and remain held for provider/collection review.

## Evidence boundaries
- Retained expiry; start/renewal dates and historical membership price unknown.
- No reconstruction of a 12-month start or automatic extension of expiry.
- Imported paid invoice evidence is not live provider settlement verification.
- Event totals are not treated as membership charges.
- No Xero invoice links, future collection authority or renewal policy invented.
- No provider requests, payments, invoice creation, email or member edits.
- Membership display and NMC recognition use the same narrow evidence predicate;
  this does not broaden renewal/collection eligibility or the older 2026 contract.

## Rollout
Deploy the accompanying API changes to show the corrected current memberships
and recognise them in the NMC report. The deployed authenticated UI was not
verified. The local preview uses legacy SOURCE and could not render this BNMS
member's authenticated detail page.

## Verification and audit
- 133 focused test cases passed across the regression run and corrected test-fixture rerun.
- Real DEST rollback test, 18-row commit, exact zero-write replay.
- All corrected saved records recognised by the updated current-membership projection.
- Private recovery journal and commit marker:
  `generated-artifacts/bnms-2027-correction/`
- Member-level results:
  `generated-artifacts/bnms-2027-correction/BNMS-2027-membership-correction.csv`
- These generated files are excluded from Git and deployment.
- Runner: `scripts/correct-bnms-2027-expiry-gap.mjs`; review and rollback-only
  dry-run must precede apply. Do not replay the old 2026 backfill with wider limits.
