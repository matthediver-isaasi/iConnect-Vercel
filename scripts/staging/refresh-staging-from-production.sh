#!/usr/bin/env bash
# Replace the iconnect-staging database with a point-in-time copy of production.
#
# Source is read only (pg_dump uses a single read-only snapshot). The target
# public schema is wiped and reloaded, then staging-safety.sql neutralises
# live side effects. See docs/staging-database.md.
#
# Required environment:
#   PROD_DATABASE_URL     session-pooler URL for lvmzliemqnieeoruhkik (read)
#   STAGING_DATABASE_URL  session-pooler URL for skaszwscycbfvfofnifx (write)
#   ICONNECT_STAGING_REFRESH_CONFIRM=skaszwscycbfvfofnifx
# Optional:
#   STAGING_REFRESH_WORKDIR (default: a new mktemp directory)
#   STAGING_REFRESH_JOBS    (default: 2)
set -euo pipefail
# Supabase roles default to a 2 minute statement timeout; index builds need longer.
export PGOPTIONS="-c statement_timeout=0 ${PGOPTIONS:-}"

PROD_REF=lvmzliemqnieeoruhkik
STAGING_REF=skaszwscycbfvfofnifx
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOBS="${STAGING_REFRESH_JOBS:-2}"

die() { echo "REFUSING: $*" >&2; exit 1; }
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

url_user() { local rest="${1#*://}"; rest="${rest%@*}"; echo "${rest%%:*}"; }
url_host() { local rest="${1##*@}"; echo "${rest%%[:/]*}"; }

[[ "${ICONNECT_STAGING_REFRESH_CONFIRM:-}" == "$STAGING_REF" ]] \
  || die "set ICONNECT_STAGING_REFRESH_CONFIRM=$STAGING_REF to confirm the target"
[[ -n "${PROD_DATABASE_URL:-}" && -n "${STAGING_DATABASE_URL:-}" ]] \
  || die "PROD_DATABASE_URL and STAGING_DATABASE_URL are required"

check_ref() { # url ref label
  local user host; user="$(url_user "$1")"; host="$(url_host "$1")"
  if [[ "$host" == *.pooler.supabase.com ]]; then
    [[ "$user" == "postgres.$2" ]] || die "$3 must connect as postgres.$2"
  elif [[ "$host" == "db.$2.supabase.co" ]]; then
    [[ "$user" == "postgres" ]] || die "$3 must connect as postgres"
  else
    die "$3 host is not a Supabase host for $2"
  fi
}
check_ref "$PROD_DATABASE_URL" "$PROD_REF" "PROD_DATABASE_URL"
check_ref "$STAGING_DATABASE_URL" "$STAGING_REF" "STAGING_DATABASE_URL"

psql_src() { psql "$PROD_DATABASE_URL" -X -v ON_ERROR_STOP=1 -A -t "$@"; }
psql_dst() { psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 -A -t "$@"; }

SRC_ID="$(psql_src -c 'select system_identifier from pg_control_system()')"
DST_ID="$(psql_dst -c 'select system_identifier from pg_control_system()')"
[[ "$SRC_ID" != "$DST_ID" ]] || die "source and target are the same cluster"
psql_dst -c "select 1 from pg_namespace where nspname='auth'" | grep -q 1 \
  || die "target does not look like a Supabase database"

WORK="${STAGING_REFRESH_WORKDIR:-$(mktemp -d -t iconnect-staging-XXXX)}"
mkdir -p "$WORK"; chmod 700 "$WORK"
log "work directory: $WORK (contains production data; deleted on success)"

log "dumping production public schema + data (read-only snapshot, $JOBS jobs)"
pg_dump "$PROD_DATABASE_URL" -Fd -j "$JOBS" -f "$WORK/public" \
  --schema=public --no-owner --no-subscriptions --no-statistics --compress=zstd:3
log "dumping auth users/identities and storage bucket metadata + policies"
pg_dump "$PROD_DATABASE_URL" -Fc -f "$WORK/auth.dump" --data-only --no-statistics \
  -t auth.users -t auth.identities -t storage.buckets
pg_dump "$PROD_DATABASE_URL" -Fc -f "$WORK/storage-policies.dump" --schema-only --no-statistics \
  -t storage.objects --no-owner

log "recording production row counts"
"$HERE/row-counts.sh" "$PROD_DATABASE_URL" > "$WORK/prod-counts.tsv"

log "wiping staging public schema"
psql_dst -f "$HERE/wipe-staging-public.sql" >/dev/null

# Keep everything except the schema itself and the publications, which the
# target already has; publication memberships are restored.
pg_restore -l "$WORK/public" \
  | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA|COMMENT|ACL) - (public|SCHEMA public)' \
  | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (PUBLICATION|EXTENSION|DEFAULT ACL) - ' \
  | grep -vE '^[0-9]+; [0-9]+ [0-9]+ COMMENT - EXTENSION ' \
  > "$WORK/public.list"

log "restoring public schema + data into staging"
pg_restore -d "$STAGING_DATABASE_URL" -j "$JOBS" -L "$WORK/public.list" \
  --no-owner --exit-on-error "$WORK/public"

log "restoring auth users and storage bucket metadata"
psql_dst -c "truncate auth.users cascade" -c "set storage.allow_delete_query = 'true'" -c "delete from storage.buckets where id not in (select bucket_id from storage.objects)" >/dev/null
pg_restore -d "$STAGING_DATABASE_URL" --data-only --exit-on-error "$WORK/auth.dump"
pg_restore -l "$WORK/storage-policies.dump" | grep -E ' POLICY storage objects ' > "$WORK/policies.list" || true
psql_dst -c "do \$\$ declare p record; begin for p in select policyname from pg_policies where schemaname='storage' and tablename='objects' loop execute format('drop policy %I on storage.objects', p.policyname); end loop; end \$\$" >/dev/null
pg_restore -d "$STAGING_DATABASE_URL" -L "$WORK/policies.list" --no-owner --exit-on-error "$WORK/storage-policies.dump"

log "applying staging safety controls"
psql_dst -f "$HERE/staging-safety.sql"
psql_dst -c "notify pgrst, 'reload schema'" >/dev/null

log "comparing row counts (counts only, no row contents)"
"$HERE/row-counts.sh" "$STAGING_DATABASE_URL" > "$WORK/staging-counts.tsv"
if diff "$WORK/prod-counts.tsv" "$WORK/staging-counts.tsv" > "$WORK/count-diff.txt"; then
  log "row counts match for $(wc -l < "$WORK/prod-counts.tsv") tables"
else
  log "row count differences (rows written to production after the snapshot appear here):"
  cat "$WORK/count-diff.txt"
fi

psql_dst -c "comment on database postgres is 'iconnect-staging: copy of $PROD_REF taken $(date -u +%FT%TZ)'" >/dev/null
rm -rf "$WORK/public" "$WORK/auth.dump" "$WORK/storage-policies.dump"
log "done; count reports kept in $WORK"
