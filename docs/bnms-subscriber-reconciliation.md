# BNMS subscriber reconciliation

## Finding

**The database supports an expected difference of 19 subscriptions, not a role-exclusion explanation:** newsletter 3,755 versus announcements 3,736 under the current category-card rules. This comprises **14 more member subscriptions and 5 more external subscriptions**. No counting defect is established as the cause of that difference.

This is a live database reconciliation, **not confirmation of the numbers currently visible in an authenticated deployed browser**. No authorized BNMS browser session or screenshot with counts was supplied. The workspace preview at `/CommunicationsManagement` showed `Public API Error (404): Tenant not found` at approximately 2026-11-19 20:27 UTC. Its browser logged the default GSF tenant and legacy SOURCE Supabase identity; it is not BNMS production evidence. Replit deployment discovery reported no Replit deployment; that does not establish the status or revision of the separately hosted Vercel application. Deployed-code parity, live requests and browser cache contents remain unverified.

## Source and identities

Read-only SELECT queries used the documented authoritative DEST project `lvmzliemqnieeoruhkik`, through the configured Supabase SQL connection, scoped to BNMS tenant `ff2df806-b321-4254-b651-3af11fccf1db`.

| Exact stored category name | ID | Active | Member enabled | Public | Role assignments |
|---|---|---|---|---|---|
| Monthly Newsletter - Wavelength | `683b3d0f-3136-4cc8-bb39-b50c9496d1e8` | Yes | Yes | Yes | 0 |
| BNMS Annoucements | `814e0ba4-5afe-4e84-a502-81002ae34a93` | Yes | Yes | Yes | 0 |

The stored spellings are **Wavelength**, not “Wavelenght”, and **Annoucements**, not “Announcements”. Both audiences are public and members. No settings were changed.

## Timestamped count reconciliation

Main aggregate snapshot: **2026-11-19 20:26:04.185650 UTC**. Independent join-based count and quality check: **20:27:21.248644 UTC**, with the same counts. Queries were separate read snapshots, not one transaction spanning both times.

| Category | Members: current rule / independent SQL | External: current rule / independent SQL | Expected card total | Actually observed deployed count |
|---|---:|---:|---:|---|
| Monthly Newsletter - Wavelength | 3,731 / 3,731 | 24 / 24 | **3,755** | Unavailable |
| BNMS Annoucements | 3,717 / 3,717 | 19 / 19 | **3,736** | Unavailable |
| Newsletter minus announcements | **+14** | **+5** | **+19** | Unverified |

“Current rule” means applying the inspected workspace implementation, not reading a deployed page. Member counts require an explicit `is_subscribed=true` preference, a nonempty non-deleted email, `login_enabled !== false`, and `communications_opted_out_all !== true`; members are deduplicated by ID. Missing preferences are not subscribers. External counts count tenant/category rows with `opted_out=false`. The card adds these two counts.

### Exact member-set difference

Among **3,810 eligible members**, the following cells are mutually exclusive and sum to 3,810:

| Newsletter preference | Announcements preference | Members |
|---|---|---:|
| True | True | 3,712 |
| True | False | **19** |
| False | True | **5** |
| False | False | 24 |
| Missing | Missing | 50 |

All other combinations, including null preference values, are zero. Thus 3,712 + 19 = 3,731 and 3,712 + 5 = 3,717. **Missing preferences do not explain the gap:** the same 50 eligible members lack both. Explicit false preferences do: newsletter has 29 eligible false preferences; announcements has 43.

### Eligibility exclusions without double-counting

There are **4,091 BNMS member records**. Apply the following priority: missing email, deleted email, disabled login, global opt-out, otherwise eligible.

| Exclusive member group | Total | True preferences in each category | False preferences in each category | Missing preferences in each category |
|---|---:|---:|---:|---:|
| Missing/empty email | 0 | 0 | 0 | 0 |
| Deleted-email records | 147 | 0 | 0 | 147 |
| Other disabled logins | 3 | 3 | 0 | 0 |
| Other global opt-outs | 131 | 14 | 43 | 74 |
| Eligible | 3,810 | Newsletter 3,731; announcements 3,717 | Newsletter 29; announcements 43 | 50 |
| **Total** | **4,091** | | | |

Overlap disclosure: all 147 deleted-email records also have disabled login; 7 also have global opt-out. Raw disabled total is therefore 150 and raw global opt-out total is 138. These raw totals must **not** be added to the exclusive exclusions. Both categories lose the same 17 true preferences to eligibility (3 disabled + 14 global), so exclusions do not produce the difference.

No member emails failed the basic structural check `^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$`; this is not deliverability verification. Deleted placeholders are checked separately. The current count helper does not validate general email syntax or bounce status.

### External subscriptions

| Category | Active | Explicit opt-out | Null opt-out status | Distinct active normalized emails |
|---|---:|---:|---:|---:|
| Newsletter | 24 | 1 | 0 | 24 |
| Announcements | 19 | 3 | 0 | 19 |

Across the two external categories, 18 normalized addresses are active in both, 6 only in the newsletter, and 1 only in announcements: 6 − 1 = **5**. “Only active” here does not distinguish a missing row in the other category from an opted-out row.

Each category has **4 active external addresses also present on tenant member records**. The category card counts external rows separately and does not deduplicate them against members. Consequently, card totals are subscription-record totals, not a certified number of unique sendable recipients. The campaign merge helper suppresses external addresses belonging to tenant members; this reconciliation did not initiate campaign preparation or sending. Equal overlap totals do not account for the +5 external gap.

### Preference integrity

- Newsletter has 3,822 preference rows: 3,820 with member IDs and **2 with null member IDs**.
- Announcements has 3,820 preference rows, all with member IDs.
- No duplicate **nonnull** member/category pairs, dangling nonnull member references, foreign-member references or foreign-tenant preference rows were found for these categories.
- The two newsletter null-member rows do not count: the shared helper requires a member ID.
- The first evidence file's `duplicate_excess=2` and `orphan_or_foreign_rows=2` are coarse indicators caused by those null IDs, **not two duplicate members or two dangling member references**. The follow-on quality evidence resolves them explicitly.

## Display and loading assessment

Actual inspected HEAD: `edc9084a96b507fe6b6d086fa5deb4895e6de28f`.

- `client/src/pages/CommunicationsManagement.jsx`: member and preference requests use `listAll` with stable ascending ID ordering. Category cards use `filterExplicitCategorySubscribers`; assigned roles are not used to compute this explicit subscriber count.
- `client/src/api/base44Client.js`: `listAll` requests batches of 1,000 and advances by actual rows returned until a short page. Current code is not limited to the first 1,000 members/preferences.
- `api/entities/[entity]/index.js` and `api/_lib/tenantContext.js`: both entities use tenant scope; server limit/offset becomes a ranged query. Deleted member emails are excluded before pagination.
- `api/_lib/externalSubscriberSearch.js`: external counts page through all active tenant rows in stable ID order; query failures throw.
- Member query stale time is 60 seconds; preferences/categories/roles use zero; external counts use 30 seconds. Member/preference queries are disabled on the status-report tab. Query keys for these category data sources are not explicitly tenant-keyed.
- Member/preference results default to empty arrays and their errors are not exposed alongside the count calculation. This can make loading/error states ambiguous, but **no live request failure or stale-cache cause was demonstrated for BNMS**. External count errors have an explicit unavailable state.

These observations establish current source behavior, not deployed request completeness, tenant-switch behavior, absence of request failures, or deployed bundle parity. If the actual screen differs from 3,755/3,736 at a comparable snapshot, the smallest next investigation is an authorized, read-only BNMS browser capture of the loaded counts, entity-page responses, failures, cache state and deployed revision. Do not change consent to make the totals agree.

## Verification and limitations

- Independent SQL uses a join plus `count(distinct member.id)` versus the main snapshot's per-member `exists` classification. Both agree.
- The actual shared member-count helper was replayed against synthetic identities constructed from the aggregate eligibility/preference matrix, with assertions against the independent SQL totals. This verifies computation without exporting member identities.
- The existing isolated `client/src/lib/subscriberModalSearch.test.mjs` suite was run. Its source-text assertion for the first toggle on a missing preference fails because it expects `getToggledExplicitSubscriptionValue(existingPref?.[0])` in the current preference API. This pre-existing test failure is not evidence that these subscription totals are wrong; no test or application code was changed.
- No historical import or individual action provenance is claimed. Current persisted true/false values establish the arithmetic difference, not who set them or whether each originated from an import, member action or administrator.
- No customer data, consent, settings, schema, provider state or deployment was modified; no communications were sent. Only local aggregate evidence and this report were added.

Evidence: `bnms-subscriber-reconciliation.sql`, `bnms-subscriber-reconciliation-evidence.json`, `bnms-subscriber-quality.sql`, and `bnms-subscriber-quality-evidence.json` in this directory. Results contain aggregate totals and category/tenant identifiers, not member contact details.
