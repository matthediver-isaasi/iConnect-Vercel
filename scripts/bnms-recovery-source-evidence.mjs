// Reconcile only documented overseas wording variants. Never alter source data.
export function overseasWordingAgrees(source) {
  return source.state === 'source_conflict_requires_review'
    && source.memberClass.startsWith('Overseas ')
    && source.matches.length > 0
    && source.matches.every(row => !row.identityConflict
      && row.expiry === source.retainedExpiry && row.status === 'Active'
      && row.type === source.legacyType && /Overseas/.test(row.type)
      && [source.memberClass.toLowerCase(), source.memberClass.replace(/^Overseas /, '').toLowerCase()]
        .includes(row.class.toLowerCase()));
}
