#!/bin/bash
set -e
npm install
# NOTE: no `npm run db:push` here — drizzle.config.ts points at the legacy
# (unreachable) Supabase host. Schema changes are applied to the DEST database
# via destination-verified SQL migration runners before workflows restart.
node scripts/apply-form-width-presets.mjs
node scripts/apply-ticket-organization-type-migration.mjs --apply --review-sha256=698a01494235fed6d1158b50380334b7dc1946fdc70c1a0d82bc8241f0abf2cd
node scripts/apply-project-list-order.mjs --apply --review-sha256=7974da4c0a0bd15fa40e73dcd0461428f13b7d628519090abf403973d059978b
node scripts/apply-zoom-registration-jobs.mjs --apply --review-sha256=31c5438e798ec53bfe5d2597cb176c0ade30a5959c1e274303a7a19fea83c05b
node scripts/apply-zoom-confirmation-delivery.mjs --apply --review-sha256=35d2f9ba9a643787b11d317f8784eaf76d320a61e0724a7d09ea92623d39e21f
node scripts/apply-custom-object-report-sort.mjs --apply --review-sha256=9f16c3c0f20ad66f8b349a964cd7ddc2acb150116c3aafa83ed631af4147f93a
node scripts/apply-custom-object-report-sharing.mjs --apply --review-sha256=c396dc6dfa2603828b5fcc2853fe321c4014501d7d6df05155bb8109169d9814
