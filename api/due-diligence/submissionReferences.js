import {
  getDueDiligenceMemberId,
  getDueDiligenceOrganizationId,
  getDueDiligenceMemberName,
  getDueDiligenceReferenceLabel,
} from '../../shared/dueDiligenceReference.js';

const unique = (values) => [...new Set(values.filter(Boolean).map((value) => String(value)))];

/**
 * Resolve the entities associated with DD form submissions.
 *
 * Direct form_submission columns are authoritative.  The pipeline link table
 * is only consulted for a missing direct reference, and member and
 * organisation links are queried independently.  In particular, an entity
 * link with entity_type=member is never sent to the organisation lookup.
 */
export async function resolveDueDiligenceSubmissionReferences({
  db,
  tenantId,
  formSubmissions = [],
}) {
  const submissions = formSubmissions.filter((submission) => submission?.id);
  const references = Object.fromEntries(
    submissions.map((submission) => [
      String(submission.id),
      {
        memberId: getDueDiligenceMemberId(submission),
        organizationId: getDueDiligenceOrganizationId(submission),
        member: null,
        organization: null,
      },
    ]),
  );

  const missingMemberSubmissionIds = submissions
    .filter((submission) => !references[String(submission.id)].memberId)
    .map((submission) => submission.id);
  const missingOrganizationSubmissionIds = submissions
    .filter((submission) => !references[String(submission.id)].organizationId)
    .map((submission) => submission.id);

  // form_submission_pipeline_entity is the durable typed reference for
  // pipeline-created entities.  Its tenant predicate is required even though
  // the parent form submission was already tenant-scoped.
  if (missingMemberSubmissionIds.length || missingOrganizationSubmissionIds.length) {
    const entityTypes = [];
    if (missingMemberSubmissionIds.length) entityTypes.push('member');
    if (missingOrganizationSubmissionIds.length) entityTypes.push('organization');

    const { data: links, error } = await db
      .from('form_submission_pipeline_entity')
      .select('form_submission_id, entity_type, entity_id')
      .eq('tenant_id', tenantId)
      .in('form_submission_id', unique(submissions.map((submission) => submission.id)))
      .in('entity_type', entityTypes);

    if (error) {
      // Older tenants may not have pipeline links.  Direct references remain
      // valid, so do not turn a missing optional link into a DD page failure.
      console.warn('[DD References] Pipeline entity lookup unavailable:', error.message || error);
    } else {
      for (const link of links || []) {
        const submissionId = String(link.form_submission_id || '');
        const reference = references[submissionId];
        if (!reference || !link.entity_id) continue;
        if (link.entity_type === 'member' && !reference.memberId) {
          reference.memberId = link.entity_id;
        } else if (link.entity_type === 'organization' && !reference.organizationId) {
          reference.organizationId = link.entity_id;
        }
      }
    }
  }

  const memberIds = unique(Object.values(references).map((reference) => reference.memberId));
  const organizationIds = unique(
    Object.values(references).map((reference) => reference.organizationId),
  );

  const [memberResult, organizationResult] = await Promise.all([
    memberIds.length
      ? db
          .from('member')
          .select('id, first_name, last_name, email, tenant_id')
          .in('id', memberIds)
          .eq('tenant_id', tenantId)
      : Promise.resolve({ data: [], error: null }),
    organizationIds.length
      ? db
          .from('organization')
          .select('id, name, tenant_id')
          .in('id', organizationIds)
          .eq('tenant_id', tenantId)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (memberResult.error) {
    console.warn('[DD References] Member lookup error:', memberResult.error.message || memberResult.error);
  }
  if (organizationResult.error) {
    console.warn(
      '[DD References] Organization lookup error:',
      organizationResult.error.message || organizationResult.error,
    );
  }

  const membersById = Object.fromEntries(
    (memberResult.data || []).map((member) => [String(member.id), member]),
  );
  const organizationsById = Object.fromEntries(
    (organizationResult.data || []).map((organization) => [
      String(organization.id),
      organization,
    ]),
  );

  for (const reference of Object.values(references)) {
    reference.member = reference.memberId
      ? membersById[String(reference.memberId)] || null
      : null;
    reference.organization = reference.organizationId
      ? organizationsById[String(reference.organizationId)] || null
      : null;
    // Expose the resolved display value for callers that do not need the
    // complete member row, without ever falling back to an ID.
    reference.memberName = getDueDiligenceMemberName(reference.member);
  }

  return references;
}

export function attachDueDiligenceReferences(formSubmission, references = {}) {
  const reference = references[String(formSubmission?.id || '')];
  if (!reference) return formSubmission;
  return {
    ...formSubmission,
    member: reference.member,
    organization: reference.organization,
    member_reference_id: reference.memberId || null,
    organization_reference_id: reference.organizationId || null,
  };
}

export function getDueDiligenceReferenceProjection(
  formSubmission,
  references = {},
  {
    applicationLevel = 'member',
    cardReferenceField = null,
    applicationUid = '',
    formValues = formSubmission?.submission_data || {},
  } = {},
) {
  const reference = references[String(formSubmission?.id || '')] || {};
  return {
    member_name: reference.memberName || null,
    organization_name: reference.organization?.name || null,
    reference_name: getDueDiligenceReferenceLabel({
      member: reference.member,
      memberId: reference.memberId || null,
      organization: reference.organization,
      organizationId: reference.organizationId || null,
      applicationLevel,
      cardReferenceField,
      formValues,
      applicationUid,
    }) || null,
  };
}
