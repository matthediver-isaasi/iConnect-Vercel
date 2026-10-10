-- Reclassify only events whose tenant, recipient, campaign and provider message
-- all match. Keep original event records and consent untouched.
WITH matched AS (
 SELECT e.*,lower(btrim(r.email)) AS address,
 public.classify_email_delivery(e.event_type,e.severity,e.delivery_status_code,e.reason) AS kind
 FROM public.email_event e JOIN public.email_campaign_recipient r ON r.id=e.recipient_id AND r.campaign_id=e.campaign_id
 JOIN public.email_campaign c ON c.id=r.campaign_id AND c.tenant_id=e.tenant_id
 WHERE trim(both '<>' from e.mailgun_message_id)=trim(both '<>' from r.mailgun_message_id)
 AND lower(btrim(e.email))=lower(btrim(r.email)) AND e.event_timestamp IS NOT NULL
), hard AS (
 SELECT *,min(event_timestamp) OVER(PARTITION BY tenant_id,address) AS first_failure
 FROM matched WHERE kind='hard_bounce'
), latest AS (
 SELECT DISTINCT ON(tenant_id,address) * FROM hard ORDER BY tenant_id,address,event_timestamp DESC,id DESC
)
INSERT INTO public.email_address_bounce(tenant_id,email,first_bounced_at,last_bounced_at,reason,smtp_code,campaign_id)
SELECT tenant_id,address,first_failure,event_timestamp,
 left(coalesce(nullif(delivery_status_message,''),reason,'No provider reason supplied'),1000),delivery_status_code,campaign_id
FROM latest ON CONFLICT(tenant_id,email) DO NOTHING;

WITH matched AS (
 SELECT e.*,public.classify_email_delivery(e.event_type,e.severity,e.delivery_status_code,e.reason) AS kind
 FROM public.email_event e JOIN public.email_campaign_recipient r ON r.id=e.recipient_id AND r.campaign_id=e.campaign_id
 JOIN public.email_campaign c ON c.id=r.campaign_id AND c.tenant_id=e.tenant_id
 WHERE trim(both '<>' from e.mailgun_message_id)=trim(both '<>' from r.mailgun_message_id)
 AND lower(btrim(e.email))=lower(btrim(r.email)) AND e.event_timestamp IS NOT NULL
), latest AS (
 SELECT DISTINCT ON(recipient_id) * FROM matched WHERE kind IS NOT NULL
 ORDER BY recipient_id,event_timestamp DESC,(kind='delivered') DESC,id DESC
)
UPDATE public.email_campaign_recipient r SET
 delivery_outcome=e.kind,delivery_outcome_at=e.event_timestamp,
 delivery_reason=left(coalesce(nullif(e.delivery_status_message,''),e.reason,'No provider reason supplied'),1000)
FROM latest e WHERE r.id=e.recipient_id AND (r.delivery_outcome_at IS NULL OR r.delivery_outcome_at<e.event_timestamp);
