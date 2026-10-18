-- Reference reads only. Run on independently verified DEST with verified TLS.
-- Output is a new observation, NOT the historical baseline or a repair plan.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';

SELECT now() AS observed_at,
       current_setting('transaction_read_only') AS read_only,
       current_setting('TimeZone') AS timezone;

SELECT c.relname, c.xmin::text AS row_transaction
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('campaign_inbox_recipient',
                   'campaign_inbox_recipient_member_sent');

SELECT c.relname, t.tgname, t.tgenabled,
       pg_get_triggerdef(t.oid) AS trigger_definition,
       pg_get_functiondef(t.tgfoid) AS function_definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('email_campaign_recipient', 'email_event')
  AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;

SELECT count(*) AS recipients, count(mailgun_message_id) AS provider_ids,
       count(sent_at) AS sent_rows,
       count(*) FILTER (WHERE delivery_is_test) AS test,
       count(*) FILTER (WHERE delivery_is_test = false) AS live,
       count(*) FILTER (WHERE delivery_is_test IS NULL) AS unclassified,
       md5(string_agg(md5((to_jsonb(r) - 'delivery_is_test')::text),
                      '' ORDER BY id)) AS canonical_legacy_row_fingerprint
FROM public.email_campaign_recipient r;

SELECT (SELECT count(*) FROM public.email_campaign) AS campaigns,
       (SELECT count(*) FROM public.member_inbox_message_state) AS inbox_states;

SELECT status, count(*) FROM public.email_campaign GROUP BY status ORDER BY status;

-- xmin is a transient row-version marker, not a timestamp or before-image.
-- This fixed transaction identifies the observed migration cohort only.
SELECT delivery_outcome, status, count(*) AS retained_versions,
       md5(string_agg(id::text, ',' ORDER BY id)) AS recipient_ids_md5
FROM public.email_campaign_recipient
WHERE xmin::text = '28592758'
GROUP BY delivery_outcome, status
ORDER BY delivery_outcome, status;

SELECT xmin::text AS row_transaction, count(*) AS classified_versions
FROM public.email_campaign_recipient
WHERE delivery_is_test IS NOT NULL AND xmin::text <> '28592758'
GROUP BY xmin;

-- Fixed historical bounds: both event and ingestion time, without raw PII.
SELECT e.event_type, e.event_timestamp, e.created_at,
       e.mailgun_event_id IS NOT NULL AS has_provider_event_id,
       e.raw_event->>'_iconnect_verified_provider' AS verified_marker,
       trim(both '<>' FROM e.mailgun_message_id) =
         trim(both '<>' FROM r.mailgun_message_id) AS message_matches,
       lower(btrim(e.email)) = lower(btrim(r.email)) AS address_matches,
       e.campaign_id = r.campaign_id AS campaign_matches,
       e.tenant_id = c.tenant_id AS tenant_matches
FROM public.email_event e
LEFT JOIN public.email_campaign_recipient r ON r.id = e.recipient_id
LEFT JOIN public.email_campaign c ON c.id = r.campaign_id
WHERE e.created_at BETWEEN '2026-10-18 15:00Z' AND '2026-10-18 15:56Z'
   OR e.event_timestamp BETWEEN '2026-10-18 15:00Z' AND '2026-10-18 15:56Z'
ORDER BY e.created_at, e.id;

SELECT count(*) AS counted_click_rows
FROM public.email_counted_link_click
WHERE created_at BETWEEN '2026-10-18 15:00Z' AND '2026-10-18 15:56Z'
   OR clicked_at BETWEEN '2026-10-18 15:00Z' AND '2026-10-18 15:56Z';

SELECT name, setting FROM pg_settings
WHERE name IN ('track_commit_timestamp', 'log_statement', 'pgaudit.log');
ROLLBACK;
