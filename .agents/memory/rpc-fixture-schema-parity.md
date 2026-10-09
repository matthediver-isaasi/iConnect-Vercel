---
name: RPC fixture schema parity
description: Validate cross-table key types against deployed metadata before relying on isolated PostgreSQL tests.
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
not merely migration installation.
