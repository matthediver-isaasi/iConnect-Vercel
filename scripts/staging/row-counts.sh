#!/usr/bin/env bash
# Prints "table<TAB>exact row count" for every public base table. Counts only.
set -euo pipefail
psql "$1" -X -v ON_ERROR_STOP=1 -A -t -F $'\t' <<'SQL'
set statement_timeout = 0;
select c.relname,
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text::bigint
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
order by 1;
SQL
