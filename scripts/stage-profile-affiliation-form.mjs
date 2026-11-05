import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { connectDestination } from './annual-meeting-destination.mjs';
import { adaptProfileAffiliationPage, PROFILE_AFFILIATION_SOURCE } from '../shared/profileAffiliationAdaptation.js';
// Read-only preparation. This command cannot insert/publish a form or enable
// tenant routing. The owner must approve a separate pilot installation.
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const db = await connectDestination();
try {
  await db.query('BEGIN READ ONLY');
  const { rows: [source] } = await db.query('SELECT * FROM form WHERE id=$1 AND tenant_id=$2', [PROFILE_AFFILIATION_SOURCE, tenant]);
  if (!source) throw new Error('Pinned source form unavailable');
  let sequence = 0;
  const nextId = () => {
    const hash = createHash('sha256').update(`bnms-profile-affiliation:${++sequence}`).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  };
  const adapted = adaptProfileAffiliationPage(source, nextId);
  adapted.form.id = nextId();
  const map = adapted.references;
  const config = {
    version: 1, purpose: 'profile', enabled: true,
    primaryOrganizationFieldIds: [map.field_1788075690796, map.field_1788678540231],
    primaryDepartmentsFieldId: map.field_1788075892819,
    organizationGroupFieldId: map.field_1787932022165,
    countryFieldId: map.field_1786371332409, siteQuestionFieldId: map.field_1788073468956,
    organizationCountryFieldId: '4f8b5c47-f074-4d15-96fd-0a44f81725eb',
    additionalQuestionFieldId: map.field_1788675459698,
    memberDepartmentDefinitionId: '0fdede92-efa2-4d84-9b16-df1a88069486',
    departmentOrganizationDefinitionId: '30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e',
    additionalSitesFieldId: map.field_1788674418554,
    secondaryOrganizationFieldId: map.row_field_1788674468526_amaga,
    secondaryDepartmentsFieldId: map.row_field_1788674529062_so7ep,
    secondaryObjectId: '1c1cdab9-5128-4e3d-b09e-b97088ae69ba',
    secondaryMemberDefinitionId: '601544ca-9db9-498e-bd03-0af5e2c2e8a0',
    secondaryOrganizationDefinitionId: '184b26ff-c918-4162-98c4-1e16fde737ad',
    secondaryLabelFieldId: '26466f9a-57d3-467f-a3c9-f5adadc29fa2',
    unknownOrganizationId: '7f16328d-e692-4671-873a-453464071eef',
  };
  const { rows: definitions } = await db.query(`SELECT id,source_kind,target_kind,source_custom_object_id,target_custom_object_id,status
    FROM custom_object_relationship_definition WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
  [tenant, [config.memberDepartmentDefinitionId, config.departmentOrganizationDefinitionId,
    config.secondaryMemberDefinitionId, config.secondaryOrganizationDefinitionId]]);
  if (definitions.length !== 4 || definitions.some(d => d.status !== 'active')) throw new Error('Relationship definitions unavailable');
  const { rows: [fallback] } = await db.query('SELECT id,name FROM organization WHERE tenant_id=$1 AND id=$2',
    [tenant, config.unknownOrganizationId]);
  if (fallback?.name !== 'Zombie Organisation') throw new Error('Approved fallback changed');
  const { rows: [label] } = await db.query('SELECT name FROM preference_field WHERE tenant_id=$1 AND id=$2 AND custom_object_id=$3',
    [tenant, config.secondaryLabelFieldId, config.secondaryObjectId]);
  if (!label?.name) throw new Error('Assignment label field unavailable');
  config.secondaryLabelFieldKey = label.name;
  const relevantSource = { id: source.id, pages: source.pages, fields: source.fields, visibility_rules: source.visibility_rules,
    entity_pipelines: source.entity_pipelines, structured_actions: source.structured_actions };
  const manifest = { version: 1, tenantId: tenant, sourceFormId: source.id,
    sourceSha256: createHash('sha256').update(JSON.stringify(relevantSource)).digest('hex'),
    verifiedAt: new Date().toISOString(), definitions, fallback,
    form: adapted.form, config, references: adapted.references,
    installationStatus: 'prepared-only; unpublished; routing disabled; no live writes' };
  await db.query('ROLLBACK');
  await writeFile('docs/profile-affiliation-form-staging.json', `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ prepared: true, fields: manifest.form.fields.length,
    visibilityRules: manifest.form.visibility_rules.length, sourceSha256: manifest.sourceSha256, liveWrites: 0 }));
} finally { await db.end(); }
