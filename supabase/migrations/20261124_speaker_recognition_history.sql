-- Read-only service facade: omit snapshots, email addresses and artifact paths.
-- UNION preserves pre-launch member badge evidence without issuing anything.
CREATE OR REPLACE VIEW public.speaker_award_history AS
SELECT r.id, r.tenant_id, r.speaker_id, r.member_id, r.event_type, r.event_id,
  r.snapshot->>'event_title' AS event_title,
  r.created_at AS awarded_at, r.status,
  COALESCE(r.snapshot->'badge'->>'name', b.name) AS badge_name,
  COALESCE(r.snapshot->'badge'->>'image_url', b.image_url) AS badge_image_url,
  CASE WHEN r.badge_id IS NULL THEN NULL
    WHEN r.member_id IS NULL THEN r.status
    WHEN mb.id IS NULL THEN 'unavailable'
    WHEN mb.revoked_at IS NOT NULL THEN 'revoked'
    ELSE 'active' END AS badge_status,
  CASE WHEN r.badge_id IS NULL THEN NULL
    WHEN r.member_id IS NULL THEN 'speaker_recognition'
    WHEN mb.source='speaker_award' AND mb.source_ref=r.event_type||':'||r.event_id::text
      THEN 'member_badge'
    ELSE 'existing_member_badge' END AS badge_evidence,
  r.certificate_status,
  (r.status='active' AND r.certificate_status='issued' AND r.pdf_path IS NOT NULL AND r.pdf_sha256 IS NOT NULL) AS certificate_available
FROM public.speaker_recognition r
LEFT JOIN public.badge b ON b.id=r.badge_id AND b.tenant_id=r.tenant_id
LEFT JOIN public.member_badge mb ON mb.id=r.member_badge_id AND mb.tenant_id=r.tenant_id
  AND mb.member_id=r.member_id AND mb.badge_id=r.badge_id
UNION ALL
SELECT g.id, g.tenant_id, g.speaker_id, g.member_id, g.event_type, g.event_id,
  COALESCE(e.title,ce.title,'Event no longer available') AS event_title,
  g.created_at AS awarded_at, g.status,
  b.name AS badge_name, b.image_url AS badge_image_url,
  CASE WHEN mb.id IS NULL THEN 'unavailable'
    WHEN mb.revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END AS badge_status,
  CASE WHEN mb.source='speaker_award' AND mb.source_ref=g.event_type||':'||g.event_id::text
    THEN 'member_badge' ELSE 'existing_member_badge' END AS badge_evidence,
  'unavailable'::text AS certificate_status, false AS certificate_available
FROM public.speaker_award_grant g
LEFT JOIN public.member_badge mb ON mb.id=g.member_badge_id AND mb.tenant_id=g.tenant_id
  AND mb.member_id=g.member_id AND mb.badge_id=g.badge_id
LEFT JOIN public.badge b ON b.id=g.badge_id AND b.tenant_id=g.tenant_id
LEFT JOIN public.event e ON g.event_type='event' AND e.id=g.event_id AND e.tenant_id=g.tenant_id
LEFT JOIN public.complex_event ce ON g.event_type='complex_event' AND ce.id=g.event_id AND ce.tenant_id=g.tenant_id
WHERE g.member_badge_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.speaker_recognition r WHERE r.tenant_id=g.tenant_id
    AND r.event_type=g.event_type AND r.event_id=g.event_id AND r.speaker_id=g.speaker_id
    AND r.member_id IS NOT DISTINCT FROM g.member_id
    AND r.badge_id=g.badge_id AND r.member_badge_id=g.member_badge_id
);
REVOKE ALL ON public.speaker_award_history FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.speaker_award_history TO service_role;