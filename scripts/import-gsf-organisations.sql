-- GSF Organisations Import Script
-- Tenant ID: 21296ad6-1350-483a-a90c-1b06ece70501
-- Organisation Type Field ID: e5ac547d-edb1-4ff1-83ab-fc82c1813065

DO $$
DECLARE
  org_id UUID;
BEGIN

  -- Insert: Apex Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Apex Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Avasar Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Avasar Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Capital Plus Exchange
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Capital Plus Exchange', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: DFID
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('DFID', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:37.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Hello Future
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Hello Future', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Hippocampus Learning Centres
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Hippocampus Learning Centres', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:56.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: IIEP
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('IIEP', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:59.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Intrinsic Labs
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Intrinsic Labs', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:04.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: LEAD
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('LEAD', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:09.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: NFER
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('NFER', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:21.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Amna
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Amna', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:13.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Child Fund
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Child Fund', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:29.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Dubai Cares
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Dubai Cares', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:38.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Gyan Prakash
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Gyan Prakash', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:54.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Kizazi
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kizazi', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:08.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: President''s Young Professionals Program
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('President''s Young Professionals Program', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:28.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: The Paquerettes Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Paquerettes Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:49.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Blavatnik School of Government
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Blavatnik School of Government', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:22.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Delivery Associates
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Delivery Associates', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:36.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Mighty Ally
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Mighty Ally', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:18.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: NABU
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('NABU', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:21.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Path Youth Organisation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Path Youth Organisation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:26.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Aga Khan Education Service Pakistan
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Aga Khan Education Service Pakistan', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:07.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Bernard van Leer
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Bernard van Leer', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:21.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: IFFEd
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('IFFEd', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:59.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Open Capital
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Open Capital', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:25.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Silverleaf Academy
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Silverleaf Academy', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:39.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: The MakersPlace
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The MakersPlace', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:49.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: UMOVEMENT
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('UMOVEMENT', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:52.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: CIFF Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('CIFF Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:32.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Dalberg
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Dalberg', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:35.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Georgetown University/ Moving Minds Alliance/ Stan
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Georgetown University/ Moving Minds Alliance/ Standford', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Antarang Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Antarang Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:14.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Asante Africa Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Asante Africa Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:17.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Atlassian Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Atlassian Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Daraja Civic Initiative
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Daraja Civic Initiative', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:35.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Edukans Education services
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Edukans Education services', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:45.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: EVPA
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('EVPA', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:48.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Flying Kites
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Flying Kites', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:49.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Futures Infinite Ltd
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Futures Infinite Ltd', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: MC2H Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('MC2H Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:16.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Octava Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Octava Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:24.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Pratham International
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Pratham International', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:28.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Public school partnerships
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Public school partnerships', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:30.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Steam Labs
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Steam Labs', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:42.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Colegio CREE
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Colegio CREE', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:32.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Darsel
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Darsel', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:35.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Grand Challenges Canada
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Grand Challenges Canada', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Gyan Shala
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Gyan Shala', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Impact Philanthropy Africa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Impact Philanthropy Africa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:02.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Leadership for Equity
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Leadership for Equity', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:09.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: VVOB
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('VVOB', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:56.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Benetech
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Benetech', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:21.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Lively Minds
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Lively Minds', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:14.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Planting Seeds International
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Planting Seeds International', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: School for Life Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('School for Life Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:36.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: STiR Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('STiR Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:42.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: The Open University
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Open University', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:49.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Involve
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Involve', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:04.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Jacobs Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Jacobs Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:05.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Kurasa Africa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kurasa Africa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:08.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Olinga Foundation for Human Development
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Olinga Foundation for Human Development', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:24.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Rightway Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Rightway Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:32.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Village Schools International
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Village Schools International', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Vitol Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Vitol Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:56.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: World Vision
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('World Vision', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:58.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Beehive School
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Beehive School', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:20.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Dyslexia Organisation Kenya
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Dyslexia Organisation Kenya', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:39.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Education Above All
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Education Above All', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:43.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Education Bridge
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Education Bridge', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:43.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: OECD
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('OECD', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:24.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Proteus Advisory
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Proteus Advisory', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:29.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Save the Childern Global Ventures
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Save the Childern Global Ventures', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:35.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Africa Dyslexia Organisation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Africa Dyslexia Organisation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:04.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Bridge Span
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Bridge Span', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:25.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Committee Chair
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Committee Chair', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:33.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: County Directors
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('County Directors', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:34.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Educate!
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Educate!', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:43.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Inherent Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Inherent Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:02.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Pursue
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Pursue', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:30.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Raspberry Pi Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Raspberry Pi Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:31.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Simple Education Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Simple Education Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:39.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Stellenbosch University
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Stellenbosch University', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:42.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Worldreader
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Worldreader', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:59.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Building Tomorrow
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Building Tomorrow', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:26.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Guillame Pousaz
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Guillame Pousaz', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:54.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: IDP Foundation, Inc
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('IDP Foundation, Inc', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:58.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Inicio Partners
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Inicio Partners', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:02.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Life Builders Initiative
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Life Builders Initiative', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:12.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Little Barn Kindergarten
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Little Barn Kindergarten', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:13.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Michael & Susan Dell Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Michael & Susan Dell Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:18.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Echidna Giving
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Echidna Giving', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:40.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Innovations for Poverty Action
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Innovations for Poverty Action', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:03.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: International Education Funders Group
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('International Education Funders Group', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:04.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Kashf
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kashf', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:06.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Van Leer Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Van Leer Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: BRAC
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('BRAC', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:24.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Common Good
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Common Good', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:33.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Grofin
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Grofin', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:54.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Leap Schools SA
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Leap Schools SA', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:10.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Moving Minds Alliance
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Moving Minds Alliance', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:20.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: NADEV
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('NADEV', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:21.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: The Reading Factory
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Reading Factory', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:49.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Transform Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Transform Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: University of Gondar
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('University of Gondar', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:54.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: AKO Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('AKO Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:10.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: FCDO
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('FCDO', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:48.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Fondation Botner
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Fondation Botner', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:49.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Molo Mhlaba
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Molo Mhlaba', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Rede Decisão
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Rede Decisão', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:31.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Sarthak Shiksha
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Sarthak Shiksha', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:35.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: SlumChild Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('SlumChild Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:40.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Dignitas
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Dignitas', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:37.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Ewangan Child Development Programme
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ewangan Child Development Programme', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:48.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Global Partnership
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Global Partnership', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:52.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Minderoo Foundaton
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Minderoo Foundaton', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:18.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Oak Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Oak Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:23.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Read Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Read Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:31.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: RTI
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('RTI', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:33.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Segal Family Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Segal Family Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:37.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Teach For America
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Teach For America', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:45.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: The Akanksha Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Akanksha Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:47.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Ark
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ark', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:16.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: LGTVP
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('LGTVP', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:12.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: White Loop
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('White Loop', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:57.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: XTX Markets
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('XTX Markets', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:59.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Aloha Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Aloha Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:12.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Blue Orchard Capital
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Blue Orchard Capital', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:23.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Kenya Connect
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kenya Connect', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:07.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Roberston Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Roberston Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:32.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: SHOFCO
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('SHOFCO', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:39.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: United World Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('United World Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: ALA
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ALA', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:11.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Challenge Works
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Challenge Works', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:29.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Indus World School
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Indus World School', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:02.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Kids Collab
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kids Collab', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:08.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Momentum
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Momentum', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Muktangan Education Trust
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Muktangan Education Trust', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:20.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Muni Public School
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Muni Public School', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:20.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Big Win
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Big Win', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:22.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Educare Learning Centre
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Educare Learning Centre', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:42.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: ESSA Africa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ESSA Africa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:47.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Lekki Peninsula College
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Lekki Peninsula College', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:11.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Practical Education Network
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Practical Education Network', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:28.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: T4 Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('T4 Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:43.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: UNESCO
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('UNESCO', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Ecole Yassamine
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ecole Yassamine', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:40.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Ed Partners Africa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ed Partners Africa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:41.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Global Innovation Fund
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Global Innovation Fund', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:52.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Hilltop Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Hilltop Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:56.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Meerkat Learning
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Meerkat Learning', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:16.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Plane Nigeria
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Plane Nigeria', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Rare
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Rare', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:30.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: TaRL
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('TaRL', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:44.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: AfriKids UK
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('AfriKids UK', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:06.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: NaSIA
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('NaSIA', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:21.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Schmidt Futures
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Schmidt Futures', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:35.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: School for Life - Ghana
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('School for Life - Ghana', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:36.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Teach For Zimbabwe
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Teach For Zimbabwe', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Allan & Gill Gray Philanthropies
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Allan & Gill Gray Philanthropies', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:11.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Early Start Africa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Early Start Africa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:39.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: EdFin Microfinance Bank Limited
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('EdFin Microfinance Bank Limited', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:41.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: EducAid Sierra Leone
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('EducAid Sierra Leone', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:42.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: KuzeKuze
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('KuzeKuze', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:09.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: LGT Impact Ventures
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('LGT Impact Ventures', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:11.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Rocket Learning
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Rocket Learning', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:33.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Skillsforus
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Skillsforus', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:40.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: University of Arkansas
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('University of Arkansas', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Usawa Agenda
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Usawa Agenda', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:54.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Cohere
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Cohere', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:32.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Education.org
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Education.org', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:44.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: IEFG
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('IEFG', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:59.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Duara Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Duara Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:38.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Education Cannot Wait
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Education Cannot Wait', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:43.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: EOF
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('EOF', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:47.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Global Teachers Institute
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Global Teachers Institute', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Gower Street
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Gower Street', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Indian School Finance Company
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Indian School Finance Company', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:02.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Metis Fund
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Metis Fund', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:18.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Partnerships associate
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Partnerships associate', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:26.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Pousaz Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Pousaz Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:28.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Schole
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Schole', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:36.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: WISE
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('WISE', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:57.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Aga Khan Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Aga Khan Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:08.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: APHRC
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('APHRC', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Hempel Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Hempel Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Liceo Impulso
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Liceo Impulso', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:12.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Link Community Development Malawi
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Link Community Development Malawi', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:12.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Mulago Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Mulago Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:20.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Pharo Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Pharo Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:26.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Previal Fund
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Previal Fund', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:29.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Aflatoun International
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Aflatoun International', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:03.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Aga Khan Education Services
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Aga Khan Education Services', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:07.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Busara Center
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Busara Center', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:26.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: ChildFund Ethiopia
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ChildFund Ethiopia', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:30.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Earth Warriors
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Earth Warriors', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:39.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Edulution
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Edulution', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:45.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Fundación ICAL
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Fundación ICAL', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:50.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Injini
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Injini', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:03.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Inspiring Teachers
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Inspiring Teachers', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:03.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Labhya Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Labhya Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:09.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Lend a Hand India
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Lend a Hand India', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:11.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Literacy and Adult Basic Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Literacy and Adult Basic Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:13.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Schools2030
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Schools2030', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:37.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: The Education Alliance
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Education Alliance', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:48.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Waterloo Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Waterloo Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:56.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Educate Me Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Educate Me Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:42.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Elimu Shop
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Elimu Shop', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Fe y Alegria
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Fe y Alegria', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:48.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Panorama Global
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Panorama Global', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:25.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Save the Children Global Ventures
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Save the Children Global Ventures', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:35.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: The World Bank
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The World Bank', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:50.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Afrikids Ghana
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Afrikids Ghana', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:06.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Charities Aid Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Charities Aid Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:29.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Higherlife Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Higherlife Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Insaan Group
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Insaan Group', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:03.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Link Education International
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Link Education International', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:13.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Lotus Flower Community School
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Lotus Flower Community School', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:14.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: SEED Education India Private Limited
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('SEED Education India Private Limited', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:37.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Stadi za Maisha Educational Trust
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Stadi za Maisha Educational Trust', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:41.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Tajizuri
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Tajizuri', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:43.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Tiny Totos
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Tiny Totos', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Ubuntu Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ubuntu Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:52.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Room to Read
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Room to Read', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:33.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Solar United Madagascar
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Solar United Madagascar', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:41.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: TeachUNITED
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('TeachUNITED', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: UGEAFI
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('UGEAFI', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:52.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Catholic Relief Services
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Catholic Relief Services', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:28.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Jumpstart Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Jumpstart Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:05.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Jupiter Academy
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Jupiter Academy', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:06.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: NudgED Trust
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('NudgED Trust', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:22.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Taleemabad
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Taleemabad', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:43.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Atalanta
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Atalanta', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:18.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Education Outcomes Fund
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Education Outcomes Fund', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:44.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Sabis
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Sabis', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:34.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Valenture Institute
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Valenture Institute', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Aga Khan- Institute for Human Development
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Aga Khan- Institute for Human Development', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:08.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Angaza Elimu
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Angaza Elimu', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:13.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Axium Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Axium Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Bridge Acadamies
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Bridge Acadamies', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:25.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Ed Tech
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ed Tech', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:41.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Ek Tara
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ek Tara', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: I&P
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('I&P', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:57.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Kaizenvest
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kaizenvest', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:06.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: LEAP Science and Maths Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('LEAP Science and Maths Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:10.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Luminos Fund
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Luminos Fund', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:14.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Watoto Wasome
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Watoto Wasome', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:56.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Bonnievale418
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Bonnievale418', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:23.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: CVC Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('CVC Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:34.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: HundrED
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('HundrED', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:57.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: ICDP Ghana
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ICDP Ghana', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:58.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Standard Chartered
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Standard Chartered', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:41.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: The Citizens Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Citizens Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:47.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: UNICEF
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('UNICEF', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Western Cape Education Department
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Western Cape Education Department', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:57.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: BHP Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('BHP Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:22.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: BMGF
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('BMGF', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:23.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Lego Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Lego Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:11.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: AAMUSTED
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('AAMUSTED', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:00.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Amala Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Amala Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:13.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Cartier Philanthropy
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Cartier Philanthropy', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:28.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Community Keepers
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Community Keepers', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:33.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: EDT
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('EDT', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:41.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Eduspots
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Eduspots', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:45.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Rangeet
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Rangeet', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:30.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Lwalla community alliance
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Lwalla community alliance', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:14.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Malaika
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Malaika', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Ministry of Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ministry of Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: ELMA Philanthropies
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ELMA Philanthropies', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: GPE
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('GPE', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: IDInsight
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('IDInsight', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:58.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Opportunity International EduFinance
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Opportunity International EduFinance', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:25.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Roger Federer Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Roger Federer Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:33.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Salt Analytics
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Salt Analytics', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:34.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: TEP Centre
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('TEP Centre', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:47.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: UBS Optimus Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('UBS Optimus Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:52.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Asociacion Esperanza Juvenil
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Asociacion Esperanza Juvenil', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:18.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Better Purpose
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Better Purpose', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:21.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Christel House
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Christel House', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:30.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: David Weekley Family Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('David Weekley Family Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:35.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Dovetail
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Dovetail', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:38.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: eKitabu
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('eKitabu', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: ENKO Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ENKO Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:47.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Impact Network
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Impact Network', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:01.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Kaya Childcare
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kaya Childcare', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:06.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Score ECD
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Score ECD', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:37.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Taleem Finance Company Ltd
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Taleem Finance Company Ltd', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:43.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: University of Oxford/Young Lives
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('University of Oxford/Young Lives', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:54.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Acumen
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Acumen', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:02.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Kgololo Academy
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kgololo Academy', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:07.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Kreedo
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kreedo', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:08.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Nova Pioneer
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Nova Pioneer', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:22.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Todos Pela EducaÃ§Ã£o
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Todos Pela EducaÃ§Ã£o', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Youth Impact
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Youth Impact', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:11:00.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Agahozo Shalom Youth Village
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Agahozo Shalom Youth Village', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:09.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Children in Crossfire
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Children in Crossfire', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:30.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Education Fund
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Education Fund', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:44.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Futura Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Futura Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:50.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Malala Fund
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Malala Fund', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Parenting for Lifelong Health
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Parenting for Lifelong Health', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:26.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Social Finance
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Social Finance', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:40.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Streetlight Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Streetlight Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:43.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Asociación Alianza Educativa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Asociación Alianza Educativa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:17.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Audacious Project
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Audacious Project', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: DRK Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('DRK Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:38.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Sabre Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Sabre Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:34.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: The Sunflower Trust
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Sunflower Trust', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:50.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Ark South Africa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ark South Africa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:16.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Bramble Network
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Bramble Network', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:24.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Bridges Outcomes Partnership
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Bridges Outcomes Partnership', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:25.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Brookings Institute
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Brookings Institute', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:26.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Greater Share
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Greater Share', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:54.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Jackfruit Finance
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Jackfruit Finance', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:05.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Metis Collective
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Metis Collective', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:16.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: PHINMA Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('PHINMA Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Safeguarding Africa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Safeguarding Africa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:34.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Schoolinka
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Schoolinka', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:36.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Street Child
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Street Child', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:42.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: The Convergence Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Convergence Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:47.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: UNSDG
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('UNSDG', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:54.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Ward Family Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ward Family Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:56.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: aeioTU
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('aeioTU', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:03.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Bowjow learning
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Bowjow learning', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:24.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Cadmus Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Cadmus Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Edzola
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Edzola', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:45.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: European Commission
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('European Commission', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:48.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: JBJ Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('JBJ Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:05.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Little Rock Kenya
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Little Rock Kenya', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:13.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Peculiar Child Care Support
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Peculiar Child Care Support', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:26.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Right to Play
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Right to Play', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:32.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Aga Khan University Examination Board
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Aga Khan University Examination Board', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:08.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: AL for Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('AL for Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:10.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Imaginable Futures
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Imaginable Futures', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:01.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Language and Learning Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Language and Learning Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:09.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Marshall Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Marshall Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:16.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Prajayatna
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Prajayatna', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:28.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Educate Girls
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Educate Girls', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:42.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Ghana National Association of Private Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ghana National Association of Private Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Siemens Stiftung
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Siemens Stiftung', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:39.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Teach For All
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Teach For All', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:45.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: The Peter Cundill Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Peter Cundill Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:49.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: ThinkZone India
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ThinkZone India', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:50.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: ECDAN
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ECDAN', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:40.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Limitless Horizons Ixil
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Limitless Horizons Ixil', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:12.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Mobile Creches
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Mobile Creches', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Money For Madagascar
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Money For Madagascar', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Your Faith International School
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Your Faith International School', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:11:00.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Ace Policy Research Institute
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ace Policy Research Institute', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:02.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Aga Khan Development Network
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Aga Khan Development Network', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:07.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Aptus
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Aptus', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:16.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Cambridge Organisation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Cambridge Organisation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Global Fund for Children
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Global Fund for Children', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:52.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Innova Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Innova Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:03.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Nimet Rener
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Nimet Rener', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:21.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Private Schools Associations
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Private Schools Associations', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:29.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Uthabiti Africa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Uthabiti Africa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Wings to Fly Initiative
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Wings to Fly Initiative', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:57.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Abaarso Network
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Abaarso Network', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:01.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Brookings Institution
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Brookings Institution', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:26.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Future Nation Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Future Nation Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:50.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Reflective Learning
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Reflective Learning', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:31.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: ECD Network for Kenya
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ECD Network for Kenya', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:39.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Edify
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Edify', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:41.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Fudela
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Fudela', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:49.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Grand Challenges
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Grand Challenges', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: APEC Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('APEC Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:14.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Ashoka
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ashoka', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:17.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Blended Finance
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Blended Finance', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:23.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: CoSchool
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('CoSchool', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:34.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: iTeach Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('iTeach Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:05.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: MAIA Impact
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('MAIA Impact', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Save the Children
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Save the Children', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:35.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: SmartStart
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('SmartStart', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:40.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Think Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Think Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:50.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Axum
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Axum', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:20.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Collaborative Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Collaborative Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:33.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Hilton Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Hilton Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:56.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: IssRoff Family Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('IssRoff Family Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:04.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: One World Academy
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('One World Academy', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:24.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Africa Practice
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Africa Practice', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:04.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Cambridge Partnership for Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Cambridge Partnership for Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Earlybird Community NPC
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Earlybird Community NPC', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:39.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Hope Worldwide International
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Hope Worldwide International', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:57.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Learning Equality
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Learning Equality', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:11.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Madhi Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Madhi Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Nottingham Institute of Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Nottingham Institute of Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:22.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Zizi Afrique Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Zizi Afrique Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:11:00.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: DBMF Douglas B Marshall Jr Family Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('DBMF Douglas B Marshall Jr Family Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:36.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Education Organisation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Education Organisation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:44.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Huddle Education
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Huddle Education', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:57.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: ID Insight
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ID Insight', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:58.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: PAL Network
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('PAL Network', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:25.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Prevail Fund
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Prevail Fund', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:29.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: CVC
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('CVC', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:34.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: DG Murray Trust
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('DG Murray Trust', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:37.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: GIP Globa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('GIP Globa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Oxford Measured
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Oxford Measured', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:25.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Rising Academies
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Rising Academies', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:32.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Bach Family Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Bach Family Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:20.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Development Media International
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Development Media International', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:36.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Fundación Luker
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Fundación Luker', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:50.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Global School Leaders
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Global School Leaders', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:52.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Plan International
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Plan International', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Porticus Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Porticus Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: SPARK Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('SPARK Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:41.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Teach for Kenya
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Teach for Kenya', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Think Equal
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Think Equal', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:50.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: USAID
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('USAID', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:54.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: World Bank
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('World Bank', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:58.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: FSG
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('FSG', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:49.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Gates Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Gates Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Hope and Homes for Children
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Hope and Homes for Children', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:56.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: NYAF Sierra Leone
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('NYAF Sierra Leone', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:23.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Said Business School
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Said Business School', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:34.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Teach For Bangladesh
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Teach For Bangladesh', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: UNICEF Kenya
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('UNICEF Kenya', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Varthana
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Varthana', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Alokit
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Alokit', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:12.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Binding Constraints Lab
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Binding Constraints Lab', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:22.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Children on the Edge
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Children on the Edge', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:30.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: English Quest
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('English Quest', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:47.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Maitri Trust
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Maitri Trust', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: SIP Red de Colegios
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('SIP Red de Colegios', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:40.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Yidan Prize
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Yidan Prize', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:11:00.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Hello Brink
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Hello Brink', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Learn to Play
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Learn to Play', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:10.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Learning Differently
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Learning Differently', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:10.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Mastercard Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Mastercard Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:16.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: SER
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('SER', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:37.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Wildbound
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Wildbound', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:57.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Central Square Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Central Square Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:28.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Fudela Eucador
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Fudela Eucador', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:50.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Funda Wande
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Funda Wande', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:50.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: KEPSA
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('KEPSA', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:07.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Kidogo ECD Centres
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kidogo ECD Centres', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:07.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Lutheran World Federation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Lutheran World Federation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:14.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Raspberry PI Organisation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Raspberry PI Organisation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:31.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: SPIX Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('SPIX Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:41.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Tata Education Services
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Tata Education Services', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:44.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Teach For Botswana
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Teach For Botswana', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: TotoCare - Nawirika foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('TotoCare - Nawirika foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Ark Ventures
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ark Ventures', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:16.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Cartier Philanthropies
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Cartier Philanthropies', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Education Design Unlimited
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Education Design Unlimited', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:43.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: EIDU
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('EIDU', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:09:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Justice Rising
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Justice Rising', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-09-30T21:10:06.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Zamunda
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Zamunda', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-02T12:27:31.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: AfriKids
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('AfriKids', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-06T17:54:32.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: One World Network of Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('One World Network of Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-08T07:49:58.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Centre for Learning Resources
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Centre for Learning Resources', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-08T07:50:31.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Sustainable Education & Enterprise Development (SE
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Sustainable Education & Enterprise Development (SEED)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-08T07:51:04.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Educore Services: Frontier Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Educore Services: Frontier Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-08T09:51:49.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Women and Rural Development Networks
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Women and Rural Development Networks', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-08T16:19:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Action for sustainable change
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Action for sustainable change', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-12T14:14:44.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Expanding Boundaries International
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Expanding Boundaries International', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-12T21:50:04.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Go Economic Empowerment Progrmme GEEP KENYA
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Go Economic Empowerment Progrmme GEEP KENYA', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-13T10:58:12.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Great Hood Academy
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Great Hood Academy', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-13T12:30:41.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Teaching at the Right Level (TaRL) Africa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Teaching at the Right Level (TaRL) Africa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-13T12:16:22.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Sierra Leone Educators Association (SLEA)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Sierra Leone Educators Association (SLEA)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-13T21:25:44.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Freshta Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Freshta Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-14T15:27:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Community And Family Aid Foundation-Ghana
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Community And Family Aid Foundation-Ghana', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-15T03:37:35.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: The Learning Foundation, Sierra Leone
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Learning Foundation, Sierra Leone', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-17T13:10:48.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Brightland High School
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Brightland High School', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-18T15:32:05.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Aid for Rural Education Access Initiative (AREAi)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Aid for Rural Education Access Initiative (AREAi)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:44:26.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Associates in Research and Education for Developme
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Associates in Research and Education for Development (ARED)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:44:35.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Child''s Destiny and Development Organization (CHI
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Child''s Destiny and Development Organization (CHIDDO)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:44:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Community Action for Health and Education Developm
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Community Action for Health and Education Development (CAHED)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:44:54.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Creative Centre for Community Mobilization (CRECCO
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Creative Centre for Community Mobilization (CRECCOM)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:45:05.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Development of Educational Action Network (DEAN)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Development of Educational Action Network (DEAN)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:45:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Dignity Education Vision International (DEVI Sanst
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Dignity Education Vision International (DEVI Sansthan)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:45:25.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Education Empowerment for Rural and Urban Slums In
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Education Empowerment for Rural and Urban Slums Initiative (EERUi)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:45:34.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Educational Initiatives (EI)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Educational Initiatives (EI)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:45:44.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Instructional Leadership Institute (ILI)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Instructional Leadership Institute (ILI)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:45:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Kisumu Medical and Education Trust (KMET)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kisumu Medical and Education Trust (KMET)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:46:04.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Lake Region Development Programme (LRDP)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Lake Region Development Programme (LRDP)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:46:13.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Learning Links Foundation (LLF)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Learning Links Foundation (LLF)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:46:26.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Tanzania Early Childhood Education and Care (TECEC
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Tanzania Early Childhood Education and Care (TECEC)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:46:37.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Together in Development & Education (TIDE)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Together in Development & Education (TIDE)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:46:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Turning Point Trust (TPT)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Turning Point Trust (TPT)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:46:56.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Young African Refugees for Integral Development (Y
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Young African Refugees for Integral Development (YARID)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:47:05.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Zambia Open Community Schools (ZOCS)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Zambia Open Community Schools (ZOCS)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:47:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: The Action Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Action Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:47:29.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Kalobeyei Initiative for Better Life (KI4BLI)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kalobeyei Initiative for Better Life (KI4BLI)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:47:38.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: PEAS (Promoting Equality in African Schools)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('PEAS (Promoting Equality in African Schools)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:47:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Peepul (Absolute Return for Kids)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Peepul (Absolute Return for Kids)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:48:01.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: The Education Partnership (TEP) Centre
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Education Partnership (TEP) Centre', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:48:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Youth Co-operation for Ideas (YCI)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Youth Co-operation for Ideas (YCI)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:48:28.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Africa Early Childhood Network (AfECN)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Africa Early Childhood Network (AfECN)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:48:43.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Inter-agency Network for Education in Emergencies 
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Inter-agency Network for Education in Emergencies (INEE)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:48:54.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Results for Development (R4D)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Results for Development (R4D)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T14:49:20.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Partner - to be removed"');

  -- Insert: Global Schools Forum
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Global Schools Forum', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-19T15:14:52.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"Staff"');

  -- Insert: LaTisha Nicole LLC
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('LaTisha Nicole LLC', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-21T02:06:24.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: BeMyBuddy Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('BeMyBuddy Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-20T15:36:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Perkins School for the Blind India Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Perkins School for the Blind India Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-22T10:14:01.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: individual
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('individual', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-22T20:17:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"TBC"');

  -- Insert: EMAN ISLAMIC DEVELOPMENT ORGANIZATION (EIDO) - SIE
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('EMAN ISLAMIC DEVELOPMENT ORGANIZATION (EIDO) - SIERRA LEONE, WEST AFRICA.', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-23T12:39:28.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Watoto Wasoka
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Watoto Wasoka', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-22T14:51:13.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"TBC"');

  -- Insert: Light Up Hope Africa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Light Up Hope Africa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-23T14:07:29.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: World Educare Network
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('World Educare Network', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-22T19:59:13.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Ambo University
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ambo University', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-23T17:01:03.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Shiksharth
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Shiksharth', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-24T17:04:28.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: EMAN ISLAMIC DEVELOPMENT ORGANIZATION (EIDO) SIERR
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('EMAN ISLAMIC DEVELOPMENT ORGANIZATION (EIDO) SIERRA LEONE', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-25T00:18:45.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: CSTA INDIA
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('CSTA INDIA', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-25T10:55:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: ChildFund India
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ChildFund India', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-26T09:54:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: ReGEN
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ReGEN', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-28T12:22:01.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Lukenya Community Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Lukenya Community Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-29T13:42:40.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: UNLEASH
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('UNLEASH', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-27T17:29:12.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Masentle Community Development
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Masentle Community Development', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-28T14:56:30.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: The Cecily Group
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Cecily Group', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-28T12:22:35.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Unwomen
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Unwomen', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-28T12:25:03.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: AKU
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('AKU', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-28T12:28:36.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: IDRC
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('IDRC', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-28T12:29:47.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Nuture First
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Nuture First', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-28T12:31:42.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Clinton Health Access
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Clinton Health Access', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-28T12:32:57.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Nurtura
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Nurtura', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-28T12:36:00.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Global Development Incubator
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Global Development Incubator', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-28T12:37:45.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Social Protection
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Social Protection', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-28T12:38:33.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Taraji Schools
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Taraji Schools', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-28T12:48:03.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Delta Education Collective
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Delta Education Collective', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-30T13:07:40.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Guide Star Organization
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Guide Star Organization', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-31T06:51:12.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Pestalozzi International
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Pestalozzi International', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-31T09:48:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: GETU Education and Research Consultancy Firm
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('GETU Education and Research Consultancy Firm', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-10-31T16:13:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"TBC"');

  -- Insert: The Noble Academy/School
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Noble Academy/School', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-01T19:32:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: WIDOWS AND SINGLE MOTHERS DEVELOPMENT ORGANIZATION
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('WIDOWS AND SINGLE MOTHERS DEVELOPMENT ORGANIZATION-WISIMODO', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-03T03:50:33.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Pratham International, Inc.
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Pratham International, Inc.', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-03T12:45:04.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: POPE JOHN PAUL II MODEL SECONDARY SCHOOL UMUNAGBOR
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('POPE JOHN PAUL II MODEL SECONDARY SCHOOL UMUNAGBOR IHITTE', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-04T08:12:48.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: LEAD Edu
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('LEAD Edu', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-04T15:14:05.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"TBC"');

  -- Insert: #TUNAWEZA faundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('#TUNAWEZA faundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-06T11:25:40.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"TBC"');

  -- Insert: WisdomWood High
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('WisdomWood High', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-04T15:40:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"TBC"');

  -- Insert: Hello Future
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Hello Future', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-07T17:02:53.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Learning Equality
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Learning Equality', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-07T17:03:18.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Lend a Hand India
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Lend a Hand India', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-07T17:03:42.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Centro Cultural Aliwen
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Centro Cultural Aliwen', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-08T10:54:44.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: iDreamCareer
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('iDreamCareer', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-10T07:25:14.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Khanyisa Inanda Seminary Community Projects
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Khanyisa Inanda Seminary Community Projects', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-10T08:15:08.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Lumina Academy Limited
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Lumina Academy Limited', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-12T17:31:34.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"TBC"');

  -- Insert: Heritage School of Kenya
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Heritage School of Kenya', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-11T12:27:11.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: BIGKID Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('BIGKID Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-12T11:08:03.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Guruji Education Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Guruji Education Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-13T11:36:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Skills Builder Partnership
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Skills Builder Partnership', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-14T11:03:57.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Nurturing Early Childhood Community Support Initia
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Nurturing Early Childhood Community Support Initiative', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-14T14:04:29.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Morogoro Saving the Poor Organization (MOSAPORG)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Morogoro Saving the Poor Organization (MOSAPORG)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-18T07:22:10.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Psych Care Uganda
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Psych Care Uganda', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-14T21:44:05.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Kathkali Swpnopuran Welfare Society
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kathkali Swpnopuran Welfare Society', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-16T14:53:17.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Helambu Education Livelihood Partnership
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Helambu Education Livelihood Partnership', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-20T06:59:50.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Team4Tech
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Team4Tech', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-20T09:18:30.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"TBC"');

  -- Insert: XEEVOLVE
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('XEEVOLVE', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-23T21:36:35.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"TBC"');

  -- Insert: Kimmy Chic Intergrated Academy
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kimmy Chic Intergrated Academy', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-20T19:40:56.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Mount Usambara English Medium Pre and Primary Scho
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Mount Usambara English Medium Pre and Primary School', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-22T18:38:05.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: SolarBuddy
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('SolarBuddy', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-25T00:05:26.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"TBC"');

  -- Insert: Youth Leaders for Restoration and Development - YO
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Youth Leaders for Restoration and Development - YOLRED', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-21T09:13:34.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: OM Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('OM Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-23T14:26:13.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Aprender (UK) Ltd
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Aprender (UK) Ltd', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-25T11:43:10.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Action Pour le Developpement des Jeunes au Congo
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Action Pour le Developpement des Jeunes au Congo', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-25T15:02:10.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Pangea Educational Development
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Pangea Educational Development', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-25T18:10:09.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Kingdomway generaruon pre school
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Kingdomway generaruon pre school', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-29T07:52:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Ajibu Community
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Ajibu Community', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-11-30T11:40:43.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Piramal F
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Piramal F', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-01T12:34:38.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Global Scientific Network (GSN)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Global Scientific Network (GSN)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-01T21:49:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Teach Me Well Ghana
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Teach Me Well Ghana', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-02T15:21:49.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Scopus International School & College
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Scopus International School & College', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-02T15:40:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Joy for Children
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Joy for Children', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-02T15:33:44.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Alarm Ministries
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Alarm Ministries', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-02T15:42:31.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Liberal educational Academy
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Liberal educational Academy', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-07T18:59:51.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: CHIYEMBEKEZO ACADEMY
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('CHIYEMBEKEZO ACADEMY', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-05T07:43:36.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Edge Hope Builders For Youth and Women Initiative
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Edge Hope Builders For Youth and Women Initiative', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-08T16:19:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Reach To Teach Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Reach To Teach Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-10T14:40:48.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: EHALINE EMPOWERMENT INITIATIVE CENTRE UGANDA
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('EHALINE EMPOWERMENT INITIATIVE CENTRE UGANDA', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-10T15:57:54.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Pratham Education Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Pratham Education Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-11T11:16:52.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Joy for Children Uganda
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Joy for Children Uganda', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-12T08:23:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Freshta Foundation Inc
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Freshta Foundation Inc', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-12T15:28:09.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Apni Shala Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Apni Shala Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-13T06:19:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Teacher coaches Uganda
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Teacher coaches Uganda', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-14T08:23:56.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Science Fuse
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Science Fuse', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-15T13:19:46.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Safisha Africa Welfare Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Safisha Africa Welfare Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-15T20:16:42.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: The Kilgoris Project
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Kilgoris Project', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-16T09:21:59.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: ATENXIA
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('ATENXIA', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-16T19:16:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: TEST Heram Solutions
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('TEST Heram Solutions', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-17T12:34:00.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Clinton Health Access Initiative
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Clinton Health Access Initiative', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-18T09:53:21.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"TBC"');

  -- Insert: The Presbyterian University of East Africa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('The Presbyterian University of East Africa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-26T09:09:24.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Dar Tawheed community school
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Dar Tawheed community school', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-26T21:43:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Mary joy Ethiopia
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Mary joy Ethiopia', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-29T09:02:11.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Agrani viklang Foundation
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Agrani viklang Foundation', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2025-12-31T04:37:23.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Sensotech Consultants Limited
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Sensotech Consultants Limited', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-05T08:05:04.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Sharon test
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Sharon test', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-06T10:14:23.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: TEST TEJASWINI -6th JAn
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('TEST TEJASWINI -6th JAn', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-06T15:28:32.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"PARTNER"');

  -- Insert: Sharon Partner
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Sharon Partner', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-06T14:06:37.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"PARTNER"');

  -- Insert: Sharon swap test
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Sharon swap test', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-07T19:34:59.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Sharon SO Swap test
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Sharon SO Swap test', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-07T19:39:24.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Northern Kenya Fund
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Northern Kenya Fund', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-09T10:33:49.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Perkins
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Perkins', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-09T18:37:43.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Salam Green Hills high School
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Salam Green Hills high School', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-10T14:53:15.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Mbariro
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Mbariro', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-14T11:36:55.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Musana
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Musana', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-14T11:01:23.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: GRACE Association
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('GRACE Association', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-17T07:09:44.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: SEF Partner School (Foundation-Assisted School)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('SEF Partner School (Foundation-Assisted School)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-17T19:36:19.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Asante Aid for Children and Schools in Africa
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Asante Aid for Children and Schools in Africa', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-20T08:26:37.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Hope for Youth - Uganda
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Hope for Youth - Uganda', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-20T12:07:27.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Commonwealth Education Trust
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Commonwealth Education Trust', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-20T16:23:47.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"ESO"');

  -- Insert: Community Centred Conservation - C3 Madagascar
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Community Centred Conservation - C3 Madagascar', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-22T12:49:02.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Oakland General merchant Consulting (OGMC)
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Oakland General merchant Consulting (OGMC)', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-26T10:34:57.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Learning alliance
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Learning alliance', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-28T11:57:07.000Z'::timestamptz)
  RETURNING id INTO org_id;

  -- Insert: Tanzania organization of serving orphans and vurne
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Tanzania organization of serving orphans and vurnelable children', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-28T13:31:53.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

  -- Insert: Delight Public School
  INSERT INTO organization (name, tenant_id, created_at)
  VALUES ('Delight Public School', '21296ad6-1350-483a-a90c-1b06ece70501'::uuid, '2026-01-30T06:50:29.000Z'::timestamptz)
  RETURNING id INTO org_id;
  INSERT INTO organization_preference_value (organization_id, field_id, value)
  VALUES (org_id, 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'::uuid, '"SO"');

END $$;
