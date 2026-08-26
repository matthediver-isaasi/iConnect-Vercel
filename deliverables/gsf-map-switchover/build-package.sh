#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

archive="gsf-map-iconnect-switchover.zip"
files=(
  "class-zoho-api.iconnect.php"
  "wp-gsf-map-reconcile.php"
  "wp-gsf-map-cleanup.php"
  "HANDOVER.md"
  "RECONCILIATION-2026-08-24.md"
  "build-package.sh"
  "tests/class-zoho-api-dedup.test.php"
  "tests/class-zoho-api-browser-cleanup.test.php"
  "tests/wp-gsf-map-reconcile.test.php"
  "tests/wp-gsf-map-cleanup.test.php"
)

temporary_archive="${archive}.tmp.zip"
verification_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_archive" "$verification_dir"' EXIT

zip -X -q "$temporary_archive" "${files[@]}"
unzip -q "$temporary_archive" -d "$verification_dir"

for file in "${files[@]}"; do
  cmp --silent "$file" "$verification_dir/$file"
done

mv "$temporary_archive" "$archive"
echo "Built and verified $archive (${#files[@]} files)"