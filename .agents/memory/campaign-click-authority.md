---
name: Campaign click authority
description: Interpretation of iConnect counts versus provider evidence and historical limits.
---

Count iConnect link requests only; Mailgun click observations are separate
evidence, not additive clicks. Total means retained requests, and unique means
campaign-recipient records, never unique humans or people across campaigns.

**Why:** The two trackers often observe the same interaction, while either can
also observe automation. Historical mixed counters cannot prove an exact
human-click count or justify dividing by two.

**How to apply:** Preserve provider/raw evidence and historical mixed values
when reconciling. Label retained-evidence coverage and scanner limitations.
Keep new sync/report/export paths on the same request-counting authority;
never restore provider click increments to compensate for missing history.

Scanner classification is an event-level reporting estimate, not recipient
suppression. A later qualifying request must count independently of earlier
scans. Trust provider bot flags only from authenticated ingestion and narrow
request correlation, never from unsigned payloads or user-agent guesses.

**Why:** Immediate legitimate clicks and later reader visits can coexist with
security scans; neither tracking images nor unflagged clicks prove a human.

**How to apply:** Retain raw evidence and explain exclusions separately from
delivery/bounce and consent authority. Historical provider events without
verified provenance must not be retroactively treated as verified.
