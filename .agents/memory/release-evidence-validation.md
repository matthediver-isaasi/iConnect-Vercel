---
name: Release evidence validation
description: Preserve user-attestation provenance and validate legitimate guard evolution without weakening financial release checks.
---

Release tools must distinguish user-supplied deployment observations from agent-verified provider responses, retain the original observation time, and recheck freshness after locks and immediately before commit.

**Why:** A valid structured curl report can replace unavailable agent API access, but parsing it does not authenticate it independently or renew its age.

**How to apply:** Use an explicit attestation path, bind its digest and provenance into the reviewed manifest, and reject expired evidence rather than updating timestamps. Completed immutable read-only replay must not be mistaken for fresh readiness.

Financial release schema validators must account for exact, reviewed later migrations rather than treating every difference from the original guard as unsafe drift.

**Why:** A legitimate manual-collection migration changed timing gates while preserving financial protections; comparing only the original function body blocked an otherwise valid read-only readiness check.

**How to apply:** Accept only the exact derived body from a pinned migration with the complete helper, trigger and privilege contract verified. Never skip body validation or overwrite a live guard merely to satisfy an older release tool.