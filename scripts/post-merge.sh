#!/bin/bash
set -e
npm install
# NOTE: no `npm run db:push` here — drizzle.config.ts points at the legacy
# (unreachable) Supabase host. Schema changes are applied to the DEST database
# via destination-verified SQL migration runners before workflows restart.
node scripts/apply-form-width-presets.mjs
