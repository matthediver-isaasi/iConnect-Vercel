#!/bin/bash
set -e
npm install
echo "Dependencies installed. Live database migrations are not run during merge setup."
echo "Apply pending migrations separately with explicit approval and destination verification."
# Historical migration commands are retained in scripts/approved-schema-migrations.sh
# for deliberate, separately approved execution, never automatic merge replay.
# Event funnel migrations remain on hold; see guides/event-funnel-staging-migrations.md.
