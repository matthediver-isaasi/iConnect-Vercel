#!/bin/bash
set -e
npm install
# NOTE: no `npm run db:push` here — drizzle.config.ts points at the legacy
# (unreachable) Supabase host. Schema changes are applied to the DEST database
# via SQL migration scripts in supabase/migrations/, run explicitly.
