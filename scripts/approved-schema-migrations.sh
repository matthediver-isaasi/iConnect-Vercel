#!/bin/bash
# Historical merge-time migration commands, retained for operator reference.
# A historical hash is not fresh permission to replay live migrations.
set -euo pipefail
if [[ "${1:-}" != "--apply-reviewed-migrations" ]]; then
  echo "Not applied. Review installation state and obtain approval before using --apply-reviewed-migrations."
  exit 1
fi
node scripts/apply-form-width-presets.mjs
node scripts/apply-ticket-organization-type-migration.mjs --apply --review-sha256=698a01494235fed6d1158b50380334b7dc1946fdc70c1a0d82bc8241f0abf2cd
node scripts/apply-project-list-order.mjs --apply --review-sha256=7974da4c0a0bd15fa40e73dcd0461428f13b7d628519090abf403973d059978b
node scripts/apply-zoom-registration-jobs.mjs --apply --review-sha256=31c5438e798ec53bfe5d2597cb176c0ade30a5959c1e274303a7a19fea83c05b
node scripts/apply-zoom-confirmation-delivery.mjs --apply --review-sha256=35d2f9ba9a643787b11d317f8784eaf76d320a61e0724a7d09ea92623d39e21f
node scripts/apply-custom-object-report-sort.mjs --apply --review-sha256=9f16c3c0f20ad66f8b349a964cd7ddc2acb150116c3aafa83ed631af4147f93a
node scripts/apply-custom-object-report-sharing.mjs --apply --review-sha256=c396dc6dfa2603828b5fcc2853fe321c4014501d7d6df05155bb8109169d9814
node scripts/apply-internal-custom-object-reports.mjs --apply --review-sha256=54705a9b1ac7ec9c090ccf67564ba99dde123f2ba31fd6ebb290943295df4f65
