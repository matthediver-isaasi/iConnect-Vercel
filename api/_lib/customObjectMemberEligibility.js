// An anonymisation address is the sole deletion signal for relationship views.
// Null emails, disabled members and directory visibility do not imply deletion.
export const isDeletedRelationshipMember = (row) =>
  typeof row.email === 'string' && /^deleted_.+@deleted\.local$/i.test(row.email);