---
name: Certificate authored-text recovery
description: Evidence boundary for restoring certificate wording lost by an older persistence contract.
---

Do not treat the editor's example CPD sentence as evidence of lost authored
wording. Restore only retained payloads or user-confirmed text, with the current
template version guard.

**Why:** A missing authored-text migration discarded the sentence while keeping
an internal text-block key; the sample and default fields did not retain it.
Replacing it with the example would invent certificate content.

**How to apply:** Distinguish schema repair from content recovery. Report
unrecovered wording explicitly, and separate isolated renderer tests from
signed-in verification on the actual serving hostname.
