export const SPEAKER_MEMBER_UNIQUE_INDEX = 'speaker_tenant_member_unique';

export function isSpeakerMemberUniqueViolation(error) {
  if (error?.code !== '23505') return false;
  if (error.constraint === SPEAKER_MEMBER_UNIQUE_INDEX) return true;
  const diagnostic = `${error.message || ''} ${error.details || ''}`;
  return diagnostic.includes(SPEAKER_MEMBER_UNIQUE_INDEX);
}

export async function validateSpeakerMemberLink({
  db,
  tenantId,
  memberId,
  excludeSpeakerId = null,
}) {
  if (!memberId) return { ok: true };
  if (!tenantId) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Tenant context required to link a speaker to a member' },
    };
  }

  const { data: member, error: memberError } = await db
    .from('member')
    .select('id')
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (memberError) {
    console.error('[Speaker Member Link] Member validation failed:', memberError);
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to validate linked member' },
    };
  }
  if (!member) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Member does not belong to your tenant' },
    };
  }

  let duplicateQuery = db
    .from('speaker')
    .select('id, full_name')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId);
  if (excludeSpeakerId) {
    duplicateQuery = duplicateQuery.neq('id', excludeSpeakerId);
  }

  const { data: existingSpeaker, error: duplicateError } = await duplicateQuery.maybeSingle();
  if (duplicateError) {
    console.error('[Speaker Member Link] Duplicate validation failed:', duplicateError);
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to validate linked member' },
    };
  }
  if (existingSpeaker) {
    return {
      ok: false,
      status: 409,
      body: {
        error: existingSpeaker.full_name
          ? `This member is already linked to ${existingSpeaker.full_name}`
          : 'This member is already linked to another speaker',
        code: 'DUPLICATE_SPEAKER_MEMBER',
        speaker_id: existingSpeaker.id,
      },
    };
  }

  return { ok: true };
}