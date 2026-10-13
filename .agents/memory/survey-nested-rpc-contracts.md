---
name: Survey nested RPC verification
description: Why invitation tests must include the inner submission contract.
---

Invitation database tests must run the real nested survey submission function,
not a permissive insert stub. Generic PostgreSQL P0001 is not evidence of an
expired or completed invitation.

**Why:** A permissive nested stub concealed a caller/allowlist mismatch while
the handler mislabeled the resulting validation exception as an answered invite.

**How to apply:** Test both identified and anonymous payloads through the full
nested transaction, including a failure after response insertion. Classify only
known invitation failures; log fixed diagnostic categories rather than raw
database messages, which may contain respondent data.

Validate the real destination table schema as well as nested RPC allowlists.

**Why:** An anonymous submission attribute passed both RPC allowlists but the
dynamic insert still failed because the destination table lacked its column.
Allowlist acceptance alone does not establish storage compatibility.

**How to apply:** Include legacy destination schemas in submission tests and
distinguish transport attributes from persisted columns. Never broaden or
silently filter arbitrary payload keys to work around a schema mismatch.