---
name: Zoom operations
description: Durable Zoom attendance and confirmation-delivery boundaries.
---
- [Attendance snapshot finalization](attendance-snapshot-finalization.md) — publish provider reports atomically; include booking, policy, target, interval and matching identity.
- [Explicit confirmation retries](zoom-confirmation-retry-policy.md) — uncertain sends are not automatically reclaimed; deliberate resends require new consent.
- [Background email recovery](zoom-background-email-recovery.md) — interrupted confirmations require delivery review; registration and email remain separate choices.
- [Background scheduling](zoom-background-scheduling.md) — preview queue endpoints can precede the production cron; verify worker activation separately.
- [Speaker panelist policy](zoom-speaker-panelist-policy.md) — auto-sync selected speakers while preserving manual panelists and shared-webinar requirements.
