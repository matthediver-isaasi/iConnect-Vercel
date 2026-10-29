---
name: RPC fixture schema parity
description: Validate key types and ownership columns against deployed metadata before relying on isolated PostgreSQL tests.
---
Match isolated RPC fixture types to deployed metadata, particularly at identity
boundaries. UUID-shaped values do not establish that a legacy column is UUID.

**Why:** A project-comment RPC passed isolated tests but failed live with SQLSTATE
42883 because the fixture assumed UUID identity keys while the deployed identity
table used varchar. PostgreSQL reported a missing comparison operator rather than
a missing RPC.

**How to apply:** Check the deployed operand types for new cross-table comparisons.
Cast the parameter to the indexed column's type where appropriate; do not cast
all stored IDs to UUID or alter legacy key types to make a new RPC work. Exercise
the function as service_role, including ordinary and mention-bearing comments,
not merely migration installation. Include unified owner/admin sessions with no
legacy user row and at least one non-UUID-shaped text identity. A member-only
fixture can completely miss the fallback identity join, even when it tests
permissions, transactions and retries thoroughly.

Do not give analogous tables identical ownership columns in fixtures without
checking their deployed definitions.

**Why:** An organisation-search regression escaped tests because the fixture
invented a tenant column on a value table whose tenant ownership is inherited
from its parent. The analogous group-value table actually has that column.

**How to apply:** Check column presence as well as types. Exercise each table
branch, including an unfiltered search: SQL still resolves columns inside a
filter branch even when that filter is disabled.
