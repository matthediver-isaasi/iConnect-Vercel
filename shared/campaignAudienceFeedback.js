// Aggregate-only feedback: never include recipient identities in diagnostics.
export function campaignAudienceFeedback(stats) {
  if (!stats || stats.finalCount > 0) return null;
  if (!stats.totalAudience) {
    return 'No contacts matched the audience. Check the selected event, ticket types and recorded attendance, and confirm attendance processing has completed.';
  }
  return `No eligible recipients remain from ${stats.totalAudience} matching contacts: ${stats.globalOptOuts} excluded by global consent and ${stats.categoryOptOuts} by category eligibility. Review the campaign category and subscription eligibility; do not override opt-outs to make the campaign send.`;
}
