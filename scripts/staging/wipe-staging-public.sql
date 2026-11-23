-- Empties the staging public schema without dropping the schema itself, so
-- its grants and default privileges (anon/authenticated/service_role) stay.
-- Only ever run against iconnect-staging (the refresh script checks).
set statement_timeout = 0;
do $$
declare r record;
begin
  for r in select oid::regclass as t from pg_class
           where relnamespace = 'public'::regnamespace and relkind in ('r','p','v','m','f')
             and not exists (select 1 from pg_depend d where d.objid = pg_class.oid and d.deptype = 'e')
  loop
    execute format('drop %s if exists %s cascade',
      case (select relkind from pg_class where oid = r.t) when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' else 'table' end, r.t);
  end loop;
  for r in select oid::regclass as s from pg_class
           where relnamespace = 'public'::regnamespace and relkind = 'S'
             and not exists (select 1 from pg_depend d where d.objid = pg_class.oid and d.deptype = 'e')
  loop execute format('drop sequence if exists %s cascade', r.s); end loop;
  for r in select p.oid::regprocedure as f, p.prokind from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop execute format('drop %s if exists %s cascade', case r.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end, r.f); end loop;
  for r in select t.oid::regtype as ty from pg_type t
           where t.typnamespace = 'public'::regnamespace and t.typtype in ('e','d','c','r','m')
             and (t.typrelid = 0 or (select relkind from pg_class where oid = t.typrelid) = 'c')
             and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
  loop execute format('drop type if exists %s cascade', r.ty); end loop;
end $$;
create extension if not exists vector with schema public;
create extension if not exists btree_gist with schema public;
