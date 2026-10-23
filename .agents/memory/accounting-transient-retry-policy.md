---
name: Accounting transient retry policy
description: Temporary provider failures must not consume genuine accounting retry allowances.
---
Rate limits and temporary provider/transport failures must not count towards genuine accounting retry attempts.

**Why:** The owner explicitly required this after a paid form membership stopped recovering when a rate-limited invoice-discovery request exhausted its allowance.

**How to apply:** Defer temporary failures without consuming the bounded genuine-failure budget. Keep invoice discovery/read-after-write safeguards after uncertain writes, and retain blocking for identity conflicts and ambiguous invoices. Reopen historical blocked records only after inspecting their evidence; a last transient error does not prove every earlier failure was transient.
