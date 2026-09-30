# BNMS resource import audit — 2026-09-20

**Read-only audit. No imports, updates, taxonomy changes, storage changes, or migrations occurred.**

- Surviving relevant uploads: 10
- Audited upload window: 2026-05-27 through 2026-09-15
- Verified production project/tenant: lvmzliemqnieeoruhkik / ff2df806-b321-4254-b651-3af11fccf1db (BNMS)
- Production read timestamp: 2026-09-20T14:42:32.461Z; report generated: 2026-09-20T14:51:23.629Z
- Populated source rows: 5773
- Distinct resource identities: 3356
- Source-row classifications: {"ambiguous":265,"intentional_hold":137,"invalid":18,"metadata_access_mismatch":438,"present":4915}
- Deduplicated classifications: {"ambiguous":133,"intentional_hold":115,"invalid":18,"metadata_access_mismatch":291,"present":2799}
- Confirmed absent identities (execution evidenced, now absent): 0
- Intentional historical holds (not counted missing): 115
- Source rows with historical hold evidence (including rows now present): 502
- Held-then-executed source rows: 155; terminal execution supersedes the earlier proposal/skip hold while both remain in the timeline.
- Executed IDs resolved 8 rows that URL identity alone left ambiguous (six changed URLs and two duplicate URL identity groups).
- Identity absent from destination: 257 unique identities / 405 source rows; {"ambiguous":127,"intentional_hold":115,"invalid":15}. This includes held and unresolved identities and does not assert a failed import. Zero executed-now-absent identities does not mean zero identities are absent.
- Production resources: 3327; two full ordered exact-count reads, stable SHA-256 16f934e317f75737a22853190bcf5a6f55b7c87fe0fa13b9411be6fd4e218cf1

## Per-file totals

- attached_assets/BNMSResourcesClean_1779888089327.csv: 29 rows; {"metadata_access_mismatch":27,"present":2}; absentFromDestination rows 0
- attached_assets/bnms-resources2_1780477749303.csv: 921 rows; {"invalid":1,"metadata_access_mismatch":28,"present":892}; absentFromDestination rows 0
- attached_assets/bnms-resources3_1780478750493.csv: 921 rows; {"invalid":1,"metadata_access_mismatch":28,"present":892}; absentFromDestination rows 0
- attached_assets/BNMS-batch3-correct_1780479260692.csv: 195 rows; {"invalid":5,"metadata_access_mismatch":92,"present":98}; absentFromDestination rows 5
- attached_assets/Resources_-_categorising-tagging_YOUTUBE_FINALISED_1789471419015.xlsx: 195 rows; {"invalid":5,"metadata_access_mismatch":131,"present":59}; absentFromDestination rows 5
- attached_assets/Resources_-_categorising-tagging_PRESENTATIONS_FINALISED_1789478058638.xlsx: 1445 rows; {"ambiguous":7,"intentional_hold":39,"metadata_access_mismatch":80,"present":1319}; absentFromDestination rows 39
- attached_assets/Resources_-_categorising-tagging_POSTERS_FINALISED_1789479638626.xlsx: 921 rows; {"invalid":1,"present":920}; absentFromDestination rows 0
- attached_assets/Resources_-_categorising-tagging_FINALISED_1789486104337.xlsx: 530 rows; {"ambiguous":6,"intentional_hold":98,"invalid":3,"metadata_access_mismatch":16,"present":407}; absentFromDestination rows 106
- attached_assets/Resources_-_categorising-tagging_2026_PRESENTATIONS_AND_POSTE_1789489599381.xlsx: 308 rows; {"ambiguous":126,"invalid":1,"metadata_access_mismatch":12,"present":169}; absentFromDestination rows 125
- attached_assets/Spring_Meeting_2026_resources_1782996382352.xlsx: 308 rows; {"ambiguous":126,"invalid":1,"metadata_access_mismatch":24,"present":157}; absentFromDestination rows 125

“No execution evidence” is not a failed import finding. “Intentional hold” is not missing.
Ambiguous and metadata/access mismatch rows require review; title-only matches never establish identity.
The initial CSV has 29 parsed data records, not the task's claimed 61. The two
June poster CSVs are byte-identical, and the July/September Spring sets overlap.
Earlier CSV imports and YouTube classification have no surviving row execution journals.
