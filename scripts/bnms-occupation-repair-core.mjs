import { TENANT, hash } from './bnms-job-title-repair-core.mjs';
const clean = value => String(value ?? '').trim();
const email = value => clean(value).toLowerCase();

// Conservative replacement only: source Notes must still be the current title.
// Blank titles and differently edited titles are not authorisation to backfill.
export function planOccupationRepair(member, legacyValues, occupationValues, sources) {
  const skip = reason => ({ reason });
  if (member.tenant_id !== TENANT || member.status === 'deleted'
    || member.is_sample || member.is_test || member.deleted_at || member.anonymized_at)
    return skip('Excluded member');
  if (!clean(member.job_title)) return skip('Blank title — no overwrite');
  if (legacyValues.length !== 1 || !clean(legacyValues[0])) return skip('Missing or ambiguous legacy identity');
  const byEmail = sources.filter(s => email(s.email) === email(member.email));
  const matches = byEmail.filter(s => clean(s.legacyId) === clean(legacyValues[0]));
  if (!matches.length || byEmail.some(s => clean(s.legacyId) !== clean(legacyValues[0])))
    return skip('Source identity missing or conflicting');
  const titles = [...new Set(matches.map(s => clean(s.occupation)).filter(Boolean))];
  if (titles.length !== 1) return skip('Source occupation missing or conflicting');
  const title = titles[0];
  if (title === member.job_title) return skip('Already matches source occupation');
  if (title.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFD]/.test(title))
    return skip('Source occupation requires review');
  if (occupationValues.length > 1 || (clean(occupationValues[0]) && clean(occupationValues[0]) !== title))
    return skip('Current Occupation differs from source');
  const noteSources = matches.filter(s => clean(s.notes) && clean(s.notes) === clean(member.job_title));
  if (!noteSources.length) return skip('Current title is not the original Notes — preserve');
  const evidence = noteSources.map(s => `${s.file}; SHA-256 ${s.fingerprint}; sheet ${s.sheet}; row ${s.row}`).sort();
  const note = {
    id: `bnms-occupation-repair-${hash([TENANT,member.id,member.job_title,title])}`,
    target_member_id: member.id, author_member_id: null,
    content: `Automated BNMS data repair — original imported Notes preserved from Job Title; not newly authored by the member.\nJob Title replaced with the original Occupation value: ${title}\nSource evidence:\n${evidence.join('\n')}\nOriginal Job Title content (verbatim):\n\n${member.job_title}`,
  };
  return { item: { id:member.id,tenant_id:TENANT,before:member,title,note }, evidence:noteSources };
}
