# Agenda-speaker live rollout — 24 November 2026

## Outcome

Installed the six approved training-speaker migrations on Supabase project
`lvmzliemqnieeoruhkik`. The targeted gate was reopened at
**2026-11-24 20:57:16 UTC**, generation **3**. No unfinished tracked operations
remained at that check.

The owner approved the maintenance window and explicitly accepted the residual
risk of older, untracked deployment callers. Their absence was **not** proven.
No global cron disable, historical backfill, automatic allocation, test email,
certificate replacement or missing-speaker-reference repair was performed.

## Release and pause evidence

- Preview: `dpl_CXLfbP12kipw829y92RCmzfZgibD`, Ready.
- Production and cron target: `dpl_2tTJ7zzrBWqMWciVfCzwFQvXT1Z2`, Ready.
- Both revisions: `cd66fe473e9b6507f29e8e7f4d51f5603a62a955`.
- Both deployments contained the tracking environment-variable key.
- Production demonstrated effective tracking: two speaker-award runs and
  21 Zoom-speaker runs completed without recorded wrapper failures before pause.
- Open → draining → paused used generation-checked operator transitions.
- At drain verification: zero unfinished tracked operations, zero notification
  leases and zero pending/error certificates.
- Paused at **20:54:56 UTC**; fresh baseline showed zero certificate attempts
  during the preceding 30 minutes.

These checks establish tracked completion, not independent proof of delivery
success or absence of untracked external effects.

## Installed migrations

Exact file hashes matched the owner-supplied manifest before execution.
Each file ran in its own transaction with a five-second lock timeout and
60-second statement timeout added for execution only. Source files were not
modified. Supabase assigned these installation-ledger versions:

| Approved file prefix | Name | Installed ledger version |
| --- | --- | --- |
| 202701220001 | training_speaker_scope | 20261124205546 |
| 202701220002 | training_speaker_processing | 20261124205549 |
| 202701220003 | training_speaker_lifecycle | 20261124205553 |
| 202701220004 | training_speaker_atomic_save | 20261124205556 |
| 202701220005 | training_speaker_consumers | 20261124205630 |
| 202701220006 | training_speaker_deletion | 20261124205633 |

The new policy cutoff is **2026-11-24 20:55:46.130115 UTC**.

## Preservation verification

Fresh before/after aggregate fingerprints matched exactly while paused:

| Evidence | Count | MD5 change-detection fingerprint |
| --- | ---: | --- |
| Award grants, excluding newly added scope fields | 42 | 4d42a6d5bc927c722da4cdd265384c51 |
| Recognition rows, excluding new agenda identity | 38 | 3a5f2dca8df5066802f2ec779e1e50b7 |
| Private certificate object metadata | 36 | a3365de92cf4d611763d6420fdf9fde0 |
| Existing agenda data, excluding new fields | — | 2f23b6d9a7697e933e5a195cb5cca851 |

Fingerprints used ordered JSONB row aggregation, not the earlier task's
fingerprint formulation. Compare this window's before/after values, not those
earlier fingerprints. No PDF bytes were downloaded; metadata preservation is
not independent byte-for-byte storage verification.

Verified all four identity indexes are valid, unique and partial; grant-table
RLS is enabled and anon/authenticated SELECT is denied. All nine checked
application RPCs allow service-role execution and deny anon/authenticated
execution. Scope, parent, date, manual-allocation and recognition-snapshot
triggers are enabled. The restrictive private-certificate storage policy is
present and the bucket remains private. The ordinary-event legacy recognition
conflict target uses the compatible partial index.

No existing training event has scoped processing enabled immediately after
migration. Allocation and finalized saving remain explicit administrator actions.

## Verification limits

No signed-in production editor or real provider send was exercised. Previously
reported isolated tests remain fixture evidence, not production end-to-end
verification. Reopening the gate permits normal scheduled processing; it does
not itself prove a subsequent cron run succeeded.
