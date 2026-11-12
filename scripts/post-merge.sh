#!/bin/bash
set -e
npm install
# NOTE: no `npm run db:push` here — drizzle.config.ts points at the legacy
# (unreachable) Supabase host. Schema changes are applied to the DEST database
# via destination-verified SQL migration runners before workflows restart.
node scripts/apply-form-width-presets.mjs
node scripts/apply-ticket-organization-type-migration.mjs --apply --review-sha256=698a01494235fed6d1158b50380334b7dc1946fdc70c1a0d82bc8241f0abf2cd
