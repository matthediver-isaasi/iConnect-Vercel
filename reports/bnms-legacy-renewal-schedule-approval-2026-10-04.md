# BNMS legacy renewal schedule approval — 4 October 2026

## Approval and limits

The operator explicitly selected all seven proposed schedule mappings and
“All selected cohorts, including Full Overseas if selected” for the policy.
This is **review approval only**, not authority to write assignments, install
migrations, enable rollout, collect payment or create successor memberships.
Any database writes require separate approval.

Scope: the exact 72 history IDs below, tenant
`ff2df806-b321-4254-b651-3af11fccf1db`. No subsequently discovered records are included.
The read-only DEST review found 83 non-deleted expiry-only paid histories:
11 already assigned and these 72 unassigned. All 72 passed
`isAttestedExpiryOnlyHistory` in `api/_lib/expiryOnlyRenewalPolicy.js`.
That predicate checks historical shape, not all payment/renewal admission gates.
The effective `membership_successor_elections_enabled` result was false.

Approved policy for every listed record:

- `renewal_open_days: 90`
- `renewal_grace_days: 90`
- `renewal_disable_login: true` (after grace if still unrenewed)
- `renewal_change_role: false`
- `renewal_fallback_role_id: null`

The five Full Overseas records have an explicitly approved record-scoped
exception: their assigned schedule currently has zero-day opening/grace and
does not disable login. Do not modify the shared schedule settings.

Preserve the recorded expiry and source provenance. Historical commencement,
amounts and invoice settlement must not be inferred or relabelled. This approval
does not establish recurring consent. Expiry plus one day defines the potential
successor start, not an existing financial commitment.

## Exact approved schedules

All names below begin with `2026-2027 `. These are exact configuration bindings,
not instructions to resolve a future default or match a tier label.
All were active annual member schedules with no effective end at review.

| Cohort | Count | Schedule suffix | Configuration ID | Effective from |
|---|---:|---|---|---|
| Full UK | 37 | Full member | b59692c9-07b0-469d-9f6e-9d314a270926 | 2026-09-01 |
| Junior UK | 13 | Full member junior | 0c68ef89-8543-4dc8-a759-20ab9b2598f5 | 2026-08-18 |
| Trainee UK | 8 | Trainee member | 5ab8875e-25a7-4224-a8b9-b9ff53871800 | 2026-09-01 |
| Student | 4 | Student | 57ba60c8-3703-4b2c-83ae-0cf7f0884cf8 | 2026-09-04 |
| Associate UK | 3 | Associate member | 9b1615b0-0699-487f-8ee5-c34746b72493 | 2026-09-01 |
| Full Overseas | 5 | Overseas full member | 1e82bb61-a0b3-4e6c-8bad-92cb527cd0ce | 2026-08-18 |
| Associate Overseas | 2 | Overseas Associate member | 62c6a57d-23c3-432d-881f-33a095a3e658 | 2026-09-07 |

No NMC-specific or LMIC schedule was selected. The ended Full member configuration
`5bf28257-540e-4aff-9b15-bfbaf0290396` is explicitly not the approved schedule.

## Pinned cohort membership and expiry

| Cohort | History ID | Recorded expiry |
|---|---|---|
| Full UK | 261a9052-8b8c-55d5-a581-fe10cf1031cd | 2026-10-04 |
| Full UK | 1c11d958-6af4-5a65-ae92-b10cd9536128 | 2026-10-09 |
| Full UK | 3a5c3078-b0b6-551c-aa30-abfac88f3ad2 | 2026-10-15 |
| Full UK | ddf6e7f7-6df4-5ee5-a5ef-a5295ac964b4 | 2026-10-15 |
| Full UK | d90ba9ef-2e94-5d81-a612-51218b860d9a | 2026-10-16 |
| Full UK | 4a4c86a0-fd93-526c-a1a7-7dabe920a39a | 2026-10-20 |
| Full UK | 9f8e784b-21ab-5f5a-aed7-68fb737702dc | 2026-10-20 |
| Full UK | 4b1f32f3-4bfc-5aa6-abc0-a434d62d9b16 | 2026-10-21 |
| Full UK | 16acfecc-b6a2-5bc1-a116-ef75fd39390b | 2026-10-23 |
| Full UK | 1fade03d-bc98-54a2-a51a-3542a4a5011d | 2026-10-23 |
| Full UK | 3185c0ee-bbcf-5f2a-a3d4-1931553ace2c | 2026-10-26 |
| Full UK | c782c575-7b80-5617-ab1d-7da52f12a6a5 | 2026-10-26 |
| Full UK | 3778bdff-c1bb-57d1-a984-f87399a2568b | 2026-10-29 |
| Full UK | 5896803c-5815-5f76-a93f-724b7a0fcb77 | 2026-10-30 |
| Full UK | 12d06f73-1e83-52fb-ae58-fa2a01ec2b82 | 2026-10-31 |
| Full UK | 183f4e41-181e-562d-a460-dfc4c128f77c | 2026-11-01 |
| Full UK | 45c21ed1-59d9-5c87-a932-f9fe638b236e | 2026-11-07 |
| Full UK | e5d7cb21-996d-5508-ace8-4cdf9b2c8693 | 2026-11-07 |
| Full UK | 14953c8e-0a70-58da-ada6-39d3eb425681 | 2026-11-08 |
| Full UK | 1d1db3bf-a711-509a-a5d9-4a3e76583e5c | 2026-11-09 |
| Full UK | bca66caa-7260-5409-a0e1-f496675541cd | 2026-11-11 |
| Full UK | 7518bf91-1627-56e7-ae1f-68e3ba88005a | 2026-11-14 |
| Full UK | 5f3a5ec1-5f32-5733-a54e-73d267a6bfb0 | 2026-11-20 |
| Full UK | d8996d6b-7859-54bd-a34d-e280614830b9 | 2026-11-27 |
| Full UK | e2c7f374-266f-5104-aa03-ba6b3b4de1ed | 2026-11-27 |
| Full UK | ebb0a61d-c34c-512a-ad05-c00a27dfe309 | 2026-11-28 |
| Full UK | 781707d6-3066-5d01-a129-47187f9e204b | 2026-12-03 |
| Full UK | 41855bd4-b338-5160-af3e-9fdfb95af9c3 | 2026-12-05 |
| Full UK | 9705166d-6d34-5dbc-a3e3-7e6418323af7 | 2026-12-08 |
| Full UK | 16bad9bc-3e19-557f-a9d7-29644a2ba5c8 | 2026-12-09 |
| Full UK | a9246a55-3364-5af8-a224-fedae14d0026 | 2026-12-09 |
| Full UK | 3fbd7697-8c83-5583-a10e-bc1b20845736 | 2026-12-21 |
| Full UK | 313f9098-4231-59e8-ae0f-e078059b5e9c | 2026-12-23 |
| Full UK | 40198ffc-9243-5d6d-af76-10ad160fbb69 | 2026-12-23 |
| Full UK | 4ffb805c-c007-5cb6-ab01-9f89873e3aa8 | 2026-12-24 |
| Full UK | 3d6930e7-5a07-52ac-a3ec-a45db62caabe | 2026-12-29 |
| Full UK | 83a0354a-56f5-57bc-afea-b13614080c3a | 2026-12-29 |
| Junior UK | 0e42d3a7-2729-51d2-a75f-4b8c5229e014 | 2026-10-05 |
| Junior UK | 0641699f-fc54-541b-a33d-71eb6a1388f6 | 2026-10-06 |
| Junior UK | db94421d-2c8a-568f-a21f-e6115199a047 | 2026-10-12 |
| Junior UK | 6eb83c51-077d-5349-aaea-894ff007f0d2 | 2026-10-16 |
| Junior UK | 5d0a93f6-74a7-533b-a666-8c02be7aaa47 | 2026-10-31 |
| Junior UK | 9278df75-6578-58f0-ae03-18eadebf9766 | 2026-10-31 |
| Junior UK | 40d0ed81-cb59-5a87-a6bf-210662102205 | 2026-11-07 |
| Junior UK | 76fde6d7-cc72-5640-af50-8d445775ea2a | 2026-11-17 |
| Junior UK | ecffe9df-9a01-5ea3-a387-adb887569d5e | 2026-11-25 |
| Junior UK | 67a813e0-076b-52ff-a7ab-a1a71fb48c3e | 2026-12-06 |
| Junior UK | 7d790956-03ce-531f-a800-12204ce38e25 | 2026-12-15 |
| Junior UK | b6124551-82cb-5dc4-af25-1ac80099fd1a | 2026-12-20 |
| Junior UK | 5aca6520-6834-5a4d-aeaa-8573ce67c689 | 2026-12-22 |
| Trainee UK | 69f1e0d8-2f9b-5f37-a178-6a35b0e4a075 | 2026-10-05 |
| Trainee UK | 2ad5f138-fac3-5f6c-a84b-e5ed0aa8d54f | 2026-10-09 |
| Trainee UK | 5ec0a3fc-eb8e-54e7-a397-52829e4f000e | 2026-11-19 |
| Trainee UK | 0d6fa2a4-928d-5e07-a2ad-0e2af141c821 | 2026-12-02 |
| Trainee UK | cedad214-bca4-5f2f-aa3e-f6054bd12f0f | 2026-12-10 |
| Trainee UK | 8638d24c-ef35-590c-a444-ae0d95c3b06d | 2026-12-11 |
| Trainee UK | ef469a6b-f5b1-5415-aafb-f8eb92956230 | 2026-12-20 |
| Trainee UK | 624d16f1-5e32-5de5-aa66-9991ea5cd72d | 2026-12-23 |
| Student | 2c344813-ec9f-5373-a1e9-27480ebc7a58 | 2026-12-01 |
| Student | ead95209-3bec-5448-a424-1c0206ca56b6 | 2026-12-01 |
| Student | 967d0153-4569-5943-aeff-2bda4e260d6b | 2026-12-16 |
| Student | dd93dfe0-9912-57ee-afcb-75bd8e20e609 | 2026-12-22 |
| Associate UK | 699af668-66c7-5111-a86d-1840271f0280 | 2026-12-02 |
| Associate UK | 34848a26-bd36-5b75-a971-72c03c70faed | 2026-12-04 |
| Associate UK | 035c6e70-dbc3-52b8-aa25-d2b8adc61130 | 2026-12-22 |
| Full Overseas | 61bf3518-b3db-5ad7-aac0-e3de81f121c9 | 2026-10-03 |
| Full Overseas | 36d03663-c9e3-5cad-a630-53f0a4776f9f | 2026-10-05 |
| Full Overseas | efc756f8-7cd8-5f66-aa27-980c02b0c588 | 2026-11-10 |
| Full Overseas | 178a4c28-5c18-5777-a745-cc10b8aa7a30 | 2026-11-16 |
| Full Overseas | fc2e4f9b-0e8c-5fba-a46a-5121bd198c3b | 2026-12-25 |
| Associate Overseas | 4087bedf-0d80-57b1-a6fa-cdb11b126a77 | 2026-10-05 |
| Associate Overseas | 0e91bb65-f45e-5908-a8e7-4d7225819bb0 | 2026-11-25 |

## Separate implementation gate

No assignments or migrations were written during this review. No migration is
needed to record this approval. Installation of the legacy renewal safety
migration and assignment application remain separate, approval-gated work.

After separate write approval, reuse the safeguards in
`scripts/assign-bnms-expiry-only-renewal-policy.mjs` and
`scripts/repair-bnms-reviewed-expiry-policies.mjs`; neither existing runner
currently authorizes this new cohort. Do not run their earlier cohorts as a
substitute. Prepare a reviewed, hash-pinned plan binding each history to its
member, original provenance and exact configuration version, and reject drift,
deleted members or conflicting assignments. Preserve full history before/after
and verify idempotent replay. Review the database's narrowly scoped overseas
exception before extending it to these five records.

Keep rollout disabled. Revalidate provenance and all current conflict,
agreement, pause and election checks before any future payer-initiated renewal.
See `guides/membership-form-renewal-choices.md`.