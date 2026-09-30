# Interpretation and spot checks — 20 September 2026

This audit measures the saved production read at 14:42:32–14:42:41 UTC, not
subsequent changes. Output regeneration used that snapshot offline. The upload
coverage is surviving workspace evidence, not a claim that every historical
attachment or chat survives.

## Corrected terminal-history interpretation

Proposal/skip evidence and terminal execution evidence are separate timeline
events. **155 source rows contain both an earlier hold and a later executed
destination ID.** The terminal execution supersedes the proposal hold for
historical-outcome interpretation; both events remain visible in each row's
`historicalTimeline`.

Executed destination IDs are resolved against the saved current snapshot before
URL or title matching. This corrected eight rows that URL-only matching had left
ambiguous:

- six rows have a changed literal/provider URL and are current
  metadata mismatches, not absent identities;
- two duplicate URL identity groups are disambiguated by the executed ID;
- across the eight rows, seven are metadata mismatches and one is present.

No title was used as an identity key.

## Corrected current totals

Across **5,773 source rows** and **3,356 deduplicated identities**:

- **2,799 present**
- **291 metadata/access mismatch**
- **133 ambiguous**
- **18 invalid**
- **115 intentional historical hold**
- **0 confirmed executed-now-absent**

Separately, `absentFromDestination` identifies **257 unique identities / 405
source rows** without a current destination identity: 127 ambiguous, 115 held,
and 15 invalid. These are not a failed-import total. Zero
executed-now-absent identities does not mean every requested resource is
present.

## What needs attention

- The 115 held/absent identities remain decision items, not evidence of failed
  execution.
- The 127 absent ambiguous identities need identity resolution; title-only
  candidates and shared folders cannot establish individual-resource presence.
- The 15 absent invalid identities need source correction before any import
  decision.
- The 291 matched identities with metadata/access differences need field-level
  review. The workbook exposes source and current title, description, URL,
  normalized date, access, collection, resource type and topics, plus current
  role IDs, member group and status.
- Formula-bearing rows, hyperlink conflicts and shared folders remain
  unresolved even if a literal URL happens to match.

## Evidence and safety

Every row includes a human reason, recommended next action, historical timeline,
current outcome, actual matched values, mismatch fields and access context.
`candidate-review.json` keeps confirmed execution-loss findings separate from
identity absence.

The saved snapshot is pinned to project `lvmzliemqnieeoruhkik`, BNMS tenant
`ff2df806-b321-4254-b651-3af11fccf1db`, with stable SHA-256
`16f934e317f75737a22853190bcf5a6f55b7c87fe0fa13b9411be6fd4e218cf1`.

No resources, taxonomy, permissions, storage or database schema were changed.
No migrations were required or applied.