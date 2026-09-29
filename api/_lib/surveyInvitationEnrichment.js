import { createHash } from 'node:crypto';
import { buildSurveyInvitationPrefill, invitationMapping, INVITATION_MEMBER_FIELDS, INVITATION_ORG_FIELDS } from '../../shared/surveyInvitationPrefill.js';
import { resolveInvitationRelationships } from './surveyInvitationRelationships.js';

const checked = result => { if (result.error) throw result.error; return result.data; };
const email = value => String(value || '').trim().toLowerCase();
// In addition to SQL invalidation, bind reads to the complete current booking.
// Even an unrelated booking edit intentionally requires fresh confirmation.
export function invitationBookingFingerprint(booking) {
  return createHash('sha256').update(JSON.stringify(Object.keys(booking).sort().map(key => [key, booking[key]]))).digest('hex');
}
export function canConfirmInvitation(member, tenantId, invited) {
  return !!member?.id && invited?.status === 'active'
    && (member.tenant_id || member.organization?.tenant_id) === tenantId
    && member.login_enabled !== false && member.membership_paused !== true
    && email(member.email) === invited.grant.recipient_email;
}

export async function resolveInvitationPrefill({ db, tenantId, invited, fields, settings, sessionMember, confirm = false }) {
  const canConfirm = canConfirmInvitation(sessionMember, tenantId, invited);
  if (confirm && !canConfirm) throw Object.assign(new Error('Attendee confirmation requires the matching member session'), { status: 403 });
  const fingerprint = invitationBookingFingerprint(invited.booking);
  if (confirm) {
    const result = await db.rpc('confirm_survey_invitation_attendee', {
      p_entitlement_id: invited.grant.id, p_tenant_id: tenantId, p_member_id: sessionMember.id,
      p_credential_id: invited.credential.id,
      p_booking_revision: invited.booking.survey_invitation_revision ?? 0,
      p_entitlement_revision: invited.grant.survey_invitation_revision ?? 0,
      p_member_revision: sessionMember.survey_invitation_revision ?? 0,
      p_booking_fingerprint: fingerprint,
    });
    if (result.error?.code === '42501') throw Object.assign(new Error('Invitation authority changed; reload before confirming'), { status: 403 });
    checked(result);
  }
  const association = checked(await db.from('survey_invitation_attendee')
    .select('member_id,recipient_email,booking_fingerprint').eq('entitlement_id', invited.grant.id)
    .eq('tenant_id', tenantId).maybeSingle());
  let enrichment = null;
  if (association?.booking_fingerprint === fingerprint && association.recipient_email === invited.grant.recipient_email) {
    const mappings = fields.map(field => invitationMapping(field, settings)).filter(Boolean);
    const memberColumns = [...new Set(['id', 'tenant_id', 'email', 'login_enabled', 'membership_paused', 'organization_id', 'organization_group_id',
      ...mappings.filter(m => m.kind === 'member' && INVITATION_MEMBER_FIELDS.has(m.key))
        .flatMap(m => m.key === 'full_name' ? ['first_name', 'last_name'] : [m.key])])];
    const member = checked(await db.from('member').select(memberColumns.join(','))
      .eq('id', association.member_id).eq('tenant_id', tenantId).maybeSingle());
    if (member && email(member.email) === association.recipient_email
      && member.login_enabled !== false && member.membership_paused !== true) {
      member.full_name = [member.first_name, member.last_name].filter(Boolean).join(' ');
      let organization = null;
      if (member.organization_id) {
        const columns = [...new Set(['id', 'organization_group_id', ...mappings.filter(m => m.kind === 'org' && INVITATION_ORG_FIELDS.has(m.key)).map(m => m.key)])];
        organization = checked(await db.from('organization').select(columns.join(','))
          .eq('id', member.organization_id).eq('tenant_id', tenantId).maybeSingle());
      }
      const relationships = { organization_id: organization?.id };
      const groupId = member.organization_group_id || organization?.organization_group_id;
      if (groupId) {
        const group = checked(await db.from('organization_group').select('id').eq('id', groupId).eq('tenant_id', tenantId).maybeSingle());
        relationships.organization_group_id = group?.id;
      }
      // Validate relationship IDs even when explicitly mapped as member columns.
      member.organization_id = relationships.organization_id;
      member.organization_group_id = relationships.organization_group_id;
      if (organization) organization.organization_group_id = relationships.organization_group_id;
      const loadCustom = async (scope, ownerId, kind) => {
        const ids = [...new Set(mappings.filter(m => m.kind === kind && /^[0-9a-f-]{36}$/i.test(m.key)).map(m => m.key))];
        if (!ownerId || !ids.length) return {};
        const candidates = checked(await db.from('preference_field').select('id,entity_scope')
          .eq('tenant_id', tenantId).eq('is_active', true).in('id', ids));
        const definitions = (candidates || []).filter(row => (row.entity_scope || 'member') === scope);
        if (!definitions.length) return {};
        const rows = checked(await db.from(`${scope}_preference_value`).select('field_id,value')
          .eq(`${scope}_id`, ownerId).in('field_id', definitions.map(row => row.id)));
        return Object.fromEntries((rows || []).map(row => [row.field_id, row.value]));
      };
      enrichment = { member, organization, relationships,
        memberCustom: await loadCustom('member', member.id, 'member_custom'),
        organizationCustom: await loadCustom('organization', organization?.id, 'org_custom') };
      enrichment.graph = await resolveInvitationRelationships({ db, tenantId, fields, settings, member, organization, relationships });
    }
  }
  return { ...buildSurveyInvitationPrefill(fields, invited.booking, settings, enrichment),
    association: { status: enrichment ? 'linked' : 'unlinked', can_confirm: canConfirm && !enrichment } };
}