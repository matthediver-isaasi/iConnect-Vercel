---
name: Consent-aware interaction verification
description: Verify interaction analytics using the current consent controls, independently of successful navigation.
---

Use the current consent contract when verifying interaction analytics; successful navigation alone does not prove that an activation was counted.

**Why:** Historical browser fixtures seeded a legacy binary consent preference. The application correctly ignored it and navigated normally, while those fixtures incorrectly expected analytics delivery. This was a fixture-contract mismatch, not permission to weaken the consent boundary.

**How to apply:** Prefer the real consent controls for end-to-end consent coverage. Focused interaction tests may publish explicit current consent snapshots to isolate the tracking hook, but must state that the banner/SDK is outside that test boundary. Assert delivery separately from navigation and keep a rejected-consent case checking both absent delivery and absent tracking identity. Do not restore legacy consent adoption to make old fixtures pass.
