---
name: Runtime security and Stripe key rotation
description: Scope of owner approval for runtime security remediation.
---

Patch and verify the runtime without rotating Stripe keys. Key rotation requires
separate explicit owner approval.

**Why:** Following Stripe's runtime vulnerability warning, the owner explicitly
said they do not want keys rotated and authorised continuing with runtime updates.

**How to apply:** Never equate a vulnerable-runtime warning with confirmed key
theft. Report separately what was patched, the observed deployed runtime, and
any evidence of compromise. Preserve the distinction between a configured major
version, build runtime, and the actual deployed function's patch version.
